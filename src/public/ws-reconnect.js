/**
 * ws-reconnect.js — decide whether a WebSocket `close` should auto-reconnect.
 *
 * Extracted from the main socket's onclose so the decision is unit-testable.
 * UMD-style: CommonJS in Node (tests) and `window.WsReconnect` in the browser.
 */
(function (global, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        global.WsReconnect = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    /**
     * @param {{wasClean?: boolean, code?: number}} event  the WebSocket CloseEvent
     * @param {boolean} [voiceRejected]  true when the server rejected a frame
     *        (1009/1003) — a CLEAN server close that must still reconnect.
     * @returns {boolean} whether the caller should attempt a reconnect.
     */
    function isReconnectableClose(event, voiceRejected) {
        if (!event) return false;
        // - Abnormal / non-clean closes (wasClean falsy): network drop, crash.
        // - Our OWN heartbeat pong-timeout close (code 4000): a CLEAN client
        //   close, so it MUST be listed explicitly — otherwise a detected dead
        //   socket would NOT reconnect and would strand the user on
        //   "Disconnected" until a manual refresh (the bug this fixes).
        // - Server frame rejection (1009/1003), surfaced as voiceRejected.
        return !event.wasClean || event.code === 4000 || !!voiceRejected;
    }

    return { isReconnectableClose: isReconnectableClose };
}));
