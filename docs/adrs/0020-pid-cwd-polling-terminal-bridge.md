# ADR-0020: PID-Based CWD Polling Backstop for Terminal Bridge

## Status

**Deferred** — not shipping in v1. See "Deferral rationale" below. Reopen criteria documented at the end of this section. The full technical design that follows in this document is preserved as the v2 starting point if/when reopen criteria are met.

### Deferral rationale

This ADR was drafted as the polling half of a "belt-and-braces" pair (with [ADR-0021](0021-osc7-shell-hook-auto-install.md) wrapper). The first draft assumed POSIX as the primary target environment. Cross-lab review (codex + gemini + opus) surfaced 13 substantive items including:

- Identity-tuple verification gaps for macOS `lsof` fallback (codex 2) → forced macOS polling to default-OFF in v1.
- Resume-on-silence pathology (gemini 1) → polling resuming during long foreground commands would read transient subprocess CWDs.
- Reconnect-timer state-location bug (gemini 2) → 30s timer was on WS state, would fire after every reconnect.
- pid-reuse race verification (codex 1), uid mismatch escalation (opus 1), in-flight teardown contract (opus 3), telemetry PII boundary (opus 4), container/namespace gaps (opus 5).

The fixes were tractable but reduced the v1 scope to **Linux-only default-ON** (macOS deferred to a future libproc-binding effort; Windows has no public cross-process CWD API). Then the user clarified that **their primary environment is Windows (pwsh, sometimes cmd.exe)**. PID polling helps zero of their sessions. The complexity-per-user-helped ratio for v1 collapsed.

Resolution: defer ADR-0020 entirely. Concentrate v1 engineering on ADR-0021 wrapper (which DOES serve the user's pwsh sessions once pwsh is undefer'd) plus Layer 5 toast (which is the safety net for unwrapped sessions on all platforms).

### Reopen criteria

Reopen this ADR for design-round-2 + implementation when ONE OR MORE of the following holds:

1. **Wrapper-miss telemetry exceeds threshold.** Post-ship measurement (post-ADR-0021 implementation) shows >10% of Terminal-bridge sessions on bash/zsh have liveCwd never populated within 30s of launch (suggesting wrapper not firing for that user's setup). This would establish that polling-as-backstop has measurable value the wrapper alone doesn't capture.

2. **User population shifts toward POSIX-primary.** If the primary user base for ai-or-die later skews toward bash/zsh users in tmux/screen/login-shell/unknown-shell setups (the categories the wrapper can't reach), polling on Linux becomes load-bearing.

3. **A macOS libproc binding becomes available** (vendored or via a maintained third-party npm package) that delivers identity-tuple verification without the lsof spawn cost. This unblocks macOS default-ON polling, expanding the addressable population.

Reopening should retread the 13 critic items below (the technical design hasn't been re-evaluated since the deferral); a fresh cross-lab round on the reopened scope is required.

### Status of v1 alternatives

While ADR-0020 is deferred, the user's "just works" UX is delivered by:

1. **[ADR-0021](0021-osc7-shell-hook-auto-install.md) (planned, pwsh-priority):** spawn-time transient wrapper for pwsh + bash + zsh; default-ON; auto-fallback to vanilla on shim breakage.
2. **Layer 5 toast** (in production, [commit c6deb71](https://github.com/animeshkundu/ai-or-die/commit/c6deb71)): user-visible safety net when wrapper doesn't establish liveCwd. Block A surfaces actionable "install OSC 7 hook" copy; Block A' (planned, bundled with ADR-0021 implementation) handles "wrapper attempted but disabled"; Block A'' (planned, bundled with ADR-0021) handles cmd.exe-style "shell can't track" sessions.

The technical design below is preserved as-written for the v2 reopen. It does NOT reflect the 13 critic-round-2 fixes (those would be applied during reopen design).

---

## Original Status (superseded — for record)

**Proposed** — cross-lab adversarial review pending before SE implementation.

## Date

2026-05-18

## Context

[ADR-0019](0019-osc7-cwd-tracking.md) chose OSC 7 as the primary CWD signal for Terminal bridges and explicitly rejected PID polling as a primary mechanism. The rejection rested on three points (gemini + codex + opus):

1. PTY-running CLI tools (`claude`, `codex`, `gemini`) don't `chdir` their host process; `/proc/<pid>/cwd` returns false data for those bridges.
2. macOS `lsof -p` costs ~120-180 ms per call — at 2 Hz × 20 sessions, ~1.5 cores burned permanently.
3. Poll latency is user-visible.

Those reasons remain valid **as primary mechanism**. They do not apply when polling is scoped narrowly:

- **Terminal-bridge sessions only.** Shells (`bash`, `zsh`, `fish`, `pwsh`) DO `chdir` on `cd`. Object (1) is irrelevant for the only bridge type this ADR targets.
- **Lazy trigger, not fixed interval.** Object (2) collapses if polling fires only when needed.
- **Backstop role, not primary.** Object (3) is bounded — polling fills the gap when OSC 7 silently fails to fire (no shell hook, tmux swallows OSC 7, unknown shell, etc.); the typical user with [ADR-0021](0021-osc7-shell-hook-auto-install.md) spawn-time auto-install gets OSC 7 within ~50ms of `cd` and polling never runs.

Why now: post-PR-108 the user reported that click-to-open silently fails when their shell doesn't emit OSC 7 (a zsh + starship session without the `chpwd` hook). Layer 5 ([commit c6deb71](https://github.com/animeshkundu/ai-or-die/commit/c6deb71)) converts that silent failure into an actionable Block A toast. The user came back with "Can we try to auto install if possible?" Cross-lab review on the wrapper-auto-install proposal (ADR-0021) flagged a real blast-radius asymmetry (opus). User's chosen resolution: **belt-and-braces — wrapper primary plus polling backstop, both default-ON.** This ADR specifies the polling backstop.

The full 3-layer architecture this ADR participates in:

1. **ADR-0021 wrapper auto-install (primary).** Default-ON. Spawn-time transient OSC 7 hook injection for bash/zsh. Fires within ~50ms of `cd`. Covers ~95% of POSIX users.
2. **ADR-0020 polling (this ADR — primary backstop).** Default-ON Linux/macOS. Lazy trigger. Covers what the wrapper misses: tmux/screen swallowing OSC 7, login-shell wrapper-skip mode, unknown shells (nu/xonsh/elvish), wrapper detect-failure fallback sessions, Windows (deferred — see Limitations).
3. **Layer 5 toast** (already in prod). User-visible safety net when neither mechanism establishes liveCwd. Block A copy points at manual hook docs; Block A' (bundled with ADR-0021) handles "wrapper attempted but disabled."

This layered defense lets the user have snappy panel re-roots when the wrapper works AND bounded "just works" behavior when it doesn't.

## Decision

Adopt PID polling as a **lazy backstop**, scoped strictly to Terminal-bridge sessions, default-ON on Linux/macOS. Linux uses `/proc/<pid>/cwd` (essentially free). macOS uses `lsof -p` / libproc with cost mitigations (long interval, panel-open gating). Windows is deferred — no public cross-process CWD API; users get OSC 7 (via ADR-0021 wrapper or manual hook) or Layer 5 toast.

### Trigger model — lazy, not always-on

Polling kicks in on either condition:

1. **30 seconds after `TerminalBridge.startSession` completes** with no `cwd_changed { source: 'osc7' }` frame yet emitted. Signal: the wrapper or user's existing shell hook has had a chance to fire on the first prompt; if it hasn't, OSC 7 is silent for this session.
2. **On resolver-chain miss for a click.** When `attachLinkProvider.activate()` produces zero hits in `resolveCandidates`, the client signals the server (new WS frame: `request_cwd_refresh`) and polling does a one-shot read. Frame includes the click hint for telemetry; the server runs a single poll cycle on the next 100ms tick to avoid request-amplification.

Once polling has started for a session, it continues at the platform-specific cadence (below) UNTIL either the session ends or `cwd_changed { source: 'osc7' }` arrives (wrapper recovered). On OSC 7 recovery, polling pauses; if OSC 7 falls silent again for >2 polling intervals, polling resumes.

Polling cost is gated on **panel-open state**. The client tells the server when the file-browser panel is open via existing `panel_state` (or a new equivalent if it doesn't exist); polling fires only while panel is open. When panel closes, polling pauses (the lazy backstop's CWD value is stale but no one's looking).

### Per-platform mechanism

**Linux:**

- Read `/proc/<pid>/cwd` symlink target via `fs.readlinkSync`. Cost: <1ms per call (no subprocess; pure VFS read).
- Poll interval: **1 second** when active.

**macOS:**

- Primary: `proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, ...)` via libproc (Node FFI through `node-ffi-napi` or a native binding). Cost: <1ms per call. **Preferred.**
- Fallback: `lsof -p <pid> | grep cwd` if libproc binding unavailable. Cost: ~120-180ms per call. Significant — use only when libproc binding fails to load.
- Poll interval: **5 seconds** when active.
- libproc is the macOS public API for inspecting other processes' VFS state; it's what `lsof` itself uses under the hood. The Node binding is a small (~50 LOC C++) addon; SE evaluates whether to ship one or accept the lsof cost. **Decision deferred to SE; documented as an implementation detail. If lsof-only ships, the 5s interval is the cost cap.**

**Windows:**

- No public cross-process CWD API. `NtQueryInformationProcess(ProcessBasicInformation)` is undocumented + requires SeDebugPrivilege. WMI `Win32_Process.ExecutablePath` doesn't expose cwd.
- **v1 deferred.** Windows users get OSC 7 (via ADR-0021 wrapper for cmd.exe-less setups, or manual pwsh hook) or Layer 5 toast on click failure. A future ADR can specify a native shim if usage warrants.

### Foreground process resolution — `tcgetpgrp`

The PTY master's `ioctl(fd, TIOCGPGRP, &pgrp)` returns the foreground process group ID. This catches the common case where the user `cd`s inside a tool: e.g., `cd subdir && vim` runs `vim` in a foreground process group inside the shell; vim's CWD reflects the post-cd location. Polling the spawn PID (the outer shell) would miss subprocess CWDs entirely.

Algorithm:

```
poll(session):
  fd = session.ptyMaster
  try {
    pgrp = ioctl(fd, TIOCGPGRP)
    pid = findPidWithPgid(pgrp)
    if not pid: pid = session.spawnPid
  } catch {
    pid = session.spawnPid
  }
  cwd = readCwdForPid(pid)
  if not cwd: return  // pid race, missing /proc entry, etc.
  if verifyPidStillValid(pid):
    broadcastCwdChanged(session, cwd, source: 'polling')
```

If `tcgetpgrp` fails (PTY closed, ioctl unsupported on the platform), fall back to the spawn PID. Documented as a soft degradation; "user `cd`s inside a tool" goes back to stale-after-tool-exit behavior, but the broader belt-and-braces still works.

### pid-reuse race handling

Between `findPidWithPgid` returning a PID and `readCwdForPid` reading it, the PID could be reused. Trusting the post-reuse PID would emit a wrong CWD. Mitigations:

- **Linux:** read `/proc/<pid>/stat` to get start-time + comm + parent. Verify:
  - `comm` matches expected basename (`bash`, `zsh`, `fish`, or `vim`/`less`/etc. for foreground subprocess) — broadly an allowlist match, not strict.
  - `ppid` is in the session's spawn-process subtree (chain from `session.spawnPid`).
  - First check passes → trust. Second fails → don't emit, log debug.
- **macOS:** `proc_pidinfo(pid, PROC_PIDTBSDINFO)` returns `pbi_start_tvsec` + `pbi_ppid` + `pbi_comm`. Same verification.
- **Cost:** Linux verification is two extra `/proc` reads, <1ms. macOS is one extra libproc call.

This is best-effort. A determined attacker could fool the heuristics; we're not solving a security problem, just avoiding read-the-wrong-CWD glitches.

### Source-tagged WS frames + OSC 7 supersedes polling

Every `cwd_changed` frame carries `source: 'osc7' | 'polling' | 'spawn'` (the `spawn` value is already in flight from `session_created` / `session_joined` / `*_started` per Layer 1 of the post-PR-108 fix; this ADR formalizes it). The server records the last source per session.

**Conflict resolution rule:** when wrapper OSC 7 emits a `cwd_changed`, it ALWAYS wins, even if polling had just set the same session's liveCwd to a different value. Rationale: OSC 7 fires AT the `cd` event (causally; emitted by the shell's prompt-cycle hook in response to the new directory); polling reads at most every 1-5s later (on a tick boundary). OSC 7 is strictly fresher.

**Stutter dedup:** the OSC 7 parser's existing `cwd === prev` dedup (per ADR-0019, `terminal-bridge.js:205`) is extended to **also short-circuit when source changes but cwd doesn't.** Specifically: if last broadcast was `{cwd: X, source: 'polling'}` and a fresh `cwd: X, source: 'osc7'` arrives, don't fire a new frame — the value is unchanged; updating the source-tag in the server-side cache without a redundant client broadcast is sufficient. Avoids log/UI noise when the wrapper recovers a session that had been polling-driven for a while.

The client's `_liveCwd` map is unchanged in semantics (latest cwd wins); the source tag is for server-side observability + diagnostic toasts (Layer 5 / Block A' eventually distinguishes osc7-vs-polling-vs-spawn provenance).

### Hard reject for AI bridges (ADR-0019 invariant preservation)

The polling install path is gated:

```js
async startPolling(sessionId, opts) {
  const session = this.claudeSessions.get(sessionId);
  if (!session || session.agent !== 'terminal') return;  // hard reject
  // ... rest of polling install
}
```

Per ADR-0019, Claude/Codex/Gemini/Copilot bridges have `liveCwd === null` by design (they don't `chdir`). Polling their host process returns the spawn dir forever — false data, not stale. The early-return guard is restated here AND must be exercised by a unit test that asserts no polling state is installed when `agent !== 'terminal'`. Defends the ADR-0019 invariant against future refactors that might dispatch polling generically.

### Opt-out (3-layer, consistent with ADR-0021)

Same shape as the wrapper opt-out for ergonomic consistency. ANY layer evaluating true disables polling for the affected scope:

1. **Env var (server-process-wide):** `AI_OR_DIE_NO_CWD_POLL=1` checked per-spawn — no restart needed to flip.
2. **Server CLI flag:** `--no-cwd-poll`. Sets the same internal state as the env var; env var overrides flag if both set.
3. **Per-session UI toggle:** session-settings menu, defaults to server flag's value. Survives across reconnects of the same session.

Server flag + per-session UI are MANDATORY for v1 per Codex #7 (default-on backstops need user-controlled disable BEFORE shipping). Env var alone would be insufficient.

## Cross-lab adversarial review

This ADR's biggest risks aren't in the polling mechanism itself — `/proc/<pid>/cwd` is well-understood prior art — but in the *interaction* surface with the rest of the system. Critic round 2 should focus:

1. **Lazy trigger correctness under reconnect.** The 30s post-launch timer is per-session. What happens on reconnect — does the timer reset, continue, or fire late? If a user reconnects 25s after a session start, do they wait 5s for polling to engage? Document.

2. **pid-reuse race exploit surface.** The comm/ppid verification is best-effort. Can an adversary inside the user's shell deliberately fork+exec a `bash`-named binary in a CWD outside the sandbox to make polling emit a misleading `cwd_changed`? `validatePath()` on the server still rejects out-of-sandbox values, so the worst case is the panel silently freezes — but worth confirming the rejection still fires for synthesized values.

3. **OSC 7 supersedes — recovery from prolonged silence.** Wrapper falls back to vanilla mid-session → polling kicks in → wrapper somehow recovers later (user resources the hook manually?) → OSC 7 starts firing again. Does the polling task stop, or do both run concurrently? Spec says polling pauses on `source: 'osc7'` arrival; >2 polling intervals of OSC 7 silence resumes. Does that round-trip correctly across the WS protocol boundary?

4. **macOS libproc binding maintenance burden.** Shipping a native addon means a new build matrix dimension (Intel + Apple Silicon, plus Node ABI version pinning). Is the SE's binding choice (libproc vs `lsof`-fallback only) worth the maintenance cost for ~150ms saved per poll?

5. **tcgetpgrp on TTY-less spawns.** node-pty allocates a PTY, but if any wrapper code path runs without one (debug/test paths), `ioctl(TIOCGPGRP)` fails. Verify the fallback-to-spawn-PID path is exercised by a test.

6. **Polling-during-claude-CLI-inside-terminal-session.** A user runs `claude` inside a Terminal bridge (the user's actual reported flow). The Terminal bridge's `agent === 'terminal'`, so polling installs. `tcgetpgrp` finds `claude` as the foreground process. Polling reads `claude`'s CWD — which is correct! The user `cd`d to projA in bash, then ran claude; claude inherited that CWD. liveCwd reflects projA. **This is the headline win** of polling for the user's reported scenario. Cross-lab to confirm no edge case breaks this (claude spawning subprocesses, claude changing CWD internally via cd-tool — claude doesn't `chdir` its own process per ADR-0019, so this should be safe).

7. **Telemetry without PII.** Polling logs SHOULD include CWD (it's session-scoped, in-sandbox) for diagnosis. Polling DEBUG logs MUST NOT include any other sensitive content. Confirm the existing debug-log policy.

8. **Cleanup on session delete.** Polling timer per-session must be cleared when the session is deleted. Existing `session.timers` array or equivalent — verify no leak path.

## Consequences

### Positive

- **"Just works" for the cases ADR-0021 wrapper misses.** tmux, screen, login bash, unknown shells, wrapper-fallback sessions. Net: belt-and-braces materially expands the user population that gets liveCwd-driven click-to-open and panel re-rooting.
- **User's exact reported scenario fixed.** Terminal → bash → `claude` inside bash → no OSC 7 hook → `tcgetpgrp` finds `claude` as foreground process → polling reads its CWD → liveCwd is correct → clicks resolve.
- **No user-filesystem touching.** Pure observability. Cannot corrupt user environment (unlike ADR-0021 wrapper).
- **Cheap when wrapper works.** Most users with ADR-0021 wrapper installed get OSC 7 on first prompt; polling 30s timer never fires.
- **Composes with existing infrastructure.** Reuses `cwd_changed` WS frame catalog, `validatePath()` sandbox gate, existing `_liveCwd` server map, ADR-0019 OSC 7 parser semantics.
- **Hard-rejects AI bridges by invariant.** ADR-0019's "liveCwd === null for AI CLI bridges" is preserved by the guard; the future-proofing is explicit.

### Negative

- **macOS cost without libproc binding.** Worst case is `lsof -p` at 5s interval × N sessions. At N=20 sessions all-active-panel-open: 20 × 0.2/s × 150ms = ~600ms/s = 60% of one core. Mitigated by panel-open gating (most users have the panel closed); becomes a non-issue at <5 active panels. libproc binding eliminates the cost entirely.
- **pid-reuse window.** Comm/ppid verification is best-effort. A determined adversary in the user's own shell could synthesize a misleading `cwd_changed`, bounded by `validatePath()` (out-of-sandbox emissions silently rejected). Bounded threat surface; documented.
- **Windows v1 gap.** Windows users without OSC 7 hooks installed get Layer 5 toast on click failure. Same as today.
- **2-5s panel lag** when polling is the only signal. Acceptable per user's belt-and-braces choice; not acceptable as a sole mechanism (which is why ADR-0021 wrapper stays in scope as primary).
- **Source-tag stutter requires deduplication.** Without the per-team-lead "no broadcast on source-only change" extension, the wrapper-recovers-after-polling-was-active case would emit redundant `cwd_changed` frames. Implemented.

### Neutral

- **No new runtime dependency in v1 if SE picks lsof-fallback path.** Optional libproc binding adds one runtime dep.
- **WebSocket protocol extension is additive.** New `source` field on existing `cwd_changed` frame; optional `request_cwd_refresh` frame. Existing clients ignore unknown fields per the protocol's forward-compat posture.
- **No impact on watched-paths or file-browser panel semantics.** Polling produces the same `cwd_changed` frame catalog as ADR-0019 OSC 7 — downstream behavior (re-root if following, stash if not) is unchanged.
- **Spec impact:** `docs/specs/file-browser.md` gains a "PID polling backstop" subsection under the existing "Live CWD tracking" section. `docs/specs/bridges.md` documents the polling-install hook on TerminalBridge. ADR-0019's "Why not PID polling" rejection bullet gets an "Amended by ADR-0020: scoped Terminal-bridge-only lazy backstop is in scope" footnote — the rejection-as-primary stands.

## Notes

- **Related:**
  - [ADR-0019](0019-osc7-cwd-tracking.md) — establishes OSC 7 as the primary CWD signal; this ADR amends the "PID polling rejected" bullet specifically (scoped Terminal-bridge-only backstop ≠ unscoped primary).
  - [ADR-0021](0021-osc7-shell-hook-auto-install.md) (proposed, parallel) — spawn-time wrapper auto-install. Belt-and-braces partner: wrapper primary, polling backstop.
  - [Layer 5 commit c6deb71](https://github.com/animeshkundu/ai-or-die/commit/c6deb71) — `FeedbackManager.resolverFailure` structured toast. User-visible safety net when neither wrapper nor polling establishes liveCwd.
- **External references:**
  - [Linux `/proc/<pid>/cwd` documentation](https://man7.org/linux/man-pages/man5/proc.5.html) — the symlink semantics and access controls.
  - [macOS libproc / `proc_pidinfo`](https://opensource.apple.com/source/xnu/xnu-7195.50.7.100.1/bsd/sys/proc_info.h.auto.html) — the cross-process VFS inspection API.
  - [TIOCGPGRP / `tcgetpgrp`](https://man7.org/linux/man-pages/man3/tcgetpgrp.3.html) — controlling-terminal foreground-process-group lookup. Same semantics on macOS via BSD ioctl heritage.
  - [VS Code's terminal shell integration](https://code.visualstudio.com/docs/terminal/shell-integration) — uses a comparable "OSC 7 primary, fallback to other signals" architecture (though VS Code does not poll PID — they use OSC 633 markers from their custom shell integration script).
- **Out of scope (deferred):**
  - **Windows polling.** No public cross-process CWD API. Future ADR if usage warrants a native shim.
  - **Always-on concurrent polling.** Rejected per arch decision #1 (cost + race + source-arbitration complexity) — polling is a lazy backstop, not a redundant concurrent signal.
  - **AI bridge polling.** ADR-0019 invariant; protected by hard-reject guard + unit test.
  - **Polling across tmux/screen panes.** Polling reads the outer PTY's foreground process. Inside tmux, the inner shells are tmux's children, not the bridge's. v1 covers the outer-bridge case; a future ADR could parse tmux's `OSC 1337 ; CurrentDir` extension for per-pane visibility.
  - **Polling-driven panel re-rooting under `_followsTerminal === false`.** Existing UX contract: panel re-roots ONLY when follow toggle is on. Polling-sourced `cwd_changed` frames respect the same toggle (no special-case).
  - **macOS native libproc binding.** Implementation detail — SE picks between binding (1ms/poll) and lsof-fallback (180ms/poll). Documented as Negative consequence above.
