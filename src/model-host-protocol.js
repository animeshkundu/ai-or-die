'use strict';

const { EventEmitter } = require('events');

const MAGIC = Buffer.from('AOD1');
const HEADER_BYTES = 20;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const DTYPES = Object.freeze({
  pcm16: 1,
  float32: 2,
  utf8: 3,
});
const DTYPE_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(DTYPES).map(([name, value]) => [value, name])
));
const ELEMENT_BYTES = Object.freeze({ pcm16: 2, float32: 4, utf8: 1 });

function normalizePayload(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  throw new TypeError('Model-host payload must be a Buffer, typed array, ArrayBuffer, or string');
}

function encodeFrame({ nonce, seq, dtype, payload }) {
  const dtypeCode = DTYPES[dtype];
  if (!dtypeCode) throw new Error(`Unsupported model-host dtype: ${dtype}`);
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 0xffffffff) {
    throw new Error('Model-host sequence must be an unsigned 32-bit integer');
  }
  if (!Number.isSafeInteger(nonce) || nonce < 1 || nonce > 0xffffffff) {
    throw new Error('Model-host nonce must be an unsigned 32-bit integer');
  }
  const body = normalizePayload(payload);
  if (body.length > MAX_PAYLOAD_BYTES) throw new Error('Model-host payload exceeds hard limit');
  const elementBytes = ELEMENT_BYTES[dtype];
  if (body.length % elementBytes !== 0) {
    throw new Error(`Model-host ${dtype} payload length is not aligned to ${elementBytes} bytes`);
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  MAGIC.copy(frame, 0);
  frame.writeUInt8(1, 4);
  frame.writeUInt8(dtypeCode, 5);
  frame.writeUInt16BE(0, 6);
  frame.writeUInt32BE(nonce, 8);
  frame.writeUInt32BE(seq, 12);
  frame.writeUInt32BE(body.length, 16);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

class FrameParser extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxPayloadBytes = options.maxPayloadBytes || MAX_PAYLOAD_BYTES;
    this._buffer = Buffer.alloc(0);
    this._failed = false;
  }

  push(chunk) {
    if (this._failed || !chunk || chunk.length === 0) return;
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, input]) : input;
    this._drain();
  }

  end() {
    if (!this._failed && this._buffer.length) {
      this._fail(new Error('Model-host payload pipe ended mid-frame'));
    }
  }

  reset() {
    this._buffer = Buffer.alloc(0);
    this._failed = false;
  }

  _drain() {
    while (!this._failed && this._buffer.length >= HEADER_BYTES) {
      if (!this._buffer.subarray(0, 4).equals(MAGIC)) {
        this._fail(new Error('Invalid model-host frame magic'));
        return;
      }
      if (this._buffer.readUInt8(4) !== 1) {
        this._fail(new Error('Unsupported model-host frame version'));
        return;
      }
      if (this._buffer.readUInt16BE(6) !== 0) {
        this._fail(new Error('Invalid model-host frame reserved bits'));
        return;
      }
      const dtypeCode = this._buffer.readUInt8(5);
      const dtype = DTYPE_NAMES[dtypeCode];
      if (!dtype) {
        this._fail(new Error('Invalid model-host frame dtype'));
        return;
      }
      const length = this._buffer.readUInt32BE(16);
      const nonce = this._buffer.readUInt32BE(8);
      const seq = this._buffer.readUInt32BE(12);
      if (nonce === 0 || seq === 0) {
        this._fail(new Error('Invalid model-host frame correlation id'));
        return;
      }
      if (length > this.maxPayloadBytes) {
        this._fail(new Error('Model-host frame length exceeds hard limit'));
        return;
      }
      if (length % ELEMENT_BYTES[dtype] !== 0) {
        this._fail(new Error('Model-host frame dtype/length mismatch'));
        return;
      }
      if (this._buffer.length < HEADER_BYTES + length) return;
      const frame = {
        nonce,
        seq,
        dtype,
        length,
        payload: Buffer.from(this._buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)),
      };
      this._buffer = this._buffer.subarray(HEADER_BYTES + length);
      this.emit('frame', frame);
    }
  }

  _fail(error) {
    this._failed = true;
    this._buffer = Buffer.alloc(0);
    this.emit('protocolError', error);
  }
}

function writeFrame(stream, frame) {
  return new Promise((resolve, reject) => {
    let callbackDone = false;
    let drained = true;
    let settled = false;
    const finish = () => {
      if (!settled && callbackDone && drained) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      drained = true;
      finish();
    };
    const onError = (error) => fail(error);
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    stream.once('error', onError);
    try {
      drained = stream.write(frame, (error) => {
        if (error) return fail(error);
        callbackDone = true;
        finish();
      });
      if (!drained) stream.once('drain', onDrain);
    } catch (error) {
      fail(error);
    }
  });
}

module.exports = {
  MAGIC,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  DTYPES,
  encodeFrame,
  FrameParser,
  writeFrame,
};
