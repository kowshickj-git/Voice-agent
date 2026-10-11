const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp',
  'approx', 'appt', 'dept', 'est', 'no', 'vol', 'fig', 'ave', 'blvd', 'rd', 'apt', 'ste', 'min', 'hr', 'hrs',
]);

/** Sentence-ending punctuation that is usually followed by a space. */
const TERMINALS = new Set(['.', '!', '?', '…', '।']);
/** Full-width sentence-ending punctuation (CJK) — no space follows it. */
const WIDE_TERMINALS = new Set(['。', '！', '？']);
const TRAILING = /["'”’)\]»]/;

export interface ChunkerOptions {
  /** The first chunk may end at a comma once it has at least this many characters (speeds up the first audio). */
  firstChunkMinChars?: number;
  /** Chunks never grow beyond this; longer text is split at a comma or space. */
  maxChunkChars?: number;
}

/**
 * Splits streamed LLM text into speakable chunks — usually whole sentences —
 * so speech synthesis can start before the full reply has been generated.
 */
export class SentenceChunker {
  private buffer = '';
  private emitted = 0;
  private readonly firstChunkMinChars: number;
  private readonly maxChunkChars: number;

  constructor(options: ChunkerOptions = {}) {
    this.firstChunkMinChars = options.firstChunkMinChars ?? 3;
    this.maxChunkChars = options.maxChunkChars ?? 240;
  }

  /** Adds streamed text; returns any chunks that are now complete. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      this.take(cut, out);
    }
    return out;
  }

  /** Returns whatever text is left once the stream has finished. */
  flush(): string[] {
    const out: string[] = [];
    this.take(this.buffer.length, out);
    return out;
  }

  private take(cut: number, out: string[]): void {
    const chunk = this.buffer.slice(0, cut).trim();
    this.buffer = this.buffer.slice(cut);
    if (chunk) {
      out.push(chunk);
      this.emitted++;
    }
  }

  private findCut(): number {
    const b = this.buffer;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i];
      if (ch === '\n') {
        if (b.slice(0, i).trim()) return i + 1;
        continue;
      }
      if (WIDE_TERMINALS.has(ch)) {
        let j = i + 1;
        while (j < b.length && TRAILING.test(b[j])) j++;
        if (j < b.length) return j;
        continue;
      }
      if (!TERMINALS.has(ch)) continue;
      let j = i + 1;
      while (j < b.length && (TERMINALS.has(b[j]) || TRAILING.test(b[j]))) j++;
      // Only a boundary once we can see the following whitespace (so "3.5" or "e.g." stay intact).
      if (j < b.length && /\s/.test(b[j])) {
        if (ch === '.' && this.isAbbreviation(i)) {
          i = j - 1;
          continue;
        }
        return j;
      }
      i = j - 1;
    }

    if (this.emitted === 0 && b.length > this.firstChunkMinChars) {
      for (let i = this.firstChunkMinChars - 1; i < b.length - 1; i++) {
        if (/[,;:]/.test(b[i]) && /\s/.test(b[i + 1])) return i + 1;
        if (b[i] === '—' || b[i] === '–') return i + 1;
      }
    }

    if (b.length > this.maxChunkChars) {
      const window = b.slice(0, this.maxChunkChars);
      const clause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
      if (clause > this.maxChunkChars / 3) return clause + 1;
      const space = window.lastIndexOf(' ');
      return space > 0 ? space + 1 : this.maxChunkChars;
    }
    return -1;
  }

  /** Splits finished text into whole sentences. */
  static sentences(text: string): string[] {
    const chunker = new SentenceChunker({ firstChunkMinChars: Number.MAX_SAFE_INTEGER });
    return [...chunker.push(text), ...chunker.flush()];
  }

  /** Whether the "." at `dot` ends an abbreviation or initial rather than a sentence. */
  private isAbbreviation(dot: number): boolean {
    const b = this.buffer;
    let k = dot - 1;
    while (k >= 0 && /[\p{L}.]/u.test(b[k])) k--;
    const word = b.slice(k + 1, dot).toLowerCase();
    if (!word) return false;
    if (word.length === 1) return true;
    if (word.includes('.')) return true;
    return ABBREVIATIONS.has(word);
  }
}
