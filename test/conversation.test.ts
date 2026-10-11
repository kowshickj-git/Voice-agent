import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from '../src/call/Conversation.js';
import { PlaybackTracker } from '../src/call/PlaybackTracker.js';
import type { SpeechSegment } from '../src/call/SpeechPipeline.js';
import { assistantContentForHistory } from '../src/llm/ClaudeBrain.js';
import { buildTools, validateToolInput } from '../src/llm/tools.js';
import type { ContentBlock } from '../src/llm/types.js';

test('conversation is append-only and skips empty messages', () => {
  const conversation = new Conversation();
  conversation.append({ role: 'user', content: 'Hi' });
  conversation.append({ role: 'assistant', content: '   ' });
  conversation.append({ role: 'assistant', content: [] });
  const snapshot = conversation.snapshot();
  conversation.append({ role: 'assistant', content: 'Hello!' });
  assert.equal(snapshot.length, 1);
  assert.equal(conversation.length, 2);
});

test('after a fallback, only text is kept from before the switch', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'sig-a' },
    { type: 'text', text: 'Partial answer ', citations: null },
    { type: 'tool_use', id: 'toolu_a', name: 'take_message', input: {} },
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal' } },
    { type: 'thinking', thinking: '', signature: 'sig-b' },
    { type: 'text', text: 'continued.', citations: null },
    { type: 'tool_use', id: 'toolu_b', name: 'end_call', input: { reason: 'done' } },
  ] as unknown as ContentBlock[];
  const { content: kept, toolUses } = assistantContentForHistory(content);
  assert.deepEqual(
    kept.map((b) => b.type),
    ['text', 'fallback', 'thinking', 'text', 'tool_use'],
  );
  assert.deepEqual(
    toolUses.map((t) => t.id),
    ['toolu_b'],
  );
});

test('without a fallback the content is kept verbatim', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'Hi', citations: null },
  ] as unknown as ContentBlock[];
  assert.equal(assistantContentForHistory(content).content, content);
});

test('tools are strict, sorted, and only offer transfers when configured', () => {
  const without = buildTools({ transferEnabled: false });
  assert.deepEqual(
    without.map((t) => t.name),
    ['end_call', 'take_message'],
  );
  const withTransfer = buildTools({ transferEnabled: true });
  assert.deepEqual(
    withTransfer.map((t) => t.name),
    ['end_call', 'take_message', 'transfer_call'],
  );
  for (const tool of withTransfer) {
    assert.equal(tool.strict, true);
    assert.equal((tool.input_schema as { additionalProperties?: boolean }).additionalProperties, false);
  }
});

test('tool inputs are validated before running', () => {
  const good = { caller_name: 'Ann Lee', callback_number: '+15550100', message: 'Call back', urgency: 'high' };
  assert.deepEqual(validateToolInput('take_message', good), good);
  // Essential fields are required...
  assert.equal(validateToolInput('take_message', { ...good, message: '' }), null);
  assert.equal(validateToolInput('take_message', { ...good, caller_name: undefined }), null);
  assert.equal(validateToolInput('take_message', 'not an object'), null);
  assert.equal(validateToolInput('unknown_tool', {}), null);
  // ...minor ones fall back to defaults, numbers become strings, and unknown fields are ignored.
  assert.deepEqual(validateToolInput('take_message', { ...good, urgency: 'whenever', extra: 'x' }), { ...good, urgency: 'normal' });
  assert.deepEqual(validateToolInput('take_message', { ...good, callback_number: 5550100 }), { ...good, callback_number: '5550100' });
  assert.deepEqual(validateToolInput('end_call', { reason: 'done' }), { reason: 'done' });
  assert.deepEqual(validateToolInput('end_call', {}), { reason: 'not given' });
});

test('playback tracker estimates what the caller heard', () => {
  let now = 1000;
  const tracker = new PlaybackTracker(() => now);
  const seg = (id: number, text: string, responseIndex = 0): SpeechSegment => ({ id, turnId: 1, responseIndex, text });
  const a = seg(1, 'Our hours are nine to five.');
  const b = seg(2, 'We are closed on Sundays and public holidays.');
  tracker.begin(a);
  tracker.wrote(a, 8000); // 1 s of audio
  tracker.marked(a, 'm1');
  tracker.begin(b);
  tracker.wrote(b, 16000); // 2 s of audio
  tracker.marked(b, 'm2');
  assert.equal(tracker.hasPending(1), true);

  now = 2000;
  assert.equal(tracker.ack('m1'), true);
  now = 3000; // halfway through the second segment
  const heard = tracker.heard(1).get(0)!;
  assert.equal(heard.playedSegments, 1);
  assert.equal(heard.heard, 'Our hours are nine to five. We are closed on');

  tracker.clearTurn(1);
  assert.equal(tracker.hasPending(1), false);
  assert.equal(tracker.ack('m2'), false, 'marks returned after a clear do not count as played');
});
