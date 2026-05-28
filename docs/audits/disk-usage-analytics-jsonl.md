# DISK-02 — Usage-Analytics JSONL Growth + Rotation

**Audit date:** 2026-05-27
**Auditor:** Claude (SUP-DISK worker)
**Scope tag:** DISK-02

## 1. Scope

Read-only audit of the JSONL ingest / analytics pipeline:

- `src/usage-analytics.js` (493 LOC)
- `src/usage-reader.js` (894 LOC)
- `src/server.js` (crash-file path, line 207)
- Reference patterns: `src/utils/circular-buffer.js`, `src/utils/session-store.js`

Goal: characterise on-disk growth, rotation status, and risk to long-running ai-or-die servers.

## 2. Current behavior

**Critical clarification up front.** The name "usage-analytics" is misleading. `src/usage-analytics.js` does **not** write any JSONL file. It is a pure in-memory `EventEmitter` (lines 1–492): all state lives in `this.recentUsage` (line 68, hard-capped at the last burn-rate window — line 102), `this.burnRateHistory` (line 73, capped to 1 h — line 221), and `this.activeSessions` / `this.sessionHistory` (line 64, pruned to 24 h by `cleanup()` line 488–490). There is no `fs.appendFile`, no `createWriteStream`, no JSONL emission anywhere in this file. Server wires a single instance at `src/server.js:120`.

**Where the JSONL actually lives.** The JSONL files we read are produced **by the Claude CLI itself** under `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl` (see `src/usage-reader.js:9` — `this.claudeProjectsPath = path.join(os.homedir(), '.claude', 'projects')`). ai-or-die is a pure **consumer** of these files (`readJsonlFile`, line 368–464). The path is hard-coded; **no env var overrides it** in this codebase. The Claude CLI controls the writer; ai-or-die controls neither the append cadence nor the file layout.

**Append cadence (observed on disk).** One file per Claude session (`<sessionId>.jsonl`). One line per CLI event — user turn, assistant turn (with `usage` block), tool_use, tool_result, system. Append-only; the CLI does not rotate.

**Typical entry size (empirical, this repo's history at `~/.claude/projects/-Users-kundus-Software-ai-or-die/`):**
- 70 579 B / 23 lines  = ~3.0 KB/line
- 654 020 B / 216 lines = ~3.0 KB/line
- 3 342 570 B / 1 145 lines = ~2.9 KB/line
- 4 654 346 B / 1 250 lines = ~3.7 KB/line

Assistant turns dominate size because the `message.content` array (text, tool_use blocks) is embedded verbatim; user turns embed tool_result payloads (often kilobytes of file content).

**Current disk footprint on this developer machine:** `du -sh ~/.claude/projects` = **723 MB across 889 JSONL files** (single user, ~6 months of mixed Claude Code + ai-or-die usage). This is the steady-state we are not managing.

**Read-side.** `src/usage-reader.js:368–464` uses `readline.createInterface` over `createReadStream` — line-by-line streaming, so peak heap is bounded per file. **But** `readAllEntries` (line 237–258) iterates **every** JSONL across **every** project directory (`findJsonlFiles`, line 329–366), with no per-file size guard and no parallelism throttle. Every refresh of `getUsageStats` (`hoursBack=24` default, line 62) re-streams the full corpus. The 5 s cache (line 12) softens this, but cold-read latency scales linearly with total `.jsonl` bytes — ~723 MB today.

## 3. Growth model

Assumptions: one active user with continuous Claude/Codex sessions; ~3 KB/line (empirical); roughly one assistant turn every 15–30 s during active work (~2–4 lines/min including user/tool entries); 6 h active work/day.

| Horizon | Lines | Bytes (raw) | Notes |
|---|---|---|---|
| 1 active hour | ~180 | ~540 KB | one session file |
| 1 day (6 h active) | ~1 080 | ~3.2 MB | typically split across 2–4 session files |
| 1 week | ~7 600 | ~22 MB | ~10–20 session files/week |
| 1 month | ~32 000 | ~96 MB | + accumulated stale files |
| 6 months | ~190 000 | ~570 MB | matches observed 723 MB on this dev machine |

Growth is **unbounded** in time. Files are never deleted, gzipped, or truncated by Claude CLI or ai-or-die.

## 4. Gaps

- **No rotation.** No size-based or age-based truncation anywhere in `src/usage-analytics.js` or `src/usage-reader.js`. Claude CLI writes; nothing prunes.
- **No size cap per file.** A single runaway tool_result (e.g., a 50 MB file paste) goes straight to disk and stays there.
- **No size cap per directory** (`~/.claude/projects/<project>/`).
- **No age-based eviction.** `usage-reader.js:62` reads "last 24 h" by *timestamp filter*, not by file selection, so all files are opened regardless of age. Files from 2024 are still being `fs.stat`'d and streamed on every cache miss.
- **No `.crash` cleanup.** `src/server.js:207` writes `${sessionsFile}.crash` on `uncaughtException`. Search of repo (`grep -rn "\.crash"`) finds exactly one write site and **zero readers/cleaners**. Each crash leaves a permanent `~/.ai-or-die/sessions.json.crash` orphan (overwritten on next crash, never deleted).
- **No fsync / no buffered writer.** Because ai-or-die does not write JSONL, the question of write amplification is moot for *this* codebase — but the read side opens 889 file descriptors serially per cold scan with no concurrency bound (`usage-reader.js:245–248`).
- **No telemetry on growth.** `_collectDiagnostics()` (referenced at `server.js:191`) does not emit JSONL footprint or file count, so we cannot alert on growth.
- **Windows note.** The hard-coded `path.join(os.homedir(), '.claude', 'projects')` (`usage-reader.js:9`) resolves correctly on Windows, but there is no `realpathSync.native` canonicalisation and no `\\?\` handling. A long-path corpus (>260 chars) could break enumeration silently on older Win10 builds.

## 5. Proposed fix sketch

Because **ai-or-die does not write the JSONL**, true rotation must either (a) ship as a *consumer-side* janitor that prunes/compresses the Claude CLI's files, or (b) be punted upstream. Recommendation: **(a), narrowly scoped**, owned by `usage-reader.js`, opt-in via env var.

**Proposed policy:**
- Threshold: per-file ≥ **100 MB**, OR per-project-dir total ≥ **500 MB**, OR file `mtime` older than **90 days**.
- Action: gzip the file in place (`<sessionId>.jsonl` → `<sessionId>.jsonl.gz`) using `zlib.createGzip()` piped through `fs.createWriteStream`, then `fs.rename` original to `.tmp`, `fs.unlink` after successful gzip flush. Keep the **last 3** non-gzipped session files per project untouched (active rotation horizon).
- Trigger: non-blocking sweep on the first `getUsageStats` call after process start, then every N hours via `setInterval`. **Never** synchronous with an append (we don't own the appender, so we cannot tie to it anyway).
- Reader must accept both `.jsonl` and `.jsonl.gz` — modify `findJsonlFiles` (`usage-reader.js:329–366`) to include `.jsonl.gz` and wrap the stream in `zlib.createGunzip()` inside `readJsonlFile` (line 368).
- Wire-up point: new method `UsageReader.compactStale()` invoked from `src/server.js` near the existing 5 min diagnostics tick (`server.js:188–193`). Behind env flag `AI_OR_DIE_USAGE_COMPACT=1` for first release.

**Crash-file pruning (separate from JSONL but in scope per brief):**
- On startup in `server.js`, glob `${sessionStore.sessionsFile}.crash*` and delete files older than 7 days. ~5 lines, no behaviour-change risk.

## 6. Risks

- **Write contention with Claude CLI.** The CLI may still hold an open append handle to a file we are gzipping. Mitigation: only compact files whose `mtime` is older than e.g. 1 hour (file is "cold"), and on Windows use `fs.copyFile` + `unlink` instead of `rename` to avoid `EBUSY` on a handle the CLI may have left open.
- **Reader compatibility.** Any external tool (claude-monitor, custom dashboards) that reads `~/.claude/projects/` directly will not understand `.jsonl.gz`. This is **upstream** territory — recommend reaching out to anthropic-ai/claude-code before shipping, or making the feature opt-in.
- **Atomicity during rotation.** Use the **same temp-then-rename pattern** as `session-store.js:95–101`: write `<file>.jsonl.gz.tmp`, fsync, rename, then unlink the original. Order matters — if we unlink first and the rename fails, data is lost.
- **Windows file locking.** `fs.rename` on Windows fails if target exists OR source is locked. Use `fs.copyFile` + `fs.unlink` with retry on `EBUSY`/`EPERM` (3 attempts, exponential backoff to 1 s). See the pattern already used in `src/utils/file-watcher.js` for chokidar-race handling.
- **`.crash` file pruning** must skip the *most recent* crash file (operators may want to inspect it).

## 7. Test strategy

Place regression test at `test/longevity/disk/usage-analytics-growth.test.js`. Approach:

1. **Synthetic corpus.** In `beforeEach`, build a temp dir mimicking `~/.claude/projects/` with N synthetic JSONL files of controlled size. Use `process.env.HOME` (or inject a constructor arg into `UsageReader`) to redirect `claudeProjectsPath` — currently this requires a small refactor since the path is fixed at line 9. Add `options.claudeProjectsPath` to the constructor; **this is the one production change the test needs** (call it out explicitly in the implementation ticket).
2. **Force size threshold.** Write a single 101 MB JSONL (`fs.writeFile` of `'x'.repeat(101 * 1024 * 1024)` + valid JSONL lines at head/tail) — confirm `compactStale()` gzips it and the resulting `.jsonl.gz` round-trips through `readJsonlFile`.
3. **Force age threshold.** `fs.utimes` a synthetic file to `Date.now() - 100 * 24 * 60 * 60 * 1000` — confirm it gets compacted even when small.
4. **Active-file protection.** Write 5 files with current `mtime`; confirm the latest 3 are skipped.
5. **Idempotency.** Run `compactStale()` twice; second pass must be a no-op.
6. **Crash-file pruning.** Touch `${tmpdir}/sessions.json.crash.<old-ts>` and `${tmpdir}/sessions.json.crash.<new-ts>`; confirm old is removed, new is kept.
7. **Windows-safety stub.** Mock `fs.rename` to reject `EBUSY` once; confirm fallback to `copyFile`+`unlink` path executes (Windows code path coverage from any OS).
8. **Bounded ports.** Per project memory, use a port > 11000 if any server is spun up (this test should not need one).

Use real temp dirs via `os.tmpdir()` + `fs.mkdtempSync` for isolation; clean up in `afterEach`. Do **not** touch the real `~/.claude/projects/`.

---

**Key finding TL;DR:** The "usage analytics JSONL" is not ours — Claude CLI writes it, we read it. We currently consume 723 MB on one dev machine with zero pruning, and we leave `.crash` orphans behind on every server uncaught exception. Fix is a consumer-side janitor (gzip+age+size policy) in `usage-reader.js`, plus a 5-line startup cleanup for `.crash` files in `server.js`.
