import { spellOutCodes } from '../text/speechText.js';
import { connectionWarmer, errorText, readBody, TtsError, type SynthesisOptions, type TextToSpeech } from './types.js';

/** Deepgram Aura text-to-speech, requested directly as raw 8 kHz μ-law. */
export class DeepgramTts implements TextToSpeech {
  readonly name = 'deepgram';
  readonly warmUp: () => void;

  constructor(
    private readonly apiKey: string,
    private readonly voice: string,
  ) {
    // A small authenticated request that succeeds, so the connection stays open.
    this.warmUp = connectionWarmer('https://api.deepgram.com/v1/projects', { Authorization: `Token ${apiKey}` });
  }

  async *synthesize(text: string, { signal }: SynthesisOptions): AsyncGenerator<Buffer> {
    const params = new URLSearchParams({ model: this.voice, encoding: 'mulaw', sample_rate: '8000', container: 'none' });
    const res = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spellOutCodes(text) }),
      signal,
    });
    if (!res.ok || !res.body) {
      const hint = res.status === 401 || res.status === 403 ? ' (check DEEPGRAM_API_KEY)' : '';
      throw new TtsError(`Deepgram TTS failed with HTTP ${res.status}${hint}: ${await errorText(res)}`, res.status);
    }
    yield* readBody(res.body);
  }
}
