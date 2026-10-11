import crypto from 'node:crypto';
import type { LlmConfig } from '../config.js';
import {
  ModelRequestError,
  type Brain,
  type ContentBlockParam,
  type FollowUp,
  type Message,
  type MessageParam,
  type ResponseStream,
  type Tool,
} from './types.js';

/** Keep the model loaded between calls so the first reply doesn't wait for it to load. */
const KEEP_ALIVE = '30m';

const FOLLOW_UP_PROMPT = `You read transcripts of phone calls answered by an automated receptionist and decide whether a staff member needs to follow up.

Set action to "follow_up" only if the caller asked to be called back, wanted to book, change, or cancel an appointment, left a message for someone, or asked something the assistant couldn't answer. Most calls need no follow-up: if the assistant answered everything the caller asked, set action to "none".

For a follow-up, give the caller's name, the best callback number (the caller ID, unless they gave another number), and the message: one short sentence saying what they need, with any days or times they asked for. Write "unknown" for details that never came up.`;

/**
 * Ollama constrains the reply to this JSON schema. Keys come out in
 * alphabetical order, so the decision ("action") is made before any text is written.
 */
const FOLLOW_UP_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['none', 'follow_up'] },
    callback_number: { type: 'string', maxLength: 30 },
    caller_name: { type: 'string', maxLength: 60 },
    message: { type: 'string', maxLength: 300 },
    urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
  },
  required: ['action', 'callback_number', 'caller_name', 'message', 'urgency'],
};

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChunk {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function blockText(content: string | ContentBlockParam[] | unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : '')).join('');
}

/**
 * Converts the conversation (kept in the Anthropic message format) to Ollama
 * chat messages: tool calls become assistant `tool_calls`, tool results become
 * `tool` messages, and thinking blocks are dropped.
 */
export function toOllamaMessages(systemPrompt: string, messages: readonly MessageParam[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: systemPrompt }];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      let text = '';
      const calls: OllamaToolCall[] = [];
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name);
          calls.push({ function: { name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> } });
        }
      }
      out.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', content: blockText(block.content), tool_name: toolNames.get(block.tool_use_id) });
      } else if (block.type === 'text') {
        texts.push(block.text);
      }
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

export function toOllamaTools(tools: readonly Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

/** Removes <think>…</think> sections from streamed text, even when the tags are split across chunks. */
export class ThinkTagFilter {
  private buffer = '';
  private inside = false;

  push(text: string): string {
    this.buffer += text;
    let out = '';
    for (;;) {
      if (this.inside) {
        const end = this.buffer.indexOf('</think>');
        if (end < 0) {
          this.buffer = this.buffer.slice(-7);
          return out;
        }
        this.buffer = this.buffer.slice(end + 8);
        this.inside = false;
      } else {
        const start = this.buffer.indexOf('<think>');
        if (start < 0) {
          const keep = partialTagLength(this.buffer, '<think>');
          out += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          return out;
        }
        out += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start + 7);
        this.inside = true;
      }
    }
  }

  flush(): string {
    const rest = this.inside ? '' : this.buffer;
    this.buffer = '';
    return rest;
  }
}

/** Length of the longest suffix of `text` that is a prefix of `tag`. */
function partialTagLength(text: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k--) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

class OllamaStream implements ResponseStream {
  private readonly listeners: ((delta: string) => void)[] = [];
  private readonly controller = new AbortController();
  private readonly result: Promise<Message>;

  constructor(run: (emit: (delta: string) => void, signal: AbortSignal) => Promise<Message>, external: AbortSignal) {
    if (external.aborted) this.controller.abort();
    else external.addEventListener('abort', () => this.controller.abort(), { once: true });
    this.result = run((delta) => {
      for (const listener of this.listeners) listener(delta);
    }, this.controller.signal);
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

const capabilityCache = new Map<string, Promise<string[]>>();

/** What the model can do according to Ollama ("tools", "thinking", ...). */
export function modelCapabilities(baseUrl: string, model: string): Promise<string[]> {
  const key = `${baseUrl}|${model}`;
  let cached = capabilityCache.get(key);
  if (!cached) {
    cached = (async () => {
      const res = await ollamaFetch(baseUrl, '/api/show', { model });
      const info = (await res.json()) as { capabilities?: string[] };
      return info.capabilities ?? [];
    })();
    cached.catch(() => capabilityCache.delete(key));
    capabilityCache.set(key, cached);
  }
  return cached;
}

async function ollamaFetch(baseUrl: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ModelRequestError(`Can't reach Ollama at ${baseUrl}. Is it running? (start the Ollama app or run "ollama serve")`, null, false);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // not JSON
    }
    const model = (body as { model?: string }).model ?? '';
    const hint = res.status === 404 && model ? ` Download it first with: ollama pull ${model}` : '';
    throw new ModelRequestError(`Ollama returned HTTP ${res.status}: ${detail}${hint}`, res.status, res.status === 404 || res.status === 400);
  }
  return res;
}

/**
 * A free model running locally in Ollama (https://ollama.com), through its
 * native chat API — which, unlike the OpenAI-compatible one, lets us set the
 * context window and keep the model loaded.
 */
export class OllamaBrain implements Brain {
  private readonly ollamaTools: unknown[];

  constructor(
    private readonly config: LlmConfig,
    private readonly systemPrompt: string,
    tools: readonly Tool[],
  ) {
    this.ollamaTools = toOllamaTools(tools);
  }

  private async requestBody(messages: readonly MessageParam[], numPredict: number): Promise<Record<string, unknown>> {
    const capabilities = await modelCapabilities(this.config.ollamaUrl, this.config.model);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOllamaMessages(this.systemPrompt, messages),
      stream: true,
      keep_alive: KEEP_ALIVE,
      // num_ctx must stay the same on every request, or Ollama reloads the model.
      options: { num_ctx: this.config.contextTokens, num_predict: numPredict, temperature: this.config.temperature },
    };
    if (capabilities.includes('tools')) body.tools = this.ollamaTools;
    // Thinking adds seconds of silence on a phone call; answer directly.
    if (capabilities.includes('thinking')) body.think = false;
    return body;
  }

  stream(messages: MessageParam[], signal: AbortSignal): ResponseStream {
    return new OllamaStream(async (emit, abortSignal) => {
      const body = await this.requestBody(messages, this.config.maxTokens);
      const res = await ollamaFetch(this.config.ollamaUrl, '/api/chat', body, abortSignal);
      const filter = new ThinkTagFilter();
      let text = '';
      const toolCalls: OllamaToolCall[] = [];
      let last: OllamaChunk = {};
      const onChunk = (chunk: OllamaChunk) => {
        if (chunk.error) throw new ModelRequestError(`Ollama error: ${chunk.error}`, null, false);
        const piece = chunk.message?.content ? filter.push(chunk.message.content) : '';
        if (piece) {
          text += piece;
          emit(piece);
        }
        if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
        if (chunk.done) last = chunk;
      };

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) onChunk(JSON.parse(line) as OllamaChunk);
        }
      }
      if (pending.trim()) onChunk(JSON.parse(pending) as OllamaChunk);
      const tail = filter.flush();
      if (tail) {
        text += tail;
        emit(tail);
      }

      const content: unknown[] = [];
      if (text.trim()) content.push({ type: 'text', text, citations: null });
      for (const call of toolCalls) {
        let input: unknown = call.function.arguments;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            // left as a string; tool validation rejects it
          }
        }
        content.push({ type: 'tool_use', id: `call_${crypto.randomUUID()}`, name: call.function.name, input });
      }
      return {
        id: `ollama_${crypto.randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: this.config.model,
        content,
        stop_reason: toolCalls.length ? 'tool_use' : last.done_reason === 'length' ? 'max_tokens' : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: last.prompt_eval_count ?? 0,
          output_tokens: last.eval_count ?? 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      } as unknown as Message;
    }, signal);
  }

  /**
   * Small local models sometimes promise a callback without calling
   * take_message, so after the call the transcript is checked once more, with
   * the reply constrained to a JSON schema.
   */
  async findFollowUp(transcript: string, callerId: string | undefined): Promise<FollowUp | null> {
    const capabilities = await modelCapabilities(this.config.ollamaUrl, this.config.model);
    const res = await ollamaFetch(this.config.ollamaUrl, '/api/chat', {
      model: this.config.model,
      stream: false,
      keep_alive: KEEP_ALIVE,
      format: FOLLOW_UP_SCHEMA,
      // Bounded: without a limit a small model can pad the JSON until the context fills,
      // keeping Ollama (which runs one request at a time) busy for minutes.
      options: { num_ctx: this.config.contextTokens, temperature: 0, num_predict: 256 },
      ...(capabilities.includes('thinking') ? { think: false } : {}),
      messages: [
        { role: 'system', content: FOLLOW_UP_PROMPT },
        { role: 'user', content: `Caller ID: ${callerId ?? 'not available'}\n\nTranscript:\n${transcript}` },
      ],
    }, AbortSignal.timeout(20_000));
    const reply = (await res.json()) as { message?: { content?: string } };
    const result = JSON.parse(reply.message?.content ?? '{}') as Record<string, unknown>;
    const text = (key: string) => (typeof result[key] === 'string' ? (result[key] as string).trim() : '');
    if (result.action !== 'follow_up' || !text('message')) return null;
    const urgency = text('urgency');
    const known = (value: string) => (value && value.toLowerCase() !== 'unknown' ? value : '');
    return {
      callerName: known(text('caller_name')) || 'unknown',
      callbackNumber: known(text('callback_number')) || callerId || 'unknown',
      message: text('message'),
      urgency: urgency === 'low' || urgency === 'high' ? urgency : 'normal',
    };
  }

  /** Loads the model and processes the system prompt ahead of the first reply. */
  async prewarm(): Promise<void> {
    const body = await this.requestBody([{ role: 'user', content: 'Hello?' }], 1);
    const res = await ollamaFetch(this.config.ollamaUrl, '/api/chat', { ...body, stream: false });
    await res.text();
  }

  private warming = false;

  /**
   * A one-token request on the conversation so far. A laptop GPU left idle for
   * 10 to 20 seconds takes over a second to wake for the next reply; this keeps
   * it awake. The prompt is the history the next reply starts with, so Ollama's
   * prompt cache stays valid. At most one runs at a time.
   */
  keepWarm(messages: readonly MessageParam[]): void {
    if (this.warming) return;
    this.warming = true;
    void (async () => {
      try {
        const body = await this.requestBody(messages, 1);
        const res = await ollamaFetch(this.config.ollamaUrl, '/api/chat', { ...body, stream: false }, AbortSignal.timeout(10_000));
        await res.text();
      } catch {
        // Best effort: the next reply simply starts a little slower.
      } finally {
        this.warming = false;
      }
    })();
  }
}
