import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { DEFAULT_OLLAMA_MODEL, type LlmConfig } from '../src/config.js';
import { OllamaBrain, ThinkTagFilter, toOllamaMessages } from '../src/llm/OllamaBrain.js';
import { buildTools } from '../src/llm/tools.js';
import { ModelRequestError, type MessageParam } from '../src/llm/types.js';

function llmConfig(ollamaUrl: string, model = DEFAULT_OLLAMA_MODEL): LlmConfig {
  return { provider: 'ollama', model, fallbacks: false, maxTokens: 1024, ollamaUrl, contextTokens: 8192, temperature: 0.2 };
}

/** A fake Ollama server: replies to /api/chat with the given NDJSON chunks (or `jsonReply` when not streaming). */
async function fakeOllama(chunks: unknown[], capabilities = ['completion', 'tools', 'thinking'], jsonReply = '{}') {
  const requests: Record<string, any>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      if (req.url === '/api/show') {
        if (body.model !== DEFAULT_OLLAMA_MODEL) {
          res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `model '${body.model}' not found` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ capabilities }));
        return;
      }
      requests.push(body);
      if (body.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: jsonReply }, done: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const chunk of chunks) {
        if (res.destroyed) return;
        res.write(`${JSON.stringify(chunk)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const history: MessageParam[] = [
  { role: 'user', content: '[Phone call connected.]' },
  { role: 'assistant', content: 'Hi! How can I help?' },
  { role: 'user', content: 'Please end the call.' },
];

test('converts the conversation to Ollama messages', () => {
  const messages = toOllamaMessages('SYSTEM', [
    { role: 'user', content: 'Hi' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'x' },
        { type: 'text', text: 'Let me note that.' },
        { type: 'tool_use', id: 'call_1', name: 'take_message', input: { message: 'hello' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'Message saved.' },
        { type: 'text', text: '[The caller interrupted you.]\nThanks!' },
      ],
    },
  ] as MessageParam[]);
  assert.deepEqual(messages, [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Let me note that.', tool_calls: [{ function: { name: 'take_message', arguments: { message: 'hello' } } }] },
    { role: 'tool', content: 'Message saved.', tool_name: 'take_message' },
    { role: 'user', content: '[The caller interrupted you.]\nThanks!' },
  ]);
});

test('think tags are removed even when split across chunks', () => {
  const filter = new ThinkTagFilter();
  const out = ['Sure', '! <thi', 'nk>planning', ' the answer</th', 'ink>We open', ' at nine.', '<'].map((piece) => filter.push(piece)).join('') + filter.flush();
  assert.equal(out, 'Sure! We open at nine.<');
});

test('streams text and tool calls, and requests a bigger context window without thinking', async () => {
  const ollama = await fakeOllama([
    { message: { role: 'assistant', content: 'Thanks for calling. ' }, done: false },
    { message: { role: 'assistant', content: 'Goodbye!' }, done: false },
    { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'end_call', arguments: { reason: 'done' } } }] }, done: false },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1500, eval_count: 20 },
  ]);
  try {
    const brain = new OllamaBrain(llmConfig(ollama.url), 'SYSTEM', buildTools({ transferEnabled: false }));
    const stream = brain.stream(history, new AbortController().signal);
    const deltas: string[] = [];
    stream.on('text', (delta) => deltas.push(delta));
    const message = await stream.finalMessage();

    assert.deepEqual(deltas, ['Thanks for calling. ', 'Goodbye!']);
    assert.equal(message.stop_reason, 'tool_use');
    assert.equal(message.content[0].type, 'text');
    const toolUse = message.content[1];
    assert.equal(toolUse.type, 'tool_use');
    assert.ok(toolUse.type === 'tool_use' && toolUse.name === 'end_call' && toolUse.id.startsWith('call_'), 'tool call converted');
    assert.deepEqual(message.usage.input_tokens, 1500);

    const request = ollama.requests[0];
    assert.equal(request.model, DEFAULT_OLLAMA_MODEL);
    assert.equal(request.think, false, 'thinking is switched off for speed');
    assert.equal(request.options.num_ctx, 8192);
    assert.equal(request.keep_alive, '30m');
    assert.deepEqual(
      request.tools.map((t: any) => t.function.name),
      ['end_call', 'take_message'],
    );
    assert.equal(request.messages[0].role, 'system');
    assert.equal(request.messages.at(-1).content, 'Please end the call.');
  } finally {
    await ollama.close();
  }
});

test('models without thinking or tools get neither option', async () => {
  const ollama = await fakeOllama([{ message: { role: 'assistant', content: 'Hi.' }, done: true, done_reason: 'stop' }], ['completion']);
  try {
    const brain = new OllamaBrain(llmConfig(ollama.url), 'SYSTEM', buildTools({ transferEnabled: false }));
    const message = await brain.stream(history, new AbortController().signal).finalMessage();
    assert.equal(message.stop_reason, 'end_turn');
    assert.equal('think' in ollama.requests[0], false);
    assert.equal('tools' in ollama.requests[0], false);
  } finally {
    await ollama.close();
  }
});

test('aborting stops the stream', async () => {
  const chunks = Array.from({ length: 50 }, (_, i) => ({ message: { role: 'assistant', content: `word${i} ` }, done: false }));
  const ollama = await fakeOllama(chunks);
  try {
    const brain = new OllamaBrain(llmConfig(ollama.url), 'SYSTEM', []);
    const controller = new AbortController();
    const stream = brain.stream(history, controller.signal);
    let received = 0;
    stream.on('text', () => {
      if (++received === 3) controller.abort();
    });
    await assert.rejects(stream.finalMessage(), (err: Error) => err.name === 'AbortError');
    assert.ok(received < 10, `stopped early (got ${received} pieces)`);
  } finally {
    await ollama.close();
  }
});

test('a model that is not downloaded gives a clear, permanent error', async () => {
  const ollama = await fakeOllama([]);
  try {
    const brain = new OllamaBrain(llmConfig(ollama.url, 'not-downloaded:1b'), 'SYSTEM', []);
    await assert.rejects(brain.stream(history, new AbortController().signal).finalMessage(), (err: unknown) => {
      assert.ok(err instanceof ModelRequestError, 'ModelRequestError');
      assert.equal(err.permanent, true);
      assert.match(err.message, /ollama pull not-downloaded:1b/);
      return true;
    });
  } finally {
    await ollama.close();
  }
});

test('the after-call review uses a JSON schema and fills in missing details', async () => {
  const reply = JSON.stringify({ action: 'follow_up', caller_name: 'Ann Lee', callback_number: 'unknown', message: 'Book a cleaning, Tuesday morning.', urgency: 'urgent-ish' });
  const ollama = await fakeOllama([], ['completion', 'tools'], reply);
  try {
    const brain = new OllamaBrain(llmConfig(ollama.url), 'SYSTEM', []);
    const followUp = await brain.findFollowUp('Caller: I want a cleaning.', '+15550100');
    assert.deepEqual(followUp, { callerName: 'Ann Lee', callbackNumber: '+15550100', message: 'Book a cleaning, Tuesday morning.', urgency: 'normal' });
    const request = ollama.requests[0];
    assert.equal(request.stream, false);
    assert.equal(request.format.required[0], 'action', 'the decision comes first');
    assert.equal(request.options.num_ctx, 8192, 'same context size, so the model is not reloaded');
  } finally {
    await ollama.close();
  }
});

test('the after-call review returns null when no follow-up is needed', async () => {
  const reply = JSON.stringify({ action: 'none', caller_name: 'unknown', callback_number: 'unknown', message: '', urgency: 'low' });
  const ollama = await fakeOllama([], ['completion'], reply);
  try {
    const brain = new OllamaBrain(llmConfig(ollama.url), 'SYSTEM', []);
    assert.equal(await brain.findFollowUp('Caller: What are your hours?\nAssistant: Nine to five.', undefined), null);
  } finally {
    await ollama.close();
  }
});

test('an unreachable Ollama server is reported clearly', async () => {
  const brain = new OllamaBrain(llmConfig('http://127.0.0.1:9'), 'SYSTEM', []);
  await assert.rejects(brain.stream(history, new AbortController().signal).finalMessage(), /Can't reach Ollama/);
});
