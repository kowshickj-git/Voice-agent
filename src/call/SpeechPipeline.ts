import type { Logger } from '../logger.js';
import type { AudioCache } from '../tts/index.js';
import type { TextToSpeech } from '../tts/types.js';

export interface SpeechSegment {
  id: number;
  turnId: number;
  /** Which LLM response in the turn produced this text (-1 for fixed phrases such as the greeting). */
  responseIndex: number;
  text: string;
  /** Set for fixed phrases whose audio can be cached and replayed instantly. */
  cacheKey?: string;
}

/** Where synthesized audio goes (the phone call). */
export interface AudioOutput {
  /** Called right before the first audio of a segment is written. */
  beginSegment(segment: SpeechSegment): void;
  writeAudio(segment: SpeechSegment, chunk: Buffer): void;
  /** Called after a segment's last audio — only for segments that produced audio. */
  endSegment(segment: SpeechSegment): void;
}

export interface SpeechPipelineOptions {
  /** Audio is held back until this resolves (used for speculative replies). */
  gate?: Promise<void>;
  /** How many segments may be synthesized ahead of the one playing. */
  prefetch?: number;
  cache?: AudioCache;
  log: Logger;
}

/** An async queue of audio chunks for one segment. */
class ChunkQueue {
  private readonly chunks: Buffer[] = [];
  private finished = false;
  private waiter: (() => void) | null = null;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.wake();
  }

  end(): void {
    this.finished = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (;;) {
      const next = this.chunks.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }
}

interface Item {
  segment: SpeechSegment;
  queue: ChunkQueue | null;
}

/**
 * Turns a stream of text segments into ordered audio. Segments are synthesized
 * in parallel (up to `prefetch` ahead) but always played in order, and the
 * first segment's audio is forwarded while it is still being generated.
 */
export class SpeechPipeline {
  readonly done: Promise<void>;
  private readonly items: Item[] = [];
  private readonly abort = new AbortController();
  private readonly prefetch: number;
  private outputIndex = 0;
  private ended = false;
  private cancelled = false;
  private wakeOutput: (() => void) | null = null;
  private signalCancel!: () => void;
  private readonly cancelledPromise = new Promise<void>((resolve) => (this.signalCancel = resolve));

  constructor(
    private readonly tts: TextToSpeech,
    private readonly output: AudioOutput,
    private readonly options: SpeechPipelineOptions,
  ) {
    this.prefetch = Math.max(1, options.prefetch ?? 2);
    this.done = this.run().catch((err: unknown) => {
      options.log.error('Speech output failed', err);
    });
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  push(segment: SpeechSegment): void {
    if (this.ended || this.cancelled) return;
    this.items.push({ segment, queue: null });
    this.startSynthesis();
    this.notify();
  }

  /** No more segments will be pushed. */
  end(): void {
    this.ended = true;
    this.notify();
  }

  /** Stops synthesis and output immediately. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.abort.abort();
    for (const item of this.items) item.queue?.end();
    this.signalCancel();
    this.notify();
  }

  private notify(): void {
    const wake = this.wakeOutput;
    this.wakeOutput = null;
    wake?.();
  }

  private startSynthesis(): void {
    const limit = Math.min(this.items.length, this.outputIndex + this.prefetch);
    for (let i = this.outputIndex; i < limit; i++) {
      const item = this.items[i];
      if (item.queue) continue;
      item.queue = new ChunkQueue();
      void this.synthesize(item, i);
    }
  }

  private async synthesize(item: Item, index: number): Promise<void> {
    const queue = item.queue!;
    const { cache, log } = this.options;
    const key = item.segment.cacheKey;
    const cached = key ? cache?.get(key) : undefined;
    if (cached) {
      queue.push(cached);
      queue.end();
      return;
    }
    const collected: Buffer[] = [];
    const started = Date.now();
    let first = true;
    try {
      const previousText = index > 0 ? this.items[index - 1].segment.text : undefined;
      for await (const chunk of this.tts.synthesize(item.segment.text, { signal: this.abort.signal, previousText })) {
        if (this.cancelled) return;
        if (first) {
          first = false;
          log.debug(`Voice: first audio ${Date.now() - started} ms for "${item.segment.text.slice(0, 40)}"`);
        }
        queue.push(chunk);
        if (key) collected.push(chunk);
      }
      if (key && cache && !this.cancelled) cache.set(key, Buffer.concat(collected));
    } catch (err) {
      if (!this.cancelled) log.error(`Text-to-speech failed for "${item.segment.text.slice(0, 60)}"`, err);
    } finally {
      queue.end();
    }
  }

  private async run(): Promise<void> {
    if (this.options.gate) {
      await Promise.race([this.options.gate, this.cancelledPromise]);
    }
    for (;;) {
      if (this.cancelled) return;
      if (this.outputIndex >= this.items.length) {
        if (this.ended) return;
        await new Promise<void>((resolve) => (this.wakeOutput = resolve));
        continue;
      }
      const item = this.items[this.outputIndex];
      if (!item.queue) this.startSynthesis();
      let begun = false;
      for await (const chunk of item.queue!) {
        if (this.cancelled) return;
        if (!begun) {
          begun = true;
          this.output.beginSegment(item.segment);
        }
        this.output.writeAudio(item.segment, chunk);
      }
      if (this.cancelled) return;
      if (begun) this.output.endSegment(item.segment);
      this.outputIndex++;
      this.startSynthesis();
    }
  }
}
