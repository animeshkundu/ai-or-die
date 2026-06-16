/**
 * VoiceFrame
 *
 * Pure helpers for the client->server binary voice path, factored out of app.js
 * so they can be unit-tested in Node. Mirrors the UMD shape of
 * heartbeat-watchdog.js (CommonJS in tests, `window.VoiceFrame` in the browser).
 */
(function (global, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        global.VoiceFrame = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    // Wire header: [ "VUP1" (4) ][ version (1) ][ type (1) ] then raw 16-bit PCM.
    var MAGIC_V = 0x56; // 'V'
    var MAGIC_U = 0x55; // 'U'
    var MAGIC_P = 0x50; // 'P'
    var MAGIC_1 = 0x31; // '1'
    var PROTO_VERSION = 0x01;
    var FRAME_TYPE_PCM = 0x01;
    var HEADER_BYTES = 6;

    /**
     * Build a binary voice frame: the 6-byte header followed by the PCM bytes of
     * `samples`. Uses byteOffset/byteLength so a subarray-backed Int16Array is
     * copied correctly (not the whole underlying buffer).
     *
     * @param {Int16Array} samples
     * @returns {Uint8Array}
     */
    function buildVoiceFrame(samples) {
        var pcm = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
        var frame = new Uint8Array(HEADER_BYTES + pcm.length);
        frame[0] = MAGIC_V;
        frame[1] = MAGIC_U;
        frame[2] = MAGIC_P;
        frame[3] = MAGIC_1;
        frame[4] = PROTO_VERSION;
        frame[5] = FRAME_TYPE_PCM;
        frame.set(pcm, HEADER_BYTES);
        return frame;
    }

    /**
     * Classify a WebSocket close code for the voice path.
     *
     * 1009 (server rejected an oversized frame) and 1003 (unsupported/garbage
     * binary) are server-initiated CLEAN closes, so `event.wasClean` is true and
     * the default onclose path would SKIP reconnect and dead-end on
     * "refresh the page". Treat them as recoverable: show a specific message and
     * still reconnect (bounded by the normal attempt budget).
     *
     * @param {number} code
     * @returns {{rejected: boolean, message: (string|null)}}
     */
    function classifyVoiceClose(code) {
        if (code === 1009 || code === 1003) {
            return {
                rejected: true,
                message: 'A voice message was rejected by the server. Reconnecting…'
            };
        }
        return { rejected: false, message: null };
    }

    return {
        HEADER_BYTES: HEADER_BYTES,
        buildVoiceFrame: buildVoiceFrame,
        classifyVoiceClose: classifyVoiceClose
    };
}));
