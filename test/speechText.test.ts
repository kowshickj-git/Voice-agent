import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBackchannel, isMutualFarewell, isSpokenEndCall, productCodes, spellOutCodes, toSpeakableText } from '../src/text/speechText.js';

test('strips Markdown formatting', () => {
  assert.equal(toSpeakableText('**Hours:** Monday to *Friday*'), 'Hours: Monday to Friday');
  assert.equal(toSpeakableText('## Our services'), 'Our services');
  assert.equal(toSpeakableText('- Cleanings\n- Fillings'), 'Cleanings Fillings');
  assert.equal(toSpeakableText('1. First\n2) Second'), 'First Second');
  assert.equal(toSpeakableText('See [our site](https://example.com) for `details`'), 'See our site for details');
});

test('removes emojis and bracketed notes', () => {
  assert.equal(toSpeakableText('Great! 😊 See you soon 👍🏽'), 'Great! See you soon');
  assert.equal(toSpeakableText('Goodbye! [ends call]'), 'Goodbye!');
});

test('keeps ordinary punctuation and symbols', () => {
  assert.equal(toSpeakableText("It's $149, or 20% off — press # to continue."), "It's $149, or 20% off — press # to continue.");
  assert.equal(toSpeakableText('Email john_doe@example.com'), 'Email john_doe@example.com');
});

test('spells out the letters of model codes for the voice', () => {
  assert.equal(spellOutCodes('The SG5.0RS, with an SBR096.'), 'The S G 5.0 R S, with an S B R 096.');
  assert.equal(spellOutCodes('SH10RT or MG10TL'), 'S H 10 R T or M G 10 T L');
  assert.equal(spellOutCodes('The SG125CX-P2 is IP66.'), 'The S G 125 C X P 2 is I P 66.');
  assert.equal(spellOutCodes('SG3.0RS-L'), 'S G 3.0 R S L');
  // Ordinary words, numbers, units, and long acronyms stay as they are.
  for (const text of ['COVID-19', '5 kW and 9.6 kWh', 'iSolarCloud', 'PowerHarbor', 'MPPT', '24/7', 'Call 98400 12345.', 'Open at 8AM', '1+X 2.0']) {
    assert.equal(spellOutCodes(text), text);
  }
});

test('finds the model codes in a text', () => {
  assert.deepEqual(productCodes('Pair the SH5.0RS with an SBR096 (IP55), not COVID-19 or 5 kW.'), ['SH5.0RS', 'SBR096', 'IP55']);
});

test('spots a hang-up written as words instead of a tool call', () => {
  for (const text of ['End call.', '*ends call*', 'Ending the call.', 'end_call', 'Hang up.']) assert.equal(isSpokenEndCall(text), true, text);
  for (const text of ['Should I end the call?', 'Call us at the end of the day.', 'Please hang up and call again.']) {
    assert.equal(isSpokenEndCall(text), false, text);
  }
});

test('mutual farewells', () => {
  assert.equal(isMutualFarewell("Great, that's everything. Thanks, bye!", 'You are welcome! Have a great night. Goodbye!'), true);
  assert.equal(isMutualFarewell('Okay, goodbye.', 'Bye!'), true);
  assert.equal(isMutualFarewell("No, that's all, thanks.", 'Have a wonderful day!'), true);
  assert.equal(isMutualFarewell("That's all. Thanks.", "You're welcome, Anne. Have a great day!"), true);
  assert.equal(isMutualFarewell('Okay, thanks, bye.', 'Bye now!'), true);
  assert.equal(isMutualFarewell("No, that's all.", 'Great, have a nice day!'), true);
  assert.equal(isMutualFarewell("That's all I wanted to ask about pricing.", 'Have a nice day!'), false);
  // Both sides have to be saying goodbye.
  assert.equal(isMutualFarewell('Bye!', 'Before you go, can I get your number?'), false);
  assert.equal(isMutualFarewell('Yes, that is all correct.', 'Have a great day!'), false);
  assert.equal(isMutualFarewell('What time do you open?', 'Goodbye!'), false);
});

test('backchannels', () => {
  for (const text of ['Mm-hmm.', 'okay', 'Yeah, yeah.', 'Uh-huh', 'Right.', 'Got it.', 'I see', 'Um']) {
    assert.equal(isBackchannel(text), true, text);
  }
  for (const text of ['Wait.', 'No', 'Yes', 'Okay, but what about Saturday?', 'Hold on', 'Stop', 'Hello?', 'Can I speak to someone']) {
    assert.equal(isBackchannel(text), false, text);
  }
});
