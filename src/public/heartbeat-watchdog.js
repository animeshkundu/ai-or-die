/**
 * HeartbeatWatchdog
 *
 * Sends periodic JSON `{type:'ping'}` frames over a WebSocket and force-closes
 * the socket if a `{type:'pong'}` doesn't arrive within `pongTimeoutMs`. Designed
 * so that an idle/zombie connection (NAT rebind, mobile sleep, captive portal)
 * is detected within `pingIntervalMs + pongTimeoutMs` instead of waiting for the
 * browser's TCP timeout (often 30+ seconds on cellular).
 *
 * Per-socket fencing: callers pass a `generation` value and the watchdog refuses
 * to act on stale callbacks (`clearInterval`/`clearTimeout` do NOT cancel an
 * already-queued callback — without this guard, a leftover tick from an old
 * socket can close the freshly-opened new one).
 *
 * UMD-style: works as a CommonJS module in Node (for tests) and as a global on
 * `window.HeartbeatWatchdog` in the browser.
 */
(function (global, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        global.HeartbeatWatchdog = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    const DEFAULT_PING_INTERVAL_MS = 25000;
    const DEFAULT_PONG_TIMEOUT_MS = 10000;
    const WS_OPEN = 1; // matches WebSocket.OPEN — avoid leaking globals in Node

    class HeartbeatWatchdog {
        /**
         * @param {object} opts
         * @param {object} opts.socket    WebSocket-like (must have readyState, send, close).
         * @param {number} opts.generation Caller-managed generation counter.
         * @param {() => number} opts.currentGeneration Returns the current generation. Stale callbacks (gen mismatch) are ignored.
         * @param {() => object|null} opts.currentSocket Returns the caller's current socket. Stale callbacks (socket mismatch) are ignored.
         * @param {number} [opts.pingIntervalMs=25000]
         * @param {number} [opts.pongTimeoutMs=10000]
         * @param {(msg:string)=>void} [opts.log] Optional logger for warnings.
         * @param {{setInterval:Function,clearInterval:Function,setTimeout:Function,clearTimeout:Function}} [opts.timers] Injectable for tests.
         */
        constructor(opts) {
            this._socket = opts.socket;
            this._generation = opts.generation;
            this._currentGeneration = opts.currentGeneration;
            this._currentSocket = opts.currentSocket;
            this._pingInterval = opts.pingIntervalMs || DEFAULT_PING_INTERVAL_MS;
            this._pongTimeout = opts.pongTimeoutMs || DEFAULT_PONG_TIMEOUT_MS;
            this._log = opts.log || function () {};
            const t = opts.timers || {};
            this._setInterval = t.setInterval || setInterval;
            this._clearInterval = t.clearInterval || clearInterval;
            this._setTimeout = t.setTimeout || setTimeout;
            this._clearTimeout = t.clearTimeout || clearTimeout;
            this._heartbeatTimer = null;
            this._pongTimer = null;
        }

        _isStale() {
            return this._generation !== this._currentGeneration()
                || this._socket !== this._currentSocket();
        }

        _sendPingAndArm() {
            if (this._isStale()) return;
            const ws = this._socket;
            if (!ws || ws.readyState !== WS_OPEN) return;
            try {
                ws.send(JSON.stringify({ type: 'ping' }));
            } catch (_) {
                return;
            }
            if (this._pongTimer) this._clearTimeout(this._pongTimer);
            this._pongTimer = this._setTimeout(() => {
                if (this._isStale()) return;
                this._log('pong timeout — forcing reconnect');
                try { ws.close(4000, 'pong-timeout'); } catch (_) {}
            }, this._pongTimeout);
        }

        /**
         * Begin pinging. Sends an immediate ping (so liveness is validated right
         * after connect or visibility-return — instead of waiting up to a full
         * interval), then continues at `pingIntervalMs` cadence.
         */
        start() {
            this.stop();
            const ws = this._socket;
            if (!ws || ws.readyState !== WS_OPEN) return;
            this._sendPingAndArm();
            this._heartbeatTimer = this._setInterval(
                () => this._sendPingAndArm(),
                this._pingInterval
            );
        }

        /** Cancel the watchdog. Safe to call repeatedly. */
        stop() {
            if (this._heartbeatTimer) {
                this._clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = null;
            }
            if (this._pongTimer) {
                this._clearTimeout(this._pongTimer);
                this._pongTimer = null;
            }
        }

        /** Call when a `pong` message is received from the peer. */
        onPong() {
            if (this._pongTimer) {
                this._clearTimeout(this._pongTimer);
                this._pongTimer = null;
            }
        }
    }

    return HeartbeatWatchdog;
}));
