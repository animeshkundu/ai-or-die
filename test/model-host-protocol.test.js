'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  encodeFrame,
  FrameParser,
  writeFrame,
} = require('../src/model-host-protocol');

describe('model-host binary protocol', function () {
  it('parses coalesced and arbitrarily split frames', function () {
    const parser = new FrameParser();
    const frames = [];
    parser.on('frame', (frame) => frames.push(frame));
    const one = encodeFrame({ nonce: 7, seq: 1, dtype: 'utf8', payload: 'hello' });
    const two = encodeFrame({ nonce: 7, seq: 2, dtype: 'pcm16', payload: new Int16Array([1, 2]) });
    const coalesced = Buffer.concat([one, two]);
    parser.push(coalesced.subarray(0, 3));
    parser.push(coalesced.subarray(3, HEADER_BYTES + 2));
    parser.push(coalesced.subarray(HEADER_BYTES + 2));
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].payload.toString(), 'hello');
    assert.strictEqual(frames[1].length, 4);
  });

  it('rejects an oversized declared length before waiting for allocation', function (done) {
    const parser = new FrameParser();
    parser.once('protocolError', (error) => {
      assert.match(error.message, /hard limit/);
      done();
    });
    const header = encodeFrame({ nonce: 1, seq: 1, dtype: 'utf8', payload: '' }).subarray(0, HEADER_BYTES);
    header.writeUInt32BE(MAX_PAYLOAD_BYTES + 1, 16);
    parser.push(header);
  });

  it('rejects EOF in the middle of a frame', function (done) {
    const parser = new FrameParser();
    parser.once('protocolError', (error) => {
      assert.match(error.message, /mid-frame/);
      done();
    });
    const frame = encodeFrame({ nonce: 1, seq: 1, dtype: 'utf8', payload: 'partial' });
    parser.push(frame.subarray(0, frame.length - 1));
    parser.end();
  });

  it('enforces dtype alignment and the payload hard limit at encode time', function () {
    assert.throws(
      () => encodeFrame({ nonce: 1, seq: 1, dtype: 'float32', payload: Buffer.alloc(3) }),
      /aligned/
    );
    assert.throws(
      () => encodeFrame({ nonce: 1, seq: 1, dtype: 'utf8', payload: Buffer.alloc(MAX_PAYLOAD_BYTES + 1) }),
      /hard limit/
    );
  });

  it('rejects zero correlation ids and non-zero reserved bits', function () {
    for (const mutate of [
      (frame) => frame.writeUInt32BE(0, 8),
      (frame) => frame.writeUInt32BE(0, 12),
      (frame) => frame.writeUInt16BE(1, 6),
    ]) {
      const parser = new FrameParser();
      let error;
      parser.once('protocolError', (value) => { error = value; });
      const frame = encodeFrame({ nonce: 1, seq: 1, dtype: 'utf8', payload: 'x' });
      mutate(frame);
      parser.push(frame);
      assert.ok(error, 'malformed frame must fail synchronously');
    }
  });

  it('waits for drain after backpressure and rejects write callback errors', async function () {
    class FakeStream extends EventEmitter {
      constructor(error) {
        super();
        this.error = error;
      }

      write(_frame, callback) {
        setImmediate(() => {
          callback(this.error);
          if (!this.error) this.emit('drain');
        });
        return false;
      }
    }

    await writeFrame(new FakeStream(null), Buffer.from('frame'));
    await assert.rejects(
      writeFrame(new FakeStream(new Error('EPIPE')), Buffer.from('frame')),
      /EPIPE/
    );
  });
});
