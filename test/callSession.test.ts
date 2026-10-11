import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PHRASES } from '../src/call/CallSession.js';
import { KnowledgeLibrary } from '../src/llm/library.js';
import type { MessageParam, ToolResultBlockParam } from '../src/llm/types.js';
import { createHarness, eventually, sleep, testConfig, textOf, until, type Harness } from './fakes.js';

const agentLines = (h: Harness) => h.transport.events.filter((e) => e.type === 'agent').map((e) => String(e.text));
/** Everything the agent has said so far (replies are spoken in pieces, e.g. "Sure," then the rest). */
const spoken = (h: Harness) => agentLines(h).join(' ');

async function greetingDone(h: Harness): Promise<void> {
  // "Hi, this is Ava." + "How can I help?" → two segments, two marks, acknowledged after 10 ms.
  await eventually(() => assert.equal(h.transport.marks.length, 2));
  await sleep(40);
}

function callerSays(h: Harness, text: string, turnIndex: number): void {
  h.stt.emit('StartOfTurn', text.split(' ')[0], turnIndex);
  h.stt.emit('Update', text, turnIndex);
  h.stt.emit('EndOfTurn', text, turnIndex);
}

test('greets the caller and answers with the full conversation as context', async () => {
  const h = createHarness([{ text: 'We are open nine to five on weekdays. Anything else?' }]);
  h.session.start();
  await greetingDone(h);
  assert.equal(h.brain.prewarmed, true);
  assert.deepEqual(agentLines(h), ['Hi, this is Ava.', 'How can I help?']);

  callerSays(h, 'What are your hours?', 0);
  await eventually(() => assert.equal(h.brain.requests.length, 1));
  const request = h.brain.requests[0];
  assert.equal(request.length, 3);
  assert.match(textOf(request[0]), /^\[Phone call connected\. Caller ID: \+15550100\. Local time: .+ \(UTC\)\.\]$/);
  assert.equal(request[1].role, 'assistant');
  assert.equal(textOf(request[1]), 'Hi, this is Ava. How can I help?');
  assert.equal(textOf(request[2]), 'What are your hours?');

  await until(() => agentLines(h).includes('Anything else?'), "agentLines(h).includes('Anything else?')");
  assert.ok(h.tts.requests.includes('We are open nine to five on weekdays.'), "h.tts.requests.includes('We are open nine to five on weekdays.')");
  assert.equal(h.transport.clears, 0);
  h.session.end({ type: 'hangup' }, 'test over');
  assert.equal(h.transport.closedWith, 'hangup:test over');
  assert.equal(h.stt.closed, true);
});

test('a local model is kept warm between replies, on the conversation so far', async () => {
  const h = createHarness([]);
  const pings: MessageParam[][] = [];
  h.brain.keepWarm = (messages) => pings.push([...messages]);
  h.session.start();
  await until(() => pings.length >= 1, 'keep-warm request', 4000);
  // The context note and the greeting: exactly what the first reply's prompt starts with.
  assert.deepEqual(
    pings[0].map((m) => m.role),
    ['user', 'assistant'],
  );
  h.session.end({ type: 'hangup' }, 'test over');
  const count = pings.length;
  await sleep(1700);
  assert.equal(pings.length, count, 'no keep-warm requests after the call');
});

test('the voice service connection is kept warm for the whole call', async () => {
  const h = createHarness([{ text: 'Sure.' }]);
  let warmed = 0;
  h.tts.warmUp = () => warmed++;
  h.session.start();
  assert.equal(warmed, 1, 'warmed as soon as the call starts');
  h.session.end({ type: 'hangup' }, 'test over');
  await sleep(3200);
  assert.equal(warmed, 1, 'no more warm-ups after the call ends');
});

test('a speculative reply is prepared early but only plays after EndOfTurn', async () => {
  const h = createHarness([{ text: 'Yes, we take most PPO plans.' }]);
  h.session.start();
  await greetingDone(h);
  const greetingBytes = h.transport.audioBytes;

  h.stt.emit('StartOfTurn', 'Do you', 0);
  h.stt.emit('EagerEndOfTurn', 'Do you take insurance?', 0);
  await until(() => h.tts.requests.join(' ') === 'Hi, this is Ava. How can I help? Yes, we take most PPO plans.', 'reply synthesized');
  await sleep(30);
  assert.equal(h.transport.audioBytes, greetingBytes, 'nothing plays before the caller is done');

  h.stt.emit('EndOfTurn', 'Do you take insurance?', 0);
  await until(() => h.transport.audioBytes > greetingBytes, "h.transport.audioBytes > greetingBytes");
  assert.equal(h.brain.requests.length, 1, 'the speculative request was reused');
  assert.deepEqual(h.transport.events.filter((e) => e.type === 'latency').length, 1);
  h.session.end({ type: 'hangup' }, 'test over');
});

test('TurnResumed discards the speculative reply', async () => {
  const h = createHarness([{ text: 'Sure, what do you need?' }, { text: 'Happy to help you reschedule.' }]);
  h.session.start();
  await greetingDone(h);

  h.stt.emit('StartOfTurn', 'I need', 0);
  h.stt.emit('EagerEndOfTurn', 'I need to', 0);
  await eventually(() => assert.equal(h.brain.requests.length, 1));
  h.stt.emit('TurnResumed', 'I need to', 0);
  await eventually(() => assert.equal(h.brain.aborted, 1));
  h.stt.emit('Update', 'I need to reschedule', 0);
  h.stt.emit('EagerEndOfTurn', 'I need to reschedule.', 0);
  h.stt.emit('EndOfTurn', 'I need to reschedule.', 0);

  await until(() => agentLines(h).includes('Happy to help you reschedule.'), "agentLines(h).includes('Happy to help you reschedule.')");
  assert.ok(!agentLines(h).includes('Sure, what do you need?'), 'the discarded reply never played');
  const second = h.brain.requests[1];
  assert.equal(second.length, 3, 'the discarded turn never entered the history');
  assert.equal(textOf(second[2]), 'I need to reschedule.');
  h.session.end({ type: 'hangup' }, 'test over');
});

test('barge-in stops playback and tells the model what the caller heard', async () => {
  const h = createHarness([
    { text: 'We offer cleanings, fillings, crowns, root canals, whitening, and braces. We also see emergencies every weekday.' },
    { text: 'Yes, we do implants too.' },
  ]);
  h.session.start();
  await greetingDone(h);
  h.transport.ackAfterMs = null; // the reply keeps "playing"

  callerSays(h, 'What services do you offer?', 0);
  await until(() => agentLines(h).some((line) => line.startsWith('We offer cleanings')), "agentLines(h).some((line) => line.startsWith('We offer cleanings'))");
  await sleep(30);
  h.stt.emit('StartOfTurn', 'Wait', 1);
  assert.equal(h.transport.clears, 1, 'queued audio is cleared immediately');
  assert.ok(h.transport.events.some((e) => e.type === 'interrupted'), "h.transport.events.some((e) => e.type === 'interrupted')");

  h.transport.ackAfterMs = 10;
  h.stt.emit('EndOfTurn', 'Wait, do you do implants?', 1);
  await eventually(() => assert.equal(h.brain.requests.length, 2));
  const last = textOf(h.brain.requests[1].at(-1));
  assert.match(last, /^\[The caller interrupted you/);
  assert.match(last, /\nWait, do you do implants\?$/);
  h.session.end({ type: 'hangup' }, 'test over');
});

test('acknowledgements like "mm-hmm" do not interrupt the agent', async () => {
  const h = createHarness([{ text: 'We have two dentists. Doctor Patel does general care and Doctor Okafor does braces.' }]);
  h.session.start();
  await greetingDone(h);
  h.transport.ackAfterMs = null;
  callerSays(h, 'Who are your dentists?', 0);
  await until(() => agentLines(h).includes('We have two dentists.'), "agentLines(h).includes('We have two dentists.')");

  h.stt.emit('StartOfTurn', 'Mm-hmm', 1);
  h.stt.emit('EagerEndOfTurn', 'Mm-hmm.', 1);
  h.stt.emit('EndOfTurn', 'Mm-hmm.', 1);
  await sleep(30);
  assert.equal(h.transport.clears, 0);
  assert.equal(h.brain.requests.length, 1);
  h.session.end({ type: 'hangup' }, 'test over');
});

test('end_call hangs up after the goodbye has played', async () => {
  const h = createHarness([{ text: 'Thanks for calling. Goodbye!', tools: [{ name: 'end_call', input: { reason: 'caller is done' } }] }]);
  h.session.start();
  await greetingDone(h);
  callerSays(h, "That's all, bye.", 0);

  await eventually(() => assert.equal(h.transport.closedWith, 'hangup:caller is done'));
  assert.deepEqual(h.ended, [{ type: 'hangup' }]);
  assert.ok(agentLines(h).includes('Goodbye!'), "agentLines(h).includes('Goodbye!')");
  const messages = h.session.messages;
  const result = messages.at(-1)!;
  assert.equal(result.role, 'user');
  assert.equal((result.content as ToolResultBlockParam[])[0].type, 'tool_result');
});

test('a hang-up without any spoken goodbye still says goodbye first', async () => {
  const h = createHarness([{ tools: [{ name: 'end_call', input: { reason: 'done' } }] }]);
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Bye.', 0);
  await eventually(() => assert.equal(h.transport.closedWith, 'hangup:done'));
  assert.ok(agentLines(h).includes(PHRASES.goodbye), 'the default goodbye was spoken');
});

test('a reply that keeps repeating itself is cut off', async () => {
  const loop = 'We open at nine. '.repeat(6);
  const h = createHarness([{ text: `Sure. ${loop}`, hang: true }]);
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'When do you open?', 0);
  await until(() => textOf(h.session.messages.at(-1)) === 'Sure. We open at nine. We open at nine.', 'looping reply stopped and recorded');
  await sleep(50);
  const said = agentLines(h).filter((line) => line === 'We open at nine.').length;
  assert.equal(said, 2, 'the repeated sentence is spoken at most twice');
  assert.equal(textOf(h.session.messages.at(-1)), 'Sure. We open at nine. We open at nine.');
  h.session.end({ type: 'hangup' }, 'test over');
});

const catalog = new Set(['SG5.0RS', 'SG10RT-P2', 'SBR096', 'IP65']);

test('a reply that names a product the knowledge base lacks is replaced', async () => {
  const h = createHarness([{ text: 'Yes, we have it. The SH8.0RS is an 8 kW hybrid with 97.7% efficiency. It also', hang: true }], {
    deps: { knownProductCodes: catalog },
  });
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Do you have the SH8.0RS?', 0);
  const expected = `Yes, we have it. ${PHRASES.unknownProduct}`;
  await until(() => textOf(h.session.messages.at(-1)) === expected, 'made-up product reply replaced');
  assert.equal(spoken(h).includes('97.7'), false);
  h.session.end({ type: 'hangup' }, 'test over');
});

test('the product check also covers the last sentence of a finished reply', async () => {
  const h = createHarness([{ text: 'Sure. The SG7.5RS is 7.5 kW' }], { deps: { knownProductCodes: catalog } });
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Tell me about the SG7.5RS', 0);
  await until(() => textOf(h.session.messages.at(-1)) === `Sure. ${PHRASES.unknownProduct}`, 'last sentence replaced');
  h.session.end({ type: 'hangup' }, 'test over');
});

test('listed products, short forms of them, and ordinary codes pass the product check', async () => {
  const reply = 'The SG5.0RS is IP65, and the SG10RT is in the RT-P2 range.';
  const h = createHarness([{ text: reply }], { deps: { knownProductCodes: catalog } });
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Which inverters do you have?', 0);
  await until(() => textOf(h.session.messages.at(-1)) === reply, 'reply kept');
  assert.equal(spoken(h).includes(PHRASES.unknownProduct), false);
  h.session.end({ type: 'hangup' }, 'test over');
});

const library = new KnowledgeLibrary('## PowerTitan storage\nKeywords: bess\n- PowerTitan 3.0 stores 6.9 MWh.\n\n## Panel cleaning\n- Rinse panels with water.\n');

test('library sections reach the model with the caller’s words, once per call', async () => {
  const h = createHarness([{ text: 'It stores 6.9 MWh.' }, { text: 'It is a big battery.' }], { deps: { library } });
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'What is the BESS called PowerTitan?', 0);
  await until(() => h.brain.requests.length === 1, 'first reply');
  const first = textOf(h.brain.requests[0].at(-1));
  assert.match(first, /^\[Reference notes for the caller's question, from the knowledge library\. [^\n]*:\n## PowerTitan storage\n- PowerTitan 3\.0 stores 6\.9 MWh\.\]\nWhat is the BESS called PowerTitan\?$/);
  assert.equal(h.session.record.transcript.find((e) => e.role === 'caller')?.text, 'What is the BESS called PowerTitan?');

  await until(() => agentLines(h).includes('It stores 6.9 MWh.'), 'first reply spoken');
  await sleep(50);
  callerSays(h, 'Tell me more about the BESS', 1);
  await until(() => h.brain.requests.length === 2, 'second reply');
  assert.equal(textOf(h.brain.requests[1].at(-1)), 'Tell me more about the BESS', 'the section is already in the history');
  h.session.end({ type: 'hangup' }, 'test over');
});

test('known mishearings are corrected before the model reads the caller’s words', async () => {
  const config = testConfig({ STT_CORRECTIONS: 'sunburo|sun grown=Sungrow' });
  const h = createHarness([{ text: 'The MG TL.' }], { config });
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'What is the latest Sunburo inverter?', 0);
  await until(() => h.brain.requests.length === 1, 'reply');
  assert.equal(textOf(h.brain.requests[0].at(-1)), 'What is the latest Sungrow inverter?');
  h.session.end({ type: 'hangup' }, 'test over');
});

test('a discarded early reply does not use up a library section', async () => {
  const h = createHarness([{ text: 'Draft.', hang: true }, { text: 'It stores 6.9 MWh.' }], { deps: { library } });
  h.session.start();
  await greetingDone(h);
  h.stt.emit('StartOfTurn', 'What', 0);
  h.stt.emit('EagerEndOfTurn', 'What is a BESS', 0);
  await until(() => h.brain.requests.length === 1, 'early reply started');
  h.stt.emit('TurnResumed', 'What is a BESS', 0);
  h.stt.emit('EndOfTurn', 'What is a BESS like PowerTitan?', 0);
  await until(() => h.brain.requests.length === 2, 'reply to the full turn');
  assert.match(textOf(h.brain.requests[1].at(-1)), /^\[Reference notes for the caller's question/);
  h.session.end({ type: 'hangup' }, 'test over');
});

test('a goodbye after two quick interruptions still ends the call (as on a live line)', async () => {
  const h = createHarness([
    { text: "You're welcome! Have a wonderful day." },
    { text: "You're welcome! Take care. End call." },
    { text: 'Thanks for calling. Have a great day! End call.' },
  ]);
  h.session.start();
  await greetingDone(h);
  h.transport.ackAfterMs = null; // replies keep "playing" until the caller talks over them
  const turn = (text: string, index: number) => {
    h.stt.emit('StartOfTurn', text.split(' ')[0], index);
    h.stt.emit('EagerEndOfTurn', text, index);
    h.stt.emit('EndOfTurn', text, index);
  };
  turn("That's all.", 0);
  await until(() => agentLines(h).includes('Have a wonderful day.'), 'first reply playing');
  h.stt.emit('Update', 'Thank', 1);
  turn('Thanks.', 1);
  await until(() => agentLines(h).includes('Take care.'), 'second reply playing');
  h.stt.emit('StartOfTurn', 'Bye', 2);
  h.transport.ackAfterMs = 10;
  turn('Bye.', 2);
  await until(() => h.transport.closedWith === 'hangup:goodbye', 'call ended after the goodbye');
});

test('a goodbye after the caller interrupts still ends the call', async () => {
  const h = createHarness([{ text: "You're welcome! Have a great day, Kumar." }, { text: 'Goodbye!' }]);
  h.session.start();
  await greetingDone(h);
  h.transport.ackAfterMs = null; // the first reply keeps "playing"
  callerSays(h, "That's all thanks.", 0);
  await until(() => agentLines(h).some((line) => line.startsWith("You're welcome")), 'first reply playing');
  await sleep(30);
  h.stt.emit('StartOfTurn', 'Bye', 1);
  h.transport.ackAfterMs = 10;
  h.stt.emit('EndOfTurn', 'Bye.', 1);
  await until(() => h.transport.closedWith === 'hangup:goodbye', 'call ended after the goodbye');
});

test('a goodbye from both sides ends the call even if the model forgets end_call', async () => {
  const h = createHarness([{ text: 'You are welcome. Goodbye!' }]);
  h.session.start();
  await greetingDone(h);
  callerSays(h, "That's all, thanks. Bye!", 0);
  await eventually(() => assert.equal(h.transport.closedWith, 'hangup:goodbye'));
});

test('after the call, a missed callback request is still saved', async () => {
  const h = createHarness([{ text: 'Sure, the front desk will call you back tomorrow.' }]);
  const reviewed: string[] = [];
  h.brain.findFollowUp = async (transcript) => {
    reviewed.push(transcript);
    return { callerName: 'Ann Lee', callbackNumber: '+15550100', message: 'Wants a cleaning next week.', urgency: 'normal' };
  };
  h.session.start();
  await greetingDone(h);
  callerSays(h, "I'm Ann Lee, please call me back to book a cleaning.", 0);
  await until(() => spoken(h).includes('Sure, the front desk will call you back tomorrow.'), 'agent reply');
  h.session.end({ type: 'hangup' }, 'caller hung up');

  const dir = path.join(h.config.dataDir, 'messages');
  await until(() => fs.existsSync(dir) && fs.readdirSync(dir).length === 1, 'follow-up saved');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
  assert.equal(saved.source, 'after-call review');
  assert.equal(saved.callerName, 'Ann Lee');
  assert.match(reviewed[0], /^Assistant: Hi, this is Ava\. How can I help\?\nCaller: I'm Ann Lee, please call me back/);
});

test('no after-call review when the agent already took the message', async () => {
  const h = createHarness([
    { text: 'Noted.', tools: [{ name: 'take_message', input: { caller_name: 'Bo', callback_number: '+1555', message: 'Call back', urgency: 'low' } }] },
    { text: 'Done!' },
  ]);
  let reviews = 0;
  h.brain.findFollowUp = async () => {
    reviews++;
    return null;
  };
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Please have someone call me back.', 0);
  await until(() => agentLines(h).includes('Done!'), 'agent finished');
  h.session.end({ type: 'hangup' }, 'caller hung up');
  await sleep(50);
  assert.equal(reviews, 0);
});

test('transfer_call hands the call to a person', async () => {
  const config = testConfig({ TRANSFER_NUMBER: '+14155550123' });
  const h = createHarness([{ text: 'Sure, connecting you now.', tools: [{ name: 'transfer_call', input: { reason: 'asked for a person' } }] }], { config });
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Can I talk to a real person?', 0);
  await eventually(() => assert.equal(h.transport.closedWith, 'transfer:+14155550123'));
  assert.deepEqual(h.ended, [{ type: 'transfer', to: '+14155550123' }]);
});

test('take_message saves the message and the model continues', async () => {
  const h = createHarness([
    {
      text: 'Let me write that down.',
      tools: [{ name: 'take_message', input: { caller_name: 'Ann Lee', callback_number: '+15550100', message: 'Wants a cleaning next week.', urgency: 'normal' } }],
    },
    { text: 'Done. The front desk will call you back. Anything else?' },
  ]);
  h.session.start();
  await greetingDone(h);
  callerSays(h, "I'd like to book a cleaning. I'm Ann Lee.", 0);

  await eventually(() => assert.equal(h.brain.requests.length, 2));
  const toolResults = h.brain.requests[1].at(-1) as MessageParam;
  assert.equal(toolResults.role, 'user');
  const block = (toolResults.content as ToolResultBlockParam[])[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.is_error, undefined);
  assert.match(String(block.content), /Message saved/);

  const files = fs.readdirSync(path.join(h.config.dataDir, 'messages'));
  assert.equal(files.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(h.config.dataDir, 'messages', files[0]), 'utf8'));
  assert.equal(saved.callerName, 'Ann Lee');
  assert.equal(saved.callerId, '+15550100');
  await until(() => agentLines(h).includes('Anything else?'), "agentLines(h).includes('Anything else?')");
  h.session.end({ type: 'hangup' }, 'test over');
});

test('talking over a goodbye cancels the hang-up', async () => {
  const h = createHarness([
    { text: 'Alright, have a great day!', tools: [{ name: 'end_call', input: { reason: 'caller done' } }] },
    { text: 'Of course, what else can I help with?' },
  ]);
  h.session.start();
  await greetingDone(h);
  h.transport.ackAfterMs = null;
  callerSays(h, 'Okay thanks.', 0);
  await until(() => spoken(h).includes('Alright, have a great day!'), 'goodbye spoken');
  await sleep(40);

  h.transport.ackAfterMs = 10;
  h.stt.emit('StartOfTurn', 'Actually wait', 1);
  h.stt.emit('EndOfTurn', 'Actually wait, one more thing.', 1);
  await eventually(() => assert.equal(h.brain.requests.length, 2));
  const content = h.brain.requests[1].at(-1)!.content as Exclude<MessageParam['content'], string>;
  assert.equal(content[0].type, 'tool_result', 'the cancelled end_call still gets its result');
  assert.match(String((content[0] as ToolResultBlockParam).content), /not ended/);
  await sleep(500);
  assert.equal(h.transport.closedWith, null);
  h.session.end({ type: 'hangup' }, 'test over');
});

test('checks in when the caller goes quiet, then hangs up', async () => {
  const config = testConfig({ MAX_SILENCE_PROMPTS: '1' });
  config.call.silenceTimeoutMs = 60;
  const h = createHarness([{ text: 'Are you still there?' }], { config });
  h.session.start();
  await eventually(() => assert.equal(h.brain.requests.length, 1));
  assert.match(textOf(h.brain.requests[0].at(-1)), /^\[No response from the caller for about \d+ seconds\.\]$/);
  await eventually(() => assert.equal(h.transport.closedWith, 'hangup:caller silent'));
});

// Right after each EndOfTurn, Flux sends an empty Update for the next turn.
test('checks in after the caller has spoken, despite the empty update after each turn', async () => {
  const config = testConfig({ MAX_SILENCE_PROMPTS: '1' });
  const h = createHarness([{ text: 'We open at nine.' }, { text: 'Are you still there?' }], { config });
  h.session.start();
  await greetingDone(h);
  config.call.silenceTimeoutMs = 60;
  callerSays(h, 'When do you open?', 0);
  h.stt.emit('Update', '', 1);
  await until(() => h.brain.requests.length === 2, 'silence check-in after the reply');
  assert.match(textOf(h.brain.requests[1].at(-1)), /^\[No response from the caller/);
  h.session.end({ type: 'hangup' }, 'test over');
});

test('hangs up after a goodbye despite the empty update after each turn', async () => {
  const h = createHarness([{ text: 'Bye now!' }]);
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Okay, thanks, bye.', 0);
  h.stt.emit('Update', '', 1);
  await until(() => h.transport.closedWith === 'hangup:goodbye', 'hung up after the goodbye');
});

test('a written "End call." is not spoken, and the call ends after the goodbye', async () => {
  const h = createHarness([{ text: 'Thanks for calling. Have a great day! End call.' }]);
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Okay.', 0);
  await until(() => h.transport.closedWith === 'hangup:goodbye', 'hung up after the goodbye');
  assert.ok(agentLines(h).includes('Have a great day!'));
  assert.equal(agentLines(h).includes('End call.'), false);
});

test('keypad presses reach the model', async () => {
  const h = createHarness([{ text: 'Got it, thanks.' }]);
  h.session.start();
  await greetingDone(h);
  for (const digit of '42#') h.session.onDtmf(digit);
  await eventually(() => assert.equal(h.brain.requests.length, 1));
  assert.equal(textOf(h.brain.requests[0].at(-1)), '[The caller pressed these keys on their keypad: 4 2 #]');
  h.session.end({ type: 'hangup' }, 'test over');
});

test('a failed model request apologizes and keeps the history valid', async () => {
  const h = createHarness([]);
  h.brain.stream = () => ({
    on: () => undefined,
    finalMessage: () => Promise.reject(new Error('network down')),
    abort: () => undefined,
  });
  h.session.start();
  await greetingDone(h);
  callerSays(h, 'Hello?', 0);
  await until(() => agentLines(h).includes(PHRASES.modelError), "agentLines(h).includes(PHRASES.modelError)");
  const messages = h.session.messages;
  assert.equal(messages.at(-1)!.role, 'assistant');
  assert.equal(textOf(messages.at(-1)), PHRASES.modelError);
  h.session.end({ type: 'hangup' }, 'test over');
});
