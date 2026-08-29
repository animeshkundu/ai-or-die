# ADR-0050: Session-Scoped Shell Integration for OSC 7

## Status

**Accepted**

> **Superseded for readiness timing only by [ADR-0054](0054-platform-specific-shell-integration-readiness.md) (2026-08-28).** The session-scoped wrapper, fallback, and artifact decisions below remain in force; ADR-0054 refines the readiness timeout selection for Windows PowerShell.

Supersedes ADR-0019's rejection of automatic shell-hook injection and ADR-0021's deferral of transient wrappers. The rejection of persistent edits to user shell configuration remains in force.

## Date

2026-08-05

## Context

Terminal path links already resolve relative paths against `session.liveCwd`, but PowerShell, bash, and bare zsh do not reliably emit OSC 7 by default. On Windows, the primary deployment target, this leaves `liveCwd` unset after `Set-Location`; a relative link then resolves against the directory where the session started.

ADR-0019 rejected editing `$PROFILE`, `~/.bashrc`, or `~/.zshrc`. ADR-0021 explored transient wrappers but deferred them behind three reopen gates. Those gates are now resolved:

1. The Layer 5 diagnostic and manual setup path shipped on 2026-05-18 and has run for eleven weeks, exceeding the six-week minimum. The current user report demonstrates that setup remains a real usability barrier.
2. This is a new ADR written from the current production behavior rather than a continuation of ADR-0021.
3. The design is bounded to two review rounds. The final implementation review treats PowerShell, bash, and zsh behavior, prompt preservation, temp-file security, and fallback as the convergence gate.

The material distinction from the rejected design is lifetime and ownership: the application configures only the shell process it spawns, for that PTY session. It never writes a user rc or profile file.

## Decision

`TerminalBridge` installs OSC 7 integration by changing only the spawned shell's argv and environment:

- PowerShell 7 and Windows PowerShell use `-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File <session-shim>`. The shim sources the four standard profile locations once, captures the resulting prompt script block, and installs a global wrapper so the prompt remains active after the startup script completes.
- bash uses `--rcfile <session-shim>`. The shim sources the user's `.bashrc` first, then appends a named function to a writable scalar or bash 5.1+ array `PROMPT_COMMAND`. Readonly and nameref values are left untouched.
- zsh uses a temporary `ZDOTDIR` with pass-through `.zshenv`, `.zprofile`, `.zshrc`, and `.zlogin` files. The user's effective `ZDOTDIR` is restored, and the hook is appended through `precmd_functions` without depending on `fpath`.
- fish is unchanged because it already emits OSC 7.
- `cmd.exe` and unknown shells are unchanged. The existing guidance to use PowerShell remains the actionable fallback.

The generated URI uses an empty host for drive and POSIX paths, a meaningful host for Windows UNC paths, and UTF-8 percent encoding for spaces, non-ASCII text, `#`, and `?`.

Session artifacts are created below `os.tmpdir()/.ai-or-die-shell/` in random `mkdtempSync` directories. The root and session directories are private, shim files are exclusive-create and private, session identifiers are not used in names, stale directories older than one day are swept, and active artifacts are removed when the session stops.

Each shim writes a ready sentinel after installing the hook. If the wrapped shell exits or does not become ready within the platform- and shell-specific deadlines defined by [ADR-0054](0054-platform-specific-shell-integration-readiness.md), `TerminalBridge` suppresses that failed attempt and starts the same shell again without integration. Startup output is bounded while the sentinel is pending. An explicit stop or server cleanup cancels startup instead of spawning a fallback shell. A setup, write, or spawn failure likewise falls back to the vanilla shell. A missing live-CWD feature is preferable to a broken terminal.

`AIORDIE_DISABLE_SHELL_INTEGRATION=1` disables the wrapper for troubleshooting.

## Consequences

### Positive

- Relative terminal links follow `cd`/`Set-Location` without persistent setup.
- Windows PowerShell is the primary validated path; bash and zsh receive equivalent behavior.
- Existing prompts and frameworks remain in control of prompt rendering.
- User profile and rc files are read according to normal shell semantics but never modified.
- A failed wrapper cannot prevent the terminal from starting.

### Negative

- Shell startup includes a small temporary-file and wrapper cost.
- Frameworks that replace the prompt after startup can still replace the wrapper.
- Nested shells and tmux/screen may not propagate OSC 7.

### Neutral

- The OSC 7 parser and browser consumer protocol do not change.
- `cmd.exe` still cannot implement the feature through its static `prompt` syntax.

## Notes

- [ADR-0019](0019-osc7-cwd-tracking.md) remains authoritative for parsing, sandbox validation, and WebSocket behavior.
- [ADR-0021](0021-osc7-shell-hook-auto-install.md) remains the historical record of the deferred designs and review findings.
