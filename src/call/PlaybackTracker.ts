import { bytesToMs } from '../audio.js';
import type { SpeechSegment } from './SpeechPipeline.js';

interface Tracked {
  segment: SpeechSegment;
  firstSentAt: number;
  bytes: number;
  mark?: string;
  played: boolean;
  cleared: boolean;
}

export interface HeardResponse {
  /** Text the caller actually heard from this response. */
  heard: string;
  /** How many of the response's segments were played to the end. */
  playedSegments: number;
}

/**
 * Follows what the caller has actually heard. Audio is sent to Twilio faster
 * than real time and buffered there; after each segment we send a "mark",
 * which Twilio echoes back once playback reaches it.
 */
export class PlaybackTracker {
  private items: Tracked[] = [];
  private readonly byMark = new Map<string, Tracked>();
  private lastAckAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  begin(segment: SpeechSegment): void {
    this.items.push({ segment, firstSentAt: this.now(), bytes: 0, played: false, cleared: false });
  }

  wrote(segment: SpeechSegment, bytes: number): void {
    const item = this.find(segment);
    if (item) item.bytes += bytes;
  }

  marked(segment: SpeechSegment, mark: string): void {
    const item = this.find(segment);
    if (!item) return;
    item.mark = mark;
    this.byMark.set(mark, item);
  }

  /** Twilio reached a mark. Returns false for unknown or cleared marks. */
  ack(mark: string): boolean {
    const item = this.byMark.get(mark);
    this.byMark.delete(mark);
    if (!item || item.cleared) return false;
    item.played = true;
    this.lastAckAt = this.now();
    return true;
  }

  /** Whether any audio of this turn is sent but not yet played. */
  hasPending(turnId: number): boolean {
    return this.items.some((t) => t.segment.turnId === turnId && !t.played && !t.cleared);
  }

  hasAudio(turnId: number): boolean {
    return this.items.some((t) => t.segment.turnId === turnId);
  }

  /**
   * What the caller heard of each response in a turn (keyed by response
   * index), estimating how far into the segment that was playing they got.
   * Responses with no audio sent yet are absent.
   */
  heard(turnId: number): Map<number, HeardResponse> {
    const result = new Map<number, HeardResponse>();
    const now = this.now();
    let playing = true;
    for (const t of this.items) {
      if (t.segment.turnId !== turnId) continue;
      const entry = result.get(t.segment.responseIndex) ?? { heard: '', playedSegments: 0 };
      result.set(t.segment.responseIndex, entry);
      if (playing && t.played) {
        entry.heard = join(entry.heard, t.segment.text);
        entry.playedSegments++;
        continue;
      }
      if (!playing) continue;
      playing = false;
      // This segment was playing when the caller interrupted: estimate how much of it they heard.
      // It started when the previous mark came back, or when its audio was sent if that was later.
      const start = Math.max(this.lastAckAt, t.firstSentAt);
      const duration = bytesToMs(t.bytes);
      if (duration <= 0) continue;
      const fraction = Math.min(1, Math.max(0, (now - start) / duration));
      const words = t.segment.text.split(/\s+/).filter(Boolean);
      const count = Math.floor(fraction * words.length);
      if (count > 0) entry.heard = join(entry.heard, words.slice(0, count).join(' '));
    }
    return result;
  }

  /** Forget unplayed audio of a turn (after telling Twilio to clear its buffer). */
  clearTurn(turnId: number): void {
    for (const t of this.items) {
      if (t.segment.turnId === turnId && !t.played) t.cleared = true;
    }
  }

  /** Drop bookkeeping for turns older than `keepFromTurnId`. */
  prune(keepFromTurnId: number): void {
    this.items = this.items.filter((t) => t.segment.turnId >= keepFromTurnId);
    for (const [mark, t] of this.byMark) {
      if (t.segment.turnId < keepFromTurnId) this.byMark.delete(mark);
    }
  }

  private find(segment: SpeechSegment): Tracked | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].segment.id === segment.id) return this.items[i];
    }
    return undefined;
  }
}

function join(a: string, b: string): string {
  return a ? `${a} ${b}` : b;
}
