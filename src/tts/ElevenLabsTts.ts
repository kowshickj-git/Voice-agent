import { spellOutCodes } from '../text/speechText.js';
import { connectionWarmer, errorText, readBody, TtsError, type SynthesisOptions, type TextToSpeech } from './types.js';

/** ElevenLabs streaming text-to-speech, requested as raw 8 kHz μ-law (`ulaw_8000`). */
export class ElevenLabsTts implements TextToSpeech {
  readonly name = 'elevenlabs';
  readonly warmUp: () => void;

  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly model: string,
  ) {
    this.warmUp = connectionWarmer('https://api.elevenlabs.io/v1/models', { 'xi-api-key': apiKey });
  }

  async *synthesize(text: string, { signal, previousText }: SynthesisOptions): AsyncGenerator<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=ulaw_8000`;
    const body: Record<string, unknown> = { text: spellOutCodes(text), model_id: this.model };
    if (previousText) body.previous_text = spellOutCodes(previousText);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const hint = res.status === 401 ? ' (check ELEVENLABS_API_KEY)' : res.status === 404 ? ' (check ELEVENLABS_VOICE_ID)' : '';
      throw new TtsError(`ElevenLabs TTS failed with HTTP ${res.status}${hint}: ${await errorText(res)}`, res.status);
    }
    yield* readBody(res.body);
  }
}
