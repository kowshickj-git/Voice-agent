import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { TAKE_MESSAGE, runTool } from '../src/llm/tools.js';
import type { ToolUseBlock } from '../src/llm/types.js';
import { silentLogger } from '../src/logger.js';
import { MessageStore } from '../src/records.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-tools-'));
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const ctx = { callSid: 'CAtools', callerId: '+15550100', messages: new MessageStore(dataDir, undefined, silentLogger), log: silentLogger };
const saved = () => (fs.existsSync(path.join(dataDir, 'messages')) ? fs.readdirSync(path.join(dataDir, 'messages')).length : 0);

function takeMessage(callerName: string): ToolUseBlock {
  return {
    type: 'tool_use',
    id: `toolu_${callerName.replace(/\W/g, '')}`,
    name: TAKE_MESSAGE,
    input: { caller_name: callerName, callback_number: '+15550100', message: 'Wants a quote.', urgency: 'normal' },
  } as ToolUseBlock;
}

test('take_message asks for a real name instead of saving a placeholder', async () => {
  for (const name of ['caller', 'The Caller', 'unknown', 'N/A']) {
    const result = await runTool(takeMessage(name), ctx);
    assert.equal(result.is_error, true, name);
    assert.match(String(result.content), /Ask the caller for their name/);
  }
  assert.equal(saved(), 0);

  for (const name of ['Kumar', 'name not given']) {
    const result = await runTool(takeMessage(name), ctx);
    assert.equal(result.is_error, undefined, name);
  }
  assert.equal(saved(), 2);
});
