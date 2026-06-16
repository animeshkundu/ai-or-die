'use strict';

/**
 * Convert 16-bit PCM samples to normalized Float32 [-1, 1).
 *
 * Divisor is 32768.0 for every sample (matching the original server-side
 * conversion): positive full-scale 32767 maps to ~0.99997, negative full-scale
 * -32768 maps to exactly -1.0. Used by the STT worker (off the server event
 * loop) and exercised directly in unit tests.
 *
 * @param {Int16Array} int16
 * @returns {Float32Array}
 */
function pcm16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    out[i] = int16[i] / 32768.0;
  }
  return out;
}

module.exports = { pcm16ToFloat32 };
