import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SentenceChunker } from '../src/text/SentenceChunker.js';

/** Feeds text in small pieces, like a token stream. */
function stream(text: string, size = 3, options?: ConstructorParameters<typeof SentenceChunker>[0]): string[] {
  const chunker = new SentenceChunker(options);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...chunker.push(text.slice(i, i + size)));
  out.push(...chunker.flush());
  return out;
}

test('splits on sentence boundaries', () => {
  assert.deepEqual(stream('Sure. We open at nine! Anything else?'), ['Sure.', 'We open at nine!', 'Anything else?']);
});

test('emits a sentence as soon as the following space arrives', () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push('Hello there.'), []);
  assert.deepEqual(chunker.push(' How'), ['Hello there.']);
  assert.deepEqual(chunker.flush(), ['How']);
});

test('keeps decimals, times, and abbreviations together', () => {
  assert.deepEqual(stream('It costs $3.50 per visit. Dr. Patel sees patients at 9 a.m. on Mondays. Thanks!'), [
    'It costs $3.50 per visit.',
    'Dr. Patel sees patients at 9 a.m. on Mondays.',
    'Thanks!',
  ]);
});

test('keeps closing quotes and repeated punctuation with the sentence', () => {
  assert.deepEqual(stream('He said "no way!" Then left... Really?!'), ['He said "no way!"', 'Then left...', 'Really?!']);
});

test('splits a long first sentence at a comma to start speaking sooner', () => {
  const text = 'Our clinic is open Monday through Friday from eight to six, and on Saturday mornings too.';
  assert.deepEqual(stream(text), ['Our clinic is open Monday through Friday from eight to six,', 'and on Saturday mornings too.']);
});

test('starts speaking at the first comma of a reply', () => {
  assert.deepEqual(stream('Sure, I can help with that.'), ['Sure,', 'I can help with that.']);
  assert.deepEqual(stream('It is $1,500, paid upfront.'), ['It is $1,500,', 'paid upfront.']);
});

test('later sentences are not split at commas', () => {
  const text = 'Yes. We take Delta Dental, Cigna, Aetna, and MetLife, plus most other PPO plans.';
  assert.deepEqual(stream(text), ['Yes.', 'We take Delta Dental, Cigna, Aetna, and MetLife, plus most other PPO plans.']);
});

test('caps very long chunks', () => {
  const text = `${'word '.repeat(80)}end.`;
  const chunks = stream(text, 7, { maxChunkChars: 100 });
  assert.ok(chunks.length > 2, "chunks.length > 2");
  for (const chunk of chunks) assert.ok(chunk.length <= 100, chunk);
  assert.equal(chunks.join(' '), text.replace(/\s+/g, ' ').trim());
});

test('treats line breaks as boundaries', () => {
  assert.deepEqual(stream('First line\nSecond line'), ['First line', 'Second line']);
});

test('handles CJK and Devanagari punctuation', () => {
  assert.deepEqual(stream('こんにちは。元気ですか？'), ['こんにちは。', '元気ですか？']);
  assert.deepEqual(stream('नमस्ते। आप कैसे हैं?'), ['नमस्ते।', 'आप कैसे हैं?']);
});

test('sentences() splits finished text', () => {
  assert.deepEqual(SentenceChunker.sentences('Hi, thanks for calling Sunrise Dental Clinic. This is Ava. How can I help you today?'), [
    'Hi, thanks for calling Sunrise Dental Clinic.',
    'This is Ava.',
    'How can I help you today?',
  ]);
});
