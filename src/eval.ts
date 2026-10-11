// Asks an agent a bank of test questions the way a call would (library notes,
// corrected transcripts, tools, the product-code check) and checks each reply.
// Run: npm run eval:sungrow
//      npm run eval -- --agent=<name> [--only=<category>] [--limit=<n>]
// The questions live in eval.json next to the agent's knowledge base. Each case has a
// "q" (or several "turns"), and checks: "expect" (regexes that must all match what the
// caller hears), "forbid" (regexes that must not match), "tool" and "toolInput".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PHRASES } from './call/CallSession.js';
import { loadConfig } from './config.js';
import { assistantContentForHistory, createAnthropicClient } from './llm/ClaudeBrain.js';
import { createBrain, describeLlm } from './llm/index.js';
import { KnowledgeLibrary, referenceNote } from './llm/library.js';
import { buildSystemPrompt, callContextNote, knownProductCodes } from './llm/prompt.js';
import { buildTools, runTool } from './llm/tools.js';
import type { MessageParam, ToolResultBlockParam, ToolUseBlock } from './llm/types.js';
import { silentLogger } from './logger.js';
import { MessageStore } from './records.js';
import { SentenceChunker } from './text/SentenceChunker.js';
import { isSpokenEndCall, productCodes, toSpeakableText } from './text/speechText.js';

interface EvalCase {
  category: string;
  q?: string;
  turns?: string[];
  expect?: string[];
  forbid?: string[];
  tool?: string;
  toolInput?: string[];
}

interface CaseResult {
  category: string;
  question: string;
  heard: string;
  tools: string[];
  firstMs: number;
  failures: string[];
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const { config, errors } = loadConfig();
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
const file = arg('questions') ?? path.join(path.dirname(config.agent.knowledgeFile), 'eval.json');
if (!fs.existsSync(file)) {
  console.error(`No questions found at ${file}`);
  process.exit(1);
}
let cases = (JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: EvalCase[] }).cases;
const only = arg('only');
if (only) cases = cases.filter((c) => c.category === only);
const limit = Number(arg('limit') ?? 0);
if (limit > 0) cases = cases.slice(0, limit);

const tools = buildTools({ transferEnabled: Boolean(config.agent.transferNumber) });
const brain = createBrain(
  config.llm,
  buildSystemPrompt(config.agent, config.llm.provider),
  tools,
  config.llm.provider === 'anthropic' ? createAnthropicClient() : undefined,
);
const library = KnowledgeLibrary.load(config.agent.libraryFile);
const known = config.llm.provider === 'ollama' ? knownProductCodes(config.agent) : undefined;
const messageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-eval-'));
const toolContext = { callSid: 'EVAL', callerId: '+919840012345', messages: new MessageStore(messageDir, undefined, silentLogger), log: silentLogger };

/** What the caller would hear: the product-code check, "End call." lines dropped, speech cleanup. */
function heardText(reply: string): { text: string; guarded: boolean } {
  if (known && productCodes(reply).some((code) => ![...known].some((k) => k.includes(code)))) {
    return { text: PHRASES.unknownProduct, guarded: true };
  }
  const spoken = SentenceChunker.sentences(reply).filter((s) => !isSpokenEndCall(s));
  return { text: toSpeakableText(spoken.join(' ')), guarded: false };
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const turns = c.turns ?? [c.q ?? ''];
  const history: MessageParam[] = [
    { role: 'user', content: callContextNote({ callerNumber: toolContext.callerId, timezone: config.agent.timezone }) },
    { role: 'assistant', content: config.agent.greeting },
  ];
  const used = new Set<number>();
  const calledTools: string[] = [];
  const toolInputs: string[] = [];
  let heard = '';
  let firstMs = 0;
  let guarded = false;
  for (const line of turns) {
    let text = line;
    for (const { pattern, replacement } of config.stt.corrections) text = text.replace(pattern, replacement);
    const found = library?.search(text, { exclude: used }) ?? [];
    for (const section of found) used.add(section.id);
    history.push({ role: 'user', content: [...(found.length ? [referenceNote(found)] : []), text].join('\n') });
    heard = '';
    // Continue after tool calls, the way a call does, until the agent waits for the caller.
    for (let step = 0; step < 4; step++) {
      const started = Date.now();
      let reply = '';
      const stream = brain.stream(history, AbortSignal.timeout(90_000));
      stream.on('text', (delta) => {
        if (!reply && !firstMs) firstMs = Date.now() - started;
        reply += delta;
      });
      const message = await stream.finalMessage();
      const spoken = heardText(reply);
      guarded ||= spoken.guarded;
      heard = `${heard} ${spoken.text}`.trim();
      history.push({ role: 'assistant', content: assistantContentForHistory(message.content).content });
      const uses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) break;
      const results: ToolResultBlockParam[] = [];
      for (const use of uses) {
        calledTools.push(use.name);
        toolInputs.push(JSON.stringify(use.input));
        results.push(
          use.name === 'take_message'
            ? await runTool(use, toolContext)
            : { type: 'tool_result', tool_use_id: use.id, content: use.name === 'end_call' ? 'The call has been ended.' : 'Done.' },
        );
      }
      if (uses.some((u) => u.name === 'end_call' || u.name === 'transfer_call')) break;
      history.push({ role: 'user', content: results });
    }
  }

  const failures: string[] = [];
  for (const pattern of c.expect ?? []) if (!new RegExp(pattern, 'i').test(heard)) failures.push(`missing /${pattern}/`);
  for (const pattern of c.forbid ?? []) if (new RegExp(pattern, 'i').test(heard)) failures.push(`said /${pattern}/`);
  if (c.tool && !calledTools.includes(c.tool)) failures.push(`no ${c.tool} call`);
  for (const pattern of c.toolInput ?? []) if (!new RegExp(pattern, 'i').test(toolInputs.join(' '))) failures.push(`tool input missing /${pattern}/`);
  if (guarded) heard = `[product check] ${heard}`;
  return { category: c.category, question: turns.join(' | '), heard, tools: calledTools, firstMs, failures };
}

console.log(`\n${config.agent.name} for ${config.agent.company} · ${describeLlm(config.llm)} · ${cases.length} questions from ${file}\n`);
await brain.prewarm();
const results: CaseResult[] = [];
for (const c of cases) {
  const result = await runCase(c);
  results.push(result);
  const mark = result.failures.length ? 'FAIL' : 'pass';
  console.log(`${mark}  [${result.category}] ${result.question}`);
  if (result.failures.length) console.log(`      heard: ${result.heard.slice(0, 220)}\n      why:   ${result.failures.join('; ')}`);
}

const passed = results.filter((r) => !r.failures.length).length;
console.log(`\nPassed ${passed} of ${results.length} (${Math.round((100 * passed) / Math.max(1, results.length))}%)`);
const categories = [...new Set(results.map((r) => r.category))];
for (const category of categories) {
  const inCategory = results.filter((r) => r.category === category);
  const ok = inCategory.filter((r) => !r.failures.length).length;
  console.log(`  ${category.padEnd(12)} ${ok}/${inCategory.length}`);
}
const times = results.map((r) => r.firstMs).filter(Boolean);
console.log(`First words after ${Math.round(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length))} ms on average (model only).`);
const reportDir = path.join(config.dataDir, 'eval');
fs.mkdirSync(reportDir, { recursive: true });
const report = path.join(reportDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(report, JSON.stringify({ model: describeLlm(config.llm), passed, total: results.length, results }, null, 2));
console.log(`Full report: ${report}\n`);
fs.rmSync(messageDir, { recursive: true, force: true });
process.exit(0);
