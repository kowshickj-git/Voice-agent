import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeTwilioSignature, validateTwilioSignature } from '../src/twilio/signature.js';
import { connectStreamTwiml, dialTwiml } from '../src/twilio/twiml.js';

// Test vector from Twilio's own SDK test suite.
const TOKEN = '12345';
const URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const PARAMS = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
const SIGNATURE = 'RSOYDt4T1cUTdK1PDd93/VVr8B8=';

test('matches Twilio’s reference signature', () => {
  assert.equal(computeTwilioSignature(TOKEN, URL, PARAMS), SIGNATURE);
  assert.equal(validateTwilioSignature(TOKEN, SIGNATURE, URL, PARAMS), true);
});

test('rejects tampered requests and wrong tokens', () => {
  assert.equal(validateTwilioSignature(TOKEN, SIGNATURE, URL, { ...PARAMS, Digits: '9999' }), false);
  assert.equal(validateTwilioSignature('wrong', SIGNATURE, URL, PARAMS), false);
  assert.equal(validateTwilioSignature(TOKEN, 'bogus', URL, PARAMS), false);
});

test('accepts the URL with or without the default port', () => {
  const withPort = 'https://mycompany.com:443/myapp.php?foo=1&bar=2';
  const signedWithPort = computeTwilioSignature(TOKEN, withPort, PARAMS);
  assert.equal(validateTwilioSignature(TOKEN, signedWithPort, URL, PARAMS), true);
  assert.equal(validateTwilioSignature(TOKEN, SIGNATURE, withPort, PARAMS), true);
});

test('TwiML escapes values', () => {
  const xml = connectStreamTwiml('wss://example.com/stream', 'a&b"c', 'https://example.com/twilio/after-stream');
  assert.match(xml, /<Stream url="wss:\/\/example.com\/stream"><Parameter name="token" value="a&amp;b&quot;c"\/><\/Stream>/);
  assert.match(xml, /<Redirect method="POST">https:\/\/example.com\/twilio\/after-stream<\/Redirect>/);
  assert.match(dialTwiml('+14155550123', 'https://x/y'), /<Dial action="https:\/\/x\/y" method="POST" timeout="25"><Number>\+14155550123<\/Number><\/Dial>/);
});
