const assert = require('assert');
const HeartbeatWatchdog = require('../src/public/heartbeat-watchdog');

// Fake clock so we can simulate timer fires deterministically without sleeping.
function createFakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map(); // id -> { fireAt, fn, recurring, intervalMs }

    function advance(ms) {
        const target = now + ms;
        // Repeatedly fire the earliest-due timer until none are due.
        // (Tasks may schedule new timers; recurring timers re-arm themselves.)
        // Snapshot guard against infinite loops in pathological tests.
        let safety = 10000;
        while (safety-- > 0) {
            let dueId = null;
            let dueAt = Infinity;
            for (const [id, t] of timers) {
                if (t.fireAt <= target && t.fireAt < dueAt) {
                    dueId = id;
                    dueAt = t.fireAt;
                }
            }
            if (dueId === null) break;
            const t = timers.get(dueId);
            now = t.fireAt;
            if (t.recurring) {
                t.fireAt = now + t.intervalMs;
                t.fn();
            } else {
                timers.delete(dueId);
                t.fn();
            }
        }
        now = target;
    }

    return {
        timers: {
            setTimeout: (fn, ms) => {
                const id = nextId++;
                timers.set(id, { fireAt: now + ms, fn, recurring: false });
                return id;
            },
            clearTimeout: (id) => { timers.delete(id); },
            setInterval: (fn, ms) => {
                const id = nextId++;
                timers.set(id, { fireAt: now + ms, fn, recurring: true, intervalMs: ms });
                return id;
            },
            clearInterval: (id) => { timers.delete(id); },
        },
        advance,
        now: () => now,
        pendingCount: () => timers.size,
    };
}

// Minimal WebSocket stub — captures sent frames, exposes close() and readyState.
function createFakeSocket() {
    const sent = [];
    const ws = {
        readyState: 1, // OPEN
        sent,
        closed: false,
        closeCode: null,
        closeReason: null,
        send(data) {
            if (this.readyState !== 1) throw new Error('socket not open');
            sent.push(data);
        },
        close(code, reason) {
            this.closed = true;
            this.closeCode = code;
            this.closeReason = reason;
            this.readyState = 3; // CLOSED
        },
    };
    return ws;
}

function makeWatchdog({ socket, gen = 1, currentGen, currentSock, timers, pingMs = 25000, pongMs = 10000, log }) {
    return new HeartbeatWatchdog({
        socket,
        generation: gen,
        currentGeneration: currentGen || (() => gen),
        currentSocket: currentSock || (() => socket),
        timers,
        pingIntervalMs: pingMs,
        pongTimeoutMs: pongMs,
        log,
    });
}

describe('HeartbeatWatchdog', () => {
    describe('start()', () => {
        it('sends an immediate ping when socket is OPEN', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            const wd = makeWatchdog({ socket: ws, timers: clock.timers });

            wd.start();

            assert.strictEqual(ws.sent.length, 1);
            assert.deepStrictEqual(JSON.parse(ws.sent[0]), { type: 'ping' });
        });

        it('does not start if socket is not OPEN', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            ws.readyState = 0; // CONNECTING
            const wd = makeWatchdog({ socket: ws, timers: clock.timers });

            wd.start();

            assert.strictEqual(ws.sent.length, 0);
            assert.strictEqual(clock.pendingCount(), 0);
        });

        it('arms a recurring ping on the configured interval', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            const wd = makeWatchdog({ socket: ws, timers: clock.timers, pingMs: 25000, pongMs: 10000 });

            wd.start();
            assert.strictEqual(ws.sent.length, 1, 'immediate ping');

            // Pong arrives immediately so the pong-timer is cleared.
            wd.onPong();

            clock.advance(25000);
            assert.strictEqual(ws.sent.length, 2, 'second ping after interval');

            wd.onPong();
            clock.advance(25000);
            assert.strictEqual(ws.sent.length, 3, 'third ping after second interval');

            wd.stop();
        });

        it('clears any prior heartbeat before starting (idempotent restart)', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            const wd = makeWatchdog({ socket: ws, timers: clock.timers, pingMs: 25000 });

            wd.start();
            wd.start(); // restart immediately

            // Only one heartbeat interval should be active.
            wd.onPong();
            clock.advance(25000);
            // Two pings total: one from each start()'s immediate ping, plus one from the interval.
            // The first start's interval was cleared, so we get 1+1+1 = 3 only if both intervals fired.
            // Correct count: 2 immediate pings + 1 interval tick = 3.
            assert.strictEqual(ws.sent.length, 3);
            wd.onPong();
            clock.advance(25000);
            assert.strictEqual(ws.sent.length, 4, 'still only one active interval');

            wd.stop();
        });
    });

    describe('pong-timeout watchdog', () => {
        it('force-closes the socket when pong does not arrive within the window', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            const logged = [];
            const wd = makeWatchdog({
                socket: ws, timers: clock.timers,
                pingMs: 25000, pongMs: 10000,
                log: (m) => logged.push(m),
            });

            wd.start();
            assert.strictEqual(ws.sent.length, 1);
            assert.strictEqual(ws.closed, false);

            // Advance just under the pong window — socket still open.
            clock.advance(9999);
            assert.strictEqual(ws.closed, false);

            // Cross the pong-timeout boundary — socket should be force-closed.
            clock.advance(2);
            assert.strictEqual(ws.closed, true);
            assert.strictEqual(ws.closeCode, 4000);
            assert.strictEqual(ws.closeReason, 'pong-timeout');
            assert.ok(logged.some(m => m.includes('pong timeout')));
        });

        it('does NOT close the socket when pong arrives in time', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            const wd = makeWatchdog({ socket: ws, timers: clock.timers, pongMs: 10000 });

            wd.start();
            clock.advance(5000);
            wd.onPong(); // within the 10s window

            clock.advance(20000); // well past where the timeout would have fired
            assert.strictEqual(ws.closed, false);

            wd.stop();
        });

        it('arms a fresh pong-timer for each ping', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            const wd = makeWatchdog({ socket: ws, timers: clock.timers, pingMs: 25000, pongMs: 10000 });

            wd.start();
            wd.onPong();

            // Next interval ping fires; 10s later, no pong = close.
            clock.advance(25000);
            assert.strictEqual(ws.sent.length, 2);
            assert.strictEqual(ws.closed, false);
            clock.advance(10001);
            assert.strictEqual(ws.closed, true);
        });
    });

    describe('per-socket fencing', () => {
        it('a stale heartbeat tick (generation moved on) does NOT send a ping', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            let currentGen = 1;
            const wd = makeWatchdog({
                socket: ws, gen: 1, timers: clock.timers, pingMs: 25000,
                currentGen: () => currentGen,
            });

            wd.start();
            assert.strictEqual(ws.sent.length, 1);
            wd.onPong();

            // Caller starts a new socket — generation advances — but the OLD
            // watchdog's interval is still queued.
            currentGen = 2;
            clock.advance(25000);

            // Stale tick must NOT send another ping.
            assert.strictEqual(ws.sent.length, 1, 'stale interval did not fire');
            assert.strictEqual(ws.closed, false, 'stale tick did not close socket');
        });

        it('a stale pong-timer (generation moved on) does NOT close the socket', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            let currentGen = 1;
            const wd = makeWatchdog({
                socket: ws, gen: 1, timers: clock.timers, pongMs: 10000,
                currentGen: () => currentGen,
            });

            wd.start();
            assert.strictEqual(ws.sent.length, 1);
            // Pong did not arrive — but caller has moved on.
            currentGen = 2;

            clock.advance(15000);
            assert.strictEqual(ws.closed, false, 'stale pong-timer did not close the (now-irrelevant) socket');
        });

        it('a stale callback (socket replaced) does NOT close the new socket', () => {
            const clock = createFakeClock();
            const oldWs = createFakeSocket();
            const newWs = createFakeSocket();
            let currentSock = oldWs;
            const wd = makeWatchdog({
                socket: oldWs, gen: 1, timers: clock.timers, pongMs: 10000,
                currentSock: () => currentSock,
            });

            wd.start();
            // Caller swaps socket without calling stop() (e.g., race during reconnect).
            currentSock = newWs;

            clock.advance(15000);

            // Old socket might be closed (it's stale anyway) — what matters is the NEW socket is untouched.
            assert.strictEqual(newWs.closed, false);
            assert.strictEqual(newWs.sent.length, 0);
        });
    });

    describe('stop()', () => {
        it('cancels pending heartbeat and pong timers', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            const wd = makeWatchdog({ socket: ws, timers: clock.timers });

            wd.start();
            wd.stop();

            clock.advance(60000);
            assert.strictEqual(ws.sent.length, 1, 'no further pings after stop()');
            assert.strictEqual(ws.closed, false, 'pong-timer cancelled');
            assert.strictEqual(clock.pendingCount(), 0, 'no pending timers');
        });

        it('is safe to call multiple times', () => {
            const clock = createFakeClock();
            const ws = createFakeSocket();
            const wd = makeWatchdog({ socket: ws, timers: clock.timers });

            wd.start();
            wd.stop();
            wd.stop();
            wd.stop();
            // No exception thrown; nothing scheduled.
            assert.strictEqual(clock.pendingCount(), 0);
        });
    });

    describe('module loading', () => {
        it('exports a class via CommonJS', () => {
            assert.strictEqual(typeof HeartbeatWatchdog, 'function');
            assert.strictEqual(HeartbeatWatchdog.name, 'HeartbeatWatchdog');
        });
    });
});
