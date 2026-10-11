import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { silentLogger } from '../src/logger.js';
import { MessageStore } from '../src/records.js';
import { createServer } from '../src/server.js';
import { AudioCache } from '../src/tts/index.js';
import { computeTwilioSignature } from '../src/twilio/signature.js';
import { eventually, FakeBrain, FakeStt, FakeTts, sleep, testConfig, until, type ScriptedReply } from './fakes.js';

async function startServer(replies: ScriptedReply[], env: Record<string, string> = {}) {
  const config = testConfig(env);
  const brain = new FakeBrain(replies);
  const stts: FakeStt[] = [];
  const { server, shutdown } = createServer({
    config,
    log: silentLogger,
    tts: new FakeTts(),
    audioCache: new AudioCache(),
    messages: new MessageStore(config.dataDir, undefined, silentLogger),
    createBrain: () => brain,
    createStt: (handlers) => {
      const stt = new FakeStt();
      stt.handlers = handlers;
      stts.push(stt);
      return stt;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { config, brain, stts, port, base: `http://127.0.0.1:${port}`, shutdown };
}

async function postForm(url: string, params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.text() };
}

/** A minimal Twilio media-stream client. */
class FakeTwilio {
  readonly ws: WebSocket;
  readonly received: any[] = [];
  closeReason: string | null = null;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.received.push(msg);
      // Play marks back immediately, like a caller who hears everything.
      if (msg.event === 'mark') this.send({ event: 'mark', streamSid: 'MZ1', mark: { name: msg.mark.name } });
    });
    this.ws.on('close', (_code, reason) => (this.closeReason = reason.toString()));
  }
  opened(): Promise<void> {
    return new Promise((resolve) => this.ws.once('open', () => resolve()));
  }
  send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  start(callSid: string, token: string): void {
    this.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    this.send({
      event: 'start',
      sequenceNumber: '1',
      streamSid: 'MZ1',
      start: { streamSid: 'MZ1', callSid, accountSid: 'AC1', tracks: ['inbound'], customParameters: { token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } },
    });
  }
}

test('incoming call webhook returns a media stream with a one-time token', async () => {
  const srv = await startServer([]);
  try {
    const { status, body } = await postForm(`${srv.base}/twilio/voice`, { CallSid: 'CA1', From: '+15550100', To: '+15550199' });
    assert.equal(status, 200);
    assert.match(body, new RegExp(`<Stream url="ws://127.0.0.1:${srv.port}/stream">`));
    assert.match(body, /<Parameter name="token" value="[\w-]{20,}"\/>/);
    assert.match(body, new RegExp(`<Redirect method="POST">http://127.0.0.1:${srv.port}/twilio/after-stream</Redirect>`));
  } finally {
    await srv.shutdown();
  }
});

test('webhooks must carry a valid Twilio signature when an auth token is set', async () => {
  const srv = await startServer([], { TWILIO_AUTH_TOKEN: 'secret-token' });
  try {
    const params = { CallSid: 'CA2', From: '+15550100' };
    assert.equal((await postForm(`${srv.base}/twilio/voice`, params)).status, 403);
    const bad = await postForm(`${srv.base}/twilio/voice`, params, { 'X-Twilio-Signature': 'nope' });
    assert.equal(bad.status, 403);
    const signature = computeTwilioSignature('secret-token', `${srv.base}/twilio/voice`, params);
    const good = await postForm(`${srv.base}/twilio/voice`, params, { 'X-Twilio-Signature': signature });
    assert.equal(good.status, 200);
  } finally {
    await srv.shutdown();
  }
});

test('media streams without a valid token are rejected', async () => {
  const srv = await startServer([]);
  try {
    const twilio = new FakeTwilio(`ws://127.0.0.1:${srv.port}/stream`);
    await twilio.opened();
    twilio.start('CA3', 'not-a-real-token');
    await eventually(() => assert.equal(twilio.closeReason, 'unauthorized'));
    assert.equal(srv.stts.length, 0, 'no call was started');
  } finally {
    await srv.shutdown();
  }
});

test('a full call over the Twilio protocol: greeting, answer, hang-up', async () => {
  const srv = await startServer([{ text: 'We open at eight. Goodbye!', tools: [{ name: 'end_call', input: { reason: 'question answered' } }] }]);
  try {
    const voice = await postForm(`${srv.base}/twilio/voice`, { CallSid: 'CA4', From: '+15550100' });
    const token = /name="token" value="([^"]+)"/.exec(voice.body)![1];

    const twilio = new FakeTwilio(`ws://127.0.0.1:${srv.port}/stream`);
    await twilio.opened();
    twilio.start('CA4', token);
    // Twilio streams caller audio continuously.
    const audio = setInterval(() => twilio.send({ event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload: Buffer.alloc(160, 0xff).toString('base64') } }), 20);

    await until(() => twilio.received.some((m) => m.event === 'media'), "twilio.received.some((m) => m.event === 'media')");
    const media = twilio.received.find((m) => m.event === 'media');
    assert.equal(media.streamSid, 'MZ1');
    assert.ok(Buffer.from(media.media.payload, 'base64').length > 0, "Buffer.from(media.media.payload, 'base64').length > 0");
    await until(() => twilio.received.filter((m) => m.event === 'mark').length >= 2, "twilio.received.filter((m) => m.event === 'mark').length >= 2");
    await sleep(30);

    const stt = srv.stts[0];
    stt.emit('StartOfTurn', 'When', 0);
    stt.emit('EndOfTurn', 'When do you open?', 0);
    await eventually(() => assert.equal(twilio.closeReason, 'hangup:question answered'), 3000);
    clearInterval(audio);
    assert.equal(srv.brain.requests.length, 1);
    assert.ok(twilio.received.every((m) => m.event !== 'debug'), 'no browser debug events on real calls');

    const after = await postForm(`${srv.base}/twilio/after-stream`, { CallSid: 'CA4' });
    assert.match(after.body, /<Hangup\/>/);
  } finally {
    await srv.shutdown();
  }
});

test('an unanswered transfer brings the caller back to the agent', async () => {
  const srv = await startServer(
    [
      { text: 'Connecting you now.', tools: [{ name: 'transfer_call', input: { reason: 'wants a person' } }] },
      { text: "Sorry, nobody's available. Can I take a message?" },
    ],
    { TRANSFER_NUMBER: '+14155550123' },
  );
  try {
    const voice = await postForm(`${srv.base}/twilio/voice`, { CallSid: 'CA5', From: '+15550100' });
    const token = /name="token" value="([^"]+)"/.exec(voice.body)![1];
    const first = new FakeTwilio(`ws://127.0.0.1:${srv.port}/stream`);
    await first.opened();
    first.start('CA5', token);
    await until(() => first.received.filter((m) => m.event === 'mark').length >= 2, "first.received.filter((m) => m.event === 'mark').length >= 2");
    await sleep(30);
    srv.stts[0].emit('EndOfTurn', 'Let me talk to a person.', 0);
    await eventually(() => assert.equal(first.closeReason, 'transfer:+14155550123'), 3000);

    const after = await postForm(`${srv.base}/twilio/after-stream`, { CallSid: 'CA5' });
    assert.match(after.body, /<Dial action="http:\/\/127\.0\.0\.1:\d+\/twilio\/dial-status" method="POST" timeout="25"><Number>\+14155550123<\/Number><\/Dial>/);

    const status = await postForm(`${srv.base}/twilio/dial-status`, { CallSid: 'CA5', DialCallStatus: 'no-answer' });
    const resumeToken = /name="token" value="([^"]+)"/.exec(status.body)![1];
    const second = new FakeTwilio(`ws://127.0.0.1:${srv.port}/stream`);
    await second.opened();
    second.start('CA5', resumeToken);
    await eventually(() => assert.equal(srv.brain.requests.length, 2));
    const resumed = srv.brain.requests[1];
    const lastText = JSON.stringify(resumed.at(-1));
    assert.match(lastText, /nobody answered/);
    assert.ok(resumed.length > 4, 'the earlier conversation is kept');
    second.ws.close();
  } finally {
    await srv.shutdown();
  }
});

test('a shared link with the access key opens the test phone from another computer', async () => {
  const key = 'k3y-for-the-test-phone-123';
  const srv = await startServer([], { WEB_ACCESS_KEY: key });
  const remote = { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' };
  try {
    const wrong = await fetch(`${srv.base}/?key=wrong-key-wrong-key`, { headers: remote });
    assert.equal(await wrong.text(), 'Voice agent is running.');
    const page = await fetch(`${srv.base}/?key=${key}`, { headers: remote });
    assert.match(await page.text(), /Voice Agent/);
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
    assert.equal(cookie, `test_phone_key=${key}`);
    assert.match(page.headers.get('set-cookie') ?? '', /HttpOnly.*Secure.*SameSite=Strict/i);
    const session = await fetch(`${srv.base}/web/session`, { method: 'POST', headers: { ...remote, cookie } });
    assert.equal(session.status, 200);
    const script = await fetch(`${srv.base}/app.js`, { headers: { ...remote, cookie } });
    assert.equal(script.status, 200);
    const noCookie = await fetch(`${srv.base}/web/session`, { method: 'POST', headers: remote });
    assert.equal(noCookie.status, 404);
  } finally {
    await srv.shutdown();
  }
});

test('the browser test page is only served locally', async () => {
  const srv = await startServer([]);
  try {
    const local = await fetch(`${srv.base}/`);
    assert.match(await local.text(), /Voice Agent/);
    const proxied = await fetch(`${srv.base}/`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(await proxied.text(), 'Voice agent is running.');
    const session = await fetch(`${srv.base}/web/session`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(session.status, 404);
  } finally {
    await srv.shutdown();
  }
});
