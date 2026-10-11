// G.711 μ-law codec (the 8 kHz format phone networks and Twilio use).

const BIAS = 0x84;
const CLIP = 32635;

/** Encodes one signed 16-bit PCM sample to a μ-law byte. */
export function encodeSample(sample) {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decodes one μ-law byte to a signed 16-bit PCM sample. */
export function decodeSample(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

const DECODE_TABLE = new Float32Array(256);
for (let i = 0; i < 256; i++) DECODE_TABLE[i] = decodeSample(i) / 32768;

/** Float32 samples in [-1, 1] → μ-law bytes. */
export function encodeFloat32(samples) {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = encodeSample(samples[i] * 32767);
  return out;
}

/** μ-law bytes → Float32 samples in [-1, 1]. */
export function decodeToFloat32(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = DECODE_TABLE[bytes[i]];
  return out;
}
