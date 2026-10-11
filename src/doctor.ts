// Checks your configuration and API keys with one small request to each service.
// Run: npm run doctor (add -- --agent=<name> to check an agent profile)
import fs from 'node:fs';
import WebSocket from 'ws';
import { agentSettingsFile, loadConfig } from './config.js';
import { createAnthropicClient, describeApiError } from './llm/ClaudeBrain.js';
import { createBrain, describeLlm } from './llm/index.js';
import { KnowledgeLibrary } from './llm/library.js';
import { modelCapabilities } from './llm/OllamaBrain.js';
import { buildSystemPrompt, callContextNote, promptSizeWarning } from './llm/prompt.js';
import { buildTools } from './llm/tools.js';
import { buildFluxUrl } from './stt/FluxStt.js';
import { createTts, voiceKey } from './tts/index.js';

const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const bad = (msg: string) => console.log(`  ✘ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);
let failures = 0;

console.log('\nConfiguration');
const { config, errors, warnings } = loadConfig();
for (const w of warnings) warn(w);
for (const e of errors) bad(e);
failures += errors.length;
if (!fs.existsSync('.env')) warn('No .env file found. Copy .env.example to .env and add your keys.');
if (errors.length === 0) ok('Settings look valid');

console.log('\nAgent');
if (config.profile) ok(`Agent profile "${config.profile}" (settings in ${agentSettingsFile(config.profile)}, records in ${config.dataDir})`);
for (const [label, file] of [
  ['Instructions', config.agent.instructionsFile],
  ['Knowledge base', config.agent.knowledgeFile],
] as const) {
  if (fs.existsSync(file)) ok(`${label}: ${file}`);
  else warn(`${label} file not found: ${file}`);
}
const library = KnowledgeLibrary.load(config.agent.libraryFile);
if (library) ok(`Knowledge library: ${library.size} sections in ${config.agent.libraryFile} (looked up per question)`);
const systemPrompt = buildSystemPrompt(config.agent, config.llm.provider);
ok(`System prompt is ${systemPrompt.length.toLocaleString()} characters`);
const sizeWarning = config.llm.provider === 'ollama' ? promptSizeWarning(systemPrompt, config.llm.contextTokens) : undefined;
if (sizeWarning) warn(sizeWarning);

async function checkModel(): Promise<void> {
  const { llm } = config;
  console.log(`\nConversation model (${describeLlm(llm)})`);
  const tools = buildTools({ transferEnabled: Boolean(config.agent.transferNumber) });
  if (llm.provider === 'ollama') {
    try {
      const capabilities = await modelCapabilities(llm.ollamaUrl, llm.model);
      ok(`Ollama is running and ${llm.model} is downloaded`);
      if (capabilities.includes('tools')) ok('The model supports tool calling (hang up, transfer, take messages)');
      else warn(`${llm.model} doesn't support tool calling, so the agent can't hang up, transfer, or take messages`);
      const loadStarted = Date.now();
      await createBrain(llm, systemPrompt, tools).prewarm();
      ok(`Model loaded in ${((Date.now() - loadStarted) / 1000).toFixed(1)} s`);
    } catch (err) {
      failures++;
      bad(describeApiError(err));
      return;
    }
  }
  const brain = createBrain(llm, systemPrompt, tools, llm.provider === 'anthropic' ? createAnthropicClient() : undefined);
  const started = Date.now();
  let firstText = 0;
  let text = '';
  try {
    const stream = brain.stream(
      [
        { role: 'user', content: callContextNote({ callerNumber: '+15550100000', timezone: config.agent.timezone }) },
        { role: 'assistant', content: config.agent.greeting },
        { role: 'user', content: 'Hi, what are your opening hours?' },
      ],
      AbortSignal.timeout(60_000),
    );
    stream.on('text', (delta) => {
      if (!firstText) firstText = Date.now();
      text += delta;
    });
    const message = await stream.finalMessage();
    ok(`Replied in ${firstText ? firstText - started : Date.now() - started} ms (first words): "${text.trim().slice(0, 160)}"`);
    if (llm.provider === 'anthropic') {
      const cached = (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
      ok(`Prompt caching active (${cached.toLocaleString()} tokens cached or read)`);
    }
  } catch (err) {
    failures++;
    bad(describeApiError(err));
  }
}

async function checkTts(): Promise<void> {
  console.log(`\nVoice (${voiceKey(config)})`);
  const tts = createTts(config);
  const started = Date.now();
  let bytes = 0;
  let firstAt = 0;
  try {
    for await (const chunk of tts.synthesize('Hello! This is a quick voice check.', { signal: AbortSignal.timeout(20_000) })) {
      if (!firstAt) firstAt = Date.now();
      bytes += chunk.length;
    }
    if (bytes === 0) throw new Error('no audio returned');
    ok(`Synthesized ${(bytes / 8000).toFixed(1)} s of audio, first audio after ${firstAt - started} ms`);
  } catch (err) {
    failures++;
    bad(err instanceof Error ? err.message : String(err));
  }
}

async function checkStt(): Promise<void> {
  console.log(`\nSpeech recognition (Deepgram ${config.stt.model})`);
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(buildFluxUrl({ ...config.stt, apiKey: config.deepgramApiKey }), {
        headers: { Authorization: `Token ${config.deepgramApiKey}` },
        handshakeTimeout: 10_000,
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('timed out waiting for Deepgram'));
      }, 15_000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string; description?: string };
        if (msg.type === 'Connected') {
          clearTimeout(timer);
          ws.send(JSON.stringify({ type: 'CloseStream' }));
          ws.close();
          resolve();
        } else if (msg.type === 'Error') {
          clearTimeout(timer);
          ws.terminate();
          reject(new Error(msg.description ?? 'Deepgram error'));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`${err.message}${/401|403/.test(err.message) ? ' (check DEEPGRAM_API_KEY)' : ''}`));
      });
    });
    ok('Connected to Deepgram Flux');
  } catch (err) {
    failures++;
    bad(err instanceof Error ? err.message : String(err));
  }
}

console.log('\nTwilio');
if (config.twilioAuthToken) ok('TWILIO_AUTH_TOKEN is set, so webhook signatures will be verified');
else warn('TWILIO_AUTH_TOKEN is not set, so webhook signatures are not verified');
warn(`Point your Twilio number's "A call comes in" webhook to ${config.publicUrl ?? 'https://<your-public-url>'}/twilio/voice (HTTP POST)`);

if (errors.length === 0) {
  await checkModel();
  if (config.deepgramApiKey) await checkStt();
  await checkTts();
}

const startCommand = config.profile ? `npm start -- --agent=${config.profile}` : 'npm start';
console.log(failures === 0 ? `\nAll checks passed. Start the agent with: ${startCommand}\n` : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
