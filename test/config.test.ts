import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import dotenv from 'dotenv';
import { layerEnv, loadConfig, parseSttCorrections, profileFromArgs } from '../src/config.js';
import { buildSystemPrompt, knownProductCodes, promptSizeWarning } from '../src/llm/prompt.js';

const root = process.cwd();

/** A .env like the main (dental) agent's. */
const mainDotEnv = {
  DEEPGRAM_API_KEY: 'dg-key',
  LLM_PROVIDER: 'ollama',
  PORT: '8080',
  AGENT_NAME: 'Ava',
  COMPANY_NAME: 'Sunrise Dental Clinic',
  TRANSFER_NUMBER: '+14155550123',
  DATA_DIR: 'data',
  TIMEZONE: '',
};

test('reads the agent profile from the command line', () => {
  assert.equal(profileFromArgs(['--agent=sungrow']), 'sungrow');
  assert.equal(profileFromArgs(['--port', '1', '--agent', 'sungrow']), 'sungrow');
  assert.equal(profileFromArgs(['--agent=']), undefined);
  assert.equal(profileFromArgs([]), undefined);
});

test('parses speech recognition corrections', () => {
  const { corrections, invalid } = parseSttCorrections('sun grow|sun grown|sunburo=Sungrow; sunbridge=Sunbridger; nonsense');
  assert.deepEqual(invalid, ['nonsense']);
  const fix = (text: string) => corrections.reduce((t, c) => t.replace(c.pattern, c.replacement), text);
  assert.equal(fix('What is the latest Sunburo inverter from sun grown?'), 'What is the latest Sungrow inverter from Sungrow?');
  assert.equal(fix('Is this  Sunbridge?'), 'Is this  Sunbridger?');
  assert.equal(fix('Is this Sunbridger, the sungrow distributor?'), 'Is this Sunbridger, the sungrow distributor?', 'whole words only');
});

test('.env wins over the shell, but empty values never erase', () => {
  const env = layerEnv({ LLM_EFFORT: 'max', TIMEZONE: 'UTC' }, { LLM_EFFORT: 'low', TIMEZONE: '' });
  assert.equal(env.LLM_EFFORT, 'low');
  assert.equal(env.TIMEZONE, 'UTC');
  assert.equal(env.AGENT_PROFILE, undefined);
});

test('a profile shares the keys in .env but not the main agent’s own settings', () => {
  const env = layerEnv({}, mainDotEnv, { name: 'shop', env: { PORT: '8082', COMPANY_NAME: 'Shop Co', LLM_PROVIDER: 'anthropic' } });
  assert.equal(env.DEEPGRAM_API_KEY, 'dg-key');
  assert.equal(env.LLM_PROVIDER, 'anthropic');
  assert.equal(env.PORT, '8082');
  assert.equal(env.COMPANY_NAME, 'Shop Co');
  assert.equal(env.AGENT_NAME, undefined);
  assert.equal(env.TRANSFER_NUMBER, undefined);
  assert.equal(env.DATA_DIR, undefined);
  assert.equal(env.AGENT_PROFILE, 'shop');
});

test('the main agent keeps its files and records folder', () => {
  const { config, errors } = loadConfig(layerEnv({}, mainDotEnv), root);
  assert.deepEqual(errors, []);
  assert.equal(config.profile, undefined);
  assert.equal(config.port, 8080);
  assert.equal(config.agent.instructionsFile, path.resolve(root, 'agent', 'instructions.md'));
  assert.equal(config.agent.knowledgeFile, path.resolve(root, 'agent', 'knowledge.md'));
  assert.equal(config.dataDir, path.resolve(root, 'data'));
});

test('a profile defaults to its own folder for prompts and records', () => {
  const { config } = loadConfig({ DEEPGRAM_API_KEY: 'k', LLM_PROVIDER: 'ollama', AGENT_PROFILE: 'sungrow' }, root);
  assert.equal(config.profile, 'sungrow');
  assert.equal(config.agent.instructionsFile, path.resolve(root, 'agents', 'sungrow', 'instructions.md'));
  assert.equal(config.agent.knowledgeFile, path.resolve(root, 'agents', 'sungrow', 'knowledge.md'));
  assert.equal(config.dataDir, path.resolve(root, 'data', 'sungrow'));
});

test('reports unknown or invalid profiles', () => {
  const missing = loadConfig({ DEEPGRAM_API_KEY: 'k', LLM_PROVIDER: 'ollama', AGENT_PROFILE: 'no-such-agent' }, root);
  assert.match(missing.errors.join('\n'), /Agent profile "no-such-agent" not found/);
  const invalid = loadConfig({ DEEPGRAM_API_KEY: 'k', LLM_PROVIDER: 'ollama', AGENT_PROFILE: '../agent' }, root);
  assert.match(invalid.errors.join('\n'), /letters, digits/);
});

test('the Sungrow agent loads cleanly on top of the main agent’s .env', () => {
  const profileEnv = dotenv.parse(fs.readFileSync(path.join(root, 'agents', 'sungrow', 'agent.env')));
  const { config, errors, warnings } = loadConfig(layerEnv({}, mainDotEnv, { name: 'sungrow', env: profileEnv }), root);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter((w) => /profile/.test(w)), []);
  assert.equal(config.port, 8081);
  assert.equal(config.agent.transferNumber, undefined);
  assert.equal(config.dataDir, path.resolve(root, 'data', 'sungrow'));
  assert.ok(fs.existsSync(config.agent.instructionsFile) && fs.existsSync(config.agent.knowledgeFile));

  const prompt = buildSystemPrompt(config.agent, config.llm.provider);
  assert.match(prompt, new RegExp(`You are ${config.agent.name}, the phone assistant for ${config.agent.company}`));
  assert.match(prompt, /SH5\.0RS/);
  assert.match(prompt, /General questions about solar power.* you may answer from your own knowledge/);
  assert.match(prompt, /A note that starts with "Reference notes" holds facts from Sunbridger's knowledge library/);
  assert.match(prompt, /come only from the knowledge base above and the reference notes/);
  assert.doesNotMatch(prompt, /Sunrise Dental|Sources:/);
  assert.ok((knownProductCodes(config.agent)?.size ?? 0) > 50);
  assert.equal(promptSizeWarning(prompt, 16384), undefined);
  assert.match(promptSizeWarning(prompt, 8192) ?? '', /Raise LLM_CONTEXT_TOKENS/);
});

test('the main agent answers only from its knowledge base', () => {
  const { config } = loadConfig(layerEnv({}, mainDotEnv), root);
  const prompt = buildSystemPrompt(config.agent, config.llm.provider);
  assert.match(prompt, /You only know what is written in the knowledge base above/);
  assert.doesNotMatch(prompt, /from your own knowledge|Reference notes/);
  assert.equal(knownProductCodes(config.agent), undefined);
});
