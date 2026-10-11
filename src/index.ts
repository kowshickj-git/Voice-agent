import type Anthropic from '@anthropic-ai/sdk';
import { agentSettingsFile, loadConfig, type AppConfig } from './config.js';
import { createAnthropicClient, describeApiError } from './llm/ClaudeBrain.js';
import { createBrain, describeLlm } from './llm/index.js';
import { modelCapabilities } from './llm/OllamaBrain.js';
import { buildSystemPrompt, promptSizeWarning } from './llm/prompt.js';
import { buildTools } from './llm/tools.js';
import { createLogger, type Logger } from './logger.js';
import { MessageStore } from './records.js';
import { createServer } from './server.js';
import { SentenceChunker } from './text/SentenceChunker.js';
import { toSpeakableText } from './text/speechText.js';
import { AudioCache, createTts, voiceKey, type TextToSpeech } from './tts/index.js';

const log = createLogger();
const { config, errors, warnings } = loadConfig();
for (const warning of warnings) log.warn(warning);
if (errors.length > 0) {
  for (const error of errors) log.error(error);
  log.error(
    config.profile
      ? `Fix these settings in .env or ${agentSettingsFile(config.profile)}, then start again.`
      : 'Fix these settings in your .env file (see .env.example), then start again.',
  );
  process.exit(1);
}

let anthropic: Anthropic | undefined;
if (config.llm.provider === 'anthropic') {
  try {
    anthropic = createAnthropicClient();
  } catch (err) {
    log.error('Could not create the Anthropic client. Set ANTHROPIC_API_KEY in .env, or use LLM_PROVIDER=ollama.', err);
    process.exit(1);
  }
}

const tts = createTts(config);
const audioCache = new AudioCache();
const messages = new MessageStore(config.dataDir, config.messageWebhookUrl, log.child('messages'));
const { server, shutdown } = createServer({ config, log, tts, audioCache, messages, anthropic });

server.on('error', (err: NodeJS.ErrnoException) => {
  log.error(
    err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT in ${agentSettingsFile(config.profile)} to another port.` : 'Server error',
    err,
  );
  process.exit(1);
});

server.listen(config.port, () => {
  const { agent, stt } = config;
  const publicBase = config.publicUrl ?? 'https://<your-public-url>';
  console.log(
    [
      '',
      `  Voice agent "${agent.name}" for ${agent.company} is running${config.profile ? ` (agent profile "${config.profile}")` : ''}.`,
      '',
      `  Talk to it in your browser:   http://localhost:${config.port}`,
      `  Twilio "A call comes in":     ${publicBase}/twilio/voice   (HTTP POST)`,
      '',
      `  Model ${describeLlm(config.llm)} · speech ${stt.model} · voice ${voiceKey(config)}`,
      `  Transfers: ${agent.transferNumber ?? 'off (set TRANSFER_NUMBER)'} · records in ${config.dataDir}`,
      '',
    ].join('\n'),
  );
  void warmGreeting(config, tts, audioCache, log);
  if (config.llm.provider === 'ollama') void warmLocalModel(config, log);
});

/** Synthesizes the greeting once at startup so calls are answered without a pause. */
async function warmGreeting(cfg: AppConfig, speech: TextToSpeech, cache: AudioCache, logger: Logger): Promise<void> {
  try {
    for (const sentence of SentenceChunker.sentences(cfg.agent.greeting)) {
      const spoken = toSpeakableText(sentence);
      if (!spoken) continue;
      const chunks: Buffer[] = [];
      for await (const chunk of speech.synthesize(spoken, { signal: AbortSignal.timeout(15_000) })) chunks.push(chunk);
      cache.set(AudioCache.key(voiceKey(cfg), spoken), Buffer.concat(chunks));
    }
    logger.debug('Greeting audio ready');
  } catch (err) {
    logger.warn(`Could not prepare the greeting audio (${speech.name} text-to-speech). Calls will still work if this is temporary.`, err);
  }
}

/** Loads the local model into memory at startup, so the first call doesn't wait for it. */
async function warmLocalModel(cfg: AppConfig, logger: Logger): Promise<void> {
  const { model, ollamaUrl } = cfg.llm;
  try {
    const capabilities = await modelCapabilities(ollamaUrl, model);
    if (!capabilities.includes('tools')) {
      logger.warn(`${model} doesn't support tool calling, so the agent can't hang up, transfer, or take messages. Pick a model with tools (see README).`);
    }
    const systemPrompt = buildSystemPrompt(cfg.agent, cfg.llm.provider);
    const sizeWarning = promptSizeWarning(systemPrompt, cfg.llm.contextTokens);
    if (sizeWarning) logger.warn(sizeWarning);
    const brain = createBrain(cfg.llm, systemPrompt, buildTools({ transferEnabled: Boolean(cfg.agent.transferNumber) }));
    const started = Date.now();
    await brain.prewarm();
    logger.info(`Local model ${model} is loaded (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    // Ollama unloads idle models after 30 minutes; keep it in memory while the agent runs,
    // so a quiet hour doesn't make the next caller wait for the model to load.
    setInterval(() => brain.prewarm().catch((err: unknown) => logger.warn(`Could not keep the local model loaded: ${describeApiError(err)}`)), 20 * 60_000).unref();
  } catch (err) {
    logger.error(`Local model not ready: ${describeApiError(err)}`);
  }
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  log.info(`${signal} received, shutting down`);
  const timeout = setTimeout(() => process.exit(0), 5000);
  timeout.unref();
  await shutdown().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', reason));
