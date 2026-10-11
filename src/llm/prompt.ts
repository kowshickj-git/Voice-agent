import fs from 'node:fs';
import type { AgentConfig, LlmProvider } from '../config.js';
import { productCodes } from '../text/speechText.js';

/** Reads an agent Markdown file, dropping <!-- comments -->. Missing files read as empty. */
export function readAgentFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Short, explicit rules for small local models, which drift from the softer
 * guidance above (they invent facts, or say "I've noted that" without calling
 * the tool). Placed last, where small models weight instructions most.
 */
function localModelRules(agent: AgentConfig, hasLibrary: boolean): string {
  const transfer = agent.transferNumber
    ? '6. If the caller wants to speak with a human or a staff member, call the transfer_call tool.'
    : '6. If the caller wants to speak with a human or a staff member, tell them nobody from the team can take the call right now, and offer to take a message.';
  const fallback = `say: "I'm sorry, I don't have that information, but I can take a message for the team."`;
  const knowledgeRule = agent.expertise
    ? `1. Facts about ${agent.company}, its products, models, prices, and policies come only from the knowledge base above${hasLibrary ? ' and the reference notes' : ''}. When the caller asks about one that is not written there, ${fallback} Never give a price, model, or specification that isn't written there for that exact item. General questions about ${agent.expertise} you may answer from your own knowledge, in simple words.`
    : `1. You only know what is written in the knowledge base above. When the caller asks about a service, price, or detail that is not written there, ${fallback} Don't say whether ${agent.company} offers it, and never give a price that isn't written there for that exact service.`;
  return `

## Rules you must always follow
${knowledgeRule}
2. Keep every reply to one or two short sentences, then let the caller talk.
3. To take a message or booking request: collect the caller's name, callback number, and what they need, and read the number back digit by digit so the caller can confirm it. As soon as they confirm, call the take_message tool in that same reply.
4. Never say you have noted, saved, booked, or sent anything unless you called take_message in this conversation.
5. When the caller says goodbye or says they have nothing else, call the end_call tool. A goodbye is spoken for you.
${transfer}`;
}

/**
 * The system prompt for a call. It is identical for every call (no per-call
 * values), so it stays in the prompt cache across calls; per-call details go
 * in the first message instead (see `callContextNote`).
 */
export function buildSystemPrompt(agent: AgentConfig, provider: LlmProvider = 'anthropic'): string {
  const instructions = readAgentFile(agent.instructionsFile);
  const knowledge = readAgentFile(agent.knowledgeFile);
  const hasLibrary = readAgentFile(agent.libraryFile) !== '';
  const canTransfer = Boolean(agent.transferNumber);
  const { name, company } = agent;

  const transferRule = canTransfer
    ? "- If the caller asks for a person, or needs something you can't handle, tell them you'll connect them with someone from the team and use the transfer_call tool in the same reply."
    : "- There's no one to transfer calls to. If the caller asks for a person, offer to take a message so the team can call them back.";
  const unknownOffer = canTransfer ? 'to take a message or to transfer them to someone on the team' : 'to take a message for the team';
  const languageRule =
    agent.language.toLowerCase() === 'auto'
      ? 'Reply in the language the caller is speaking, and switch if they switch.'
      : `Speak ${agent.language}.`;

  return `You are ${name}, the phone assistant for ${company}. You answer incoming phone calls and talk with callers in real time.

## How this call works
This is a live phone conversation. The caller's speech is transcribed for you, and everything you write is turned into speech and played to them, so write exactly what you would say out loud. The transcription sometimes mishears words, especially names, numbers, and email addresses; if something sounds wrong or unclear, ask the caller to repeat or spell it instead of guessing.

Text in square brackets, like "[No response from the caller for 10 seconds.]", is a note from the phone system, not something the caller said. Never read these notes aloud or mention them. When a note says the caller interrupted you, they did not hear the rest of what you were saying: respond to what they just said, and only repeat what they missed if it still matters.${
    hasLibrary
      ? ` A note that starts with "Reference notes" holds facts from ${company}'s knowledge library, looked up for the caller's question: treat it as part of your knowledge base and use only what helps.`
      : ''
  }

## How to speak
- Sound like a warm, capable receptionist: natural, friendly, and to the point. Most replies are one or two short sentences.
- Ask one question at a time, then stop and let the caller answer.
- Write plain spoken sentences. Lists, headings, bold text, emojis, and symbols can't be spoken, so never use them.
- Say numbers the way people say them out loud, like "two thirty in the afternoon" or "about forty dollars". Read phone numbers digit by digit in small groups.
- Vary your wording, and don't open every reply with the same word.
- If the caller asks whether they're talking to a person or an AI, be honest: you're ${company}'s automated assistant.

## Getting things right
- Only tell callers facts about ${company} that appear in your role description or knowledge base below. If you don't know something, say so plainly and offer ${unknownOffer}. Never make up prices, availability, policies, or appointment times.${
    agent.expertise
      ? `\n- You can also answer general questions about ${agent.expertise} from your own knowledge, in simple spoken words. Use the knowledge base whenever it covers the question, and never make up product specifications.`
      : ''
  }
- When you take down details like a name, phone number, date, or time, read them back to confirm before you act on them.
- The caller can't see anything, so don't refer to links, websites, or written material unless they're in the knowledge base.

## Ending and transferring calls
- When the caller has what they need and the conversation is wrapping up, say a short, friendly goodbye and use the end_call tool in the same reply.
${transferRule}
- If the caller has gone quiet through a couple of check-ins, say goodbye and end the call. If they asked you to hold on, give them time.

## Language
${languageRule}

## Your role
${instructions || `Help callers with their questions about ${company}, and take a message when they need something you can't do yourself.`}

## Knowledge base
${knowledge || '(No knowledge base has been provided.)'}${provider === 'ollama' ? localModelRules(agent, hasLibrary) : ''}`;
}

/**
 * A warning when the system prompt (roughly 3 characters per token) leaves
 * less than a third of a local model's context window for the conversation.
 */
export function promptSizeWarning(systemPrompt: string, contextTokens: number): string | undefined {
  const tokens = Math.round(systemPrompt.length / 3);
  if (tokens < contextTokens * 0.67) return undefined;
  return (
    `The instructions and knowledge base take about ${tokens.toLocaleString()} of the model's ${contextTokens.toLocaleString()} tokens, ` +
    'leaving little room for the conversation. Raise LLM_CONTEXT_TOKENS (16384 or more) or shorten the knowledge base.'
  );
}

/** Codes that are fine to say although no agent file mentions them. */
const COMMON_CODES = ['CO2', 'H2', 'H2O', 'PM2.5'];

/**
 * Every model or part code written in the agent's files ("SG5.0RS", "IP66"),
 * for catching replies that name products the agent knows nothing about.
 * Undefined when the files aren't a product catalog (fewer than 3 codes).
 */
export function knownProductCodes(agent: AgentConfig): Set<string> | undefined {
  const files = [agent.instructionsFile, agent.knowledgeFile, agent.libraryFile];
  const codes = new Set(productCodes(files.map(readAgentFile).join('\n')));
  if (codes.size < 3) return undefined;
  for (const code of COMMON_CODES) codes.add(code);
  return codes;
}

export interface CallContext {
  callerNumber?: string;
  timezone: string;
  now?: Date;
}

/** The first message of every call: who is calling and the local date and time. */
export function callContextNote({ callerNumber, timezone, now = new Date() }: CallContext): string {
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  const caller = callerNumber ? `Caller ID: ${callerNumber}.` : 'Caller ID: not available.';
  return `[Phone call connected. ${caller} Local time: ${local} (${timezone}).]`;
}
