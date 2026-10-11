import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centralSubsidy, estimateSolar, parseAmount } from '../src/llm/solarEstimate.js';
import { buildTools, runTool, SOLAR_ESTIMATE } from '../src/llm/tools.js';
import type { ToolUseBlock } from '../src/llm/types.js';
import { silentLogger } from '../src/logger.js';
import { MessageStore } from '../src/records.js';
import { buildSystemPrompt, knownProductCodes } from '../src/llm/prompt.js';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { layerEnv, loadConfig } from '../src/config.js';

test('reads amounts the way callers and models write them', () => {
  assert.equal(parseAmount('about 600 units'), 600);
  assert.equal(parseAmount('5.5 kW'), 5.5);
  assert.equal(parseAmount('1,200'), 1200);
  assert.equal(parseAmount('unknown'), undefined);
  assert.equal(parseAmount('0'), undefined);
});

test('the PM Surya Ghar subsidy grows to 78,000 rupees at 3 kW', () => {
  assert.equal(centralSubsidy(1), 30_000);
  assert.equal(centralSubsidy(2), 60_000);
  assert.equal(centralSubsidy(2.5), 69_000);
  assert.equal(centralSubsidy(3), 78_000);
  assert.equal(centralSubsidy(10), 78_000);
});

test('sizes a home from monthly units and matches Sungrow models', () => {
  const text = estimateSolar({ monthlyUnits: 600, connection: 'single_phase', backup: 'no', site: 'home' });
  assert.match(text, /about 5 kW of panels, for 600 units a month/);
  assert.match(text, /about 20 units a day, 600 a month, 7,300 a year/);
  assert.match(text, /about 10 panels of 550 W/);
  assert.match(text, /400 to 500 square feet/);
  assert.match(text, /single-phase, no backup: SG5\.0RS on-grid inverter/);
  assert.match(text, /about 78,000 rupees for 3 kW \(it stops growing after 3 kW\)/);
  assert.match(text, /Never turn this into a price/);
});

test('rounds a system up to the next half kilowatt', () => {
  assert.match(estimateSolar({ monthlyUnits: 450, connection: 'unknown', backup: 'unknown', site: 'unknown' }), /about 4 kW of panels/);
  assert.match(estimateSolar({ monthlyUnits: 50, connection: 'unknown', backup: 'unknown', site: 'unknown' }), /about 1 kW of panels/);
});

test('without the phase, offers both and says to ask', () => {
  const text = estimateSolar({ systemKw: 10, connection: 'unknown', backup: 'no', site: 'home' });
  assert.match(text, /SG10RS on-grid inverter\. Or, three-phase, no backup: SG10RT-P2 on-grid inverter/);
  assert.match(text, /Ask whether their connection is single-phase or three-phase/);
});

test('suggests hybrids and a battery size for backup', () => {
  const single = estimateSolar({ systemKw: 5, connection: 'single_phase', backup: 'yes', site: 'home', backupLoadWatts: 800, backupHours: 5 });
  assert.match(single, /SH5\.0RS hybrid with a Sungrow SBR battery, or MG5RL hybrid/);
  assert.match(single, /about 4\.6 kWh usable/);
  assert.match(single, /one SBR096 stack/);
  assert.match(single, /one MBL050 \(48 V\)/);

  const three = estimateSolar({ systemKw: 15, connection: 'three_phase', backup: 'yes', site: 'home' });
  assert.match(three, /MG15TL hybrid/);
  assert.match(three, /ask what must run during a power cut/);
});

test('businesses get CX inverters and no home subsidy', () => {
  const text = estimateSolar({ systemKw: 45, connection: 'three_phase', backup: 'no', site: 'business' });
  assert.match(text, /SG50CX business inverter/);
  assert.match(text, /for homes only, not businesses/);
  assert.doesNotMatch(text, /78,000/);
});

test('asks for units when there is nothing to size from', () => {
  assert.match(estimateSolar({ connection: 'single_phase', backup: 'no', site: 'home' }), /Ask for the average units used per month/);
});

test('every model the estimator names is in the Sunbridger agent files', () => {
  const { config } = loadConfig({ DEEPGRAM_API_KEY: 'k', LLM_PROVIDER: 'ollama', AGENT_PROFILE: 'sungrow' }, process.cwd());
  const known = knownProductCodes(config.agent)!;
  const cases = [
    ...[1, 3.3, 4, 5, 6, 8, 9, 10, 12].map((kw) => ({ systemKw: kw, connection: 'single_phase' as const })),
    ...[4, 6, 7, 8, 10, 12, 15, 17, 20, 30, 40, 50, 100, 125, 150].map((kw) => ({ systemKw: kw, connection: 'three_phase' as const })),
  ];
  for (const base of cases) {
    for (const backup of ['yes', 'no'] as const) {
      const text = estimateSolar({ ...base, backup, site: 'unknown', backupLoadWatts: 3000, backupHours: 8 });
      for (const code of text.match(/\b(?:SG|SH|MG|SBR|SBH|MBL|MGL)[\dA-Z.-]*\d[\dA-Z.-]*/g) ?? []) {
        assert.ok(known.has(code.replace(/[.-]$/, '')), `${code} (from ${JSON.stringify(base)}, backup ${backup})`);
      }
    }
  }
});

test('solar_estimate is offered only when enabled, and runs as a tool', async () => {
  assert.ok(!buildTools({ transferEnabled: false }).some((t) => t.name === SOLAR_ESTIMATE));
  assert.deepEqual(
    buildTools({ transferEnabled: false, solarEstimator: true }).map((t) => t.name),
    ['end_call', 'solar_estimate', 'take_message'],
  );
  const use = {
    type: 'tool_use',
    id: 'toolu_estimate',
    name: SOLAR_ESTIMATE,
    // Small models leave fields out or write numbers with units; both are handled.
    input: { monthly_units: '300 units', connection: 'three_phase', backup: 'maybe' },
  } as unknown as ToolUseBlock;
  const ctx = { callSid: 'CAest', messages: new MessageStore('/nonexistent', undefined, silentLogger), log: silentLogger };
  const result = await runTool(use, ctx);
  assert.equal(result.is_error, undefined);
  assert.match(String(result.content), /about 2\.5 kW of panels, for 300 units a month/);
  assert.match(String(result.content), /SG5\.0RT-P2 on-grid inverter/);
  assert.match(String(result.content), /hybrid inverter with a battery is needed instead/);
});

test('the Sunbridger agent turns the estimator on, and the main agent never inherits it', () => {
  const profileEnv = dotenv.parse(fs.readFileSync(path.join('agents', 'sungrow', 'agent.env')));
  const shared = { DEEPGRAM_API_KEY: 'k', LLM_PROVIDER: 'ollama' };
  assert.equal(loadConfig(layerEnv({}, shared, { name: 'sungrow', env: profileEnv }), process.cwd()).config.agent.solarEstimator, true);
  assert.equal(loadConfig(shared, process.cwd()).config.agent.solarEstimator, false);
  const prompt = buildSystemPrompt(loadConfig(layerEnv({}, shared, { name: 'sungrow', env: profileEnv }), process.cwd()).config.agent, 'ollama');
  assert.match(prompt, /call the solar_estimate tool instead of working out numbers yourself/);
});
