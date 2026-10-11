import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { KnowledgeLibrary, referenceNote, tokenize } from '../src/llm/library.js';

const sample = `<!-- notes for editors -->
## PowerTitan storage
Keywords: bess, utility storage
- PowerTitan 3.0 stores 6.9 MWh in a 20-foot container.

## Panel cleaning
- Rinse panels with plain water every week or two.

## Net metering in Tamil Nadu
Keywords: net meter, tnpdcl
- TNPDCL fits a two-way meter.
`;

test('tokenizes words and codes, drops filler words, and singularizes', () => {
  assert.deepEqual(tokenize('What are the batteries in the SG5.0RS?'), ['battery', 'sg5.0rs']);
  assert.deepEqual(tokenize('Hello, can you tell me please'), []);
  // Spelled-out acronyms are joined; a leading article may have joined too.
  assert.ok(tokenize('what is a b e s s').includes('bess'));
  assert.ok(tokenize('tell me about A F C I').includes('afci'));
});

test('splits a library into sections with keywords', () => {
  const library = new KnowledgeLibrary(sample);
  assert.equal(library.size, 3);
  const [first] = library.search('Tell me about BESS');
  assert.equal(first.title, 'PowerTitan storage');
  assert.equal(first.text, '- PowerTitan 3.0 stores 6.9 MWh in a 20-foot container.');
  assert.match(referenceNote([first]), /^\[Reference notes for the caller's question, from the knowledge library\. Answer in one or two short sentences[^\n]*:\n## PowerTitan storage\n- PowerTitan/);
});

test('finds sections by title, keywords, words, and names split by speech recognition', () => {
  const library = new KnowledgeLibrary(sample);
  assert.equal(library.search('how do I clean my panels')[0]?.title, 'Panel cleaning');
  assert.equal(library.search('apply for a net meter with TNPDCL')[0]?.title, 'Net metering in Tamil Nadu');
  assert.equal(library.search('tell me about power titan')[0]?.title, 'PowerTitan storage');
  assert.deepEqual(library.search('yes please, thank you'), []);
});

test('skips excluded sections', () => {
  const library = new KnowledgeLibrary(sample);
  const [first] = library.search('BESS storage');
  assert.deepEqual(library.search('BESS storage', { exclude: new Set([first.id]) }), []);
});

test('the Sunbridger library answers typical caller questions', () => {
  const library = KnowledgeLibrary.load(path.join(process.cwd(), 'agents', 'sungrow', 'library.md'));
  assert.ok(library && library.size > 30);
  const expectations: [string, RegExp][] = [
    ['What is a BESS?', /battery energy storage system/],
    ['Tell me about power titan', /PowerTitan/],
    ['What is grid forming?', /Grid-forming/],
    ['How do I apply for net metering in Tamil Nadu?', /TNPDCL/],
    ['What is the Tamil Nadu state subsidy?', /Subsidies/],
    ['What is the latest Sungrow inverter?', /Latest Sungrow launches/],
    ['Which is better, lithium or lead acid battery?', /Battery chemistry/],
    ['Do they make inverters in India?', /Sungrow in India/],
  ];
  for (const [question, title] of expectations) {
    assert.match(library.search(question)[0]?.title ?? '(nothing)', title, question);
  }
  for (const smallTalk of ['Hello, how are you?', 'Yes please', 'My name is Kumar and my number is 98400 12345']) {
    assert.deepEqual(library.search(smallTalk), [], smallTalk);
  }
});
