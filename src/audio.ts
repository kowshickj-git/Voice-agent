/** Phone audio on Twilio media streams: 8 kHz, 8-bit μ-law, mono — one byte per sample. */
export const SAMPLE_RATE = 8000;
export const BYTES_PER_MS = SAMPLE_RATE / 1000;

/** μ-law encodes silence as 0xFF. */
export const MULAW_SILENCE_BYTE = 0xff;

export function bytesToMs(bytes: number): number {
  return bytes / BYTES_PER_MS;
}

export function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round(ms * BYTES_PER_MS), MULAW_SILENCE_BYTE);
}
