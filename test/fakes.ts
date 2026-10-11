import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { CallSession, type CallSessionDeps, type EndAction } from '../src/call/CallSession.js';
import type { Transport } from '../src/call/MediaStream.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { Brain, Message, MessageParam, ResponseStream } from '../src/llm/types.js';
import { silentLogger } from '../src/logger.js';
import { MessageStore } from '../src/records.js';
import type { SpeechToText, SttHandlers, TurnEventType } from '../src/stt/types.js';
import { AudioCache } from '../src/tts/index.js';
import type { SynthesisOptions, TextToSpeech } from '../src/tts/types.js';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` is true. */
export async function until(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(5);
  }
}

/**
 * Polls until `check` passes (or throws its last error after `timeoutMs`).
 * Use assertions with explicit messages here: a message-less assert.ok() makes
 * Node re-parse the test's source on every failure, which is very slow.
 */
export async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(5);
    }
  }
}

/** Records what the session sends to the phone line; can acknowledge marks like Twilio. */
export class FakeTransport implements Transport {
  audioBytes = 0;
  marks: string[] = [];
  clears = 0;
  events: Record<string, unknown>[] = [];
  closedWith: string | null = null;
  session: CallSession | null = null;
  /** Play marks back after this many ms (null = never, i.e. audio is still "playing"). */
  ackAfterMs: number | null = 10;

  sendAudio(chunk: Buffer): void {
    this.audioBytes += chunk.length;
  }
  sendMark(name: string): void {
    this.marks.push(name);
    if (this.ackAfterMs !== null) setTimeout(() => this.session?.onMark(name), this.ackAfterMs);
  }
  clearAudio(): void {
    this.clears++;
  }
  sendEvent(event: Record<string, unknown>): void {
    this.events.push(event);
  }
  close(reason: string): void {
    this.closedWith = reason;
  }
  /** Acknowledge every mark sent so far (playback caught up). */
  ackAll(): void {
    for (const mark of this.marks) this.session?.onMark(mark);
  }
}

export class FakeStt implements SpeechToText {
  handlers!: SttHandlers;
  closed = false;
  start(): Promise<void> {
    return Promise.resolve();
  }
  sendAudio(): void {}
  close(): void {
    this.closed = true;
  }
  emit(type: TurnEventType, transcript: string, turnIndex = 0): void {
    this.handlers.onTurn({ type, transcript, turnIndex, endOfTurnConfidence: 0.9 });
  }
}

/** 100 ms of μ-law audio per word, delivered after a short delay. */
export class FakeTts implements TextToSpeech {
  readonly name = 'fake';
  warmUp?: () => void;
  requests: string[] = [];
  async *synthesize(text: string, { signal }: SynthesisOptions): AsyncGenerator<Buffer> {
    this.requests.push(text);
    await sleep(2);
    if (signal.aborted) return;
    for (const _word of text.split(/\s+/)) yield Buffer.alloc(800, 0xff);
  }
}

export interface ScriptedReply {
  text?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
  /** Never finish (until aborted) after streaming the text. */
  hang?: boolean;
  stopReason?: Message['stop_reason'];
}

class FakeStream implements ResponseStream {
  private readonly listeners: ((delta: string) => void)[] = [];
  private readonly result: Promise<Message>;
  private readonly controller = new AbortController();

  constructor(reply: ScriptedReply, signal: AbortSignal) {
    const abort = () => this.controller.abort();
    signal.addEventListener('abort', abort);
    this.result = new Promise<Message>((resolve, reject) => {
      this.controller.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
      void (async () => {
        await sleep(3);
        for (const piece of (reply.text ?? '').match(/\S+\s*/g) ?? []) {
          if (this.controller.signal.aborted) return;
          for (const listener of this.listeners) listener(piece);
          await sleep(1);
        }
        if (reply.hang || this.controller.signal.aborted) return;
        const content: unknown[] = [];
        if (reply.text) content.push({ type: 'text', text: reply.text, citations: null });
        for (const [i, tool] of (reply.tools ?? []).entries()) {
          content.push({ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}_${i}`, name: tool.name, input: tool.input });
        }
        resolve({
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'fake-model',
          content,
          stop_reason: reply.stopReason ?? (reply.tools?.length ? 'tool_use' : 'end_turn'),
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        } as unknown as Message);
      })();
    });
    this.result.catch(() => {});
  }

  on(_event: 'text', listener: (delta: string) => void): this {
    this.listeners.push(listener);
    return this;
  }
  finalMessage(): Promise<Message> {
    return this.result;
  }
  abort(): void {
    this.controller.abort();
  }
}

/** A scripted model: each request takes the next reply. Records every request. */
export class FakeBrain implements Brain {
  readonly requests: MessageParam[][] = [];
  aborted = 0;
  prewarmed = false;
  findFollowUp?: Brain['findFollowUp'];
  keepWarm?: Brain['keepWarm'];
  constructor(public replies: ScriptedReply[]) {}

  stream(messages: MessageParam[], signal: AbortSignal): ResponseStream {
    this.requests.push(messages);
    signal.addEventListener('abort', () => this.aborted++);
    const reply = this.replies.shift() ?? { text: 'Okay.' };
    return new FakeStream(reply, signal);
  }
  async prewarm(): Promise<void> {
    this.prewarmed = true;
  }
}

const tempDirs: string[] = [];
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-test-'));
  tempDirs.push(dataDir);
  const { config } = loadConfig(
    {
      DEEPGRAM_API_KEY: 'test',
      ANTHROPIC_API_KEY: 'test',
      AGENT_NAME: 'Ava',
      COMPANY_NAME: 'Test Co',
      GREETING: 'Hi, this is Ava. How can I help?',
      TIMEZONE: 'UTC',
      SILENCE_TIMEOUT_SECONDS: '3',
      DATA_DIR: dataDir,
      ...overrides,
    },
    process.cwd(),
  );
  return config;
}

export interface Harness {
  session: CallSession;
  transport: FakeTransport;
  stt: FakeStt;
  tts: FakeTts;
  brain: FakeBrain;
  config: AppConfig;
  ended: EndAction[];
}

export function createHarness(replies: ScriptedReply[], options: { config?: AppConfig; deps?: Partial<CallSessionDeps> } = {}): Harness {
  const config = options.config ?? testConfig();
  const transport = new FakeTransport();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const brain = new FakeBrain(replies);
  const ended: EndAction[] = [];
  const session = new CallSession({ callSid: 'CAtest', from: '+15550100', mode: 'twilio' }, transport, {
    config,
    brain,
    tts,
    createStt: (handlers) => {
      stt.handlers = handlers;
      return stt;
    },
    audioCache: new AudioCache(),
    voiceKey: 'fake',
    messages: new MessageStore(config.dataDir, undefined, silentLogger),
    log: silentLogger,
    onEnd: (action) => ended.push(action),
    ...options.deps,
  });
  transport.session = session;
  return { session, transport, stt, tts, brain, config, ended };
}

/** Text of a user message's content, for assertions. */
export function textOf(message: MessageParam | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.map((block) => ('text' in block ? block.text : `<${block.type}>`)).join('|');
}
