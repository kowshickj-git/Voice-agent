import WebSocket from 'ws';
import type { SttConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { SpeechToText, SttHandlers, TurnEvent, TurnEventType } from './types.js';

const FLUX_URL = 'wss://api.deepgram.com/v2/listen';
/** Flux works best with ~80 ms audio chunks; Twilio sends 20 ms frames. */
const CHUNK_BYTES = 640;
/** Audio kept while (re)connecting: ~5 seconds. */
const MAX_BUFFERED_BYTES = 40_000;
const MAX_RECONNECTS = 5;
const TURN_EVENTS = new Set<TurnEventType>(['StartOfTurn', 'Update', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn']);

export interface FluxOptions extends SttConfig {
  apiKey: string;
}

export function buildFluxUrl(options: FluxOptions): string {
  const params = new URLSearchParams({ model: options.model, encoding: 'mulaw', sample_rate: '8000' });
  if (options.eotThreshold !== undefined) params.set('eot_threshold', String(options.eotThreshold));
  if (options.eagerEotThreshold !== undefined) params.set('eager_eot_threshold', String(options.eagerEotThreshold));
  if (options.eotTimeoutMs !== undefined) params.set('eot_timeout_ms', String(Math.round(options.eotTimeoutMs)));
  for (const term of options.keyterms) params.append('keyterm', term);
  for (const hint of options.languageHints) params.append('language_hint', hint);
  return `${FLUX_URL}?${params}`;
}

/**
 * Streams caller audio to Deepgram Flux, a speech recognizer built for voice
 * agents: besides the transcript it reports turn boundaries (StartOfTurn,
 * EagerEndOfTurn, TurnResumed, EndOfTurn), which drive barge-in and replies.
 */
export class FluxStt implements SpeechToText {
  private ws: WebSocket | null = null;
  private open = false;
  private closed = false;
  private reconnects = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private frame: Buffer[] = [];
  private frameBytes = 0;
  private backlog: Buffer[] = [];
  private backlogBytes = 0;

  constructor(
    private readonly options: FluxOptions,
    private readonly handlers: SttHandlers,
    private readonly log: Logger,
  ) {}

  start(): Promise<void> {
    return this.connect();
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed) return;
    this.frame.push(chunk);
    this.frameBytes += chunk.length;
    if (this.frameBytes < CHUNK_BYTES) return;
    const data = Buffer.concat(this.frame, this.frameBytes);
    this.frame = [];
    this.frameBytes = 0;
    if (this.open && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return;
    }
    this.backlog.push(data);
    this.backlogBytes += data.length;
    while (this.backlogBytes > MAX_BUFFERED_BYTES && this.backlog.length > 1) {
      this.backlogBytes -= this.backlog.shift()!.length;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        // already closing
      }
      setTimeout(() => ws.terminate(), 1000).unref();
    } else {
      ws.terminate();
    }
  }

  /**
   * Opens the socket. Resolves once connected; rejects if this attempt fails
   * (transient failures keep retrying in the background, permanent ones are
   * reported through `handlers.onFatal`).
   */
  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('Deepgram Flux client is closed'));
        return;
      }
      const ws = new WebSocket(buildFluxUrl(this.options), {
        headers: { Authorization: `Token ${this.options.apiKey}` },
        handshakeTimeout: 10_000,
      });
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        this.open = true;
        this.reconnects = 0;
        for (const data of this.backlog) ws.send(data);
        this.backlog = [];
        this.backlogBytes = 0;
        this.log.debug('Deepgram Flux connected');
        resolve();
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary) this.onMessage(data.toString());
      });

      ws.on('error', (err) => {
        const hint = /\b(401|403)\b/.test(err.message) ? ' (check DEEPGRAM_API_KEY)' : '';
        if (opened) {
          this.log.warn(`Deepgram Flux error: ${err.message}${hint}`);
          return;
        }
        const error = new Error(`Deepgram Flux connection failed: ${err.message}${hint}`);
        reject(error);
        if (this.closed) return;
        // A rejected handshake (bad key or parameters) will not fix itself.
        if (/\b(400|401|403)\b/.test(err.message)) {
          this.closed = true;
          this.handlers.onFatal(error);
        } else {
          this.log.warn(error.message);
          this.scheduleReconnect();
        }
      });

      ws.on('close', (code, reason) => {
        if (this.ws === ws) this.ws = null;
        if (!opened) return; // handled by 'error'
        this.open = false;
        if (this.closed) return;
        this.log.warn(`Deepgram Flux closed unexpectedly (${code} ${reason.toString()}); reconnecting`);
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      this.closed = true;
      this.handlers.onFatal(new Error('Lost the connection to Deepgram Flux and could not reconnect.'));
      return;
    }
    const delay = 250 * 2 ** this.reconnects++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // the 'error' handler already scheduled the next attempt or reported a fatal error
      });
    }, delay);
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'TurnInfo': {
        const type = msg.event as TurnEventType;
        if (!TURN_EVENTS.has(type)) return;
        const event: TurnEvent = {
          type,
          turnIndex: Number(msg.turn_index ?? 0),
          transcript: String(msg.transcript ?? '').trim(),
          endOfTurnConfidence: Number(msg.end_of_turn_confidence ?? 0),
        };
        this.handlers.onTurn(event);
        return;
      }
      case 'Connected':
        return;
      case 'Warning':
        this.log.warn(`Deepgram Flux warning: ${String(msg.description ?? msg.code)}`);
        return;
      case 'Error':
        this.log.error(`Deepgram Flux error: ${String(msg.code)} ${String(msg.description ?? '')}`);
        return;
      default:
        this.log.debug(`Deepgram Flux message: ${String(msg.type)}`);
    }
  }
}
