import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeSample, decodeToFloat32, encodeFloat32, encodeSample } from '../public/mulaw.js';

test('silence encodes to 0xFF and decodes back to 0', () => {
  assert.equal(encodeSample(0), 0xff);
  assert.equal(decodeSample(0xff), 0);
});

test('round trip stays within μ-law quantization error', () => {
  for (let s = -32768; s <= 32767; s += 97) {
    const back = decodeSample(encodeSample(s));
    // μ-law step size grows with amplitude: at most ~1/16 of the value (plus a small floor).
    const tolerance = Math.max(16, Math.abs(s) / 16);
    assert.ok(Math.abs(back - s) <= tolerance, `sample ${s} decoded to ${back}`);
  }
});

test('sign and extremes', () => {
  assert.ok(decodeSample(encodeSample(1000)) > 0, "decodeSample(encodeSample(1000)) > 0");
  assert.ok(decodeSample(encodeSample(-1000)) < 0, "decodeSample(encodeSample(-1000)) < 0");
  assert.ok(decodeSample(encodeSample(32767)) > 30000, "decodeSample(encodeSample(32767)) > 30000");
  assert.ok(decodeSample(encodeSample(-32768)) < -30000, "decodeSample(encodeSample(-32768)) < -30000");
});

test('float helpers convert whole buffers', () => {
  const input = new Float32Array([0, 0.5, -0.5, 0.99, -0.99]);
  const bytes = encodeFloat32(input);
  assert.equal(bytes.length, input.length);
  const output = decodeToFloat32(bytes);
  for (let i = 0; i < input.length; i++) assert.ok(Math.abs(output[i] - input[i]) < 0.04, `index ${i}`);
});
