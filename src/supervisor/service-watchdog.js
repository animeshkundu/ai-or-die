'use strict';

// ServiceWatchdog — out-of-process liveness recovery for the user-level service.
//
// Task Scheduler (and systemd/launchd) restart a process that DIED. None of them
// can distinguish "serving" from "alive but wedged": a supervisor stuck in an
// event-loop stall, or one whose respawn logic gave up after a port conflict,
// is a perfectly healthy process as far as the OS is concerned. `IgnoreNew`
// then refuses every later trigger, and the machine silently stops answering.
//
// The watchdog is a SECOND scheduled task (every 5 minutes) that only acts when
// all three independent signals agree the daemon is gone:
//   1. run/heartbeat.json is missing or older than the stale threshold,
//   2. the pid recorded in it is not alive,
//   3. GET http://127.0.0.1:<port>/api/health fails.
// Requiring all three prevents the failure mode where the health probe is
// blocked (firewall/loopback policy) while the daemon is fine, and the failure
// mode where the heartbeat is stale because the clock jumped while the server
// still answers.
//
// A debounce persisted in run/watchdog.json stops a genuinely broken install
// (e.g. missing server binary) from restarting every 5 minutes forever: after a
// restart that does not produce a fresh heartbeat, successive attempts back off
// up to a fixed ceiling.
//
// POSIX platforms use systemd/launchd Restart=always / KeepAlive and are not
// touched by this module.

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execFileSync } = require('child_process');
const { heartbeatAgeMs, readHeartbeat } = require('./heartbeat');

const DEFAULT_STALE_MS = 120000;      // 3 missed 15s beats + slack
const DEFAULT_DEBOUNCE_MS = 600000;   // 10 min between self-healing restarts
const DEFAULT_BACKOFF_MAX_MS = 3600000;
const DEFAULT_BOOT_GRACE_MS = 600000;  // 10 min for a first boot to reach ready
const DEFAULT_PORT = 7777;

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch (_) {
    return null;
  }
}

/**
 * Atomic JSON write. Never throws; calls `onError(err)` when it fails so the
 * caller can say so — a silently unwritable watchdog.json makes `restarts`
 * read back as 0 on every tick, which silently disables the exponential
 * backoff (a permanently broken install then retries at the minimum interval
 * forever).
 */
function writeJson(file, value, onError) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    if (typeof onError === 'function') {
      try { onError(err); } catch (_) { /* never let reporting break the tick */ }
    }
    return false;
  }
}

function isPidAlive(pid) {
  const n = parseInt(pid, 10);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — for a
    // same-user service that is still "alive" as far as we can tell.
    return !!(err && err.code === 'EPERM');
  }
}

/**
 * Probe `/api/health`.
 *
 * `expectProcess` guards against the failure mode where the port is served by
 * something else entirely (a stale dev server, another user's instance): a 200
 * from the wrong process would tell the watchdog the daemon is healthy while it
 * is actually wedged. A 200 therefore counts as healthy ONLY when the body
 * names a pid equal to `expectProcess`; a missing/unparseable pid, or no
 * expectation at all (no heartbeat on disk), is reported as not healthy with a
 * detail saying which case it was. An installed service always runs a
 * provisioned server that reports `pid`, so this excludes nobody real.
 */
function probeHealth(port, timeoutMs = 3000, expectProcess) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail });
    };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
        const chunks = [];
        // Bounded: a hostile or broken endpoint must not stream forever.
        res.on('data', (d) => { if (chunks.length < 16) chunks.push(d); });
        res.on('end', () => {
          if (res.statusCode !== 200) return done(false, `HTTP ${res.statusCode}`);
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { body = null; }
          // Coerce numerically: a JSON pid may arrive as a string, and
          // `'1234' === 1234` is false — that mismatch used to look like a
          // mismatch of IDENTITY rather than of type. Explicit undefined/null/''
          // checks keep Number(null) === 0 from masquerading as a real pid.
          const rawPid = body && (body.pid !== undefined && body.pid !== null
            ? body.pid
            : (body.supervisor ? body.supervisor.pid : undefined));
          const pid = (rawPid === undefined || rawPid === null || rawPid === '') ? NaN : Number(rawPid);
          const expect = (expectProcess === undefined || expectProcess === null || expectProcess === '')
            ? NaN
            : Number(expectProcess);
          if (!Number.isFinite(expect)) {
            // No heartbeat on disk means we cannot name the process that should
            // own the port, so a 200 proves nothing about OUR daemon: a stale
            // dev server squatting the port would otherwise be reported
            // healthy-but-stale forever and the wedge never repaired.
            return done(false, `HTTP ${res.statusCode} but no expected pid (no heartbeat recorded one); cannot confirm identity`);
          }
          if (!Number.isFinite(pid)) {
            // Same reasoning: an endpoint that does not name its pid cannot
            // prove it is the daemon we are guarding.
            return done(false, `HTTP ${res.statusCode} without a usable pid in the body; cannot confirm identity`);
          }
          if (pid === expect) return done(true, `HTTP ${res.statusCode} pid ${pid}`);
          return done(false, `port ${port} answered for pid ${pid}, expected ${expect}`);
        });
        res.on('error', (err) => done(false, (err && err.code) || 'response error'));
      });
    } catch (err) {
      return done(false, (err && err.message) || 'request failed');
    }
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} done(false, 'timeout'); });
    req.on('error', (err) => done(false, (err && err.code) || 'error'));
  });
}

function portFromServerArgs(args, fallback = DEFAULT_PORT) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length - 1; i += 1) {
    if (list[i] === '--port' || list[i] === '-p') {
      const n = parseInt(list[i + 1], 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) return n;
    }
  }
  for (const a of list) {
    if (typeof a === 'string' && a.startsWith('--port=')) {
      const n = parseInt(a.slice('--port='.length), 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) return n;
    }
  }
  return fallback;
}

class ServiceWatchdog {
  constructor(options = {}) {
    this._platform = options.platform || process.platform;
    this._baseDir = options.baseDir || null;
    this._execFileSync = options.execFileSync || execFileSync;
    this._logger = options.logger || console;
    this._staleMs = Number.isFinite(options.staleMs)
      ? options.staleMs
      : (parseInt(process.env.AIORDIE_WATCHDOG_STALE_MS, 10) || DEFAULT_STALE_MS);
    this._debounceMs = Number.isFinite(options.debounceMs)
      ? options.debounceMs
      : (parseInt(process.env.AIORDIE_WATCHDOG_DEBOUNCE_MS, 10) || DEFAULT_DEBOUNCE_MS);
    this._backoffMaxMs = Number.isFinite(options.backoffMaxMs)
      ? options.backoffMaxMs
      : DEFAULT_BACKOFF_MAX_MS;
    // Longest a single boot may stay in a non-ready phase before it counts as
    // wedged. SERVER_READY_TIMEOUT_MS is 30s, so 10 minutes covers a very slow
    // machine without ever masking a hung start indefinitely.
    this._bootGraceMs = Number.isFinite(options.bootGraceMs)
      ? options.bootGraceMs
      : (parseInt(process.env.AIORDIE_WATCHDOG_BOOT_GRACE_MS, 10) || DEFAULT_BOOT_GRACE_MS);
    this._now = options.now || (() => Date.now());
    this._probe = options.probeHealth || probeHealth;
    this._serviceName = options.serviceName || process.env.AIORDIE_SERVICE_NAME || 'ai-or-die';
    this._watchdogTaskName = options.watchdogTaskName || `${this._serviceName}-watchdog`;
    this._paths = null;
    // Reset per run(): the scheduler ticks every 5 minutes, so a permanently
    // unwritable state file must be reported once per tick, not on every write.
    this._stateWriteFailureLogged = false;
  }

  /**
   * Persist the debounce/backoff state. Losing this write is not fatal, but it
   * IS the difference between backing off and hammering, so say it once.
   */
  _writeState(file, value) {
    return writeJson(file, value, (err) => {
      if (this._stateWriteFailureLogged) return;
      this._stateWriteFailureLogged = true;
      const why = (err && err.message) || String(err);
      this._log(
        `cannot persist watchdog state (${file}): ${why} — restart backoff resets to 0 every tick, ` +
        'so a broken install will keep retrying at the minimum interval'
      );
    });
  }

  _resolvePaths() {
    if (this._paths) return this._paths;
    const base = this._baseDir || (() => {
      try { return require('./constants').STABLE_BASE; } catch (_) { return path.join(os.homedir(), '.ai-or-die'); }
    })();
    this._paths = {
      base,
      heartbeat: path.join(base, 'run', 'heartbeat.json'),
      state: path.join(base, 'run', 'watchdog.json'),
      log: path.join(base, 'logs', 'watchdog.log'),
      meta: path.join(base, 'service.json'),
    };
    return this._paths;
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try { this._logger.log(msg); } catch (_) { /* ignore */ }
    try {
      const p = this._resolvePaths();
      fs.mkdirSync(path.dirname(p.log), { recursive: true });
      fs.appendFileSync(p.log, `${line}\n`);
    } catch (_) { /* ignore */ }
  }

  _serverPort() {
    const p = this._resolvePaths();
    const meta = readJson(p.meta) || {};
    return portFromServerArgs(meta.serverArgs, DEFAULT_PORT);
  }

  _effectiveDebounce(restarts) {
    // 10 min, 20, 40, then capped. A permanently broken install settles at one
    // restart attempt per hour instead of hammering every 5 minutes.
    const n = Math.max(0, Math.min(8, parseInt(restarts, 10) || 0));
    return Math.min(this._backoffMaxMs, this._debounceMs * Math.pow(2, Math.max(0, n - 1)));
  }

  /**
   * Decide + (optionally) act. Returns a diagnostic object; never throws.
   * `dryRun` reports the decision without restarting anything.
   */
  async run(options = {}) {
    // One report per tick: see _stateWriteFailureLogged.
    this._stateWriteFailureLogged = false;
    const result = {
      platform: this._platform,
      acted: false,
      reason: null,
      heartbeatAgeMs: null,
      alive: null,
      healthy: null,
      restarts: 0,
    };
    if (this._platform !== 'win32' && !options.forcePlatform) {
      result.reason = 'not-applicable';
      return result;
    }
    try {
      const p = this._resolvePaths();
      const state = readJson(p.state) || { restarts: 0 };
      result.restarts = state.restarts || 0;

      const hb = readHeartbeat({ file: p.heartbeat });
      const age = heartbeatAgeMs({ file: p.heartbeat });
      result.heartbeatAgeMs = Number.isFinite(age) ? age : null;
      const pidAlive = hb ? isPidAlive(hb.pid) : false;
      result.alive = pidAlive;
      result.pid = hb ? hb.pid : null;
      result.phase = hb ? hb.phase : null;
      result.serverPid = hb && hb.status && hb.status.serverPid ? hb.status.serverPid : null;

      if (age <= this._staleMs && pidAlive) {
        result.reason = 'heartbeat-fresh';
        // Healthy again: forget the backoff so the NEXT outage is handled fast.
        if (state.restarts) this._writeState(p.state, { restarts: 0, updatedAt: new Date().toISOString() });
        return result;
      }

      // A daemon that is still BOOTING (phase boot/init, never ready) writes one
      // beacon and then goes quiet until the server answers. A slow first boot
      // must not be treated as a wedge, or the watchdog would kill it mid-start
      // and the install self-test would never see a heartbeat.
      if (hb && hb.phase && hb.phase !== 'ready' && hb.phase !== 'shutdown') {
        const startedAt = Number.isFinite(hb.startedAtMs) ? hb.startedAtMs : (Date.now() - age);
        const bootingFor = this._now() - startedAt;
        if (bootingFor < this._bootGraceMs) {
          result.reason = 'booting';
          result.bootGraceRemainingMs = this._bootGraceMs - bootingFor;
          return result;
        }
      }

      const port = this._serverPort();
      result.port = port;
      // The health endpoint answers from the SERVER process, not the supervisor
      // (the supervisor holds no HTTP listener), so the pid to expect is the one
      // the heartbeat records under status.serverPid. Coerced numerically: a
      // stringified pid would otherwise be dropped as "no expectation" and a
      // perfectly healthy daemon would be restarted as a foreign squatter.
      const serverPidRaw = hb && hb.status ? hb.status.serverPid : undefined;
      const serverPidNum = (serverPidRaw === undefined || serverPidRaw === null || serverPidRaw === '')
        ? NaN
        : Number(serverPidRaw);
      const serverPid = Number.isFinite(serverPidNum) ? serverPidNum : undefined;
      const health = await this._probe(port, undefined, serverPid);
      result.healthy = !!health.ok;
      result.healthDetail = health.detail;
      if (health.ok) {
        // Serving but not beating: report, never restart (a restart would drop
        // live sessions for a daemon that is answering requests).
        result.reason = 'healthy-but-stale';
        if (!options.quiet) {
          const ageText = Number.isFinite(age) ? `${Math.round(age / 1000)}s old` : 'missing';
          this._log(`${result.reason}: heartbeat ${ageText}, /api/health OK (${health.detail}); not restarting`);
        }
        return result;
      }

      const lastAttempt = state.lastAttemptMs || 0;
      const waitMs = this._effectiveDebounce(state.restarts) - (this._now() - lastAttempt);
      if (lastAttempt && waitMs > 0) {
        result.reason = 'debounced';
        result.debounceRemainingMs = waitMs;
        return result;
      }

      if (options.dryRun) {
        result.reason = 'would-restart';
        return result;
      }

      this._log(
        `restarting ${this._serviceName}: heartbeat ${Number.isFinite(age) ? Math.round(age / 1000) + 's old' : 'missing'}, ` +
        `pid ${hb && hb.pid ? hb.pid : '?'} ${pidAlive ? 'alive' : 'dead'}, /api/health ${health.detail}`
      );
      const restartOutcome = this._restart();
      const nextState = {
        restarts: (state.restarts || 0) + 1,
        lastAttemptMs: this._now(),
        lastAttemptAt: new Date().toISOString(),
        lastOutcome: restartOutcome,
      };
      this._writeState(p.state, nextState);
      result.acted = restartOutcome.ok;
      result.reason = restartOutcome.ok ? 'restarted' : 'restart-failed';
      result.restartDetail = restartOutcome.detail;
      result.restarts = nextState.restarts;
      this._log(`restart ${restartOutcome.ok ? 'issued' : 'FAILED'}: ${restartOutcome.detail || ''}`.trim());
      return result;
    } catch (err) {
      result.reason = 'error';
      result.error = (err && err.message) || String(err);
      try { this._log(`watchdog error: ${result.error}`); } catch (_) { /* ignore */ }
      return result;
    }
  }

  _restart() {
    const verbs = [];
    const step = (args) => {
      try {
        // stdio: 'pipe' — schtasks writes "ERROR: ..." to stderr on failure and
        // execFileSync would inherit it into the watchdog log next to the
        // structured verdict.
        this._execFileSync('schtasks', args, { encoding: 'utf8', stdio: 'pipe' });
        verbs.push(`${args.join(' ')}: ok`);
        return { ok: true };
      } catch (err) {
        verbs.push(`${args.join(' ')}: ${(err && err.message) || 'failed'}`);
        return { ok: false, err };
      }
    };
    // /end first: /run is ignored (IgnoreNew) while a wedged instance holds the
    // task, so a bare /run would silently do nothing forever.
    step(['/end', '/tn', this._serviceName]);
    const ran = step(['/run', '/tn', this._serviceName]);
    return { ok: ran.ok, detail: verbs.join('; ') };
  }

  /** Register/unregister the watchdog task itself (win32 only). */
  watchdogXmlPath() {
    return path.join(this._resolvePaths().base, 'ai-or-die-watchdog-task.xml');
  }

  buildWatchdogXml(nodePath, supervisorPath, options = {}) {
    const { quoteArg, escapeXml } = require('./service-installer');
    const args = [supervisorPath, 'service', 'watchdog'];
    const mode = options.mode === 'boot' ? 'boot' : 'login';
    const userId = options.userId || null;
    // The watchdog must run in the SAME session mode as the service it guards.
    // An InteractiveToken watchdog cannot run at boot before login, which is
    // exactly the case (headless boot mode) where a wedge would otherwise go
    // unnoticed until someone logged in.
    const principal = mode === 'boot'
      ? [
        '    <Principal id="Author">',
        ...(userId ? [`      <UserId>${escapeXml(userId)}</UserId>`] : []),
        '      <LogonType>S4U</LogonType>',
        '      <RunLevel>LeastPrivilege</RunLevel>',
        '    </Principal>',
      ]
      : [
        '    <Principal id="Author">',
        '      <LogonType>InteractiveToken</LogonType>',
        '      <RunLevel>LeastPrivilege</RunLevel>',
        '    </Principal>',
      ];
    const triggers = [];
    if (mode === 'boot') {
      // Wait out the same boot delay as the service, then start ticking. The
      // TimeTrigger repetition below keeps the 5-minute cadence afterwards.
      triggers.push(
        '    <BootTrigger>',
        '      <Enabled>true</Enabled>',
        '      <Delay>PT2M</Delay>',
        '    </BootTrigger>'
      );
    }
    triggers.push(
      '    <TimeTrigger>',
      '      <StartBoundary>2026-01-01T00:00:00</StartBoundary>',
      '      <Enabled>true</Enabled>',
      '      <Repetition>',
      '        <Interval>PT5M</Interval>',
      '        <StopAtDurationEnd>false</StopAtDurationEnd>',
      '      </Repetition>',
      '    </TimeTrigger>'
    );
    return [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo>',
      '    <Author>ai-or-die</Author>',
      '    <Description>ai-or-die service watchdog (out-of-process liveness recovery)</Description>',
      '    <Version>1.0</Version>',
      '  </RegistrationInfo>',
      '  <Principals>',
      ...principal,
      '  </Principals>',
      '  <Triggers>',
      ...triggers,
      '  </Triggers>',
      '  <Actions Context="Author">',
      '    <Exec>',
      `      <Command>${escapeXml(nodePath)}</Command>`,
      `      <Arguments>${escapeXml(args.map(quoteArg).join(' '))}</Arguments>`,
      `      <WorkingDirectory>${escapeXml(this._resolvePaths().base)}</WorkingDirectory>`,
      '    </Exec>',
      '  </Actions>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>',
      '    <StartWhenAvailable>true</StartWhenAvailable>',
      '    <AllowStartOnDemand>true</AllowStartOnDemand>',
      '    <AllowHardTerminate>true</AllowHardTerminate>',
      '    <Enabled>true</Enabled>',
      '    <Hidden>true</Hidden>',
      '  </Settings>',
      '</Task>',
      '',
    ].join('\n');
  }
}

module.exports = {
  ServiceWatchdog,
  probeHealth,
  isPidAlive,
  portFromServerArgs,
  DEFAULT_STALE_MS,
  DEFAULT_BOOT_GRACE_MS,
  DEFAULT_DEBOUNCE_MS,
};
