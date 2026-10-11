export interface SynthesisOptions {
  signal: AbortSignal;
  /** Text spoken just before this chunk — some providers use it for smoother prosody. */
  previousText?: string;
}

/** Converts text to raw 8 kHz μ-law audio, streamed in chunks as it is generated. */
export interface TextToSpeech {
  readonly name: string;
  synthesize(text: string, options: SynthesisOptions): AsyncGenerator<Buffer>;
  /**
   * Opens a connection to the service ahead of the first request of a reply.
   * A new TLS connection costs ~0.5 s on long routes, and idle connections are
   * closed after a few seconds, so this runs whenever the agent starts a reply.
   */
  warmUp?(): void;
}

/**
 * Fires cheap authenticated requests to `url` (at most every 2 s) so the next
 * real requests reuse warm connections. Two at a time, because a reply's first
 * two sentences are synthesized in parallel. They must succeed: servers close
 * the connection after rejecting a request (401), which would defeat the purpose.
 */
export function connectionWarmer(url: string, headers: Record<string, string>, connections = 2): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < 2000) return;
    last = now;
    for (let i = 0; i < connections; i++) {
      fetch(url, { headers, signal: AbortSignal.timeout(5000) })
        .then((res) => res.arrayBuffer())
        .catch(() => {
          // best effort
        });
    }
  };
}

export class TtsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TtsError';
  }
}

/** Reads a fetch() response body chunk by chunk. */
export async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (value && value.byteLength > 0) yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
  }
}

export async function errorText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
