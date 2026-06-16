'use strict';

// Pure-function unit tests for the binary voice path. No server / socket — these
// cover the client frame builder, the close-code classifier, the server-side
// frame normalize/classify (incl. the Buffer[] fragmented-frame path), and the
// int16->float32 conversion.

const assert = require('assert');
const VoiceFrame = require('../src/public/voice-frame.js');
const {
  normalizeBinaryMessage,
  classifyVoiceFrame,
  VOICE_MAGIC,
  MAX_VOICE_BINARY_FRAME_BYTES,
  MAX_VOICE_PCM_BYTES,
} = require('../src/utils/ws-voice-frame.js');
const { pcm16ToFloat32 } = require('../src/utils/pcm.js');

function header() {
  // "VUP1" + version 1 + type 1
  return Buffer.from([0x56, 0x55, 0x50, 0x31, 0x01, 0x01]);
}

describe('voice-frame: client buildVoiceFrame', function () {
  it('prepends the 6-byte VUP1 header and the PCM bytes', function () {
    const samples = new Int16Array([1, -1, 32767, -32768]);
    const frame = VoiceFrame.buildVoiceFrame(samples);

    assert.strictEqual(frame.length, 6 + samples.byteLength);
    assert.deepStrictEqual(
      Array.from(frame.subarray(0, 6)),
      [0x56, 0x55, 0x50, 0x31, 0x01, 0x01]
    );
    // PCM bytes match the samples' raw little-endian bytes.
    const expected = new Uint8Array(samples.buffer);
    assert.deepStrictEqual(Array.from(frame.subarray(6)), Array.from(expected));
  });

  it('copies a subarray-backed Int16Array correctly (nonzero byteOffset)', function () {
    const big = new Int16Array([9, 9, 1, 2, 3, 9]);
    const sub = big.subarray(2, 5); // [1, 2, 3], byteOffset = 4
    assert.strictEqual(sub.byteOffset, 4);

    const frame = VoiceFrame.buildVoiceFrame(sub);
    assert.strictEqual(frame.length, 6 + 6); // 3 samples * 2 bytes
    const expected = new Uint8Array(new Int16Array([1, 2, 3]).buffer);
    assert.deepStrictEqual(Array.from(frame.subarray(6)), Array.from(expected));
  });
});

describe('voice-frame: client classifyVoiceClose', function () {
  it('flags 1009 and 1003 as recoverable server rejections', function () {
    assert.strictEqual(VoiceFrame.classifyVoiceClose(1009).rejected, true);
    assert.strictEqual(VoiceFrame.classifyVoiceClose(1003).rejected, true);
    assert.strictEqual(typeof VoiceFrame.classifyVoiceClose(1009).message, 'string');
  });

  it('does not flag normal/abnormal network closes', function () {
    assert.strictEqual(VoiceFrame.classifyVoiceClose(1000).rejected, false);
    assert.strictEqual(VoiceFrame.classifyVoiceClose(1006).rejected, false);
    assert.strictEqual(VoiceFrame.classifyVoiceClose(4000).rejected, false);
  });
});

describe('ws-voice-frame: normalizeBinaryMessage', function () {
  it('passes a Buffer through unchanged', function () {
    const b = Buffer.from([1, 2, 3]);
    assert.strictEqual(normalizeBinaryMessage(b), b);
  });

  it('concatenates a Buffer[] (fragmented frame) into one Buffer', function () {
    const parts = [Buffer.from([1, 2]), Buffer.from([3, 4, 5])];
    const out = normalizeBinaryMessage(parts);
    assert.ok(Buffer.isBuffer(out));
    assert.strictEqual(out.length, 5);
    assert.deepStrictEqual(Array.from(out), [1, 2, 3, 4, 5]);
  });

  it('wraps an ArrayBuffer into a Buffer', function () {
    const ab = new Uint8Array([7, 8, 9]).buffer;
    const out = normalizeBinaryMessage(ab);
    assert.ok(Buffer.isBuffer(out));
    assert.deepStrictEqual(Array.from(out), [7, 8, 9]);
  });
});

describe('ws-voice-frame: classifyVoiceFrame', function () {
  it('accepts a well-formed frame and returns the PCM slice', function () {
    const pcm = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    const frame = Buffer.concat([header(), pcm]);
    const v = classifyVoiceFrame(frame);
    assert.strictEqual(v.action, 'pcm');
    assert.deepStrictEqual(Array.from(v.pcm), Array.from(pcm));
  });

  it('classifies an over-size frame as oversize (-> 1009)', function () {
    const frame = Buffer.alloc(MAX_VOICE_BINARY_FRAME_BYTES + 1);
    assert.strictEqual(classifyVoiceFrame(frame).action, 'oversize');
  });

  it('accepts a frame at exactly the max and rejects one byte over', function () {
    const atMax = Buffer.alloc(MAX_VOICE_BINARY_FRAME_BYTES);
    header().copy(atMax, 0);
    assert.strictEqual(classifyVoiceFrame(atMax).action, 'pcm');
    assert.strictEqual(classifyVoiceFrame(atMax).pcm.length, MAX_VOICE_PCM_BYTES);
  });

  it('rejects a short frame (< 6 bytes) as unsupported (-> 1003)', function () {
    assert.strictEqual(classifyVoiceFrame(Buffer.from(VOICE_MAGIC)).action, 'unsupported');
  });

  it('rejects bad magic, wrong version, and wrong type', function () {
    const badMagic = Buffer.concat([Buffer.from([0x58, 0x58, 0x58, 0x58, 1, 1]), Buffer.from([0, 0])]);
    assert.strictEqual(classifyVoiceFrame(badMagic).action, 'unsupported');

    const badVer = Buffer.concat([Buffer.from([0x56, 0x55, 0x50, 0x31, 2, 1]), Buffer.from([0, 0])]);
    assert.strictEqual(classifyVoiceFrame(badVer).action, 'unsupported');

    const badType = Buffer.concat([Buffer.from([0x56, 0x55, 0x50, 0x31, 1, 9]), Buffer.from([0, 0])]);
    assert.strictEqual(classifyVoiceFrame(badType).action, 'unsupported');
  });
});

describe('pcm: pcm16ToFloat32', function () {
  it('normalizes 16-bit samples to [-1, 1) using /32768', function () {
    const out = pcm16ToFloat32(new Int16Array([0, 32767, -32768, 16384]));
    assert.strictEqual(out.length, 4);
    assert.ok(Math.abs(out[0] - 0) < 1e-9);
    assert.ok(Math.abs(out[1] - 32767 / 32768) < 1e-9);
    assert.ok(Math.abs(out[2] - -1.0) < 1e-9);
    assert.ok(Math.abs(out[3] - 0.5) < 1e-9);
  });
});

describe('stt-engine: _toInt16Array', function () {
  const SttEngine = require('../src/stt-engine.js');
  const engine = new SttEngine({}); // not initialized — no worker/model

  it('copies into a fresh, solely-owned buffer (safe to transfer)', function () {
    const src = new Int16Array([5, 6]);
    const out = engine._toInt16Array(src);
    assert.deepStrictEqual(Array.from(out), [5, 6]);
    assert.notStrictEqual(out.buffer, src.buffer, 'must own a fresh buffer');
    assert.strictEqual(out.byteOffset, 0);
  });

  it('floors an odd-length input to whole 16-bit samples (no RangeError)', function () {
    const out = engine._toInt16Array(Buffer.from([1, 2, 3])); // 3 bytes -> 1 sample
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0], 1 | (2 << 8)); // little-endian 0x0201 = 513
  });

  it('reads only the viewed region of a subarray-backed Buffer', function () {
    const big = Buffer.from([9, 9, 1, 0, 2, 0, 9, 9]);
    const view = big.subarray(2, 6); // bytes [1,0,2,0] -> int16 [1, 2]
    const out = engine._toInt16Array(view);
    assert.deepStrictEqual(Array.from(out), [1, 2]);
  });
});
