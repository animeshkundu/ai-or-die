'use strict';

/**
 * Inbound binary voice-frame framing (client mic -> server STT).
 *
 * Wire format:
 *   [4 bytes ASCII "VUP1"][1 byte version][1 byte type][raw 16-bit PCM @16kHz mono]
 *
 * Pure (no I/O) so the dispatcher logic in server.js can be unit-tested without
 * a live socket — in particular the Buffer[] (fragmented frame) normalization,
 * which is the one genuinely platform-dependent receive path.
 */

const VOICE_MAGIC = Buffer.from('VUP1', 'ascii');
const VOICE_PROTO_VERSION = 1;
const VOICE_FRAME_TYPE_PCM = 0x01;
const VOICE_HEADER_BYTES = 6; // magic(4) + version(1) + type(1)
const MAX_VOICE_PCM_BYTES = 3840000; // 120 s @ 16 kHz / 16-bit / mono
const MAX_VOICE_BINARY_FRAME_BYTES = VOICE_HEADER_BYTES + MAX_VOICE_PCM_BYTES;

/**
 * Normalize ws RawData to a single Buffer. ws delivers a Buffer when the frame
 * is un-fragmented, a Buffer[] when it arrived in multiple WS continuation
 * fragments (1-4 MB voice frames fragment variably across browsers/proxies/
 * tunnels), or an ArrayBuffer under non-default options. Always size-check the
 * RESULT of this, never the raw message (whose `.length` is the fragment count
 * for an array).
 *
 * The concatenation is bounded: the ws server's `maxPayload` (8 MiB) caps the
 * total message length during fragment reassembly and closes 1009 before the
 * 'message' event fires, so this never concatenates more than 8 MiB.
 *
 * @param {Buffer|Buffer[]|ArrayBuffer|ArrayBufferView} message
 * @returns {Buffer}
 */
function normalizeBinaryMessage(message) {
  if (Buffer.isBuffer(message)) return message;
  if (Array.isArray(message)) return Buffer.concat(message);
  return Buffer.from(message);
}

/**
 * Classify a normalized binary frame.
 *  - { action: 'oversize' }    -> caller closes 1009 (message too big)
 *  - { action: 'unsupported' } -> caller closes 1003 (bad/short/unknown header)
 *  - { action: 'pcm', pcm }    -> caller hands `pcm` (Buffer) to the STT core
 *
 * @param {Buffer} buf  Normalized frame (see normalizeBinaryMessage).
 * @returns {{action: string, pcm?: Buffer}}
 */
function classifyVoiceFrame(buf) {
  if (buf.length > MAX_VOICE_BINARY_FRAME_BYTES) {
    return { action: 'oversize' };
  }
  if (buf.length < VOICE_HEADER_BYTES
    || !buf.subarray(0, 4).equals(VOICE_MAGIC)
    || buf[4] !== VOICE_PROTO_VERSION
    || buf[5] !== VOICE_FRAME_TYPE_PCM) {
    return { action: 'unsupported' };
  }
  return { action: 'pcm', pcm: buf.subarray(VOICE_HEADER_BYTES) };
}

module.exports = {
  VOICE_MAGIC,
  VOICE_PROTO_VERSION,
  VOICE_FRAME_TYPE_PCM,
  VOICE_HEADER_BYTES,
  MAX_VOICE_PCM_BYTES,
  MAX_VOICE_BINARY_FRAME_BYTES,
  normalizeBinaryMessage,
  classifyVoiceFrame,
};
