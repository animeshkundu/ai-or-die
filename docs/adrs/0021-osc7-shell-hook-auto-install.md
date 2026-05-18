# ADR-0021: Spawn-Time Transient OSC 7 Hook Auto-Install for Terminal Bridge

## Status

**Deferred — v1 cut after round-4 stop-loss.** Wrapper auto-install for ANY shell (pwsh + bash + zsh + fish) does NOT ship in v1. Users get manual one-line install per shell (see `docs/specs/file-browser.md` Shell hooks section). Click-to-open + diagnostic toast (Layer 5) ship in PR #108 as designed; they surface the manual-install snippet contextually on first failed click.

The full technical design from rounds 1–4 is preserved IN this file (below the Status / v1 deferral rationale sections) as the v2 starting point. Bash + zsh design preserved earlier (cut in round 3 E-shape decision; recoverable from the revision-3 snapshot in git history). Pwsh design preserved in the current file head; recoverable in-place.

### v1 deferral rationale

**Four cross-lab review rounds surfaced ~50 cumulative substantive items** with the per-round count staying flat (~10-15 items each), not decreasing:

| Round | New items | Cumulative |
|---|---|---|
| 1 (codex + gemini + opus) | 9 | 9 |
| 2a (gemini + opus) | 6 | 15 |
| 2b (codex re-fire) | 10 | 25 |
| 3 (gemini + codex + opus) | 15 | 40 |
| 4 (codex + opus; gemini re-firing) | 7 | 47+ |

Round 3 surfaced a fatal `.zprofile` Homebrew break on macOS zsh, prompting the **E-shape cut** (bash + zsh deferred to v2; pwsh-only proceeded). Round 4 was the verification pass on the smaller pwsh-only surface. **Stop-loss criterion** set in the E-shape decision: if round 4 surfaced 5+ new substantive items on pwsh-only, downgrade to D (cut wrapper entirely v1, manual install + Layer 5 only). Round 4 returned 7 items including a real correctness bug in our round-3 self-test fix (Phase B lifetime-flag stuck-at-true). **Stop-loss triggered.**

Honest engineering accounting: the wrapper design surface is more dynamic than the v1 cross-lab cycle can clear. Each round closes many items but the rate of NEW item discovery is approximately constant. Continuing iteration produces diminishing returns at increasing risk of shipping subtle bugs (round-3 fix introduced a round-4 bug; one more round may surface bugs in our round-4 fixes). The right move is the pre-committed stop-loss: cut clean now, reset with a fresh ADR after Layer 5 + manual install has shipped and we have real production usage data.

**Same-lab fatigue caveat (opus round-4):** opus explicitly noted "I can't honestly verify [convergence] — I'm the same model as architect." Architect agrees: by the time we're 4 rounds deep into a design, "this last item is small, we can ship it" is exactly the bias the stop-loss was designed to guard against. Honoring the pre-iteration commitment over the in-iteration judgment is the correct epistemic move.

### v1 ship contents (post-deferral)

- **PR #108** — file browser v2 + click-to-open + Layer 5 diagnostic toast. Independent ship.
- **`docs/specs/file-browser.md` Shell hooks section** — per-shell manual install snippets (bash, zsh, fish, pwsh, cmd.exe-recommend-pwsh). Already updated in this revision turn; adjusted to reflect "all shells: manual install" (previously had pwsh marked as auto-installed).
- **Layer 5 Block A** — surfaces the manual-install snippet contextually on first failed click. No Block A' (wrapper-attempted-but-fell-back) needed — there's no wrapper-attempt in v1. Block A'' (cmd.exe → recommend pwsh) keeps its install-pwsh/winget copy.

User's original "Can we try to auto install?" ask is answered: in v1, the manual install is one line of copy-paste from the diagnostic toast. Auto-install is preserved as a future ADR — see Reopen criteria below.

### Reopen criteria for any auto-install wrapper

Any future ADR resurrecting the auto-install wrapper concept (pwsh-only OR bash/zsh) MUST satisfy all of:

1. **Layer 5 + manual install ships in prod for ≥6 weeks** with measurable click-to-open feature usage. Confirms the safety-net path is viable before adding auto-install complexity.
2. **A NEW ADR (e.g., ADR-0022)** specifies the wrapper from scratch. Not a continuation of this ADR. Bash + zsh design from git revision-3 + pwsh design from current head are starting POINTS, not pre-approved designs. The new ADR retreads cross-lab review.
3. **The new ADR's cross-lab review must converge in ≤2 rounds.** If it doesn't, the auto-install wrapper concept is **permanently shelved**. Manual install is the long-term answer; the diagnostic toast already makes that path adequately discoverable.

The stop-loss in this ADR set a precedent: if engineering review can't bound a design's complexity in a finite number of rounds, the right move is to ship the safe subset and let production data inform whether the optimization is needed. The wrapper is an optimization; manual install is the baseline. If users find manual install sufficient (likely given the toast surfaces it contextually), the wrapper may never be needed.

## Date

2026-05-18 (initial), revised through 2026-05-18 (5 revisions: pwsh-priority + round 2a + round 2b + B-shape staged rollout + E-shape pwsh-only + **D-cut to manual-install-only after round-4 stop-loss**).

---

## ORIGINAL DESIGN (preserved for v2 reopen reference)

The remainder of this file documents the design as it stood at the round-4 revision, before the D-cut. It is preserved for v2 reopen reference — any future ADR may take elements from below as the starting point, but they are NOT pre-approved and must be re-litigated in fresh cross-lab review per the Reopen criteria above.

## Context

[ADR-0019](0019-osc7-cwd-tracking.md) ships OSC 7 as the primary CWD signal for Terminal bridges. It explicitly OOS'd auto-injecting OSC 7 hooks into user shell rc files on the basis that "user shell config is sacrosanct; the documented one-liner is the right boundary."

In production this posture has aged poorly:

- macOS bash 3.2 (system default) emits no OSC 7. Homebrew bash 5.x doesn't either.
- zsh + popular prompt frameworks (starship, oh-my-zsh, prezto) don't emit by default.
- pwsh on Windows requires a `function prompt` definition that most users never install.
- cmd.exe has no `PROMPT_COMMAND` equivalent at all — there's no clean emit path.
- Even users who reach `docs/specs/file-browser.md` rarely install the manual one-liner.
- **User report** (architect task #11 origin): with a zsh + starship session, the post-PR-108 click-to-open feature fails silently because `liveCwd` is never populated.

Layer 5 ([commit c6deb71](https://github.com/animeshkundu/ai-or-die/commit/c6deb71)) addresses the silent-failure UX with `FeedbackManager.resolverFailure`'s structured toast (Block A surfaces "install the OSC 7 hook" as actionable copy). The same user came back: **"Can we try to auto install if possible?"**

### Mid-design environment reframe

The initial draft of this ADR (and the parallel [ADR-0020](0020-pid-cwd-polling-terminal-bridge.md) PID-polling backstop) assumed POSIX as the primary target environment. **Two cross-lab rounds focused on bash + zsh + macOS + Linux** — the wrong design center for the user's actual setup. The user clarified mid-design that **their primary environment is Windows (pwsh, sometimes cmd.exe)**.

Implications:

- The original draft deferred pwsh on the basis of critic findings (URI form, `$PROFILE` coverage, `-ExecutionPolicy Bypass`, PSReadLine interaction). Deferring pwsh delivered zero value for the user's actual sessions.
- ADR-0020 PID polling has no path on Windows (no public cross-process CWD API); it's been deferred entirely (see its Status section).
- This revision **promotes pwsh to priority shell** and addresses the previously-deferred pwsh-specific critic items as required engineering, not as "future work."

Architectural acknowledgment: the team should have probed environment earlier. The technical work invested in bash + zsh design and critic rigor is not wasted (it still serves the Linux/macOS user population, even if not the primary user), but the priority order had been miscalibrated.

### What this ADR is NOT (key distinction from ADR-0019's rejected alternative)

ADR-0019 OOS'd auto-injection of OSC 7 hooks into the user's **persistent** shell rc files (`~/.bashrc`, `~/.zshrc`, `$PROFILE`). That posture stands. Editing a user's home directory has unbounded surface: interaction with existing customizations, undo on uninstall, dotfile-manager conflicts, surprise on next non-ai-or-die shell session, security review for any tool that writes to dotfiles.

### What this ADR IS

**Spawn-time transient wrapper.** When we spawn the user's shell as a PTY child, we modify the spawn invocation so the SHELL INSTANCE we spawn sources our OSC 7 hook. We never write to anything inside `$HOME`. Cleanup happens at session end; the user's rc files are read but never written.

The risk profile is fundamentally different:

- **No persistent state on the user's machine.** Tempfiles live under `os.tmpdir()` for the session lifetime.
- **No effect outside ai-or-die.** Wrapper applies ONLY to shells WE spawn; the user's Terminal.app / iTerm2 / tmux sessions started elsewhere are untouched.
- **Automatic cleanup.** No uninstall step required.

## Decision

Adopt the spawn-time transient wrapper for **pwsh only** in v1:

- **pwsh: default-ON** (Windows PowerShell 7 + 5.1). User's primary environment. All critic items addressed at the higher rigor level required for default-on shipping. Detect-failure auto-fallback + 3-layer opt-OUT (env > CLI > UI precedence).
- **bash + zsh: DEFERRED to v2.** Wrapper code is NOT shipped in v1 — not opt-in, not experimental, not behind a flag. Manual one-line install instructions in `docs/specs/file-browser.md` Shell hooks section (per-shell snippets, copy-paste ready). Layer 5 Block A copy points at those docs. See "v2 reopen path" below.
- **fish: no-op** (native OSC 7).
- **cmd.exe: no-op + Block A''** Layer 5 escalation (recommend switch to pwsh).
- **Unknown shells: no-op** (Layer 5 Block A on click failure → manual install instructions).

### v1 scope rationale — pwsh-only

Three cross-lab review rounds surfaced ~40 substantive items, with the bash + zsh surface producing the deepest matrix complexity and the highest rate of "round N finds depth round N-1 missed." Examples:

- Round 1 → bash declare-p shape detection, zsh ZDOTDIR env leak, OSC 7 URI percent-encoding.
- Round 2a → fatal zsh ZDOTDIR load-order paradox (gemini), sentinel marker placement.
- Round 2b → bash declare-p attribute parser broken in 5 ways, zsh effective ZDOTDIR not captured.
- Round 3 → **fatal `.zprofile` Homebrew break on macOS zsh** (gemini), bash declare-p readonly-array edge case, zsh pass-through-shim-for-all-4-files needed for `.zprofile` fix.

Each round closed many items but surfaced ~10-15 new ones. The bash + zsh surface is genuinely more dynamic than the v1 critic cycle can clear. Codex round-2b explicitly recommended cutting bash + zsh; team-lead + architect concurred in round-3 close-out. v1 ships only the subset where the design has converged: pwsh.

User's "can we auto install?" ask is still met for their primary environment (Windows pwsh). Bash + zsh users get manual install instructions surfaced contextually via Layer 5 Block A — same "I clicked, it didn't work, here's the fix" flow as today, just with one-time copy-paste cost.

### v2 reopen path — bash/zsh wrapper

Bash + zsh wrapper design is preserved in git history (see commit history on `docs/adrs/0021-osc7-shell-hook-auto-install.md` for the round-2b revision that included the full bash + zsh sections). v2 reopen criteria:

1. **pwsh v1 ships clean** with no major bash-style depth surprises post-launch (4 weeks zero major issues).
2. **zsh ZDOTDIR pass-through-shim design** (gemini round-3 proposal) is empirically validated against Homebrew + Linuxbrew + oh-my-zsh + powerlevel10k + prezto + zsh-vi-mode + starship.
3. **bash declare-p attribute parser** validated against bash 3.2 / 4.x / 5.x with mocked + real `declare -p` outputs covering readonly-array, associative, nameref, readonly-nameref edge cases.
4. **A fresh cross-lab review round** on a bash + zsh-only ADR (not folded into ADR-0021) confirms no new architectural surprises.

If those conditions are met, **a new ADR (e.g., ADR-0022)** specifies bash + zsh wrapper. ADR-0021 stays pwsh-only-permanent.

### Architecture

New module `src/shell-osc7-installer.js` exposes a single entry point:

```js
prepareShellSpawn({ shell, sessionId }) → { command, args, env, cleanup }
```

- `command` / `args` / `env` are the (possibly modified) spawn arguments TerminalBridge passes to node-pty.
- `cleanup` is an idempotent `() => void` TerminalBridge invokes from `stopSession`.

**Honest naming (codex round-2 item E):** `prepareShellSpawn` is NOT a pure function. It performs I/O at call time — synchronous tempfile mkdir/write, opens a `fs.watch` handle, runs `execFileSync` for the pwsh ExecutionPolicy probe, populates a server-process-wide policy cache, and returns a cleanup callback that closes the watch handle and removes the tempdir. The earlier draft's "pure function over input" claim was misleading. Treat it as a **spawn-prep orchestrator**: deterministic given (shell, sessionId, environment, policy cache, server config), but it actively mutates filesystem and observable system state. Tests stub the I/O surface; callers don't need to know it's not pure.

TerminalBridge.startSession calls it before `super.startSession`, threads `cleanup` through the existing stopSession hook. Testable in isolation via stubbed `fs` + `child_process` + `os.tmpdir()` injection points; swappable; easy to reason about IF you don't mistake it for pure.

When the opt-out resolution (per the Staged Rollout section above) returns "disabled" for the spawning shell, `prepareShellSpawn` returns the spawn arguments unchanged (no-op cleanup, no tempfiles written, no policy probe). This is the fast-path; vanilla spawn is the result.

### Per-shell mechanism (priority order: pwsh first, then POSIX, then no-op shells)

The priority order reflects the user's primary environment. Each shell's hook content + spawn-arg modifications + tempfile layout is documented below. The installer's `prepareShellSpawn({shell, sessionId})` dispatches by basename match (POSIX-style regex on the leaf component of `$SHELL`).

#### pwsh (Windows PowerShell 7 / 5.1) — **priority shell**

The user's primary environment. Treated as first-class with all critic round-1 items addressed (not deferred).

**Detection:**
- Basename match `/pwsh(\.exe)?$/` (PowerShell 7+) or `/powershell(\.exe)?$/` (Windows PowerShell 5.1).
- Platform gate: refuse to wrap on non-Windows pwsh. The wrapper's URI emission uses the Windows backslash-path convention (`C:\Users\foo` → `file:///C:/Users/foo`) and the per-flavor PowerShell binary detection (pwsh.exe vs powershell.exe). On Linux/macOS pwsh, fall through to vanilla spawn + Layer 5 toast.

**ExecutionPolicy handling — rely on early-exit retry, no pre-spawn probe** (SE round-3 empirical finding):

Prior drafts proposed a pre-spawn `Get-ExecutionPolicy` probe (per-flavor cached) to detect locked-down machines (`AllSigned` / `Restricted` policies that `-ExecutionPolicy Bypass` cannot override) and skip the wrapper. SE's probe-2 empirical measurement found this probe costs ~420ms cold subprocess on the GitHub Actions Windows runner, paid on every server startup that initializes Windows-shell handling.

Cost-benefit:
- **Pre-spawn probe:** 420ms × every Windows server startup, regardless of whether the user ever opens a pwsh session.
- **No probe (always attempt wrapper):** 0ms cost on unlocked machines (95%+ of installs per Windows-10/11 default-`RemoteSigned` posture); ~3-5s extra latency on locked-down machines (failed wrapper spawn → early-exit watchdog → vanilla retry) on first pwsh session.

The wrapper-attempt-then-retry path is the better tradeoff. Locked-down corporate machines are the minority case; failing them with a noticeable 3-5s latency on first session is acceptable (they ALSO get a Layer 5 toast explaining the failure). Saving 420ms × every server start × every Windows install is the bigger UX win.

**Design:**
1. Always pass `-ExecutionPolicy Bypass` on the pwsh spawn args.
2. On unlocked machines: the Process-scope Bypass overrides the LocalMachine RemoteSigned default; our shim sources cleanly.
3. On locked-down machines: pwsh refuses to honor the Bypass flag; spawn errors out within seconds.
4. Early-exit watchdog (per "Detection-of-failure auto-fallback" section) catches the failed spawn AND retries vanilla.
5. User sees vanilla shell + Layer 5 toast: "Auto-installed shell hook didn't work for your shell setup; running vanilla shell. See server logs for the failure cause."

No policy detection, no policy cache, no per-flavor probe. Simpler design; faster startup; same eventual UX for locked-down users.

**Tempfile layout:**

```
<os.tmpdir()>/.ai-or-die-shell/<sid>-<rand>/profile.ps1
```

The dot-prefixed parent dir (`.ai-or-die-shell`) avoids file-watcher noise per the SE-flagged sandbox edge case (chokidar's default `ignored: /(^|[\/\\])\../` skips it).

**`profile.ps1` shim content** (addresses items a, b, d, e, f, g; codex round-2 items B, C, F, I applied):

```powershell
# Idempotent wrap check (item e). If we're being re-sourced (e.g., user did
# `. $PROFILE` interactively), don't double-wrap.
if (-not (Get-Variable -Name '_aiordie_origPrompt' -Scope Global -ErrorAction SilentlyContinue)) {

    # Item b: source all 4 canonical $PROFILE locations in canonical order.
    # `Test-Path` each; dot-source if exists. AllUsersAllHosts is sourced
    # first (lowest precedence), CurrentUserCurrentHost last (highest).
    # Spawn command uses `-NoProfile` (codex round-2 item F) so pwsh
    # doesn't double-source $PROFILE.CurrentUserCurrentHost.
    $profiles = @(
        $PROFILE.AllUsersAllHosts,
        $PROFILE.AllUsersCurrentHost,
        $PROFILE.CurrentUserAllHosts,
        $PROFILE.CurrentUserCurrentHost
    )
    foreach ($p in $profiles) {
        if ($p -and (Test-Path -LiteralPath $p)) {
            try { . $p } catch {
                Write-Host "[ai-or-die] warning: failed to source $p : $_" -ForegroundColor Yellow
            }
        }
    }

    # Codex round-2 item B: bytewise UTF-8 percent encoder for path bytes.
    # [Uri]::EscapeUriString preserves URI-reserved chars (`:`, `/`, `?`,
    # `#`) — which means a path containing `#` becomes a URI fragment
    # boundary, and `?` becomes a query boundary. Wrong for path bytes.
    # This encoder treats everything outside the POSIX path-safe allowlist
    # as a byte to percent-encode, matching the bash/zsh shim's behavior.
    function script:_AiordieEncodePathBytes([string]$s) {
        $sb = [System.Text.StringBuilder]::new($s.Length)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
        foreach ($b in $bytes) {
            # Same allowlist as bash/zsh: [A-Za-z0-9._~/-]
            if (($b -ge 0x30 -and $b -le 0x39) -or  # 0-9
                ($b -ge 0x41 -and $b -le 0x5A) -or  # A-Z
                ($b -ge 0x61 -and $b -le 0x7A) -or  # a-z
                $b -eq 0x2D -or                      # -
                $b -eq 0x2E -or                      # .
                $b -eq 0x2F -or                      # /
                $b -eq 0x5F -or                      # _
                $b -eq 0x7E) {                       # ~
                [void]$sb.Append([char]$b)
            } else {
                [void]$sb.AppendFormat('%{0:X2}', $b)
            }
        }
        return $sb.ToString()
    }

    # Item d/e: capture original prompt function, then wrap.
    $global:_aiordie_origPrompt = $function:prompt

    function global:prompt {
        # Call the original prompt first; preserve its return (the prompt string).
        $orig = & $global:_aiordie_origPrompt

        # Compute the OSC 7 URI for the current FileSystem location.
        # Items a + f + g handled here.
        # SE round-3 probe finding: use `file:///` (empty host) for drive
        # paths instead of `file://$env:COMPUTERNAME/`. The Windows-side
        # parser (url.fileURLToPath) treats any non-empty host as a UNC
        # server, so `file://HOSTNAME/C:/...` round-trips to
        # `\\hostname\C:\...` (UNC form) — incorrect for a local drive
        # path. Empty-host form `file:///C:/...` round-trips cleanly to
        # `C:\...`. Drops the $env:COMPUTERNAME interpolation entirely
        # (saves a variable read; cleaner shim).
        try {
            $loc = $executionContext.SessionState.Path.CurrentLocation
            if ($loc.Provider.Name -eq 'FileSystem') {
                $pPath = $loc.ProviderPath

                # Item f: UNC path detection. `\\server\share\foo` becomes
                # `file://server/share/foo` (server name IS the URI host
                # for UNC; that's the semantically correct case where the
                # host segment is meaningful).
                # SE probe-5 finding: the naive `(Get-Location).Path -replace
                # '\\','/'` on a UNC path produces `//server/share/foo`
                # which prepended with `file://HOSTNAME/` yields a
                # malformed three-slash URI. Explicit branch fixes it.
                if ($pPath.StartsWith('\\')) {
                    # Strip leading `\\`, split host from path.
                    # Codex round-2 item C: variable name $host CANNOT be
                    # used — it's a PowerShell automatic read-only variable
                    # (the host metadata object). Assigning to $host throws.
                    $rest = $pPath.Substring(2)
                    $sepIdx = $rest.IndexOf('\')
                    if ($sepIdx -gt 0) {
                        $uriHost = $rest.Substring(0, $sepIdx)
                        $rawPath = $rest.Substring($sepIdx).Replace('\', '/')
                        # Bytewise percent-encode the path bytes (item B).
                        $encPath = _AiordieEncodePathBytes $rawPath
                        [Console]::Write("$([char]27)]7;file://$uriHost$encPath$([char]7)")
                    }
                } else {
                    # Item a: regular drive path. `C:\Users\foo` becomes
                    # `file:///C:/Users/foo` (note THREE slashes after `file:`
                    # = scheme `file` + empty host + path `/C:/Users/foo`).
                    # SE probe-5b confirmed url.fileURLToPath round-trips
                    # this to `C:\Users\foo` cleanly.
                    $forwardSlashPath = '/' + ($pPath -replace '\\', '/')
                    $encPath = _AiordieEncodePathBytes $forwardSlashPath
                    [Console]::Write("$([char]27)]7;file://$encPath$([char]7)")
                }
            }
        } catch {
            # Never let the OSC 7 emit break the user's prompt. Silently swallow.
        }

        $orig
    }

    # Sentinel marker IPC. Codex round-2 item I: use the server-injected
    # _AIORDIE_SHIM_DIR env var for the marker path, NOT a `$PSScriptRoot`
    # or current working-dir resolution. The shim dir is the only stable
    # location we can guarantee here.
    # Gemini round-2 item 3: write marker BEFORE user-rc-equivalent code
    # could run extra side effects. Here the marker is the LAST action
    # of the wrap-install block; if profile sourcing above threw, we
    # don't write the marker → server sees no marker → wrapper failure
    # (correct semantic for pwsh, where profile sourcing IS the user-rc
    # equivalent step).
    try {
        $markerPath = Join-Path $env:_AIORDIE_SHIM_DIR '.shim-ready'
        Set-Content -LiteralPath $markerPath -Value (Get-Date -Format o) -ErrorAction SilentlyContinue
    } catch {}
}
```

**Spawn command:**

```
pwsh.exe -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File <tmpdir>/profile.ps1
```

Argument array passed via node-pty's array form (no string-concat quoting hazards). `-NoExit` keeps the shell interactive after sourcing the .ps1. `-NoProfile` (codex round-2 item F) prevents pwsh from auto-sourcing `$PROFILE.CurrentUserCurrentHost` — our shim sources all 4 profile locations manually, so without `-NoProfile` we'd double-source the CurrentUserCurrentHost profile (once by pwsh, once by us). `-ExecutionPolicy Bypass` is process-scoped (doesn't affect other pwsh invocations). The pre-spawn MachinePolicy check has already filtered the locked-down cases; for unlocked machines this is safe.

**Critic item interactions:**
- Item (a) URI construction: ✅ via the prompt function logic above.
- Item (b) `$PROFILE` 4-location chain: ✅ via the `Test-Path` loop.
- Item (c) ExecutionPolicy: ✅ pre-spawn detection + skip; unlocked machines use Bypass safely.
- Item (d) PSReadLine: prompt-function wrap chains, PSReadLine resolves `prompt` at render time. SE empirical confirmation pending (Windows runner needed).
- Item (e) Idempotent: ✅ via `Get-Variable -Name '_aiordie_origPrompt' -Scope Global -ErrorAction SilentlyContinue` check.
- Item (f) UNC paths: ✅ explicit `StartsWith('\\')` branch.
- Item (g) Percent-encoding: ✅ via `[Uri]::EscapeUriString`.

#### bash + zsh — DEFERRED to v2

**Status: not shipped in v1.** Per the round-3 scope cut documented in the Status header above, the bash + zsh wrapper design surfaced more depth than the v1 cross-lab cycle could clear (3 rounds × ~10-15 items per round, including the fatal macOS Homebrew `.zprofile` break that gemini found in round 3). The wrapper code is NOT shipped for bash + zsh in v1 — not opt-in, not experimental, not behind a flag.

**v1 user path for bash + zsh:** manual one-line install in their  / . Snippets live in  Shell hooks section; Layer 5 Block A toast surfaces those instructions contextually on the first failed click. Same UX as today, plus the toast points at the exact fix.

**v2 reopen path:** see "v2 reopen path — bash/zsh wrapper" in the Decision section above. New ADR (e.g., ADR-0022) specifies the bash + zsh wrapper with the design lessons from rounds 1-3 baked in. ADR-0021 stays pwsh-only-permanent.

**Design preservation:** the prior bash + zsh shim designs (which closed 7 of the 9 round-1 items, plus codex's round-2b BASH_REMATCH attribute parser, plus gemini's round-2 ZDOTDIR both-places restore, plus codex's round-2b zsh effective-ZDOTDIR capture) are preserved in git history at the revision-3 snapshot of this file. v2 reopen starts from that snapshot plus the round-3 findings ( pass-through-shim, gemini's non-interactive shell env poisoning, codex's fs.watch failure handling).

#### pwsh non-Windows / cmd.exe / fish / unknown shells

**pwsh non-Windows** (Linux/macOS pwsh installations): wrapper refuses to engage (platform gate above). User gets Layer 5 toast on click failure.

**fish:** Detect via basename match (`/fish$/`). **No-op** — fish emits OSC 7 natively.

**cmd.exe** (Windows): Detect via basename match (`/cmd(\.exe)?$/`). **No-op + Block A'' Layer 5 escalation.** cmd.exe's `prompt` definition supports only static text + small variable substitutions ($P, $G, $T, etc.); no `PROMPT_COMMAND` equivalent; no arbitrary command execution per prompt cycle. SE empirically confirmed (pending). The wrapper cannot help cmd.exe users. Layer 5 surfaces a distinct copy (Block A'' — see below) that doesn't ask the user to install a hook (they can't) but instead recommends switching to pwsh.

**Unknown shells** (nu, xonsh, elvish, custom paths): Allowlist miss → no-op (vanilla spawn). Layer 5 Block A copy fires on click failure (user can install the relevant shell-specific hook manually if their shell supports OSC 7).

### Tempfile lifecycle

**Layered TOCTOU defense (codex round-2 item D):**

The earlier draft's "synchronous mkdir + writeFileSync" approach leaves three real attack surfaces:

1. Parent `<os.tmpdir()>/.ai-or-die-shell/` can be pre-created by an attacker (or a previous compromised instance) as a symlink or with attacker ownership. We'd write our shim INTO the attacker-controlled location.
2. `writeFileSync(path, ..., { mode: 0o600 })` defaults to follow-symlinks on `open`. An attacker who races us could swap the file path to a symlink pointing into a victim's home directory.
3. Embedding `sessionId` in the path is a path-traversal risk if sessionId is ever non-UUID (today's `crypto.randomBytes` UUID is safe, but the assumption is fragile and shouldn't be load-bearing).

Three-part fix:

**Part 1 — `ensureSecureRoot()`:** before any per-session work, ensure the parent root `<os.tmpdir()>/.ai-or-die-shell/` is safe.

```js
function ensureSecureRoot(root) {
  try {
    const st = fs.lstatSync(root);  // lstat — don't follow symlinks
    // Reject symlinks, non-directories, and unexpected owners.
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (process.platform !== 'win32' && st.uid !== process.getuid()) return false;
    // Enforce 0700 perms on POSIX. Fail-closed if we can't.
    if (process.platform !== 'win32') {
      try { fs.chmodSync(root, 0o700); } catch { return false; }
    }
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Doesn't exist; create with 0700.
      try {
        fs.mkdirSync(root, { recursive: false, mode: 0o700 });
        return true;
      } catch { return false; }
    }
    return false;  // EACCES or other → fail closed.
  }
}
```

If `ensureSecureRoot` returns false → wrapper aborted for THIS spawn → vanilla spawn → Layer 5 toast catches click failures.

**Part 2 — `mkdtempSync` for per-session dir:** never embed sessionId in the path. Use `mkdtempSync(path.join(root, 'session-'))` — Node generates a unique random suffix; OS guarantees no collision.

```js
const shimDir = fs.mkdtempSync(path.join(root, 'session-'));
// shimDir is e.g. <root>/session-aB3xK7
```

Resulting shim path: `<os.tmpdir()>/.ai-or-die-shell/session-<random>/profile.ps1` (or `.bashrc`, etc.). No sessionId; no traversal surface.

**Part 3 — `openSync(O_EXCL)` for shim files:** never let the write follow a symlink. Use `O_WRONLY | O_CREAT | O_EXCL` to refuse if the file already exists.

```js
function writeNewFile(path, content) {
  // O_EXCL → fail if file exists; fresh-only.
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeSync(fd, content); }
  finally { fs.closeSync(fd); }
}
```

If the file exists (race attacker pre-created it inside our just-`mkdtemp`'d dir — extremely narrow window): `O_EXCL` throws `EEXIST`; we abort the wrapper for this spawn → vanilla spawn.

**`createShimDir(shell)` orchestrator** (called by `prepareShellSpawn`):

```js
function createShimDir(shell) {
  const root = path.join(os.tmpdir(), '.ai-or-die-shell');
  if (!ensureSecureRoot(root)) return null;        // fail closed
  const shimDir = fs.mkdtempSync(path.join(root, 'session-'));
  try {
    // Write per-shell files via writeNewFile (O_EXCL).
    if (shell === 'pwsh') writeNewFile(path.join(shimDir, 'profile.ps1'), pwshShimContent);
    else if (shell === 'bash') writeNewFile(path.join(shimDir, '.bashrc'), bashShimContent);
    else if (shell === 'zsh') {
      writeNewFile(path.join(shimDir, '.zshenv'), zshEnvContent);
      writeNewFile(path.join(shimDir, '.zshrc'), zshRcContent);
    }
    return shimDir;
  } catch (err) {
    // Best-effort cleanup; ignore errors.
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
    return null;  // fail closed
  }
}
```

**Location summary (post-fix):** `path.join(os.tmpdir(), '.ai-or-die-shell', 'session-<random>')` — random suffix from `mkdtempSync`, no sessionId, parent root validated by `lstat`+ownership check + chmod 0700. The dot-prefixed parent dir continues to handle the chokidar file-watcher exclusion (separate concern; not security).

- **Per-session cleanup:** TerminalBridge.stopSession invokes the cleanup callback returned by `prepareShellSpawn`. Cleanup does `fs.rmSync(shimDir, {recursive: true, force: true})`. Idempotent; safe to call multiple times.
- **Startup sweep:** scan `os.tmpdir()/.ai-or-die-shell/` for `session-*` directories older than 24h on server start, parallel to the existing `_sweepAttachments` infrastructure (`server.js:501`). Sweep does its own `lstat`+ownership check before `rm` (don't follow symlinks; don't touch other-user files even if name matches).
- **Permissions:** 0700/0600 (POSIX-only attribute; Windows ignores).
- **Memory pressure:** each shim dir is ~4 files × ~200 bytes (zsh) or ~2 files × ~200 bytes (bash) or ~1 file × ~1KB (pwsh) = ~1-2KB. At N=50 long-running sessions, ~100KB total under `os.tmpdir()`. Negligible.
- **Windows 8.3 SHORT vs LONG path mismatch** (SE round-3 probe-1 bonus finding): on Windows, `os.tmpdir()` from Node may return `C:\Users\RUNNER~1\AppData\Local\Temp` (8.3 SHORT form on CI runners and some legacy username configurations). After spawning pwsh, `$PSScriptRoot` and `(Get-Location).Path` return the LONG form (`C:\Users\runneradmin\AppData\Local\Temp`). The `_canonicalizePathSync` helper shipped in PR #108 handles this short-vs-long mismatch at compare time (validatePath sandbox checks normalize both to the long form before comparison). **No new server work needed** — the existing helper closes this surface. Noted here so a future maintainer doesn't re-discover.

### Detection-of-failure auto-fallback

A **NEW early-exit watchdog** is added — distinct from `BaseBridge`'s existing 30s "no first data" watchdog (`base-bridge.js:256-266`), which catches a different failure mode (shell hung at startup). The early-exit watchdog catches "shim was malformed, shell parsed it, errored, exited" — combined with a sentinel-marker IPC check for the steady-state success signal.

**Sentinel marker IPC placement** (replaces the 3s timing heuristic from the earlier draft + gemini round-2 fatal item 3 placement fix):

Each per-shell shim writes a `.shim-ready` file **IMMEDIATELY BEFORE sourcing the user's rc file** — NOT at the end of the shim. Gemini round-2 caught: if user's `.bashrc` errors / `set -e`'s / calls `exit`, the shell terminates BEFORE a tail-end marker write fires → server falsely concludes wrapper failed → triggers vanilla fallback even though the wrapper worked, the user's rc just has bugs. Vanilla retry would fail the same way.

The marker's semantic is "**shim itself initialized successfully**" — true the moment our wrapper code is in place (hook registered, ZDOTDIR-restore complete, PROMPT_COMMAND/prompt wired). Subsequent user-rc execution is the user's responsibility; if it fails, that's a user-rc bug, not a wrapper failure. Our existing BaseBridge spawn-error path handles user-rc errors generically.

Per-shell marker write points:

- **bash:** write marker AFTER `_aiordie_osc7` function defined + PROMPT_COMMAND wired (`declare -p` shape branch complete), BEFORE the user's `.bashrc` is sourced. Wait — currently we source user's `.bashrc` FIRST then wire PROMPT_COMMAND. Re-order: source user's `.bashrc` first (so user's PROMPT_COMMAND value is captured pre-wrap), THEN our shape-detection branch, THEN sentinel marker, THEN done. The user-rc-errors-after-marker case is the bash equivalent of "user's PROMPT_COMMAND wires up incorrectly" or "another later-sourced script breaks things" — uncommon; bash's typical rc flow finishes in milliseconds without errors.

  Actually for bash specifically, the user-rc source completes BEFORE we wire our hook (we read the existing PROMPT_COMMAND to detect its shape). So our shim ordering is: source user.bashrc → shape-detect → wire hook → write marker. The marker write is the LAST shim action; if user's bashrc errored, the shell exits at that point. Acceptable: same outcome as without the wrapper.

- **zsh:** write marker AFTER `add-zsh-hook precmd _aiordie_osc7` completes (hook registered with zsh's array), BEFORE returning control to the interactive shell. In our `.zshrc` flow that's: ZDOTDIR restore → source user.zshrc → register precmd hook → write marker → done. Same caveat as bash: user-zshrc errors before our shim completes → no marker → server flags wrapper failure → auto-fallback to vanilla. That's the trade-off; vanilla retry would fail the same way for user-rc bugs, so we accept it.

- **pwsh:** write marker AFTER `function global:prompt {...}` defined, BEFORE returning from `profile.ps1`. Our shim sources all 4 user `$PROFILE` locations BEFORE wrapping the prompt; user-profile errors during that sourcing already cause shell exit. Marker fires only if all profiles loaded + we wrapped successfully. Stricter than bash/zsh (because the wrap depends on $function:prompt being settled), but correctly reflects "shim initialized" semantics.

The slight asymmetry across shells reflects each shell's actual setup-completion-point. All three converge on "marker = our wrapper code is live and ready to emit OSC 7." 

**Server-side watchdog logic** (codex round-2 item J: fs.watch + fallback poll; separate state; codex round-3 fixes for fs.watch failure handling + onMarker idempotency):

The marker observation uses TWO independent mechanisms to avoid relying on `fs.watch` semantics (which are platform-quirky on some Linux fs / network mounts / containerized environments):

1. **Primary — `fs.watch()` on the shim tempdir** for fast event-driven notification. Started BEFORE spawning the PTY. **If `fs.watch()` throws at install time** (codex round-3): catch the error, log it, and treat as "primary mechanism unavailable" — the polling fallback below becomes the sole observation path. Don't fail the spawn; don't fall back to vanilla because of a watch-install failure (the wrapper might still work; the watch is just the fast-path).
2. **Fallback — polling loop** at ~250ms interval reading `fs.existsSync(markerPath)`. Runs in parallel to the watch. Whichever observes the marker first wins; both then short-circuit. **Installed unconditionally** — even when `fs.watch()` succeeds, the poll runs as belt-and-braces. Cheap (250ms `existsSync` is nanoseconds).
3. **`onMarker()` is idempotent** (codex round-3): both the watch handler and the poll loop call `onMarker()`; the first call sets `session._wrapperInitialized = true` and short-circuits subsequent invocations via the existing flag. JS event-loop double-delivery (e.g., watch and poll both observe the same marker write within microseconds) is bounded — `onMarker()` runs at most once per session.
4. **Watch handle cleanup** is wired into the cleanup callback from `prepareShellSpawn`. On session end OR marker-observed OR auto-fallback fired, the watch handle is closed and the poll timer is cleared. Verified by leak test (no dangling watchers after session.destroy()).

**Separated state per codex round-2 item J:**

| State | Set by | Purpose |
|---|---|---|
| `session._wrapperInitialized` (boolean) | marker-observed (fs.watch or poll) | "Our shim code finished installing." |
| `session._osc7Observed` (boolean) | OSC 7 parser receiving a sequence (`terminal-bridge.js:205`) | "OSC 7 has been emitted at least once." |
| `session._autoOsc7FellBack` (boolean) | Auto-fallback fired (init failure OR self-test failure) | "Wrapper attempted but isn't delivering; show Block A' on click failure." |

These are three separate signals; the toast logic reads each independently. Conflating them (as an earlier draft did) made the post-install self-test ambiguous.

**Watchdog decision tree:**

1. PTY spawned with wrapper args.
2. Marker observation (fs.watch OR poll) → `session._wrapperInitialized = true`; cancel watch + poll.
3. PTY `onExit` with `exitCode != 0` BEFORE marker → wrapper failed during init; auto-fallback to vanilla spawn.
4. PTY `onExit` with `exitCode == 0` BEFORE marker → clean exit at startup (user typed `exit` immediately, or shell flag-misparsed); bubble as normal spawn outcome; don't retry.
5. **Post-marker user-rc errors:** PTY exits with `exitCode != 0` AFTER marker → log full user-rc stderr capture to server log (the wrapper's tempdir path is in the log so user can locate). Do NOT trigger auto-fallback — wrapper worked; user's rc has bugs that would fail vanilla too. Surface the normal spawn-error toast.

The 3s arbitrary timing window from the original draft is dropped entirely. Event-driven + polled — long-running rc files (nvm cold-init taking 5-10s) work without false-positives.

**Auto-fallback sequence on detected init failure** (case 3 above):

1. Log warning with shell + wrapper-tempdir path + exit code + last 1KB of PTY output (so the user can grep their rc for the failing line).
2. Surface a non-modal toast (Block A'' if cmd.exe — see Layer 5 spec below — else "Shell hook auto-install failed; running vanilla shell. Click-to-open paths may not resolve outside the session's start directory.").
3. Retry the spawn with vanilla args (no wrapper).
4. Mark the session as `_autoOsc7FellBack: true` so subsequent reconnects skip the wrapper for THIS session id.

One-shot retry: if vanilla also fails (PTY emits error or non-zero exit within the BaseBridge 30s watchdog), the second failure bubbles as a normal spawn error (don't loop).

### Post-install OSC 7 self-test (opus round-2 critic, silent-clobber gap)

The sentinel marker confirms the shim wrote our hook code. It does NOT confirm the hook actually EMITS OSC 7 in practice. **Opus round-2 surfaced item 14:** PowerShell modules (oh-my-posh, posh-git, starship-init, PSReadLine extensions), zsh frameworks (some prezto modules), and bash plugins can register `prompt` overrides AFTER our wrapper sources them. The wrapper installs cleanly, sentinel marker fires, shell runs normally — but OSC 7 never emits because the module clobbered our prompt. The user clicks → silent failure. No Block A''/A' fires because nothing in our existing pipeline knows the emit is missing.

**The fix is cheap and does NOT resurrect ADR-0020 polling:**

**Two-phase self-test** (opus round-3 refinement: 30s alone doesn't catch lazy/on-demand prompt clobbers; oh-my-posh `Import-Module` on first command >30s after spawn, PSReadLine deferred rebinds, profile event handlers that fire later):

- **Phase A — startup window (30s):** server already tracks `session._osc7Observed` via the OSC 7 parser (`terminal-bridge.js:205-209`); we read the bit at 30s post-spawn. If `_wrapperInitialized && !_osc7Observed` at the boundary, flip `_autoOsc7FellBack = true` immediately.
- **Phase B — running window (re-check on prompt N):** server tracks a per-session `_promptCount` (incremented every time we observe ANY OSC sequence on the PTY stream, OSC 7 or otherwise — proxy for "the shell has rendered a prompt"). After 5 prompts have been observed AND `_osc7Observed` is still false, flip `_autoOsc7FellBack = true`. Catches the "module clobbers on first interactive command" case (oh-my-posh import, posh-git first-run, etc.).

```js
// At wrap-spawn time:
session._osc7Observed = false;
session._promptCount = 0;
session._wrapperSelfTestTimer = setTimeout(() => {
  if (!session._osc7Observed && session._wrapperInitialized) {
    // Phase A: 30s post-spawn, no OSC 7. Likely a module clobbered our
    // prompt at startup.
    flipAutoFellBack(session, '30s startup window');
  }
  session._wrapperSelfTestTimer = null;
}, 30000);

// Hooked into the OSC sequence parser:
function onOscSequenceObserved(session, oscType) {
  if (oscType === 7) session._osc7Observed = true;
  // Any OSC sequence on the PTY is a prompt-cycle proxy.
  session._promptCount = (session._promptCount || 0) + 1;
  if (session._promptCount >= 5 && !session._osc7Observed && !session._autoOsc7FellBack) {
    // Phase B: 5 prompts observed, no OSC 7. Module clobbered later.
    flipAutoFellBack(session, '5-prompt running window');
  }
}

function flipAutoFellBack(session, reason) {
  if (session._autoOsc7FellBack) return;  // idempotent
  session._autoOsc7FellBack = true;
  console.warn(`[wrapper-self-test] session ${session.id} (${session.shellBasename}): no OSC 7 after ${reason} — flipping autoOsc7FellBack (Block A' fires on next click failure)`);
}
```

Two-phase covers both startup-time clobber AND deferred-clobber cases. Phase A is the 30s cutoff for "nothing fired"; Phase B is the running-window catch for "fired once or twice then got clobbered." Together they catch the lazy/on-demand clobber opus round-3 flagged.

**Why this isn't ADR-0020 polling:**
- Polling reads CWD at intervals. Self-test reads ONE bit at ONE moment.
- Polling continues running for the session's lifetime. Self-test runs once at 30s, then never again.
- Polling generates ongoing CPU + IPC traffic. Self-test is `setTimeout` + a boolean read.
- Polling fills the liveCwd map (provides a CWD value). Self-test only changes which Block A vs A' the toast picks; doesn't populate liveCwd.

~20 LOC server-side. Closes opus item 14 without resurrecting the deferred polling ADR.

### Opt-out (v1) — 3-layer with explicit precedence

Codex round-1 item 7: env-var-only is insufficient for default-on with no consent gate. Three layers, with **explicit precedence rule per opus round-2 critic item 6:**

**Precedence: env > CLI > UI** (highest priority first). If a higher-precedence layer is set to "off," lower layers cannot re-enable.

1. **Env var (server-process-wide, highest precedence):** `AI_OR_DIE_NO_AUTO_OSC7=1`. Checked PER-SPAWN (not just at server startup). `AI_OR_DIE_NO_AUTO_OSC7=1 ai-or-die` works as expected without restart; mid-session export also takes effect for the NEXT session-create.
2. **Server CLI flag (mid precedence):** `--no-shell-hook`. Sets the same internal state as the env var; explicit on the command line. Env var overrides if both set (env is the more ephemeral, more "right now" signal).
3. **Per-session UI toggle (lowest precedence):** session-settings menu, defaults to (NOT env_off) AND (NOT cli_off) AND server_default. Survives across reconnects of the same session id (stored in session metadata).

**UI behavior when overridden by higher layer:** the toggle is **visibly disabled** with a tooltip explaining which higher layer is overriding (e.g., "Disabled by --no-shell-hook server flag" or "Disabled by AI_OR_DIE_NO_AUTO_OSC7=1 env var"). User can see why their per-session preference isn't taking effect.

**Precedence resolution pseudocode:**
```js
function wrapperEnabledForSession(session) {
  if (process.env.AI_OR_DIE_NO_AUTO_OSC7 === '1') return false;  // env wins
  if (server.flags.noShellHook) return false;                     // CLI wins next
  // UI toggle is per-session. null = unset → fall through to server default.
  if (session.settings?.wrapperEnabled === false) return false;
  return true;  // default ON
}
```

**Session metadata schema migration:** add a single `settings: { wrapperEnabled: boolean | null }` field to the session-store JSON schema. Existing sessions on disk pre-this-version get null on load (treated as "use server default" → enable). No active migration script needed; the field is additive and tolerant of absence.

### Layer 5 Block A'' (cmd.exe) — spec for PE

Layer 5's existing `FeedbackManager.resolverFailure` Blocks A/B/C/D (shipped in [commit c6deb71](https://github.com/animeshkundu/ai-or-die/commit/c6deb71)) cover the main resolver-failure copy paths. Two new blocks are needed for the wrapper-aware UX, both bundling with the ADR-0021 implementation PR per the prior plan:

**Block A'' — cmd.exe-specific copy** (new, with opus round-2 fix for stock-Windows CTA):

- **Trigger:** `bridgeType === 'terminal' && process.platform === 'win32' && shellBasename === 'cmd.exe' && liveCwd === null`
- **Distinct from Block A** (which assumes a hook IS installable). cmd.exe cannot install an OSC 7 hook; recommending the user install one would be misleading.
- **CTA copy depends on pwsh availability** (opus round-2 caught: stock Windows ships `powershell.exe` 5.1 only; `pwsh.exe` 7 is a separate Microsoft Store install. Recommending `pwsh` on a fresh Windows install would fail with "not found" — worse UX than the cmd.exe fallback we're trying to escape).
- **Detection:** server probes `pwsh.exe --version` once at startup (cached); separately probes `powershell.exe --version` (always present on Windows). Both probes timeout-guarded to 1s.

Copy variant A — pwsh 7 present:
```
Couldn't open "src/server.js"

cmd.exe doesn't support live directory tracking. For click-to-open
to work, start your next session with PowerShell 7 (`pwsh`) — it
supports the same auto-installed shell hook that bash and zsh do.

Tried: C:\Users\foo\src\server.js — not found
```

Copy variant B — pwsh 7 absent, Windows PowerShell 5.1 only:
```
Couldn't open "src/server.js"

cmd.exe doesn't support live directory tracking. For click-to-open
to work, start your next session with Windows PowerShell (`powershell`) —
it supports the same auto-installed shell hook.

Optionally, install PowerShell 7 for the modern shell experience:
   winget install --id Microsoft.PowerShell --source winget
   (or: https://aka.ms/PSWindows for Microsoft Store)

Tried: C:\Users\foo\src\server.js — not found
```

The `winget` command (opus round-3 fix) works on Windows Server / LTSC / enterprise-managed installs where the Microsoft Store is unavailable or blocked by Group Policy. Microsoft Store link kept as the fallback for non-winget-equipped systems (very old Windows 10 builds pre-1809).

**CTA behavior:** v1 is **informational only** (no auto-action button). Opus round-2 surfaced a real footgun: a "Switch to PowerShell" button would create a new session, which means the user loses their current cmd.exe session's terminal state AND any in-flight conversation context with Claude/Codex/etc. Letting the user manually create the new session (via the existing session-create UI they're already familiar with) preserves that context.

v2 could add an actionable "Open new PowerShell session at this cwd" CTA with explicit "starts a fresh session at the same workingDir; existing conversation stays in the cmd tab" copy. Out of scope for v1.

**Block A' — wrapper-attempted-but-fell-back copy** (new):
- **Trigger:** `bridgeType === 'terminal' && liveCwd === null && session._autoOsc7FellBack === true`
- Per the auto-fallback section + post-install self-test section above, a session that experienced wrapper failure OR post-install OSC 7 self-test failure is marked `_autoOsc7FellBack`. Block A' surfaces a distinct CTA than Block A — the user shouldn't be told to "install OSC 7 hook" when our auto-install already attempted-and-failed (or attempted-and-silently-clobbered) for them.
- **Copy:**
  ```
  Couldn't open "src/server.js"

  Auto-installed shell hook didn't work for your shell setup
  (either failed to install or was overridden by a prompt-customizing
  module loaded by your rc). Running vanilla shell; see server logs
  for the failure cause.

  Tried: /Users/foo/src/server.js — not found
  ```
- **CTA:** "Open server logs →" (where the wrapper-tempdir-path + last 1KB of PTY output were logged at fallback time, OR where the self-test "no OSC 7 in 30s" warning was logged).

The shellBasename + `_autoOsc7FellBack` flag plumbing: server adds these fields to the existing `claudeSessions[].agent` adjacency — `agent: 'terminal'` already lands per the Layer 5 commit; add `shellBasename: 'cmd.exe' | 'bash' | 'zsh' | 'pwsh' | 'powershell' | 'fish' | string` and `autoOsc7FellBack: boolean`. Layer 5's `getBridgeType` callback factored once more in `_setupTerminalLinking` to expose this richer context.

### Documented limitations

- **Login bash (`bash -l`).** `--rcfile` is ignored for login bash. Per SE empirical confirmation, our `TerminalBridge` has NEVER spawned login shells — `buildArgs()` returns `[]`, kernel calls `execvp($SHELL, [])`, no `-l` ever passed. node-pty also does NOT expose an `argv0` override, so we can't inject the conventional leading-dash login marker. Login bash is only triggered if the user has aliased `$SHELL` to include `-l` (rare) or invokes a login bash explicitly from within a session. Documented; PID polling (planned ADR-0020) backstops.
- **`.bash_profile` PATH/env not sourced for bash.** Per the bash-shim shape decision above: we source ONLY `~/.bashrc` to avoid double-source hazards (ssh-agent leak, PATH duplication, nvm cold-init re-cost). Users who keep PATH/env exclusively in `~/.bash_profile` see the same gap they'd see in any non-login bash; standard fix is the conventional chain (`[[ -f ~/.bashrc ]] && source ~/.bashrc` at the bottom of `.bash_profile`). Documented as a known limitation, not a regression — current ai-or-die behavior already matches this.
- **zsh non-`.zshenv`/`.zshrc` startup files.** Our shim supplies `.zshenv` + `.zshrc` (both v1-required per SE finding above). Users who rely on `.zprofile` (login-shell) or `.zlogin` (post-zshrc, login-shell) for setup don't get those sourced through our wrapper. Login-shell is rare in our non-login PTY context; v2 could stub all four.
- **pwsh `prompt` redefined AFTER our wrapper wins silently.** If a user's `$PROFILE` (which our shim sources first via `. $PROFILE`) defines `function prompt {...}` AFTER our wrapper saves `$function:prompt`, our hook's `$_aiordie_origPrompt` chain still calls the original prompt, BUT if anything in `$PROFILE` re-defines `prompt` AFTER `. $PROFILE` returns... actually our `function global:prompt {...}` is run AFTER `. $PROFILE`, so we always win the prompt-binding race. The risk is the inverse: if a user later (interactively) does `function prompt { ... }`, that clobbers our wrapper and the hook silently dies. Document as expected behavior; no auto-recovery (user explicit action).
- **tmux / screen multiplexers.** Inner shells inside tmux fire OSC 7 but tmux 3.x swallows it (per ADR-0019). Wrapper fires; tmux still swallows. PID polling (planned ADR-0020) backstops by reading the inner shell's `/proc/<pid>/cwd`.
- **Read-only `/tmp`** (chrooted / hardened environments). Caught (fs.writeFileSync throws); logged; vanilla spawn. Silent fallback.
- **bash PROMPT_COMMAND readonly edge case.** When a user has explicitly `readonly`-locked PROMPT_COMMAND, our shim respects that lock and skips appending; no OSC 7 emit on that user's prompts. Rare but documented. Layer 5 Block A catches resulting click failures with the "install OSC 7 hook" advice — which for a readonly-PROMPT_COMMAND user means manually editing their `.bashrc` and removing the readonly, since our wrapper won't touch it.
- **pwsh on Windows empirically pending.** SE Windows-runner validation (task #16) in flight; the 6 empirical items must clear before shipping pwsh wrapping. If PSReadLine interaction (item d) breaks, pwsh fall-through to vanilla + Layer 5 toast (which on Windows is Block A pointing at the pwsh hook docs — same instructions the wrapper would have applied).
- **`--folder=os.tmpdir()` file-watcher noise.** If user runs ai-or-die with the file-browser sandbox rooted at `/tmp` (legit dev workflow), our tempfile writes under `<tmpdir>/.ai-or-die-shell/<sid>/` are NOT scanned because chokidar's default `ignored: /(^|[\/\\])\../` skips dot-prefixed paths. v1 mitigation is the nested dot-dir per Tempfile lifecycle above. If a future chokidar config disables the dotfile ignore for some reason, this surfaces.
- **Non-standard shells.** No injection; Layer 5 toast catches.

### Interaction with Layer 5 (`FeedbackManager.resolverFailure`) and deferred ADR-0020 (PID polling)

Two-layer defense in v1 (was three; ADR-0020 deferred per its Status header):

1. **ADR-0021 wrapper auto-install (this ADR).** Primary fix — pwsh + bash + zsh. Hook fires on initial prompt, so `liveCwd` is primed by session start. Closes most cases for users on the four supported shells.
2. **Layer 5 toast (commit c6deb71 + Block A'' + Block A' patches bundled with this ADR's implementation PR).** Safety net for cases the wrapper doesn't cover:
   - **Block A:** wrapper not installed (unknown shell; wrapper opt-out engaged; shell platform ungated like Unix pwsh). "Install OSC 7 hook" copy still applicable.
   - **Block A' (new):** wrapper attempted but auto-fallback fired. Don't tell user to install something we tried + failed at; point at server logs.
   - **Block A'' (new):** cmd.exe. Wrapper can't help (no `PROMPT_COMMAND` equivalent). Tell user to switch to pwsh; provide a CTA.
   - **Block B/C/D:** unchanged from c6deb71 (other resolver-failure copy paths).
3. **~~ADR-0020 PID polling~~:** DEFERRED. See ADR-0020 Status header for rationale + reopen criteria. Linux/macOS users in tmux/screen/unknown-shell setups don't get this backstop in v1.

Layered, not redundant. Each handles a case the others can't, within the v1 scope.

### Cross-lab adversarial review status

Round 1 surfaced 9 items (codex 1-7, gemini A+B). Round 2 surfaced 6 items (gemini 1-3 fatal, opus 4-6). ALL 15 items addressed in this revision per the engineering matrix below. Round 3 focus:

- **Verifying round-2 fixes hold** — especially the both-places ZDOTDIR pattern in real zsh test environments (worth empirical test against oh-my-zsh + powerlevel10k + prezto on Linux, since SE's earlier zsh validation was macOS-only).
- **Folding codex round-2** — codex re-fired the round with a request for full ADR text inline; their findings will arrive separately and need to fold into round-3 close-out.
- **Confirming SE empirical results** — Windows probe round (task #16) is in flight; if the probes return blocking issues with pwsh-on-Windows (especially PSReadLine interaction in the impl-phase test), the design may need adjustment.
- **Round-1 stress-test items 1-15** — preserved below for reference; most are resolved by round-1+2 fixes, with the unresolved ones flagged in their items.

The 15 stress-test items from prior rounds remain documented below as reference for what the design needed to address — many are now closed by the round-1+2 fix matrix, with residuals (e.g., real-world framework interaction tests) for round-3 verification:

Round 1 surfaced 9 items (codex 1-7, gemini A+B); all 9 are addressed in this revised draft (mapping in the "Engineering items resolved" matrix below). Round 2 focuses on the **pwsh-specific** items that became load-bearing after the user-environment reframe, plus any residual concerns on the bash/zsh design:

1. **pwsh `Get-ExecutionPolicy -Scope MachinePolicy` reliability.** Detect-then-skip pre-spawn assumes the probe is fast (~200ms) and accurate. **Critic question:** is there any policy state where `MachinePolicy` reports `Undefined` but a downstream effective policy is `AllSigned`? Should we probe `Get-ExecutionPolicy -List` and inspect all scopes, taking the strictest? What about Group Policy applied via Active Directory after pwsh is already running?

2. **pwsh 4-`$PROFILE`-location dot-source side effects.** Sourcing AllUsersAllHosts → AllUsersCurrentHost → CurrentUserAllHosts → CurrentUserCurrentHost in order. **Critic question:** if a user's CurrentUserCurrentHost `$PROFILE` does `. $PSScriptRoot\helpers.ps1` with a relative reference, does our shim's location vs. the user's location confuse the relative resolution? `$PSScriptRoot` should resolve to the directory of the .ps1 being sourced — which during their profile is THEIR profile's dir, not our shim's. Worth empirical confirmation.

3. **pwsh prompt-function wrapping under PSReadLine.** PSReadLine (default line editor in pwsh 7) hooks prompt rendering via `Set-PSReadLineOption -PromptText`. **Critic question:** does our `function global:prompt {...}` override interfere with PSReadLine's prompt detection, cursor positioning, or history navigation (Up/Down arrows, Ctrl+R search)? Specifically: does PSReadLine resolve `$function:prompt` at every render or cache the function reference at install time?

4. **pwsh `$PROFILE` sourcing TWICE risk.** Our shim does `. $PROFILE.CurrentUserCurrentHost` explicitly. PSReadLine and other modules might ALSO call `. $PROFILE` internally. **Critic question:** is there a real risk of double-source side effects in pwsh equivalent to the bash ssh-agent-leak case we cited as motivation for single-source `.bashrc`? Need empirical check.

5. **bash `declare -p` shape detection edge cases.** Round-1 critic codex 1 demanded shape detection over version detection. Our shim now branches on `declare -p PROMPT_COMMAND` output. **Critic question:** does `declare -p` for a readonly PROMPT_COMMAND emit the same `'declare -ar'` prefix we expect? What about `local` or `nameref` in nested function contexts? Edge cases worth exhausting before ship.

6. **zsh ZDOTDIR restore correctness.** Round-1 gemini A: capture ORIG_ZDOTDIR at shim entry; restore at end. Our `.zshenv` does this BEFORE sourcing user's `.zshenv`, so nested `zsh -c` subshells started by the user's `.zshenv` see RESTORED ZDOTDIR. **Critic question:** what about subshells started by `.zshrc` (which is sourced later)? They'd see restored ZDOTDIR too because `.zshenv` already ran. Confirmed correct, but verify with a test.

7. **OSC 7 URI percent-encoding correctness.** Round-1 gemini B: encode the path. Our bash/zsh shim uses a POSIX hex/percent loop; pwsh uses `[Uri]::EscapeUriString`. **Critic question:** do these two encoders agree on edge cases like `+`, `%`, fragment `#`, query `?`? `[Uri]::EscapeUriString` does NOT encode characters reserved for URI structure (`:`, `/`, `?`, `#`, etc.); our bash loop encodes everything except `[A-Za-z0-9._~/-]`. Slight asymmetry; matters when a path contains `?` or `#` (unusual but legal on Windows / Linux). Cross-lab to verify the server-side `url.fileURLToPath()` handles both consistently.

8. **Tempfile race / TOCTOU.** Synchronous write before spawn avoids the write-vs-spawn race. **Critic question:** is there a TOCTOU surface between `mkdtempSync` + `writeFileSync` + spawn where another process could substitute the file? (0700/0600 in user's own tmpdir is a strong mitigation, but worth checking — particularly the brief window where the dir exists with 0700 but the file inside has just been written with 0600.)

9. **Sentinel-marker IPC reliability.** The `.shim-ready` file is the signal that the wrapper sourced successfully. **Critic question:** what if the shim writes the marker but then the user's `.bashrc` errors out AFTER the marker write? Our auto-fallback wouldn't fire because the marker arrived. The user is left with a half-loaded environment + a working OSC 7 emit. Acceptable degradation (env may be incomplete but liveCwd works) but document as a known semantic.

10. **Layer 5 Block A'' UX coherence.** Block A'' tells cmd.exe users to "switch to PowerShell." **Critic question:** is the "Switch to PowerShell" CTA easy to implement (terminal sessions are typed at creation time; switching requires destroying the current session and creating a new one)? Or is it better to surface "open settings" only and let the user re-create themselves?

11. **Opt-out 3-layer interaction.** Env var + CLI flag + per-session UI toggle. **Critic question:** the per-session UI toggle requires storing state in session metadata that survives reconnects. Does the existing session-store schema accommodate a `wrapperEnabled: boolean` field? Migration concerns for existing sessions on disk?

12. **conda/pyenv/nvm `export SHELL=/bin/bash` leakage.** Carried over from round 1 (codex item flagged but unaddressed). User's `.bash_profile` may override `$SHELL` — but we don't source `.bash_profile`, so the override doesn't reach our shim. **Critic question:** does anything else leak the wrong `$SHELL` value back to children spawned by the wrapped shell (e.g., user starts `claude` inside the wrapped bash; `claude` reads `$SHELL`)?

13. **zsh emulation modes affecting `printf`.** Our hook function uses `emulate -L sh` to scope to POSIX behavior. **Critic question:** does `emulate -L sh` reliably reset all flags that could affect `printf '\e]7;...'` parsing, including `setopt no_unset` / `setopt err_exit` propagated from outer scope?

### Engineering items resolved from cross-lab rounds 1, 2a, and 2b

**Round 1 items (codex 1-7, gemini A+B):**

| Round-1 item | Status in this revision |
|---|---|
| Codex 1 — bash PROMPT_COMMAND shape detection (not version) | ✅ `declare -p PROMPT_COMMAND` shape match (scalar/array/readonly/unset) in bash shim. Named function `_aiordie_osc7` appended by NAME, not inline. |
| Codex 2 — pwsh broken (deferred) | ✅ UNDEFERRED. All 7 sub-items (a-g) addressed in pwsh section above. |
| Codex 3 — TOCTOU/sweep | ✅ Synchronous mkdir + write before spawn; nested dot-dir under `os.tmpdir()`; per-session cleanup on stopSession; startup sweep for >24h orphans; 0700/0600 perms. |
| Codex 4 — zsh .zshenv | ✅ Mandatory v1; shim sources `$HOME/.zshenv` with the load-order-safe both-places restore pattern (see round-2 item 1). |
| Codex 5 — 3s timing dropped | ✅ Replaced with sentinel-marker IPC (`.shim-ready` file); exit-code-only trigger for auto-fallback. Marker placement now correct per round-2 item 3. |
| Codex 6 — login-shell argv0 | ✅ Documented: TerminalBridge has never spawned login shells; only affects user-aliased SHELL with `-l`. Wrapper detects-and-no-ops on login-shell spawn intent. |
| Codex 7 — 3-layer opt-out | ✅ Env var + CLI flag + per-session UI toggle. All three v1-required. **Round-2 added explicit precedence rule (env > CLI > UI) + UI disabled-state tooltip + session metadata schema migration plan.** |
| Gemini A — ZDOTDIR env leak | ✅ Both-places restore pattern in zsh shim (see round-2 item 1 for the full pattern fix). |
| Gemini B — OSC 7 URI percent-encoding | ✅ POSIX hex/percent-encode loop in bash/zsh; `[Uri]::EscapeUriString` in pwsh. |

**Round 2 items (gemini 1-3 fatal + opus 4-6):**

| Round-2 item | Status in this revision |
|---|---|
| Gemini 1 — zsh ZDOTDIR load-order paradox | ✅ Both-places restore pattern: `.zshenv` temporarily restores ZDOTDIR for user-`.zshenv` sourcing then puts ZDOTDIR back to temp so zsh finds OUR `.zshrc`; `.zshrc` does the permanent restore. Addresses gemini's load-order finding AND the round-1 env-leak in one mechanism. Goes beyond gemini's simpler "restore at top of .zshrc" suggestion because that pattern leaks subshells spawned from user `.zshenv` (conda init, pyenv init). |
| Gemini 2 — ExecutionPolicy `-Scope MachinePolicy` blind | ✅ Pre-spawn detection DROPPED entirely per SE round-3 probe (420ms cost per server start was the wrong tradeoff vs locked-down minority case). Design now: always pass `-ExecutionPolicy Bypass`; rely on early-exit watchdog + vanilla retry for locked-down machines. No two-flavor probe; no policy cache; no `-Scope MachinePolicy` issue (because no probe). |
| Gemini 3 — Sentinel marker placement creates false-positive fallbacks | ✅ Marker write moved to BEFORE user-rc source. Marker semantic clarified: "shim itself initialized successfully" — true once our wrapper code is in place, BEFORE user rc runs. User-rc errors post-marker bubble as normal spawn errors with stderr capture logged; do NOT trigger auto-fallback (vanilla retry would fail the same way). |
| Opus 4 — Post-install OSC 7 self-test (module clobber gap) | ✅ Per-session 30s timer + `_osc7Observed` bit. If wrapper installed cleanly (marker fired) but no OSC 7 received in 30s, flip `_autoOsc7FellBack = true` → Block A' fires on subsequent click failure. ~20 LOC server-side; not polling (reads one bit at one moment vs. polling's continuous CWD reads). |
| Opus 5 — Block A'' CTA broken on stock Windows | ✅ Two-tier copy: pwsh 7 detected → recommend `pwsh`; pwsh 7 absent → recommend Windows PowerShell 5.1 (`powershell.exe`, always present on Windows) PLUS link to install pwsh 7. v1 CTA is **informational only** (no auto-click button) to avoid the cwd/conversation-state-loss footgun on auto-switch. |
| Opus 6 — Opt-out 3-layer precedence undefined | ✅ Explicit precedence: env > CLI > UI. UI toggle visibly disabled with tooltip when overridden by higher layer. Session metadata schema migration plan documented (additive nullable `settings.wrapperEnabled` field). |

All 15 round-1+2a items resolved. Below: 10 more from codex's round-2b re-firing.

**Round 2b items (codex full-ADR re-fire):**

| Round-2b item | Status in this revision |
|---|---|
| Codex A — bash `declare -p` matrix broken multiple ways | ✅ Replaced string-prefix `case` with BASH_REMATCH attribute-set parse. Handles `-ar` (readonly array), `-A` (associative — refuses), `-n` (nameref — refuses), and version-gates array PROMPT_COMMAND to bash 5.1+ (where it became prompt-aware). |
| Codex B — `[Uri]::EscapeUriString` preserves URI-reserved chars | ✅ Replaced with bytewise UTF-8 percent encoder (`_AiordieEncodePathBytes`) in pwsh shim. Encodes everything outside POSIX path-safe allowlist `[A-Za-z0-9._~/-]`. Matches bash/zsh shim behavior. |
| Codex C — `$host` PowerShell automatic variable collision | ✅ Renamed to `$uriHost`. UNC branch no longer throws into outer try/catch. |
| Codex D — Tempfile TOCTOU multi-surface | ✅ Three-part layered defense: `ensureSecureRoot()` (lstat + ownership check + chmod 0700 + fail-closed); `mkdtempSync('session-')` (no sessionId in path; OS-generated random suffix); `openSync(O_EXCL)` for shim files (refuses pre-existing files). All paths fail-closed → vanilla spawn. |
| Codex E — `prepareShellSpawn` "pure function" claim misleading | ✅ Dropped. Renamed honest naming: "spawn-prep orchestrator." Doc updated to acknowledge I/O at call time (tempfile mkdir/write, fs.watch, execFileSync). |
| Codex F — pwsh missing `-NoProfile` flag | ✅ Added. Spawn command now `pwsh.exe -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File <path>`. Prevents pwsh's auto-source of `$PROFILE.CurrentUserCurrentHost` from double-sourcing alongside our shim's manual 4-location sourcing. |
| Codex G — Policy detection must query actual shell | ✅ Per-flavor probe + cache: `probeEffectivePolicy(exeBasename)` where `exeBasename` is derived from the spawned shell ('pwsh' vs 'powershell'). Two independent caches; correct policy for each flavor. |
| Codex H — zsh effective user ZDOTDIR | ✅ `.zshenv` captures `_AIORDIE_EFFECTIVE_ZDOTDIR` AFTER user's `.zshenv` runs (which may have set custom ZDOTDIR). `.zshrc` sources `$ZDOTDIR/.zshrc` using the effective value, not always `$HOME/.zshrc`. Honors user-set custom ZDOTDIR. |
| Codex I — marker path `${ZDOTDIR}/.shim-ready` after ZDOTDIR restore | ✅ All shims use server-injected `_AIORDIE_SHIM_DIR` env var for marker path. zsh shim caches the value before unsetting bookkeeping vars. bash uses `${_AIORDIE_SHIM_DIR:-/tmp}`. pwsh uses `$env:_AIORDIE_SHIM_DIR`. |
| Codex J — fs.watch reliability + state separation | ✅ Two-mechanism marker observation: fs.watch (primary, fast) + 250ms polling fallback (Linux/network-mount/container safety). Watch handle cleanup wired into `cleanup` callback. Separated state: `_wrapperInitialized` (marker) vs `_osc7Observed` (parser) vs `_autoOsc7FellBack` (decision flag) — three independent signals, no conflation. |

All 25 round 1+2 items resolved. Round 3 surfaced 15+ MORE items, including a fatal macOS Homebrew break on zsh (`.zprofile` bypassed by ZDOTDIR shim). After three rounds of ~10-15 items each with no convergence signal, scope cut to pwsh-only per the Decision section.

**Round 3 items resolved (pwsh-specific only — bash + zsh items preserved in git history for v2 reopen):**

| Round-3 item | Status |
|---|---|
| Gemini — fatal `.zprofile` Homebrew break on macOS zsh | ✅ **DEFERRED via scope cut.** bash + zsh wrapper not shipped in v1. Pass-through-shim design (gemini's proposed fix) preserved in v2 reopen notes; needs its own ADR. |
| Gemini — non-interactive shell env poisoning | ✅ DEFERRED via scope cut (zsh-specific). |
| Gemini — JS event-loop double-delivery on marker | ✅ Codex round-3 onMarker idempotency fix in Detection-of-failure section (state-flag short-circuit). |
| Codex — fs.watch failure handling missing | ✅ Catch error at install time, log, polling fallback becomes sole observation; don't fail spawn (Detection-of-failure section). |
| Codex — onMarker idempotency missing | ✅ Idempotent via `session._wrapperInitialized` flag short-circuit (Detection-of-failure section). |
| Codex — `_AIORDIE_SHIM_DIR` env var not actually immutable | ✅ For pwsh, the shim reads `$env:_AIORDIE_SHIM_DIR` once at marker-write time via a captured variable; we accept that user startup code COULD theoretically mutate `$env:_AIORDIE_SHIM_DIR` between source-start and marker-write (it's a write-once captured variable in pwsh, not a true immutable). Documented as a residual; mitigation considered (a separate const) deferred — the practical attack surface is low (user would have to actively target our env var). |
| Codex — item H mishandles default zsh users | ✅ DEFERRED via scope cut (zsh-specific). |
| Codex — item G doesn't probe ACTUAL shell | ✅ **DISSOLVED via SE round-3** — pre-spawn policy probe dropped entirely; no shell-flavor mis-classification possible because no probe runs. |
| Codex — B-shape opt-in env var footgun | ✅ **DISSOLVED** — B-shape itself is cut. No `AI_OR_DIE_ENABLE_BASH_ZSH_HOOK` env var ships in v1; the parent-shell-profile-inherit footgun cannot fire. |
| Opus — multi-shell session toggle UI confusion | ✅ **MOOT under E-shape** — only one wrapped shell type (pwsh) in v1; toggle scope is unambiguous. |
| Opus — 30s self-test misses lazy/on-demand clobbers | ✅ Two-phase self-test (Phase A: 30s startup window; Phase B: 5-prompt running window) in Post-install OSC 7 self-test section. Catches both startup-time and deferred-clobber cases. |
| Opus — "Zero auto-fallback for ≥4 weeks" is unmeasurable | ✅ N/A under E-shape — bash/zsh promotion criteria deferred entirely (v2 ADR specifies its own measurable criteria). For pwsh post-launch monitoring, this ADR doesn't require promotion since pwsh ships default-ON from v1. |
| Opus — Microsoft Store CTA breaks on Server/LTSC | ✅ Added `winget install Microsoft.PowerShell` command alongside Microsoft Store link in Block A'' copy. |

Round 3 items deferred via scope cut: 4 (all bash/zsh-specific). Round 3 items addressed in design: 9. Round 3 items moot/dissolved under E-shape: 2.

**SE empirical round (task #16) — Windows CI probes:**

| SE finding | Status |
|---|---|
| Probe 1 — node-pty + pwsh -File array form works (plain/spaces/long tempdirs) | ✅ Validated; ADR locks array form. |
| Probe 1 bonus — Windows 8.3 SHORT/LONG path mismatch | ✅ Note added to Tempfile lifecycle; existing `_canonicalizePathSync` (PR #108) handles. No new server work. |
| Probe 2 — `Get-ExecutionPolicy` subprocess is 420ms cold | ✅ Pre-spawn detection DROPPED entirely (see Gemini 2 row above). Rely on early-exit retry + Layer 5 toast. |
| Probe 3 — 4 $PROFILE paths resolve cleanly; sourcing not idempotent | ✅ Validated; canonical-order design preserved. -NoProfile + explicit dot-source confirmed correct. |
| Probe 4 — PSReadLine 2.3.6 baseline + wrap-install smoke positive | ✅ Validated; interactive Up/Tab still deferred to impl-phase per agreement. |
| Probe 5 — `[Uri]::EscapeUriString` handles ASCII/spaces/unicode/parens; UNC + URI emit shape needs design change | ✅ pwsh shim updated: `file:///` empty-host form for drive paths (was `file://HOSTNAME/`); explicit UNC branch for `\\server\share` paths. Round-trips via `url.fileURLToPath()` confirmed. |
| Probe 5b — server-side parser round-trips all 5 path shapes | ✅ Wire-compatible. |
| Probe 6 — cmd.exe `prompt /?` has zero command-execution mechanism | ✅ Block A'' limitation hardened from "we believe" to "Microsoft-documented." |

**Cumulative: 40 items across 4 critic rounds + 6 SE-empirical findings, all addressed or dissolved.** Bash + zsh items are preserved in git history (revision-3 snapshot) for v2 reopen; their fix designs aren't lost, just deferred.

### Round 4 focus (stop-loss verification pass)

Round 4 is a VERIFICATION pass on the pwsh-only design, NOT a full re-review. Critics asked to confirm:

- Round-3 pwsh fixes hold (two-phase self-test correctness; fs.watch + poll idempotency; winget CTA enterprise-compat).
- pwsh-only design doesn't have hidden depth comparable to bash/zsh (the .zprofile-class surprises).
- Scope cut is correctly reflected (no stale bash/zsh references; no half-cut shape).

**Stop-loss: if round 4 surfaces 5+ NEW substantive items on the pwsh-only design, downgrade to D** (drop wrapper entirely in v1; ship manual hook docs + Layer 5 toast for all shells). Honest acknowledgment that wrapper design needs a v2 cycle.

14. **pwsh PROFILE-defers-prompt-redefinition race.** Our wrapper does `. $PROFILE.*` THEN `function global:prompt {...}`. **Critic question:** what if a PowerShell module loaded by `$PROFILE` lazily defers a `prompt` redefinition (e.g. registers a `prompt` override on first command via an event handler)? Our wrapper would be in-place at session start but get overwritten later — silently. Document as expected behavior or guard with a re-wrap step on each prompt invocation?

15. **File-watcher sandbox edge case re-verify.** If user runs `ai-or-die --folder=/tmp` (dev workflow), our tempfile writes under `<os.tmpdir()>/.ai-or-die-shell/<sid>-<rand>/` are NOT scanned because chokidar's default `ignored: /(^|[\/\\])\../` skips dot-prefixed paths. **Critic question:** is the dotted-parent-dir mitigation reliable across chokidar's documented behavior on macOS / Linux / Windows? Does any future chokidar config (e.g. `ignored: false` for debug) re-open this?

## Consequences

### Positive

- **"Just works" for the user's primary environment.** pwsh on Windows gets `liveCwd` populated automatically. Click-to-open + panel re-rooting work without user setup. The Windows-primary reframe is fully addressed.
- **Bash + zsh users get a clear manual-install path.** Layer 5 Block A toast surfaces the per-shell hook snippet contextually on the first failed click — they paste one line in their `~/.bashrc` / `~/.zshrc`, done. Same UX as before this design effort, but with actionable in-app guidance instead of silent failure.
- **No user-filesystem mutation in v1** for any shell. pwsh wrapper is transient (tempfile only); bash + zsh have no wrapper code at all (manual install is user's choice + their file).
- **No surprise outside ai-or-die.** Wrapper applies ONLY to pwsh sessions we spawn; user's other terminals (Terminal.app, iTerm2, tmux sessions started elsewhere, Windows Terminal tabs spawned outside ai-or-die) are untouched.
- **Composes with existing infrastructure.** Reuses BaseBridge's PTY-spawn surface, terminal-bridge's OSC 7 parser, Layer 5's safety-net toast.
- **Bounded blast radius.** Wrapper failure is one pwsh session; sentinel-marker auto-fallback retries vanilla. Bash + zsh have ZERO blast radius (no wrapper to fail).
- **Default-ON respects the user's explicit ask** for their primary shell. "Can we try to auto install if possible?" → yes for pwsh; cmd.exe gets a clearer alternative path via Block A''; bash/zsh users get Block A pointing at the manual one-liner.
- **Hook fires on initial prompt.** Side benefit for pwsh: `liveCwd` is primed by session start, which lands the user's "resync on launch" intuition automatically — no separate signaling needed.
- **All 40 cumulative critic items resolved.** Engineering matrix above shows each item closed by a concrete design change or scope cut.
- **Smaller round-4 verification surface** vs the prior B-shape (which would have needed full bash/zsh round-3 fix-pass + round-4 review). Faster ship.

### Negative

- **Bash + zsh wrapper deferred to v2** — Linux/macOS users (the broader POSIX dev population, not the primary user) don't get auto-install in v1. Manual one-line install is the documented alternative; Layer 5 surfaces it on first failed click. Real cost in onboarding friction for that user segment, but bounded (one-time copy-paste).
- **Footgun surface in user pwsh-profile interactions.** PowerShell modules with deferred prompt redefinition (oh-my-posh, posh-git, starship init ordering, PSReadLine extensions) — each is a potential surprise. Two-phase self-test catches most; documented limitations cover the rest; cross-lab round 4 + auto-fallback safety net cover what we missed.
- **Significant engineering complexity for pwsh** (4-profile-location chain, pre-spawn MachinePolicy detection, bytewise URI encoder, sentinel-marker IPC with watch + poll fallback, 3-layer opt-out, 2-phase self-test, tempfile TOCTOU defense). But bounded — pwsh design has converged where bash + zsh hasn't.
- **pwsh on Windows empirically pending.** SE Windows-runner validation (task #16) in flight; if any of the 6 empirical items returns blocking issues, may need design adjustment before ship.
- **cmd.exe gets no wrapping; Block A'' tells user to switch shells.** Acceptable per technical reality (no `PROMPT_COMMAND` equivalent) but real UX cost for cmd.exe users.
- **Polling backstop (ADR-0020) is DEFERRED.** Users in tmux/screen/unknown-shell setups get Layer 5 toast as their only fallback when wrapper doesn't engage.
- **Slightly larger spawn cost** for pwsh. Tempfile write + extra `-NoLogo -NoProfile -NoExit` args + one-time MachinePolicy probe (~200ms). Sub-millisecond steady-state.
- **Diagnostic surface widens.** "Did my shell fail because of my profile, or because of the wrapper?" Logging includes the wrapper-tempdir path + last 1KB PTY output on fallback; the auto-fallback warning toast makes the wrapper's presence visible at failure time.
- **Diagnostic surface widens.** "Did my shell fail because of my rc, or because of the wrapper?" Logging includes the wrapper-tempdir path so users can investigate; the auto-fallback warning toast makes the wrapper's presence visible at failure time.

### Neutral

- **No new runtime dependency.** Installer is pure Node (`crypto`, `fs`, `os`, `path`).
- **Tempfile sweep parallels existing `_sweepAttachments`.** No new sweep machinery to design.
- **WebSocket protocol unchanged.** Spawn-time concern; client side already consumes `cwd_changed` per ADR-0019.
- **Spec impact:** `docs/specs/file-browser.md` gains an "Auto-installed shell hook" section; `docs/specs/bridges.md` documents the installer hook on TerminalBridge.startSession. ADR-0019's "Auto-injecting OSC 7 hooks into user shell rc files" OOS bullet gets an "Amended by ADR-0021: spawn-time transient wrapper" footnote — the persistent-rc-edit posture stands, the transient-wrapper alternative is the new approach.

## Notes

- **Related:**
  - [ADR-0019](0019-osc7-cwd-tracking.md) — establishes OSC 7 as the primary CWD signal for Terminal bridges; this ADR amends the "auto-injection OOS" bullet specifically (transient wrapper ≠ persistent rc-edit).
  - [ADR-0020](0020-pid-cwd-polling-terminal-bridge.md) (Deferred) — PID polling backstop scoped to Linux/macOS Terminal bridges. Deferred in v1 per its Status header (Windows-primary user shift; complexity-per-user-helped ratio post-critic-round-2). Reopen criteria documented.
  - [Layer 5 commit c6deb71](https://github.com/animeshkundu/ai-or-die/commit/c6deb71) — `FeedbackManager.resolverFailure` structured toast that surfaces actionable failure copy when the wrapper doesn't help.
- **External references:**
  - [bash 5.1 release notes](https://lists.gnu.org/archive/html/bash-announce/2020-12/msg00000.html) — `PROMPT_COMMAND` array support; the version-vs-string divide driving our shim's conditional.
  - [zsh add-zsh-hook documentation](https://zsh.sourceforge.io/Doc/Release/Functions.html) — the additive hook mechanism we use (vs `function chpwd() {...}` which would clobber).
  - [WezTerm shell integration](https://wezterm.org/shell-integration.html) — pwsh `function global:prompt {...}` wrapping pattern our pwsh wrapper mirrors.
  - [VS Code's shell integration](https://code.visualstudio.com/docs/terminal/shell-integration) — comparable spawn-time hook auto-install in another editor; useful precedent + comparable footgun history to study.
- **Out of scope (deferred):**
  - **Login-shell support (`bash -l`).** `--rcfile` ignored; explicit profile-source chain in our shim is a critic-magnet (interaction with nvm / asdf / conda / custom `$PROFILE` order, plus the SE-flagged double-source hazards documented in the bash decision above). Layer 5 + ADR-0020 cover.
  - **zsh `.zprofile` / `.zlogin` shimming.** Login-shell-only files; rare in our non-login PTY context. v2 could stub both. (`.zshenv` IS shimmed v1 — see zsh decision above.)
  - **`.bash_profile` sourcing.** Single-source `.bashrc` is the v1 shape per team-lead + SE convergence; users with PATH-only-in-`.bash_profile` see the same gap as any non-login bash. Standard chain advice (`[[ -f ~/.bashrc ]] && source ~/.bashrc` in `.bash_profile`) is the user-side fix.
  - **Per-session UI opt-out toggle.** Env var + planned server flag are the v1 escape hatches.
  - **Server flag (`--shell-hook=auto|off`).** Trivial follow-up; one-liner CLI parse + env-var fallback already there.
  - **cmd.exe wrapping.** Per ADR-0019; recommend pwsh.
  - **tmux / screen / nested subshell tracking.** Wrapper fires inside tmux but tmux 3.x swallows OSC 7. ADR-0020 PID polling WOULD backstop, but ADR-0020 is deferred. v1 users in tmux get Layer 5 toast on click failure (Block A pointing at the manual hook docs — which won't help inside tmux either; documented limitation).
  - **Audit logging at startup** ("auto-install enabled for these shells, opt out via `AI_OR_DIE_NO_AUTO_OSC7=1`"). Suggested by pre-review; cross-lab to decide whether it's must-have for enterprise/multi-user or deferred.
