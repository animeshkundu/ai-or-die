# ADR-0019: OSC 7 In-Band CWD Tracking for Terminal-Bridge Sessions

## Status

**Accepted**

## Date

2026-05-15

## Context

The first-class file browser shipped in commit `e381913` (per [ADR-0016](0016-monaco-based-file-browser-editor.md)) wires a `getCwd` callback so the panel opens at the active session's working directory. That callback returns `session.workingDir` — the directory the PTY was spawned in — and **never updates**. Once a user types `cd ~/code/other-repo` in a Terminal-bridge session, the file browser stays anchored to the original `workingDir`. Re-opening it goes back to where the shell *started*, not where the shell *is*.

This breaks the central first-class-IDE story for the file browser the same way the agent-vs-user concurrent-edit gap broke it for ADR-0017: the panel's view of the world drifts out of step with the user's actual environment, and the user has to manually re-navigate to compensate. For an app whose tagline is "frontend for AI coding agents," the expectation is that the file panel tracks `cd` the way every modern terminal-aware UI does (VS Code's integrated terminal, JetBrains, iTerm2's directory tracking, GNOME Terminal's "open new tab in current directory").

We need a CWD signal. Three candidates were weighed:

### (a) OSC 7 in-band escape sequence

The shell emits `ESC ] 7 ; file://<host><path> BEL` (or `ST`-terminated variant) every time the prompt fires. The terminal emulator parses the sequence out of the byte stream and learns the new CWD. This is the protocol [VTE/GNOME Terminal](https://vtdn.dev/docs/osc/osc7/), [iTerm2](https://iterm2.com/shell_integration.html), [WezTerm](https://wezterm.org/shell-integration.html), Konsole, and (in progress, see [microsoft/terminal#8214](https://github.com/microsoft/terminal/issues/8214)) Windows Terminal already use. Many distros emit OSC 7 by default — Fedora's bash via `/etc/profile.d/vte.sh`, fish unconditionally, macOS Terminal.app's default zshrc, Git Bash on Windows when configured.

### (b) PID polling — read `/proc/<pid>/cwd` on Linux, `lsof` on macOS, `GetCurrentDirectory` via tooling on Windows

Walk the PTY's process tree (the shell, plus any child the user `cd`-ed inside) at a fixed interval. Parse the kernel's view of each process's CWD.

### (c) Static-only (status quo)

Keep `session.workingDir` static; the panel root never moves. Document the limitation; tell users to re-open the panel after navigating.

### Adversarial review baked in

This decision was drafted with three lab critics weighing in on the plan ([gemini-3.1-pro], [codex-critic / gpt-5.5], [opus-4.7]). All three reached the same conclusion: PID polling is the wrong primary mechanism. The reasons differ enough to be worth recording.

- **gemini's analysis (decisive):** PTY-running CLI tools — `claude`, `codex`, `gemini` — do **not** `chdir` their host process when the user "navigates" inside them. They mutate internal state and pass paths to tool calls. `/proc/<pid>/cwd` returns the static start directory forever for those sessions. PID polling on AI bridge sessions reports false data, not stale data — there is nothing to read. The same gap applies to subshells, REPLs, tmux panes, and any tool that manages "current directory" as application state.
- **codex's cost analysis:** `lsof -p <pid>` on macOS costs ~120–180 ms per call (subprocess fork + scan of the per-process file table). At a 2 Hz poll across 20 active sessions this is ~1.5 cores burned permanently, just to learn what the shell is already willing to tell us in-band for free. Linux `/proc` is cheaper but not free; Windows requires a third-party native shim (`GetProcessImageFileName` + handle iteration) since there is no public `GetCurrentDirectory` for another process.
- **opus's UX angle:** polling latency is user-visible. A 500 ms poll means the panel lags 0–500 ms behind every `cd`; faster polls eat more CPU. OSC 7 is event-driven; the panel re-roots within the prompt-render cycle, indistinguishable from instant.

### What we're choosing between, restated

- **(a) OSC 7** is the protocol every modern terminal already uses, costs ~zero at runtime, fires on `cd` instead of on a wall-clock interval, and works uniformly across POSIX + Windows drive paths + Windows UNC via Node's built-in `url.fileURLToPath()` (with a small POSIX host-strip fallback for the real-shell `$HOSTNAME` case — see Parser semantics). The cost is one shell-hook line of user setup on shells that don't emit by default — `bash` requires `PROMPT_COMMAND`, bare `zsh` requires `chpwd` (many distros and frameworks ship one), `pwsh` requires a `prompt` function. Modern distro defaults already emit it on bash + fish; zsh varies by framework.
- **(b) PID polling** has three independent failure modes (false data on CLI bridges, real CPU cost on macOS, user-visible latency) and one orthogonal cost (Windows requires a native shim).
- **(c) Static-only** is what we have today. Loses the central UX win this iteration is for.

### What this ADR is NOT trying to solve

- **Live CWD for AI CLI bridges (`claude`, `codex`, `gemini`).** These bridges do not chdir; the concept doesn't map. Their `liveCwd` stays `null`. If those CLIs ever expose a "current selected directory" via their own protocols, that's a different ADR.
- **Auto-injecting OSC 7 hooks into the user's shell rc files.** Footgun-prone (we'd be editing user `~/.bashrc`); the user-visible cost of the documented one-liner is acceptable given how many distros emit OSC 7 by default already.
- **Windows `cmd.exe` support.** There is no clean way to emit OSC 7 from a `cmd.exe` `prompt` definition without a doskey or a wrapper. Recommend pwsh on Windows; `cmd.exe` users get static `workingDir` and can re-open the panel manually.
- **Multi-pane shells (tmux / screen).** Confirmed against tmux 3.x on macOS: tmux **swallows** OSC 7 from the inner shell — it intercepts the sequence and does not forward it to the outer PTY. tmux runs its own `OSC 1337 ; CurrentDir` multiplexer protocol but does not re-emit standard OSC 7 outbound. v1 does not parse the tmux-specific extension; users who want live-CWD inside tmux should run their shell directly in the bridge.

## Decision

Adopt **(a)**: parse OSC 7 inside the Terminal bridge's PTY data stream, decode the URI via `url.fileURLToPath()`, validate via `validatePath()`, and emit a `cwd_changed` WebSocket frame to subscribed clients. The client maintains a per-session `_liveCwd` and a per-session `_followsTerminal` boolean (default true). When the panel is following and a `cwd_changed` arrives, the panel re-roots to the new CWD; when not following, the new CWD is stashed silently and surfaced via a "📍 follow terminal" toggle the user can click to re-engage.

### Parser semantics

```
\x1b]7;file://[^/]*(/[^\x07\x1b]+)(?:\x07|\x1b\\)
```

- Match the `OSC 7;file://...` prefix; capture the URI starting at the first `/` after the host segment.
- Pass the full `file://host/path` URI to Node's built-in [`url.fileURLToPath()`](https://nodejs.org/api/url.html#urlfileurltopathurl) — it handles POSIX, Windows drive paths (`file:///C:/Users/foo` → `C:\Users\foo`), and UNC paths (`file://server/share/foo` → `\\server\share\foo`) uniformly. Wrap in try/catch; treat any malformed URI as "no update" (silent drop, optional `DEBUG=1` log).
- **Host-strip fallback (POSIX only).** `url.fileURLToPath()` throws `ERR_INVALID_FILE_URL_HOST` on POSIX for any host segment that isn't exactly empty or `localhost`. Every documented shell hook in the spec emits the local machine's hostname (`$HOSTNAME` / `$HOST` / `$env:COMPUTERNAME`) — `file://my-mac/Users/foo`, not `file:///Users/foo` — because that's what the OSC 7 protocol historically encodes (the URI carries the host so consumers can distinguish local vs remote SSH sessions). Without compensation, the parser would silently reject every emit from the documented copy-paste hooks. Systems-engineer caught this in real-shell validation (task #7 → fix `e878c77`). The parser now: (1) tries `fileURLToPath(body)` first; (2) on POSIX, when that throws `ERR_INVALID_FILE_URL_HOST`, strips the host segment and re-parses; (3) on Windows, the host segment is meaningful (UNC paths) and is **never** stripped. This matches iTerm2 / GNOME Terminal / WezTerm posture: the hostname is informational and discarded for local sessions.
- Run the resolved path through the existing `validatePath()` (`src/server.js:260`); reject anything outside the sandbox silently.
- Update `session.liveCwd` only on change. Emit `{ type: 'cwd_changed', sessionId, cwd, prev, source: 'osc7' }` over WebSocket.
- **Buffer-boundary safety**: OSC 7 sequences can split across PTY chunks (`onData` is byte-boundary unaware). Maintain a small per-session pending-OSC buffer (cap 4 KB, flushed on terminator or buffer-full) so a sequence delivered as `\x1b]7;file://h/Users/fo` + `o\x07` resolves correctly.
- **Do not strip OSC 7 from the output stream.** xterm.js ignores unknown OSC by default; leaving the bytes intact preserves parity with native terminals and lets future addons re-parse.
- **Bridge contract**: only Terminal-bridge sessions parse OSC 7. Claude/Codex/Gemini bridges no-op (their `session.liveCwd === null`); documented in `docs/specs/bridges.md`.

### Cross-platform path handling

`url.fileURLToPath()` is the reference implementation, with a host-strip fallback on POSIX (described in Parser semantics above). Test fixtures cover:

- POSIX: `file:///Users/foo/code` → `/Users/foo/code`; `file://localhost/Users/foo` → `/Users/foo`
- POSIX with hostname (the real-shell case): `file://my-mac/Users/foo` → `/Users/foo` (host stripped + re-parsed)
- Windows drive: `file:///C:/Users/foo` → `C:\Users\foo`
- Windows UNC: `file://server/share/foo` → `\\server\share\foo` (host **kept** — UNC server name is meaningful)
- Percent-encoded paths: `file:///Users/foo/my%20code` → `/Users/foo/my code`
- Both terminators: `\x07` (BEL) and `\x1b\\` (ST)

The cross-platform surface is contained to `url.fileURLToPath()` plus the POSIX-only host-strip fallback. No further per-platform branches in production code.

### Shell hooks (documented, not auto-injected)

- **bash** (`~/.bashrc`):
  ```bash
  PROMPT_COMMAND='printf "\e]7;file://%s%s\e\\" "$HOSTNAME" "$PWD"'
  ```
- **zsh** (`~/.zshrc`):
  ```zsh
  function chpwd() { printf "\e]7;file://%s%s\e\\" "$HOST" "$PWD" }
  ```
- **fish** — emits OSC 7 unconditionally; no setup needed.
- **PowerShell** (`$PROFILE` — works on Windows + macOS + Linux pwsh):
  ```powershell
  function prompt {
      $loc = $executionContext.SessionState.Path.CurrentLocation
      $out = "PS $loc> "
      if ($loc.Provider.Name -eq 'FileSystem') {
          $p = $loc.ProviderPath -replace '\\','/'
          $out += "$([char]27)]7;file://$env:COMPUTERNAME/$p$([char]7)"
      }
      $out
  }
  ```
- **Windows cmd.exe** — out of scope; recommend pwsh.

These snippets live in `docs/specs/file-browser.md` under "Live CWD tracking (OSC 7)" so users hitting the missing-update papercut have a one-line fix.

### Client-side `_followsTerminal` toggle (UX contract)

An earlier draft proposed an implicit "auto-rebase if breadcrumb still matches old liveCwd" rule. opus flagged this as brittle: the moment the user manually navigates to inspect anything, the rule silently disengages, and if `cd` then fires the panel doesn't move — the user has no way to tell why. Replaced with an explicit per-session boolean:

- `_followsTerminal` defaults to `true` on session create.
- Manual breadcrumb navigation flips it to `false`.
- A small "📍 follow terminal" toggle button in the panel header (highlighted when `true`, dimmed when `false`) re-engages it. Clicking when `false` flips to `true` and immediately re-roots to the latest stashed `liveCwd`.
- `cwd_changed` arriving with `_followsTerminal === true` re-roots the panel; arriving with `_followsTerminal === false` updates `_liveCwd` silently and refreshes the toggle's hover-tooltip (`"📍 follow terminal — currently at /Users/foo/other-repo"`).

### `getCurrentWorkingDir()` resolution

```js
getCurrentWorkingDir() {
  return liveCwd ?? session.workingDir ?? currentFolderPath;
}
```

Existing `getCwd` callback signature is unchanged; it returns the new resolution. `FileBrowserPanel.open()`'s 4-step resolution order from the existing spec stays as-is.

## Consequences

### Positive

- **Panel follows the user's `cd`.** The central first-class-IDE win for Terminal sessions. Indistinguishable-from-instant via OSC 7's event-driven semantics.
- **Zero ongoing CPU cost.** No timer, no `lsof`, no `/proc` scan. Parser runs only on PTY data already being processed.
- **Cross-platform via `url.fileURLToPath()`.** POSIX + Windows drive + UNC handled by a single Node API; no per-platform branches.
- **Convention alignment.** Same protocol VS Code, JetBrains, iTerm2, GNOME Terminal, Konsole, WezTerm, and Windows Terminal (in progress) speak. Users coming from any of those tools get the behaviour they expect.
- **Composes with ADR-0017's reactive sync.** The fs-watcher already follows `session.workingDir`; live CWD is orthogonal to it (the watcher stays rooted at the original `workingDir`; only the panel's *display* re-roots). No watcher churn on `cd`.
- **Safe degradation.** Shells that don't emit OSC 7 (cmd.exe, ancient bash without the hook, sandboxed environments) get the existing static behaviour. No regression.

### Negative

- **Shell-side setup required for shells that don't emit by default.** bash + zsh on most distros need a one-line `PROMPT_COMMAND` / `chpwd` snippet. Documented in the spec; not auto-injected (user shell config is sacrosanct). Users who don't add the hook get static behaviour — same as today, no regression.
- **Windows cmd.exe gap.** No clean way to emit OSC 7 from `cmd.exe`'s `prompt` definition. Recommend pwsh; `cmd.exe` users keep static `workingDir`. Documented as a Limitation in `file-browser.md`.
- **Multi-pane / multiplexer ambiguity.** tmux 3.x **swallows** OSC 7 outright — sessions wrapped in tmux get `liveCwd === undefined` and stay there. Documented in the Limitations section of `file-browser.md`; workaround is to run the shell directly in the bridge (no tmux). Parsing tmux's `OSC 1337 ; CurrentDir` extension is deferred.
- **Spoofing surface.** A program running inside the user's PTY can emit OSC 7 with an arbitrary path. Mitigated by `validatePath()` (the resolved path must be inside `baseFolder`); a malicious sequence pointing outside the sandbox is silently dropped. The remaining surface — moving the panel to a *valid* but unintended sandbox path — is bounded by what the user could already type at the shell prompt.
- **CLI bridges left out.** Claude/Codex/Gemini bridges report `liveCwd === null`; their panel stays at `session.workingDir`. This is the right answer for v1 (those CLIs don't chdir) but means the "panel follows my work" UX only lands for Terminal sessions in this iteration.

### Neutral

- **No new runtime dependency.** OSC 7 parser is ~30 LOC of regex + `url.fileURLToPath()`. Buffer accumulator is ~15 LOC. Total parser surface fits in `src/terminal-bridge.js` without a separate module.
- **WebSocket frame is additive.** `cwd_changed` joins the existing frame catalog (input, resize, stop, image_uploaded, etc.); existing clients ignore unknown frames per the WebSocket protocol's existing forward-compat posture.
- **No impact on the fs-watcher (ADR-0017).** Watcher root is still `session.workingDir` so the user can `cd` outside, edit, `cd` back in and still get reactive sync for files inside the original sandbox. Adding "watcher follows `cd`" is a separate scope (would need watcher recreate on every `cd`, expensive, and probably not what users want).
- **Spec impact:** `docs/specs/file-browser.md` gains a "Live CWD tracking (OSC 7)" section, the keyboard-shortcuts table gains the "📍 follow terminal" toggle, and the Limitations section names cmd.exe + CLI bridges. `docs/specs/bridges.md` documents the `liveCwd` field on bridge sessions.

## Notes

- **Related**: [ADR-0017](0017-fs-watcher-push-channel.md) (the orthogonal proactive-sync surface; this ADR is to ADR-0017 what "panel root" is to "open-tab content"), [ADR-0012](0012-file-browser-architecture.md) (the `validatePath` sandbox + `getCwd` callback surface this ADR plugs into), [`docs/agent-instructions/06-local-first-then-ci.md`](../agent-instructions/06-local-first-then-ci.md) (the cross-platform-via-CI testing posture this ADR's POSIX + Windows-drive + UNC fixtures fit within).
- **External references** (OSC 7 protocol):
  - [vtdn.dev — OSC 7 reference](https://vtdn.dev/docs/osc/osc7/) — full byte-level spec, terminator variants, percent-encoding rules.
  - [GNOME VTE / Tilix configuration guide](https://gnunn1.github.io/tilix-web/manual/vteconfig/) — the canonical Linux-distro shell-hook pattern (`/etc/profile.d/vte.sh`).
  - [iTerm2 shell integration](https://iterm2.com/shell_integration.html) — OSC 7 vs the iTerm2-proprietary OSC 1337 `CurrentDir` extension; rationale for the standard's adoption.
  - [WezTerm shell integration](https://wezterm.org/shell-integration.html) — bash + zsh + fish + pwsh hook snippets used as the basis for our spec's PowerShell snippet.
  - [microsoft/terminal#8214 — "Find a way to make OSC7 work"](https://github.com/microsoft/terminal/issues/8214) — Windows Terminal's in-progress OSC 7 work, including the WSL/Windows path-translation discussion that informs our `url.fileURLToPath()` choice.
- **Out of scope (deferred)**:
  - **Live CWD for AI CLI bridges (Claude/Codex/Gemini).** Those CLIs don't chdir; concept doesn't map. Re-evaluate only if a CLI exposes a "selected directory" protocol of its own.
  - **Auto-injecting OSC 7 hooks into user shell rc files.** User shell config is sacrosanct; the documented one-liner is the right boundary.
  - **Windows cmd.exe support.** No clean emit path; recommend pwsh.
  - **Per-pane CWD for tmux / screen.** tmux 3.x swallows OSC 7 outright (does not forward to the outer PTY); parsing its proprietary `OSC 1337 ; CurrentDir` extension is its own ADR.
  - **OSC 7 + watcher root co-tracking** (re-rooting the chokidar watcher on `cd`). v1 keeps the watcher pinned to `session.workingDir`; live CWD only moves the panel display.
  - **Subprocess CWD tracking** (a `vim` opened from the shell that itself navigates internally). Out of scope; OSC 7 is a shell-level protocol.
