# Windows ConPTY teardown crashes the Playwright worker (2026)

Status: contained, not fixed. The defect lives in `node_modules`.

## Symptom

A single Windows browser job goes red while every sibling job passes. The
reported failure is not an assertion — it is the test runner losing its worker:

```
[functional-extended] > e2e\tests\06-large-paste.spec.js:60:3 >
  paste via Ctrl+V with clipboard API works for moderate text
  Error: worker process exited unexpectedly (code=3221225477, signal=null)
28 passed (1.4m)
```

`3221225477` is `0xC0000005`, a Windows access violation. The job log is flooded
beforehand with repeated uncaught crashes of a node-pty helper process:

```
node_modules\@lydell\node-pty-win32-x64\lib\conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
Error: AttachConsole failed
```

The failing test title moves between runs and suites. It has been observed in
`test-browser-functional-extended`, and the earlier triage note recorded the same
`AttachConsole failed` crash in `test-browser-sticky-notes`. Any suite that boots
a real server with PTYs can reach it.

## Root cause

Traced by reading the installed `@lydell/node-pty` 1.2.0-beta.10 sources.

1. `e2e/helpers/server-factory.js` `createServer()` instantiates
   `ClaudeCodeWebServer` **in-process**. The Playwright worker therefore hosts
   node-pty itself, so a native crash in PTY teardown kills the worker rather
   than an isolated child. (`spawnCli()`, next to it, is the out-of-process
   pattern.)
2. `lib/windowsPtyAgent.js:102-129` — `WindowsPtyAgent.prototype.kill()`. When
   `_useConptyDll` is false (the default) it calls `_getConsoleProcessList()` and
   then, **without awaiting the returned promise**, immediately runs
   `_ptyNative.kill(this._pty, this._useConptyDll)` and disposes the conout
   socket worker.
3. `lib/windowsPtyAgent.js:130-144` — `_getConsoleProcessList()` `fork()`s
   `conpty_console_list_agent`. By the time that child runs, step 2 has already
   killed the pty, so `AttachConsole(shellPid)` fails. The agent has no error
   handling (`lib/conpty_console_list_agent.js:13`), throws uncaught, and dies.
   That is the log flood.
4. Because the agent never `process.send`s, the promise only settles via the 5s
   timeout, which resolves with the stale shell pid. The `.then()` then calls
   `process.kill()` on a pid Windows may already have recycled.
5. The access violation arises from this unsynchronised teardown — native kill
   and conout-worker disposal racing the forked agent — inside third-party code.

Our own teardown is not implicated. `BaseBridge.stopSession()`
(`src/base-bridge.js:700-787`) already disposes PTY listeners before killing,
closes the per-PTY kill-on-close Job Object, and bounds the wait;
`src/utils/process-tree.js` is `taskkill`-only with no FFI.

## Evidence that it predates the change it blocked

- The client-redesign branch touches neither `e2e/tests/06-large-paste.spec.js`
  nor the `functional-extended` project definition nor any server/PTY code.
- The same job flakes on the unrelated `fix/ci-signal-integrity` branch, where
  Windows browser jobs fail intermittently with shifting job names run to run.
- `docs/history/ci-flakiness-triage-2026.md` already recorded this crash as a
  known node-pty/Windows issue living in `node_modules`.

## Containment

`e2e/playwright.config.js` now uses:

```js
retries: process.env.CI && process.platform === 'win32' ? 1 : 0,
```

Why this boundary and not another:

- **Not per-project.** Scoping to whichever suite is red today would be shaped by
  the symptom, not the cause, and would simply relocate the red.
- **Not global.** The crashing agent ships only in the `win32` binary package.
  POSIX cannot execute that code path, so retrying ~30 Ubuntu jobs would absorb
  genuine flakes that have no such excuse.
- **Not local.** Developers keep `retries: 0` and see flakes raw.
- **One retry, not two or three.** A deterministic failure still fails both
  attempts, so this cannot turn a real Windows regression green. Playwright's
  GitHub reporter marks a retried-then-passed test `flaky`, distinct from
  `passed`, so the signal stays visible.

Note that `docs/history/ci-flakiness-triage-2026.md` advised "reduce that suite's
Playwright retries". That advice was written while retries were non-zero, when
the crash cost wall-clock time by triggering retries near the 20-minute cap.
Retries were later set to 0 globally, which inverted the trade-off: the crash now
costs correctness instead of time. The older note is stale on this point.

## Exit criteria

This containment must be escalated, not extended, if either holds:

- any Windows job fails on **both** attempts with this signature; or
- the `flaky` outcome becomes routine rather than occasional.

Escalation paths, in order of preference:

1. **Fix the harness.** Make `createServer()` boot the server out-of-process the
   way `spawnCli()` already does. This contains any third-party native crash to a
   child process instead of the worker, and it closes the whole class rather than
   this instance. It rewrites the harness shared by most specs across every
   browser job, so it needs its own change and a Windows verification run.
2. **Bypass the crashing branch.** ~~Passing `useConptyDll: true` when spawning
   on Windows takes the other branch of `kill()` and never forks the agent.~~
   **TRIED AND DISPROVEN — do not attempt again without new information.**

   This was implemented and pushed (`604b93a`) and had to be reverted
   (`06752ae`). The mechanism works exactly as predicted here: the agent is never
   forked and the `AttachConsole failed` flood goes from dozens of lines per run
   to **zero**, with `02-terminal-io` still passing 3/3 locally.

   But it breaks Windows broadly. CI on `604b93a` failed **every** Windows job:
   `test (windows-latest)` at 1988 passing / 4 failing (3 of those are
   pre-existing) plus all five Windows browser buckets, including a clipboard
   test that had been passing. The three runs before it were 31/31 green and the
   PTY backend was the only difference; reverting restored 31/31 green on
   attempt 1, confirming attribution. Why the DLL backend breaks Windows here was
   not investigated.

   This closes the gap in the "Honest limitation" below for this path
   specifically: it has now been exercised on a real Windows machine and on the
   Windows runners. Escalation path 1 (boot the server out-of-process) remains
   unexercised and is now the preferred route — it also closes the whole class
   rather than this instance.
3. **Report upstream** the un-awaited `fork()` in `kill()` and the unguarded
   `getConsoleProcessList` call in the agent.

## Honest limitation

This diagnosis is from source reading and CI logs. It was not reproduced on a
Windows machine — the work was done in a Linux container with no Windows runner
available, so no Windows-specific behaviour here was observed locally.
