import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from '../logger.js';

/** How the call session talks back to the phone line. */
export interface Transport {
  sendAudio(chunk: Buffer): void;
  sendMark(name: string): void;
  /** Drops audio that was sent but hasn't played yet (barge-in). */
  clearAudio(): void;
  /** Status events for the browser test client (ignored on real calls). */
  sendEvent(event: Record<string, unknown>): void;
  close(reason: string): void;
}

export interface StreamStart {
  streamSid: string;
  callSid: string;
  customParameters: Record<string, string>;
}

/** Largest audio payload per message: one second of 8 kHz μ-law. */
const MAX_PAYLOAD_BYTES = 8000;

/**
 * The Twilio Media Streams protocol over a WebSocket (bidirectional
 * `<Connect><Stream>`). The browser test client speaks the same protocol.
 *
 * Events: 'start' (StreamStart), 'media' (Buffer), 'mark' (name), 'dtmf' (digit), 'stop', 'close'.
 */
export class MediaStream extends EventEmitter implements Transport {
  private streamSid = '';
  private closed = false;
  private debugEvents = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly log: Logger,
  ) {
    super();
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.onMessage(data.toString());
    });
    ws.on('close', () => {
      this.closed = true;
      this.emit('close');
    });
    ws.on('error', (err) => this.log.warn(`Media stream socket error: ${err.message}`));
  }

  /** Enables the extra status events the browser test client displays. */
  enableDebugEvents(): void {
    this.debugEvents = true;
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg?.event) {
      case 'connected':
        return;
      case 'start': {
        const start = msg.start ?? {};
        this.streamSid = String(start.streamSid ?? msg.streamSid ?? '');
        const params: Record<string, string> = {};
        for (const [key, value] of Object.entries(start.customParameters ?? {})) params[key] = String(value);
        this.emit('start', { streamSid: this.streamSid, callSid: String(start.callSid ?? ''), customParameters: params } satisfies StreamStart);
        return;
      }
      case 'media': {
        const media = msg.media;
        if (!media?.payload || (media.track && media.track !== 'inbound')) return;
        this.emit('media', Buffer.from(String(media.payload), 'base64'));
        return;
      }
      case 'mark':
        if (msg.mark?.name) this.emit('mark', String(msg.mark.name));
        return;
      case 'dtmf':
        if (msg.dtmf?.digit !== undefined) this.emit('dtmf', String(msg.dtmf.digit));
        return;
      case 'stop':
        this.emit('stop');
        return;
      default:
        return;
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  sendAudio(chunk: Buffer): void {
    for (let offset = 0; offset < chunk.length; offset += MAX_PAYLOAD_BYTES) {
      const payload = chunk.subarray(offset, offset + MAX_PAYLOAD_BYTES).toString('base64');
      this.send({ event: 'media', streamSid: this.streamSid, media: { payload } });
    }
  }

  sendMark(name: string): void {
    this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
  }

  clearAudio(): void {
    this.send({ event: 'clear', streamSid: this.streamSid });
  }

  sendEvent(event: Record<string, unknown>): void {
    if (this.debugEvents) this.send({ event: 'debug', streamSid: this.streamSid, ...event });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // Close reasons are limited to 123 bytes.
      this.ws.close(1000, Buffer.from(reason).subarray(0, 120).toString());
    } catch {
      this.ws.terminate();
    }
  }
}
