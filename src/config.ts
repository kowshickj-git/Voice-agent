import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/** Extra agents live in agents/<name>/, each with agent.env, instructions.md and knowledge.md. */
export const PROFILES_DIR = 'agents';
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Settings that belong to one agent rather than to the whole setup. An agent
 * profile never inherits them from .env, so a second agent can't pick up the
 * first one's port, records folder, transfer number, or prompts.
 */
export const AGENT_SCOPED_KEYS: ReadonlySet<string> = new Set([
  'PORT',
  'PUBLIC_URL',
  'DATA_DIR',
  'AGENT_NAME',
  'COMPANY_NAME',
  'GREETING',
  'AGENT_LANGUAGE',
  'AGENT_EXPERTISE',
  'TRANSFER_NUMBER',
  'MESSAGE_WEBHOOK_URL',
  'AGENT_INSTRUCTIONS_FILE',
  'AGENT_KNOWLEDGE_FILE',
  'AGENT_LIBRARY_FILE',
  'STT_KEYTERMS',
  'STT_CORRECTIONS',
]);

/** The file that holds this agent's own settings: .env, or the profile's agent.env. */
export function agentSettingsFile(profile: string | undefined): string {
  return profile ? path.join(PROFILES_DIR, profile, 'agent.env') : '.env';
}

type EnvVars = Record<string, string | undefined>;

function readEnvFile(file: string): Record<string, string> | undefined {
  try {
    return dotenv.parse(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/** The agent profile chosen on the command line with `--agent=<name>` or `--agent <name>`. */
export function profileFromArgs(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--agent=')) return argv[i].slice('--agent='.length).trim() || undefined;
    if (argv[i] === '--agent') return argv[i + 1]?.trim() || undefined;
  }
  return undefined;
}

/**
 * Stacks the settings: the shell (or hosting platform), then the shared .env,
 * then the agent profile's agent.env. Each file wins over what came before (some
 * tools export generic names into the shell), but an empty placeholder like
 * `KEY=` never erases a value that is already set. A profile skips the
 * AGENT_SCOPED_KEYS in .env, which describe the main agent.
 */
export function layerEnv(shell: EnvVars, dotEnv: Record<string, string>, profile?: { name: string; env: Record<string, string> }): EnvVars {
  const env: EnvVars = { ...shell };
  const apply = (vars: Record<string, string>, skip?: ReadonlySet<string>) => {
    for (const [key, value] of Object.entries(vars)) {
      if (skip?.has(key)) continue;
      if (value !== '' || env[key] === undefined) env[key] = value;
    }
  };
  apply(dotEnv, profile ? AGENT_SCOPED_KEYS : undefined);
  if (profile) {
    apply(profile.env);
    env.AGENT_PROFILE = profile.name;
  }
  return env;
}

/** Loads .env, plus agents/<name>/agent.env when a profile is chosen with --agent or AGENT_PROFILE. */
function loadEnvFiles(root = process.cwd()): void {
  const dotEnv = readEnvFile(path.join(root, '.env')) ?? {};
  const name =
    profileFromArgs(process.argv.slice(2)) ?? (process.env.AGENT_PROFILE?.trim() || dotEnv.AGENT_PROFILE?.trim() || undefined);
  // An invalid name reads no file; loadConfig reports it.
  const profileEnv = name && PROFILE_NAME.test(name) ? readEnvFile(path.join(root, PROFILES_DIR, name, 'agent.env')) : undefined;
  const env = layerEnv(process.env, dotEnv, name ? { name, env: profileEnv ?? {} } : undefined);
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

loadEnvFiles();

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TtsProviderName = 'deepgram' | 'elevenlabs';
/** Claude through the Anthropic API, or a free model running locally in Ollama. */
export type LlmProvider = 'anthropic' | 'ollama';

/** The default local model: small enough for a 6 GB GPU, with tool calling. */
export const DEFAULT_OLLAMA_MODEL = 'qwen3:4b-instruct';

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  /** Claude only. Omitted from requests when undefined (for models that don't accept `effort`). */
  effort?: Effort;
  /** Claude only: server-side refusal fallbacks (`fallbacks: "default"`). */
  fallbacks: boolean;
  maxTokens: number;
  /** Ollama only: where the Ollama server listens. */
  ollamaUrl: string;
  /** Ollama only: context window to request (Ollama's default is just 4k tokens on GPUs under 24 GB). */
  contextTokens: number;
  /** Ollama only: sampling temperature. Low values keep small models closer to the facts. */
  temperature: number;
}

export interface SttConfig {
  model: string;
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
  keyterms: string[];
  languageHints: string[];
  /** Words the recognizer keeps getting wrong, replaced in the caller's transcript ("sunburo" → "Sungrow"). */
  corrections: SttCorrection[];
}

export interface SttCorrection {
  pattern: RegExp;
  replacement: string;
}

/**
 * Parses STT_CORRECTIONS: groups separated by ";", each "wrong|other wrong=Right".
 * Matching ignores case and only replaces whole words.
 */
export function parseSttCorrections(raw: string): { corrections: SttCorrection[]; invalid: string[] } {
  const corrections: SttCorrection[] = [];
  const invalid: string[] = [];
  for (const group of raw.split(';').map((g) => g.trim()).filter(Boolean)) {
    const [heard, right, ...extra] = group.split('=').map((part) => part.trim());
    const variants = (heard ?? '').split('|').map((v) => v.trim()).filter(Boolean);
    if (!right || extra.length || variants.length === 0) {
      invalid.push(group);
      continue;
    }
    // Longest first, so "sun grown" wins over "sun grow"; spaces match any run of spaces.
    const alternatives = variants
      .sort((a, b) => b.length - a.length)
      .map((v) => v.replace(/[.*+?^${}()[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    corrections.push({ pattern: new RegExp(`\\b(?:${alternatives.join('|')})\\b`, 'giu'), replacement: right });
  }
  return { corrections, invalid };
}

export interface TtsConfig {
  provider: TtsProviderName;
  deepgramVoice: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModel: string;
}

export interface AgentConfig {
  name: string;
  company: string;
  greeting: string;
  /** Free text such as "English" or "Spanish", or "auto" to mirror the caller's language. */
  language: string;
  /**
   * A subject the agent may also explain from general knowledge, such as
   * "solar power". Unset: it answers only from the knowledge base.
   */
  expertise?: string;
  timezone: string;
  transferNumber?: string;
  instructionsFile: string;
  knowledgeFile: string;
  /** Optional knowledge library: sections looked up per question instead of always being in the prompt. */
  libraryFile: string;
}

export interface CallConfig {
  silenceTimeoutMs: number;
  maxSilencePrompts: number;
  maxDurationMs: number;
}

export interface AppConfig {
  /** The agent profile (agents/<name>/) this server runs, or undefined for the main agent in agent/. */
  profile?: string;
  port: number;
  publicUrl?: string;
  twilioAuthToken?: string;
  deepgramApiKey: string;
  llm: LlmConfig;
  stt: SttConfig;
  tts: TtsConfig;
  agent: AgentConfig;
  call: CallConfig;
  dataDir: string;
  messageWebhookUrl?: string;
}

export interface ConfigReport {
  config: AppConfig;
  errors: string[];
  warnings: string[];
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Models that accept `fallbacks: "default"` (Claude API). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const str = (name: string, fallback = ''): string => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? fallback : value.trim();
  };
  const optional = (name: string): string | undefined => str(name) || undefined;
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = str(name);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${name} must be a number between ${min} and ${max} (got "${raw}").`);
      return fallback;
    }
    return value;
  };
  const optionalNum = (name: string, min: number, max: number): number | undefined => {
    if (!str(name)) return undefined;
    return num(name, min, min, max);
  };
  const list = (name: string): string[] =>
    str(name)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const deepgramApiKey = str('DEEPGRAM_API_KEY');
  if (!deepgramApiKey) errors.push('DEEPGRAM_API_KEY is missing. Get one at https://console.deepgram.com (used for speech recognition and the default voice).');

  const providerRaw = str('LLM_PROVIDER', 'anthropic').toLowerCase();
  if (providerRaw !== 'anthropic' && providerRaw !== 'ollama') {
    errors.push(`LLM_PROVIDER must be "anthropic" (Claude) or "ollama" (free local model), got "${providerRaw}".`);
  }
  const provider: LlmProvider = providerRaw === 'ollama' ? 'ollama' : 'anthropic';
  if (provider === 'anthropic' && !str('ANTHROPIC_API_KEY') && !str('ANTHROPIC_AUTH_TOKEN')) {
    warnings.push('ANTHROPIC_API_KEY is not set. The Anthropic SDK will look for other credentials (e.g. an `ant auth login` profile); set the key in .env, or use LLM_PROVIDER=ollama for a free local model.');
  }

  const model = str('LLM_MODEL', provider === 'ollama' ? DEFAULT_OLLAMA_MODEL : 'claude-opus-5-5');
  const effortRaw = str('LLM_EFFORT', 'low').toLowerCase();
  let effort: Effort | undefined;
  if (effortRaw === 'none' || effortRaw === 'off') effort = undefined;
  else if ((EFFORTS as readonly string[]).includes(effortRaw)) effort = effortRaw as Effort;
  else errors.push(`LLM_EFFORT must be one of ${EFFORTS.join(', ')} or "none" (got "${effortRaw}").`);
  const fallbacksRaw = str('LLM_FALLBACKS', 'auto').toLowerCase();
  const fallbacks =
    provider === 'anthropic' && (fallbacksRaw === 'auto' ? FALLBACK_MODELS.has(model) : ['1', 'true', 'on', 'yes'].includes(fallbacksRaw));
  const ollamaUrl = str('OLLAMA_URL', 'http://localhost:11434').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(ollamaUrl)) errors.push(`OLLAMA_URL must start with http:// or https:// (got "${ollamaUrl}").`);

  const sttModel = str('STT_MODEL', 'flux-general-en');
  if (!sttModel.startsWith('flux-')) errors.push(`STT_MODEL must be a Deepgram Flux model (flux-general-en or flux-general-multi), got "${sttModel}".`);
  const languageHints = list('STT_LANGUAGE_HINTS');
  const sttCorrections = parseSttCorrections(str('STT_CORRECTIONS'));
  for (const group of sttCorrections.invalid) {
    errors.push(`STT_CORRECTIONS entries look like "wrong|other wrong=Right", separated by ";" (got "${group}").`);
  }
  if (languageHints.length && sttModel !== 'flux-general-multi') {
    warnings.push('STT_LANGUAGE_HINTS is ignored unless STT_MODEL=flux-general-multi.');
  }

  const ttsProvider = str('TTS_PROVIDER', 'deepgram').toLowerCase();
  if (ttsProvider !== 'deepgram' && ttsProvider !== 'elevenlabs') errors.push(`TTS_PROVIDER must be "deepgram" or "elevenlabs" (got "${ttsProvider}").`);
  const elevenLabsApiKey = optional('ELEVENLABS_API_KEY');
  const elevenLabsVoiceId = optional('ELEVENLABS_VOICE_ID');
  if (ttsProvider === 'elevenlabs') {
    if (!elevenLabsApiKey) errors.push('TTS_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY.');
    if (!elevenLabsVoiceId) errors.push('TTS_PROVIDER=elevenlabs requires ELEVENLABS_VOICE_ID (find voice IDs in the ElevenLabs voice library).');
  }

  const profile = optional('AGENT_PROFILE');
  let agentDir = 'agent';
  if (profile) {
    agentDir = path.join(PROFILES_DIR, profile);
    if (!PROFILE_NAME.test(profile)) {
      errors.push(`Agent profile names may only use letters, digits, - and _ (got "${profile}").`);
    } else if (!fs.existsSync(path.resolve(root, agentDir))) {
      errors.push(`Agent profile "${profile}" not found. Create the folder ${agentDir} with agent.env, instructions.md and knowledge.md.`);
    } else if (!str('COMPANY_NAME')) {
      warnings.push(`COMPANY_NAME is not set for agent profile "${profile}". Set it in ${path.join(agentDir, 'agent.env')}.`);
    }
  }

  const agentName = str('AGENT_NAME', 'Ava');
  const company = str('COMPANY_NAME', 'Sunrise Dental Clinic');
  const greeting = str('GREETING', `Hi, thanks for calling ${company}. This is ${agentName}. How can I help you today?`);
  const timezone = str('TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    errors.push(`TIMEZONE "${timezone}" is not a valid IANA time zone (e.g. America/New_York, Europe/London, Asia/Kolkata).`);
  }
  const transferNumber = optional('TRANSFER_NUMBER');
  if (transferNumber && !/^\+?[0-9][0-9 ()-]{5,}$/.test(transferNumber) && !transferNumber.startsWith('sip:')) {
    errors.push(`TRANSFER_NUMBER should be a phone number in E.164 format like +14155550123 (got "${transferNumber}").`);
  }

  const twilioAuthToken = optional('TWILIO_AUTH_TOKEN');
  if (!twilioAuthToken) {
    warnings.push('TWILIO_AUTH_TOKEN is not set, so Twilio webhook signatures are NOT verified. Set it before exposing the server publicly.');
  }

  let publicUrl = optional('PUBLIC_URL');
  if (publicUrl) {
    publicUrl = publicUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(publicUrl)) errors.push(`PUBLIC_URL must start with https:// (got "${publicUrl}").`);
  }

  const config: AppConfig = {
    profile,
    port: num('PORT', 8080, 1, 65535),
    publicUrl,
    twilioAuthToken,
    deepgramApiKey,
    llm: {
      provider,
      model,
      effort,
      fallbacks,
      // Claude's budget covers its thinking too. Local models only write the short spoken reply, and
      // a low cap stops a small model that gets stuck repeating itself.
      maxTokens: num('LLM_MAX_TOKENS', provider === 'ollama' ? 300 : 4096, 100, 64000),
      ollamaUrl,
      contextTokens: num('LLM_CONTEXT_TOKENS', 8192, 2048, 262144),
      temperature: num('LLM_TEMPERATURE', 0.2, 0, 2),
    },
    stt: {
      model: sttModel,
      eotThreshold: optionalNum('STT_EOT_THRESHOLD', 0.5, 0.9),
      eagerEotThreshold: env.STT_EAGER_EOT_THRESHOLD === undefined ? 0.5 : optionalNum('STT_EAGER_EOT_THRESHOLD', 0.3, 0.9),
      eotTimeoutMs: optionalNum('STT_EOT_TIMEOUT_MS', 500, 10000),
      keyterms: list('STT_KEYTERMS'),
      corrections: sttCorrections.corrections,
      languageHints: sttModel === 'flux-general-multi' ? languageHints : [],
    },
    tts: {
      provider: ttsProvider === 'elevenlabs' ? 'elevenlabs' : 'deepgram',
      deepgramVoice: str('DEEPGRAM_VOICE', 'aura-2-thalia-en'),
      elevenLabsApiKey,
      elevenLabsVoiceId,
      elevenLabsModel: str('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
    },
    agent: {
      name: agentName,
      company,
      greeting,
      language: str('AGENT_LANGUAGE', 'English'),
      expertise: optional('AGENT_EXPERTISE'),
      timezone,
      transferNumber,
      instructionsFile: path.resolve(root, str('AGENT_INSTRUCTIONS_FILE', path.join(agentDir, 'instructions.md'))),
      knowledgeFile: path.resolve(root, str('AGENT_KNOWLEDGE_FILE', path.join(agentDir, 'knowledge.md'))),
      libraryFile: path.resolve(root, str('AGENT_LIBRARY_FILE', path.join(agentDir, 'library.md'))),
    },
    call: {
      silenceTimeoutMs: num('SILENCE_TIMEOUT_SECONDS', 10, 3, 120) * 1000,
      maxSilencePrompts: num('MAX_SILENCE_PROMPTS', 2, 0, 10),
      maxDurationMs: num('MAX_CALL_MINUTES', 20, 1, 240) * 60_000,
    },
    dataDir: path.resolve(root, str('DATA_DIR', profile ? path.join('data', profile) : 'data')),
    messageWebhookUrl: optional('MESSAGE_WEBHOOK_URL'),
  };

  const { eagerEotThreshold, eotThreshold } = config.stt;
  if (eagerEotThreshold !== undefined && eagerEotThreshold >= (eotThreshold ?? 0.7)) {
    errors.push(`STT_EAGER_EOT_THRESHOLD (${eagerEotThreshold}) must be lower than STT_EOT_THRESHOLD (${eotThreshold ?? 0.7}).`);
  }

  return { config, errors, warnings };
}
