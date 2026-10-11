import type { AppConfig } from '../config.js';
import { DeepgramTts } from './DeepgramTts.js';
import { ElevenLabsTts } from './ElevenLabsTts.js';
import type { TextToSpeech } from './types.js';

export function createTts(config: AppConfig): TextToSpeech {
  const { tts } = config;
  if (tts.provider === 'elevenlabs') {
    return new ElevenLabsTts(tts.elevenLabsApiKey ?? '', tts.elevenLabsVoiceId ?? '', tts.elevenLabsModel);
  }
  return new DeepgramTts(config.deepgramApiKey, tts.deepgramVoice);
}

/** Identifies the voice in use, for caching synthesized audio. */
export function voiceKey(config: AppConfig): string {
  const { tts } = config;
  return tts.provider === 'elevenlabs' ? `elevenlabs:${tts.elevenLabsVoiceId}:${tts.elevenLabsModel}` : `deepgram:${tts.deepgramVoice}`;
}

/** Keeps synthesized audio for fixed phrases (like the greeting) so they play instantly. */
export class AudioCache {
  private readonly entries = new Map<string, Buffer>();

  constructor(private readonly maxEntries = 64) {}

  static key(voice: string, text: string): string {
    return `${voice}|${text}`;
  }

  get(key: string): Buffer | undefined {
    return this.entries.get(key);
  }

  set(key: string, audio: Buffer): void {
    if (audio.length === 0) return;
    this.entries.delete(key);
    this.entries.set(key, audio);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export type { TextToSpeech } from './types.js';
