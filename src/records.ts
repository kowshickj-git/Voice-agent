import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './logger.js';
import type { Message, MessageParam } from './llm/types.js';

export type TranscriptRole = 'caller' | 'agent' | 'system' | 'tool';

export interface TranscriptEntry {
  /** Seconds since the call started. */
  at: number;
  role: TranscriptRole;
  text: string;
}

export interface CallInfo {
  callSid: string;
  from?: string;
  to?: string;
  mode: 'twilio' | 'web';
}

/** Everything worth keeping about a call; saved as JSON when it ends. */
export class CallRecord {
  readonly startedAt = new Date();
  readonly transcript: TranscriptEntry[] = [];
  readonly responseLatenciesMs: number[] = [];
  readonly usage = { responses: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  endReason = '';

  constructor(readonly info: CallInfo) {}

  add(role: TranscriptRole, text: string): void {
    const at = Math.round((Date.now() - this.startedAt.getTime()) / 100) / 10;
    this.transcript.push({ at, role, text });
  }

  addUsage(usage: Message['usage']): void {
    this.usage.responses++;
    this.usage.inputTokens += usage.input_tokens ?? 0;
    this.usage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.usage.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.usage.outputTokens += usage.output_tokens ?? 0;
  }

  toJSON(messages: readonly MessageParam[]): Record<string, unknown> {
    const endedAt = new Date();
    const latencies = [...this.responseLatenciesMs].sort((a, b) => a - b);
    return {
      ...this.info,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSeconds: Math.round((endedAt.getTime() - this.startedAt.getTime()) / 1000),
      endReason: this.endReason,
      responseLatencyMs: latencies.length
        ? { median: latencies[Math.floor(latencies.length / 2)], max: latencies[latencies.length - 1], count: latencies.length }
        : null,
      usage: this.usage,
      transcript: this.transcript,
      messages,
    };
  }
}

function stamp(date: Date): { day: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  };
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

export async function saveCallRecord(dataDir: string, record: CallRecord, messages: readonly MessageParam[]): Promise<string> {
  const { day, time } = stamp(record.startedAt);
  const dir = path.join(dataDir, 'calls', day);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${time}_${safeName(record.info.callSid)}.json`);
  await fs.writeFile(file, JSON.stringify(record.toJSON(messages), null, 2));
  return file;
}

export interface TakenMessage {
  callSid: string;
  callerId?: string;
  callerName: string;
  callbackNumber: string;
  message: string;
  urgency: string;
  /** How the message was captured, if not by the agent during the call. */
  source?: string;
}

/** Saves messages the agent takes for the team, and optionally posts them to a webhook (Slack, Zapier, Make, ...). */
export class MessageStore {
  constructor(
    private readonly dataDir: string,
    private readonly webhookUrl: string | undefined,
    private readonly log: Logger,
  ) {}

  async save(message: TakenMessage): Promise<string> {
    const createdAt = new Date();
    const { day, time } = stamp(createdAt);
    const dir = path.join(this.dataDir, 'messages');
    await fs.mkdir(dir, { recursive: true });
    const base = path.join(dir, `${day}_${time}_${safeName(message.callSid)}`);
    const record = { ...message, createdAt: createdAt.toISOString() };
    const body = JSON.stringify(record, null, 2);
    // Two messages from one call within the same second must not overwrite each other.
    let file = `${base}.json`;
    for (let n = 2; ; n++) {
      try {
        await fs.writeFile(file, body, { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        file = `${base}_${n}.json`;
      }
    }
    if (this.webhookUrl) void this.postWebhook(record);
    return file;
  }

  private async postWebhook(record: TakenMessage & { createdAt: string }): Promise<void> {
    const text =
      `New ${record.urgency === 'high' ? 'URGENT ' : ''}phone message from ${record.callerName} ` +
      `(callback ${record.callbackNumber}): ${record.message}`;
    try {
      const res = await fetch(this.webhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...record }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) this.log.warn(`Message webhook returned HTTP ${res.status}`);
    } catch (err) {
      this.log.warn('Message webhook failed', err);
    }
  }
}
