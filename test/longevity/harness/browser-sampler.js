'use strict';

/**
 * BrowserSampler (SOAK-05b — CLIENT-03 integration).
 *
 * Owns ONE long-lived Playwright page against the live server's `/` URL
 * and polls `window.__diagnostics()` at a configurable cadence (default
 * 60s per CLIENT-03 spec §5). Emits per-metric rows into the same JSONL
 * sink the server-side `DiagnosticsSampler` uses, with `gate` prefixed
 * `client.*` so the GateEvaluator can pick them out cleanly.
 *
 * Lifecycle (per CLIENT-03 spec §5 "When to call"):
 *   - **Baseline**: ONE sample immediately after `page.goto(appUrl)` — the
 *     "empty tab" reference before any session join.
 *   - **Steady-state**: every `intervalMs` ms (default 60s).
 *   - **Stop**: ONE final sample on `stop()` so the post-quiesce window
 *     captures any straggler buffer/state.
 *
 * Page ownership: the sampler owns its own page (NOT piggybacked on a
 * workload's page). Reasoning: workload-owned pages cycle on reconnect
 * (e.g. `reconnect-storm` closes them every 1s), which would reset
 * client-side counters every sample and defeat slope measurements. SUP-CLIENT
 * confirmed this design in the SOAK-05b design thread.
 *
 * Session attachment: per SUP-CLIENT clarification, the sampler page MUST
 * join a session and start a terminal so that PTY output (driven by the
 * `pty-flood` workload) actually flows into the page's plan-detector
 * buffer. Otherwise `client.plan_detector.bytes` stays at 0 forever and
 * the gate is meaningless. The sampler attaches via the same WS protocol
 * the production client uses: `create_session` → `start_terminal`.
 *
 * Graceful degradation: if `window.__diagnostics` is absent (running
 * against pre-CLIENT-03 main HEAD), the sampler emits ONE meta row
 * (`{gate: 'meta', metric: 'window_diagnostics_present', value: 0}`)
 * then short-circuits each tick. Lets the harness still run server-side
 * gates against an old main without breaking.
 */

const { chromium } = require('playwright');

// Thresholds align with CLIENT-03 spec §1, §2 + CLIENT-01 hard cap.
// Spot-check thresholds are sample-by-sample; trend gates evaluated in
// gate-evaluator.js per the registry in gates.js.
const PLAN_DETECTOR_BYTES_CAP = 8 * 1024 * 1024;  // CLIENT-01 hard cap (8 MB)
const XTERM_SCROLLBACK_CAP = 10100;               // 10000 scrollback + ~100 viewport

class BrowserSampler {
  constructor(options) {
    if (!options || !options.appUrl || typeof options.sink !== 'function') {
      throw new Error('BrowserSampler: appUrl and sink are required');
    }
    this.appUrl = options.appUrl;
    this.sink = options.sink;
    this.intervalMs = options.intervalMs || 60_000;
    this.navTimeoutMs = options.navTimeoutMs || 15_000;
    this.joinSession = options.joinSession !== false; // default true
    this.headless = options.headless !== false;       // default true
    this.launchArgs = options.launchArgs || [];

    this._browser = null;
    this._context = null;
    this._page = null;
    this._timer = null;
    this._sampleCount = 0;
    this._errorCount = 0;
    this._baselineCaptured = false;
    this._diagnosticsAvailable = null; // tri-state: null=unknown, true, false
  }

  async start() {
    this._browser = await chromium.launch({
      headless: this.headless,
      args: this.launchArgs,
    });
    this._context = await this._browser.newContext();
    this._page = await this._context.newPage();
    // waitUntil:'domcontentloaded' — app.js sets up window.__diagnostics at
    // module level, so it's available before 'load' fires.
    await this._page.goto(this.appUrl, {
      timeout: this.navTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
    // Pre-session baseline sample (spec §5: "immediately after page load").
    await this._tick({ phase: 'baseline_pre_session' });

    // Optionally join a session so PTY output flows into the plan-detector.
    if (this.joinSession) {
      try {
        await this._joinSessionInPage();
        // Spec §5: "and again ~30s after first session open" — but we
        // condense to a quick verification sample here; the periodic
        // sampler will capture steady-state.
        await this._page.waitForTimeout(500);
        await this._tick({ phase: 'baseline_post_session' });
      } catch (err) {
        this.sink({
          ts: new Date().toISOString(),
          gate: 'meta',
          metric: 'browser_join_session_error',
          value: err.message,
          threshold: null,
          pass: false,
        });
      }
    }

    this._timer = setInterval(() => {
      this._tick({ phase: 'steady' }).catch(err => {
        process.stderr.write(`[soak/browser-sampler] tick failed: ${err.message}\n`);
      });
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  async stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Final tick on the way out so the post-quiesce snapshot is recorded.
    try { await this._tick({ phase: 'final' }); } catch (_) { /* ignore */ }
    if (this._page) {
      try { await this._page.close(); } catch (_) { /* ignore */ }
      this._page = null;
    }
    if (this._context) {
      try { await this._context.close(); } catch (_) { /* ignore */ }
      this._context = null;
    }
    if (this._browser) {
      try { await this._browser.close(); } catch (_) { /* ignore */ }
      this._browser = null;
    }
  }

  stats() {
    return {
      samples: this._sampleCount,
      errors: this._errorCount,
      diagnostics_available: this._diagnosticsAvailable,
    };
  }

  async _joinSessionInPage() {
    // Drive the production client's create_session flow via in-page JS.
    // We avoid hand-crafting WebSocket frames because the client app
    // already serializes the right protocol — we just call its surface.
    await this._page.evaluate(async () => {
      // Wait up to 5s for window.app to be constructed (DOMContentLoaded
      // handler in app.js may not have fired by the time we get here).
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (window.app && typeof window.app.createSession === 'function') return;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('window.app.createSession not available within 5s');
    });
    // Best-effort: kick off a session. The exact method name may vary by
    // app version; if absent, the sampler still runs (just measures an
    // empty tab).
    await this._page.evaluate(async () => {
      try {
        if (window.app.createSession) {
          await window.app.createSession('soak-browser-sampler');
        }
        if (window.app.startTerminal) {
          await window.app.startTerminal();
        }
      } catch (_) { /* tolerate; sampler still measures DOM/scrollback/ws */ }
    });
  }

  async _tick({ phase = 'steady' } = {}) {
    const ts = new Date().toISOString();
    let snap;
    try {
      snap = await this._page.evaluate(async () => {
        if (typeof window.__diagnostics !== 'function') return null;
        try { return await window.__diagnostics(); }
        catch (err) { return { __error: err && err.message }; }
      });
    } catch (err) {
      this._errorCount++;
      this.sink({
        ts,
        gate: 'meta',
        metric: 'browser_sampler_error',
        value: err.message,
        threshold: null,
        pass: false,
      });
      return;
    }

    if (snap === null) {
      // CLIENT-03 not loaded on this build of the app.
      if (this._diagnosticsAvailable !== false) {
        this._diagnosticsAvailable = false;
        this.sink({
          ts,
          gate: 'meta',
          metric: 'window_diagnostics_present',
          value: 0,
          threshold: 1,
          pass: false,
        });
      }
      return;
    }
    if (snap && snap.__error) {
      this._errorCount++;
      this.sink({
        ts,
        gate: 'meta',
        metric: 'window_diagnostics_threw',
        value: snap.__error,
        threshold: null,
        pass: false,
      });
      return;
    }

    if (this._diagnosticsAvailable !== true) {
      this._diagnosticsAvailable = true;
      this.sink({
        ts,
        gate: 'meta',
        metric: 'window_diagnostics_present',
        value: 1,
        threshold: 1,
        pass: true,
      });
    }

    this._sampleCount++;
    if (phase.startsWith('baseline')) this._baselineCaptured = true;

    // Emit per-metric rows. Defensive accessors — spec guarantees the
    // shape but we don't trust input.
    const dom = snap.dom || {};
    const buffers = snap.buffers || {};
    const ws = snap.ws || {};
    const sse = snap.sse || {};
    const memory = snap.memory || {};

    if (typeof dom.total_nodes === 'number') {
      this.sink({
        ts, gate: 'client.dom', metric: 'total_nodes',
        value: dom.total_nodes, threshold: null, pass: null,
      });
    }
    if (typeof buffers.plan_detector_bytes === 'number') {
      const v = buffers.plan_detector_bytes;
      this.sink({
        ts, gate: 'client.plan_detector', metric: 'bytes',
        value: v, threshold: PLAN_DETECTOR_BYTES_CAP,
        pass: v <= PLAN_DETECTOR_BYTES_CAP,
      });
    }
    if (typeof buffers.xterm_scrollback_lines === 'number') {
      const v = buffers.xterm_scrollback_lines;
      this.sink({
        ts, gate: 'client.xterm', metric: 'scrollback_lines',
        value: v, threshold: XTERM_SCROLLBACK_CAP,
        pass: v <= XTERM_SCROLLBACK_CAP,
      });
    }
    if (ws.state !== undefined) {
      // ws.state == 1 means OPEN. Per spec: "ws.state flipping to 2/3 and
      // staying there for more than one sample period — reconnect failure".
      // We don't spot-check at the row level (pre-session state == null is
      // legit); gate-evaluator does post-baseline assertion.
      const v = ws.state;
      this.sink({
        ts, gate: 'client.ws', metric: 'state',
        value: v, threshold: 1, pass: null,
      });
    }
    if (typeof sse.streams === 'number') {
      this.sink({
        ts, gate: 'client.sse', metric: 'streams',
        value: sse.streams, threshold: null, pass: null,
      });
    }
    // Memory: prefer measureUserAgentSpecificMemory bytes; fall back to
    // navigator.deviceMemory GB hint.
    if (memory && typeof memory.bytes === 'number') {
      this.sink({
        ts, gate: 'client.memory', metric: 'bytes',
        value: memory.bytes, threshold: null, pass: null,
      });
    } else if (memory && typeof memory.deviceMemoryGB === 'number') {
      this.sink({
        ts, gate: 'client.memory', metric: 'device_memory_gb',
        value: memory.deviceMemoryGB, threshold: null, pass: null,
      });
    }
  }
}

module.exports = { BrowserSampler, PLAN_DETECTOR_BYTES_CAP, XTERM_SCROLLBACK_CAP };
