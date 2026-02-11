'use strict';

/**
 * Generate minimal WAV audio fixture files for voice input tests.
 * These contain silence or simple tones — content doesn't matter
 * because STT is mocked in tests.
 *
 * Run: node test/fixtures/generate-wav.js
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a WAV file buffer with the given parameters.
 * @param {number} durationSec - Duration in seconds
 * @param {number} sampleRate - Sample rate (e.g., 16000)
 * @param {'silence'|'tone'} type - Audio content type
 * @returns {Buffer}
 */
function createWav(durationSec, sampleRate, type) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const bytesPerSample = 2; // 16-bit PCM
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);          // chunk size
  buffer.writeUInt16LE(1, 20);           // PCM format
  buffer.writeUInt16LE(1, 22);           // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32);              // block align
  buffer.writeUInt16LE(16, 34);          // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Audio data
  if (type === 'tone') {
    const freq = 440; // A4
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(Math.sin(2 * Math.PI * freq * i / sampleRate) * 16000);
      buffer.writeInt16LE(sample, 44 + i * 2);
    }
  }
  // 'silence' leaves the buffer as zeros

  return buffer;
}

const fixturesDir = __dirname;

// hello-world.wav — 5 seconds of 440Hz tone at 16kHz mono
const helloWorld = createWav(5, 16000, 'tone');
fs.writeFileSync(path.join(fixturesDir, 'hello-world.wav'), helloWorld);
console.log('Created hello-world.wav (%d bytes)', helloWorld.length);

// silence.wav — 3 seconds of silence at 16kHz mono
const silence = createWav(3, 16000, 'silence');
fs.writeFileSync(path.join(fixturesDir, 'silence.wav'), silence);
console.log('Created silence.wav (%d bytes)', silence.length);
