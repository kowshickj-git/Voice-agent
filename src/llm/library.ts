import { readAgentFile } from './prompt.js';

/** One "## Title" section of an agent's knowledge library. */
export interface LibrarySection {
  id: number;
  title: string;
  /** The section's facts, without its "Keywords:" line. */
  text: string;
}

interface IndexedSection extends LibrarySection {
  termCounts: Map<string, number>;
  length: number;
}

// Words that say nothing about the topic of a question.
const STOPWORDS = new Set(
  (
    'a an the is are was were be been being am do does did done i me my mine we us our you your yours it its this that these those ' +
    'what which who whom whose how why when where can could would should will shall may might must to of in on at for from with ' +
    'about as by and or but if so than then there here tell please know want like need get got have has had any some all more much ' +
    'many also just okay ok yes no not hi hello hey thanks thank sir madam into up out over im dont kindly explain give detail ' +
    'details information info say said talk let us help am going go use using one two they them their name number call calling ' +
    'best better good great idea fine nice really very'
  ).split(' '),
);

/**
 * Lowercase words and codes ("sg5.0rs"), without stopwords, with plurals reduced
 * ("batteries" → "battery") and spelled-out acronyms joined ("b e s s" → "bess").
 */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*/gu) ?? [];
  const words: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let j = i;
    while (j < raw.length && /^\p{L}$/u.test(raw[j])) j++;
    if (j - i >= 2) {
      const letters = raw.slice(i, j).join('');
      words.push(letters);
      // "what is a b e s s": the article may have joined the acronym.
      if (/^[ai]../.test(letters)) words.push(letters.slice(1));
      i = j - 1;
    } else words.push(raw[i]);
  }
  const tokens: string[] = [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    const plain = /^\p{L}+$/u.test(word); // codes like "sg5.0rs" are left as they are
    if (plain && word.length > 4 && word.endsWith('ies')) tokens.push(`${word.slice(0, -3)}y`);
    else if (plain && word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) tokens.push(word.slice(0, -1));
    else tokens.push(word);
  }
  return tokens;
}

const K1 = 1.2;
const B = 0.75;
/**
 * A section must score at least this share of one solid match on a word that
 * appears in no other section, so small talk ("yes, please") looks up nothing.
 */
const MIN_MATCH = 0.9;
/** Further sections must score at least this share of the best one. */
const RELATIVE_SCORE = 0.85;

/**
 * Knowledge an agent looks up per question, so it can know far more than fits
 * in its prompt (or than a small model can keep track of). The library is a
 * Markdown file of "## Title" sections. A "Keywords: ..." line in a section adds
 * search terms, such as synonyms and words speech recognition hears instead.
 */
export class KnowledgeLibrary {
  private readonly sections: IndexedSection[] = [];
  private readonly docFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(markdown: string) {
    const blocks = markdown.split(/^##[ \t]+/m).slice(1);
    for (const block of blocks) {
      const newline = block.indexOf('\n');
      const title = (newline < 0 ? block : block.slice(0, newline)).trim();
      let body = newline < 0 ? '' : block.slice(newline + 1);
      let keywords = '';
      body = body.replace(/^[ \t]*Keywords:[ \t]*(.*)$/im, (_line, terms: string) => {
        keywords = terms;
        return '';
      });
      const text = body.trim();
      if (!title || !text) continue;
      // The title and keywords say what a section is about, so they count extra.
      const tokens = [...tokenize(text), ...repeat(tokenize(title), 3), ...repeat(tokenize(keywords), 2)];
      const termCounts = new Map<string, number>();
      for (const token of tokens) termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
      for (const term of termCounts.keys()) this.docFrequency.set(term, (this.docFrequency.get(term) ?? 0) + 1);
      this.sections.push({ id: this.sections.length, title, text, termCounts, length: tokens.length });
    }
    this.averageLength = this.sections.reduce((sum, s) => sum + s.length, 0) / Math.max(1, this.sections.length);
  }

  /** Reads a library file. Undefined when the file is missing or has no sections. */
  static load(file: string): KnowledgeLibrary | undefined {
    const text = readAgentFile(file);
    if (!text) return undefined;
    const library = new KnowledgeLibrary(text);
    return library.size > 0 ? library : undefined;
  }

  get size(): number {
    return this.sections.length;
  }

  /** The sections that best match `query`, best first; empty when nothing matches well. */
  search(query: string, { limit = 2, exclude }: { limit?: number; exclude?: ReadonlySet<number> } = {}): LibrarySection[] {
    const ranked = this.rank(query).filter(({ section }) => !exclude?.has(section.id));
    const best = ranked[0]?.score ?? 0;
    const minScore = MIN_MATCH * this.idf(1);
    return ranked
      .filter((r) => r.score >= minScore && r.score >= best * RELATIVE_SCORE)
      .slice(0, limit)
      .map((r) => r.section);
  }

  /** Every section that shares a term with `query`, with its BM25 score, best first. */
  rank(query: string): { section: LibrarySection; score: number }[] {
    const terms = new Set(tokenize(query));
    // Speech recognition splits names ("power titan"); also try neighbouring words joined.
    const words = [...terms];
    for (let i = 0; i + 1 < words.length; i++) {
      for (const joined of [words[i] + words[i + 1], words[i] + words[i + 1] + (words[i + 2] ?? '')]) {
        if (this.docFrequency.has(joined)) terms.add(joined);
      }
    }
    const ranked: { section: LibrarySection; score: number }[] = [];
    for (const section of this.sections) {
      let score = 0;
      for (const term of terms) {
        const count = section.termCounts.get(term);
        if (!count) continue;
        const idf = this.idf(this.docFrequency.get(term) ?? 0);
        score += (idf * count * (K1 + 1)) / (count + K1 * (1 - B + (B * section.length) / this.averageLength));
      }
      const { id, title, text } = section;
      if (score > 0) ranked.push({ section: { id, title, text }, score });
    }
    return ranked.sort((a, b) => b.score - a.score);
  }

  /** How telling a word is that appears in `docFrequency` sections (BM25 inverse document frequency). */
  private idf(docFrequency: number): number {
    return Math.log(1 + (this.sections.length - docFrequency + 0.5) / (docFrequency + 0.5));
  }
}

function repeat<T>(items: T[], times: number): T[] {
  return Array.from({ length: times }, () => items).flat();
}

/** How looked-up sections are shown to the model, ahead of the caller's words. */
export function referenceNote(sections: LibrarySection[]): string {
  const body = sections.map((s) => `## ${s.title}\n${s.text}`).join('\n\n');
  return `[Reference notes for the caller's question, from the knowledge library. Answer in one or two short sentences with only what they asked, and offer more detail:\n${body}]`;
}
