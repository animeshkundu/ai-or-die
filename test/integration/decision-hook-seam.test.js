#!/usr/bin/env node
'use strict';

// Live seam verifier for ai-or-die mobile-mode Channel-1 decisions.
//
// This intentionally uses REAL processes on the two checked-out repos:
//   - ai-or-die: node bin/ai-or-die.js --port <ephemeral> --auth <token>
//   - github-router: node dist/main.js internal-decision-hook
//
// Run directly from the ai-or-die repo after building github-router:
//   node test/integration/decision-hook-seam.test.js
//
// Mocha integration is opt-in because this test depends on a sibling checkout of
// github-router and spawns cross-repo binaries:
//   AIORDIE_DECISION_HOOK_SEAM=1 npx mocha --timeout 60000 test/integration/decision-hook-seam.test.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const AI_OR_DIE_ROOT = path.resolve(__dirname, '..', '..');
const GITHUB_ROUTER_ROOT = process.env.GITHUB_ROUTER_ROOT
  ? path.resolve(process.env.GITHUB_ROUTER_ROOT)
  : path.resolve(AI_OR_DIE_ROOT, '..', 'github-router');
const HOOK_MAIN = process.env.GITHUB_ROUTER_HOOK_MAIN
  ? path.resolve(process.env.GITHUB_ROUTER_HOOK_MAIN)
  : path.join(GITHUB_ROUTER_ROOT, 'dist', 'main.js');

// CI-safe live seam requirement: github-router must be checked out on branch
// feat/mobile-mode-decision-hook and built via its build step producing dist/main.js.
let githubRouterRepoPresent = false;
try { githubRouterRepoPresent = fs.statSync(GITHUB_ROUTER_ROOT).isDirectory(); } catch (_) {}
if (!githubRouterRepoPresent) {
  console.log(`SKIP: github-router repo not found at ${GITHUB_ROUTER_ROOT}; requires the github-router sibling repo on branch feat/mobile-mode-decision-hook, built via its build step producing dist/main.js`);
  process.exit(0);
}
if (!fs.existsSync(HOOK_MAIN)) {
  console.log(`SKIP: github-router built binary not found at ${HOOK_MAIN}; requires the github-router sibling repo on branch feat/mobile-mode-decision-hook, built via its build step`);
  process.exit(0);
}

const WebSocket = require('ws');

const AUTH_TOKEN = 'decision-seam-token';
const CASE_WALL_MS = 12000;
const NO_VIEWER_WALL_MS = 7000;
const VIEWER_TIMEOUT_WALL_MS = 8000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && address.port;
      server.close(() => resolve(port));
    });
  });
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    err.responseText = text;
    throw err;
  }
}

async function requestJson(baseUrl, method, pathname, body) {
  const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  if (text) {
    try { json = JSON.parse(text); }
    catch (_) { json = { nonJsonBody: text }; }
  }
  if (!response.ok) {
    const err = new Error(`${method} ${pathname} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
    err.status = response.status;
    err.body = json;
    throw err;
  }
  return json;
}

function captureProcess(child, name) {
  const chunks = { stdout: [], stderr: [] };
  child.stdout && child.stdout.on('data', (buf) => chunks.stdout.push(Buffer.from(buf)));
  child.stderr && child.stderr.on('data', (buf) => chunks.stderr.push(Buffer.from(buf)));
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({
        name,
        code,
        signal,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });
    });
  });
  return { chunks, exit };
}

async function waitForHealth(baseUrl, serverCapture, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      serverCapture.exit.then((result) => ({ exited: true, result })),
      sleep(1).then(() => ({ exited: false })),
    ]);
    if (exited.exited) {
      throw new Error(`ai-or-die exited before health was ready: code=${exited.result.code} signal=${exited.result.signal}\nstdout=${exited.result.stdout}\nstderr=${exited.result.stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      if (response.ok) {
        const json = await readJsonResponse(response);
        if (json && json.status === 'ok') return json;
      } else {
        lastErr = new Error(`health HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for /api/health${lastErr ? `; last error: ${lastErr.message}` : ''}`);
}

async function startAiOrDie() {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiordie-decision-seam-'));
  const childHome = path.join(scratchRoot, 'home');
  const localAppData = path.join(scratchRoot, 'localappdata');
  const appData = path.join(scratchRoot, 'appdata');
  fs.mkdirSync(childHome, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const port = await pickFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = [
    'bin/ai-or-die.js',
    '--port', String(port),
    '--auth', AUTH_TOKEN,
    '--no-stt',
    '--no-sticky-notes',
    '--no-keepalive',
  ];
  const child = spawn(process.execPath, args, {
    cwd: AI_OR_DIE_ROOT,
    env: {
      ...process.env,
      HOME: childHome,
      USERPROFILE: childHome,
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
      CI: '1',
      STT_DISABLED: '1',
      AIORDIE_DISABLE_STICKY_NOTES: '1',
      AIORDIE_DISABLE_KEEPALIVE: '1',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const capture = captureProcess(child, 'ai-or-die');

  await waitForHealth(baseUrl, capture, 30000);

  return {
    port,
    baseUrl,
    child,
    capture,
    scratchRoot,
    command: `${process.execPath} ${args.join(' ')}`,
    async stop() {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGTERM'); } catch (_) {}
        const done = await Promise.race([
          capture.exit.then((result) => ({ result })),
          sleep(5000).then(() => ({ timeout: true })),
        ]);
        if (done.timeout && child.exitCode == null && child.signalCode == null) {
          try { child.kill('SIGKILL'); } catch (_) {}
          await Promise.race([capture.exit, sleep(2000)]);
        }
      }
      try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

async function createAiOrDieSession(baseUrl, name) {
  const created = await requestJson(baseUrl, 'POST', '/api/sessions/create', { name });
  if (!created || typeof created.sessionId !== 'string' || !created.sessionId) {
    throw new Error(`create session returned no sessionId: ${JSON.stringify(created)}`);
  }
  return created.sessionId;
}

function writeMirror(claudeConfigDir, baseUrl, sessionId) {
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  const mirror = {
    baseUrl,
    token: AUTH_TOKEN,
    sessionId,
    insecureTLS: false,
  };
  const mirrorPath = path.join(claudeConfigDir, '.aiordie-artifact.json');
  fs.writeFileSync(mirrorPath, JSON.stringify(mirror, null, 2));
  return { mirror, mirrorPath };
}

function startHookProcess({ stdin, claudeConfigDir, sessionId, wallMs, extraEnv }) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [HOOK_MAIN, 'internal-decision-hook'], {
    cwd: GITHUB_ROUTER_ROOT,
    env: {
      ...process.env,
      AIORDIE_SESSION_ID: sessionId,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      NO_COLOR: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const capture = captureProcess(child, 'internal-decision-hook');
  child.stdin.end(stdin);

  let timedOut = false;
  const wall = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch (_) {}
  }, wallMs);
  if (typeof wall.unref === 'function') wall.unref();

  const result = capture.exit.then((out) => {
    clearTimeout(wall);
    return { ...out, timedOut, durationMs: Date.now() - startedAt };
  });

  return { child, result };
}

async function waitForDecision(baseUrl, sessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const listed = await requestJson(baseUrl, 'GET', `/api/control/sessions/${encodeURIComponent(sessionId)}/decisions`);
    last = listed;
    const decisions = Array.isArray(listed.decisions) ? listed.decisions : [];
    const match = decisions.find(predicate || (() => true));
    if (match) return match;
    await sleep(25);
  }
  throw new Error(`timed out waiting for decision; last=${JSON.stringify(last)}`);
}

async function listDecisions(baseUrl, sessionId) {
  const listed = await requestJson(baseUrl, 'GET', `/api/control/sessions/${encodeURIComponent(sessionId)}/decisions`);
  return Array.isArray(listed.decisions) ? listed.decisions : [];
}

async function answerDecision(baseUrl, decisionId, choice) {
  return requestJson(baseUrl, 'POST', `/api/control/decisions/${encodeURIComponent(decisionId)}/answer`, { choice });
}

async function awaitDecisionStatus(baseUrl, decisionId, timeoutMs) {
  return requestJson(baseUrl, 'GET', `/api/control/decisions/${encodeURIComponent(decisionId)}/await?timeoutMs=${encodeURIComponent(String(timeoutMs))}`);
}

function waitForWsMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for WebSocket message ${type}`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
      ws.removeListener('error', onError);
    }

    function onMessage(raw, isBinary) {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (msg.type === type) {
        cleanup();
        resolve(msg);
      } else if (msg.type === 'error' && type !== 'error') {
        cleanup();
        reject(new Error(`WebSocket error while waiting for ${type}: ${msg.message || JSON.stringify(msg)}`));
      }
    }

    function onClose() {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for ${type}`));
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

async function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch (_) {}
      resolve();
    }, 2000);
    if (typeof timer.unref === 'function') timer.unref();
    ws.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    try { ws.close(); } catch (_) {
      try { ws.terminate(); } catch (__) {}
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    }
  });
}

async function joinSessionViewer(ctx, sessionId) {
  const url = `ws://127.0.0.1:${ctx.port}/?token=${encodeURIComponent(AUTH_TOKEN)}`;
  const ws = new WebSocket(url);
  try {
    const connected = await waitForWsMessage(ws, 'connected', 5000);
    ws.send(JSON.stringify({ type: 'join_session', sessionId }));
    const joined = await waitForWsMessage(ws, 'session_joined', 5000);
    assert.strictEqual(joined.sessionId, sessionId, 'viewer joined the target session');
    return { ws, url, connected, joined };
  } catch (err) {
    await closeWebSocket(ws);
    throw err;
  }
}

function parseDenyStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const hookOutput = parsed && parsed.hookSpecificOutput;
    if (hookOutput && hookOutput.permissionDecision === 'deny') return hookOutput;
    return null;
  } catch (_) {
    return null;
  }
}

function bashPayload(command) {
  return JSON.stringify({
    session_id: 'claude-hook-session-id-does-not-key-aiordie',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: AI_OR_DIE_ROOT,
  });
}

function planPayload(plan) {
  return JSON.stringify({
    session_id: 'claude-hook-session-id-does-not-key-aiordie',
    tool_name: 'ExitPlanMode',
    tool_input: { plan },
    cwd: AI_OR_DIE_ROOT,
  });
}

const NORMAL_HOOK_ENV = {
  GH_ROUTER_DECISION_HOOK_MAX_HUMAN_WAIT_MS: '10000',
  GH_ROUTER_DECISION_HOOK_POLL_TIMEOUT_MS: '5000',
  GH_ROUTER_DECISION_HOOK_SELF_DEADLINE_MS: '12000',
};

const NO_VIEWER_HOOK_ENV = {
  GH_ROUTER_DECISION_HOOK_MAX_HUMAN_WAIT_MS: '3000',
  GH_ROUTER_DECISION_HOOK_POLL_TIMEOUT_MS: '200',
  GH_ROUTER_DECISION_HOOK_SELF_DEADLINE_MS: '5000',
};

const VIEWER_TIMEOUT_HOOK_ENV = {
  GH_ROUTER_DECISION_HOOK_MAX_HUMAN_WAIT_MS: '2000',
  GH_ROUTER_DECISION_HOOK_POLL_TIMEOUT_MS: '250',
  GH_ROUTER_DECISION_HOOK_SELF_DEADLINE_MS: '6000',
};

async function runCase(ctx, spec) {
  const caseScratch = fs.mkdtempSync(path.join(ctx.scratchRoot, `${spec.name.toLowerCase()}-`));
  const sessionId = await createAiOrDieSession(ctx.baseUrl, `decision-hook-seam-${spec.name}`);
  const claudeConfigDir = path.join(caseScratch, 'claude-config');
  const { mirrorPath } = writeMirror(claudeConfigDir, ctx.baseUrl, sessionId);

  const hook = startHookProcess({
    stdin: spec.stdin,
    claudeConfigDir,
    sessionId,
    wallMs: spec.wallMs || CASE_WALL_MS,
    extraEnv: spec.extraEnv || NORMAL_HOOK_ENV,
  });

  let decision = null;
  let answerResult = null;
  let caseError = null;

  try {
    if (spec.answerChoice) {
      decision = await waitForDecision(ctx.baseUrl, sessionId, spec.decisionPredicate, 5000);
      answerResult = await answerDecision(ctx.baseUrl, decision.decisionId, spec.answerChoice);
    } else {
      // Observe the live create path without answering. If the hook wins the race
      // and returns first, the pending decision remains listable and is checked
      // after the hook result below.
      try {
        decision = await waitForDecision(ctx.baseUrl, sessionId, spec.decisionPredicate, 1000);
      } catch (_) {
        // Deliberately ignored until after the hook exits.
      }
    }
  } catch (err) {
    caseError = err;
  }

  const hookResult = await hook.result;

  if (!decision) {
    try {
      const decisions = await listDecisions(ctx.baseUrl, sessionId);
      decision = decisions.find(spec.decisionPredicate || (() => true)) || decisions[0] || null;
    } catch (err) {
      if (!caseError) caseError = err;
    }
  }

  const deny = parseDenyStdout(hookResult.stdout);
  const allow = hookResult.code === 0 && !hookResult.timedOut && !deny;

  let pass = false;
  const assertions = [];
  try {
    assert.strictEqual(hookResult.timedOut, false, 'hook exceeded wall-clock cap');
    assert.strictEqual(hookResult.code, 0, 'hook exit code');
    assert.ok(decision, 'decision was registered and listable');
    if (spec.expectedKind) assert.strictEqual(decision.kind, spec.expectedKind, 'decision kind');
    if (spec.expectedPlan !== undefined) assert.strictEqual(decision.plan, spec.expectedPlan, 'decision plan');
    if (spec.expectedTool !== undefined) assert.strictEqual(decision.tool, spec.expectedTool, 'decision tool');
    if (spec.expectedCommand !== undefined) assert.strictEqual(decision.command, spec.expectedCommand, 'decision command');
    if (spec.answerChoice) assert.deepStrictEqual(answerResult, { ok: true }, 'answer route result');
    if (spec.expectAllow) assert.ok(allow, 'expected allow (exit 0 and no deny JSON)');
    if (spec.expectDeny) {
      assert.ok(deny, 'expected deny JSON on stdout');
      if (spec.expectedDenyReasonIncludes) {
        assert.ok(String(deny.permissionDecisionReason || '').includes(spec.expectedDenyReasonIncludes), `deny reason includes ${spec.expectedDenyReasonIncludes}`);
      }
    }
    if (caseError) throw caseError;
    pass = true;
  } catch (err) {
    assertions.push(err.message || String(err));
  }

  return {
    name: spec.name,
    pass,
    sessionId,
    mirrorPath,
    decision,
    answerResult,
    hook: {
      command: `${process.execPath} ${HOOK_MAIN} internal-decision-hook`,
      exitCode: hookResult.code,
      signal: hookResult.signal,
      timedOut: hookResult.timedOut,
      durationMs: hookResult.durationMs,
      stdout: hookResult.stdout,
      stderr: hookResult.stderr,
      deny,
    },
    assertions,
  };
}

async function runViewerTimeoutCase(ctx) {
  const name = 'VIEWER-TIMEOUT';
  const caseScratch = fs.mkdtempSync(path.join(ctx.scratchRoot, `${name.toLowerCase()}-`));
  const sessionId = await createAiOrDieSession(ctx.baseUrl, `decision-hook-seam-${name}`);
  const claudeConfigDir = path.join(caseScratch, 'claude-config');
  const { mirrorPath } = writeMirror(claudeConfigDir, ctx.baseUrl, sessionId);

  let viewer = null;
  let hook = null;
  let decision = null;
  let awaitStatus = null;
  let caseError = null;

  try {
    viewer = await joinSessionViewer(ctx, sessionId);

    hook = startHookProcess({
      stdin: bashPayload('echo SEAM'),
      claudeConfigDir,
      sessionId,
      wallMs: VIEWER_TIMEOUT_WALL_MS,
      extraEnv: VIEWER_TIMEOUT_HOOK_ENV,
    });

    try {
      decision = await waitForDecision(ctx.baseUrl, sessionId, null, 5000);
      awaitStatus = await awaitDecisionStatus(ctx.baseUrl, decision.decisionId, 1);
    } catch (err) {
      caseError = err;
    }

    const hookResult = await hook.result;
    const deny = parseDenyStdout(hookResult.stdout);
    const denyReason = deny && deny.permissionDecisionReason ? String(deny.permissionDecisionReason) : '';

    if (!decision) {
      try {
        const decisions = await listDecisions(ctx.baseUrl, sessionId);
        decision = decisions[0] || null;
      } catch (err) {
        if (!caseError) caseError = err;
      }
    }

    const assertions = [];
    let pass = false;
    try {
      assert.strictEqual(hookResult.timedOut, false, 'hook exceeded wall-clock cap');
      assert.strictEqual(hookResult.code, 0, 'hook exit code');
      assert.ok(decision, 'decision was registered and listable');
      assert.strictEqual(decision.kind, 'tool_approval', 'decision kind');
      assert.strictEqual(decision.tool, 'Bash', 'decision tool');
      assert.strictEqual(decision.command, 'echo SEAM', 'decision command');
      assert.ok(awaitStatus && awaitStatus.answered === false, `decision await should still be unanswered: ${JSON.stringify(awaitStatus)}`);
      assert.ok(awaitStatus.viewers > 0, `viewer count should be >0 after join_session: ${JSON.stringify(awaitStatus)}`);
      assert.ok(deny, 'expected deny JSON on stdout');
      assert.ok(/wait|deadline|timeout|timed out/i.test(denyReason), `deny reason mentions wait/deadline/timeout: ${denyReason}`);
      assert.ok(!denyReason.includes('no mobile reviewer connected'), `deny reason must not be no-reviewer branch: ${denyReason}`);
      if (caseError) throw caseError;
      pass = true;
    } catch (err) {
      assertions.push(err.message || String(err));
    }

    return {
      name,
      pass,
      sessionId,
      mirrorPath,
      decision,
      answerResult: null,
      viewer: viewer ? {
        url: viewer.url,
        connectionId: viewer.connected && viewer.connected.connectionId,
        joined: viewer.joined,
        awaitStatus,
        registeredViewers: awaitStatus && typeof awaitStatus.viewers === 'number' ? awaitStatus.viewers : null,
      } : null,
      hook: {
        command: `${process.execPath} ${HOOK_MAIN} internal-decision-hook`,
        exitCode: hookResult.code,
        signal: hookResult.signal,
        timedOut: hookResult.timedOut,
        durationMs: hookResult.durationMs,
        stdout: hookResult.stdout,
        stderr: hookResult.stderr,
        deny,
      },
      env: VIEWER_TIMEOUT_HOOK_ENV,
      assertions,
    };
  } catch (err) {
    const hookResult = hook ? await hook.result : null;
    const deny = hookResult ? parseDenyStdout(hookResult.stdout) : null;
    return {
      name,
      pass: false,
      sessionId,
      mirrorPath,
      decision,
      answerResult: null,
      viewer: viewer ? {
        url: viewer.url,
        connectionId: viewer.connected && viewer.connected.connectionId,
        joined: viewer.joined,
        awaitStatus,
        registeredViewers: awaitStatus && typeof awaitStatus.viewers === 'number' ? awaitStatus.viewers : null,
      } : null,
      hook: hookResult ? {
        command: `${process.execPath} ${HOOK_MAIN} internal-decision-hook`,
        exitCode: hookResult.code,
        signal: hookResult.signal,
        timedOut: hookResult.timedOut,
        durationMs: hookResult.durationMs,
        stdout: hookResult.stdout,
        stderr: hookResult.stderr,
        deny,
      } : {
        command: `${process.execPath} ${HOOK_MAIN} internal-decision-hook`,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: null,
        stdout: '',
        stderr: '',
        deny: null,
      },
      env: VIEWER_TIMEOUT_HOOK_ENV,
      assertions: [err && err.message ? err.message : String(err)],
    };
  } finally {
    if (viewer && viewer.ws) await closeWebSocket(viewer.ws);
  }
}

async function runHarness() {
  const ctx = await startAiOrDie();
  const planText = '# Plan\n- prove the live decision seam\n- report the result';
  try {
    const cases = [];
    cases.push(await runCase(ctx, {
      name: 'ACCEPT',
      stdin: bashPayload('echo SEAM'),
      answerChoice: 'accept',
      expectedKind: 'tool_approval',
      expectedTool: 'Bash',
      expectedCommand: 'echo SEAM',
      expectAllow: true,
    }));
    cases.push(await runCase(ctx, {
      name: 'REJECT',
      stdin: bashPayload('echo SEAM'),
      answerChoice: 'reject',
      expectedKind: 'tool_approval',
      expectedTool: 'Bash',
      expectedCommand: 'echo SEAM',
      expectDeny: true,
      expectedDenyReasonIncludes: 'choice=reject',
    }));
    cases.push(await runCase(ctx, {
      name: 'NO-VIEWER',
      stdin: bashPayload('echo SEAM'),
      expectedKind: 'tool_approval',
      expectedTool: 'Bash',
      expectedCommand: 'echo SEAM',
      expectDeny: true,
      expectedDenyReasonIncludes: 'no mobile reviewer connected',
      extraEnv: NO_VIEWER_HOOK_ENV,
      wallMs: NO_VIEWER_WALL_MS,
    }));
    cases.push(await runViewerTimeoutCase(ctx));
    cases.push(await runCase(ctx, {
      name: 'PLAN',
      stdin: planPayload(planText),
      answerChoice: 'accept',
      expectedKind: 'plan_approval',
      expectedPlan: planText,
      expectAllow: true,
    }));

    return {
      ok: cases.every((c) => c.pass),
      aiOrDie: {
        command: ctx.command,
        baseUrl: ctx.baseUrl,
      },
      hook: {
        root: GITHUB_ROUTER_ROOT,
        main: HOOK_MAIN,
        command: `${process.execPath} ${HOOK_MAIN} internal-decision-hook`,
      },
      contract: {
        mirror: 'CLAUDE_CONFIG_DIR/.aiordie-artifact.json with {baseUrl, token, sessionId, insecureTLS}',
        envGate: 'AIORDIE_SESSION_ID must be non-empty; hook uses mirror.sessionId for the ai-or-die /api/control session id',
        auth: 'hook sends Authorization: Bearer <token>; harness ran ai-or-die with --auth and used the same token',
        endpoints: [
          'GET /api/health',
          'POST /api/sessions/create',
          'POST /api/control/sessions/:id/decision',
          'GET /api/control/sessions/:id/decisions',
          'POST /api/control/decisions/:decisionId/answer',
          'GET /api/control/decisions/:decisionId/await?timeoutMs=',
        ],
      },
      cases,
    };
  } finally {
    await ctx.stop();
  }
}

async function main() {
  const report = await runHarness();
  for (const c of report.cases) {
    console.log(`${c.name}: ${c.pass ? 'PASS' : 'FAIL'} exit=${c.hook.exitCode} stdout=${JSON.stringify(c.hook.stdout)}`);
    if (c.hook.stderr) console.log(`${c.name}: stderr=${JSON.stringify(c.hook.stderr)}`);
    if (c.decision) console.log(`${c.name}: decision=${JSON.stringify(c.decision)}`);
    if (c.assertions.length) console.log(`${c.name}: assertions=${JSON.stringify(c.assertions)}`);
  }
  console.log('SEAM_REPORT_JSON ' + JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}

if (typeof describe === 'function') {
  const suite = process.env.AIORDIE_DECISION_HOOK_SEAM === '1' ? describe : describe.skip;
  suite('github-router internal-decision-hook ↔ ai-or-die decision seam', function () {
    this.timeout(60000);
    it('round-trips accept, reject, no-viewer, and plan approval through live HTTP', async function () {
      const report = await runHarness();
      assert.strictEqual(report.ok, true, JSON.stringify(report.cases, null, 2));
    });
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
