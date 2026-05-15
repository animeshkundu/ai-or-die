# ADR-0018: Bundled `@vscode/ripgrep` for Cross-Platform Search Backend

## Status

**Accepted**

## Date

2026-05-15

## Context

`/api/search` (added in commit `bde844f` per the PR-#99 work) shells out
to `rg` (ripgrep) for cross-file search, falling back to GNU `grep` on
Linux when `rg` is absent. That decision was made in [ADR-0012](0012-file-browser-architecture.md)'s
broader file-browser context — `grep` is universally present on Linux,
`rg` is faster + respects `.gitignore` + emits structured `--json`, and
the fallback covered the common case.

Two real-world gaps surfaced after shipping:

1. **Windows users have NEITHER** `rg` NOR `grep` in PATH by default.
   Search silently degrades to a server-side error; the `(j)` e2e
   scenario in `15-file-browser-rich-viewers.spec.js` had to be made
   conditional on `if (start.backend)` (commit `1d87cb9`) to avoid
   failing on the Windows runner. **The conditional masks the fact that
   real Windows users get a broken search feature in production.**
2. **macOS users** without `rg` (haven't `brew install ripgrep`'d) get
   the same broken state as Windows. The `grep` fallback was
   strict-Linux-only because BSD grep on macOS doesn't share GNU grep's
   `-rIn` semantics; we never extended it.

The user direction at the time of this ADR: "stop skipping the Windows
test; deliver real cross-platform search." That makes the conditional
test the wrong shape — the test is honest about what's broken, but the
fix is to fix the broken thing, not to hide the test.

This sits in the same shape as the agent-vs-user concurrent-edit gap
[ADR-0017](0017-fs-watcher-push-channel.md) addressed: the user's bar is
"first-class IDE for the single user using this app," not "first-class
on Linux + degraded on Mac/Windows." A documented workflow broken on a
supported platform is the same kind of "first-class for whom?" gap.

Three candidate fixes were weighed:

- **(a)** Bundle [`@vscode/ripgrep`](https://www.npmjs.com/package/@vscode/ripgrep)
  as a runtime dependency. Microsoft-maintained; used by VS Code itself
  (and downstream by Cursor, Theia, etc.); downloads the
  platform-appropriate `rg` binary at `npm install` time via a
  postinstall hook (~2 MB).
- **(b)** Require system `rg` as an install prerequisite. Document
  three platform install paths (`brew install ripgrep` /
  `choco install ripgrep` / `apt install ripgrep`); add a startup check
  with actionable guidance.
- **(c)** Install `rg` on the Windows CI runner via
  `chocolatey-action`. Solves CI green; doesn't fix real users.

(b) breaks the `npx ai-or-die` zero-install promise for an app marketed
as "frontend for AI coding agents" — adding three platform-specific
install steps is poor first-touch UX.

(c) explicitly rejects the user's direction. It stops the test from
telling us about Windows users; it doesn't help them.

(a) is the convention this app's competitors already use. The 2 MB
postinstall download is paid once at install; runtime cost is zero
beyond the spawn. License compatible (`@vscode/ripgrep` is MIT; the
bundled `rg` binary is MIT/Unlicense).

## Decision

Adopt **(a)**: bundle `@vscode/ripgrep` as a runtime dependency. Modify
`_detectBackend()` to use a three-step search: try system `rg` first,
fall back to bundled `rg`, fall back to `grep` on Linux as a
belt-and-suspenders for the "rg present but unexecutable" edge case.
Hard-error at server startup with actionable guidance if none of the
three is available.

### Detection order: try-system-`rg` first, then bundled, then grep

```
if (system rg in PATH and executable) → use it
else if (require('@vscode/ripgrep').rgPath exists and is executable) → use bundled
else if (Linux and grep -rIn works) → use grep (belt-and-suspenders)
else → hard-error at server startup with actionable guidance
```

**Why try-system-first**:
- A user who has installed a newer `rg` (or one with custom build flags
  — e.g. `--features=pcre2`) keeps using it. Their environment, their
  preference.
- The detection cost is one `which rg` (or `where rg` on Windows) per
  process startup. Cached behind the existing `_detectionDone` flag in
  `src/utils/search.js`; subsequent calls are free.
- Makes it trivial to verify the bundled-fallback path locally:
  temporarily remove `rg` from PATH, restart, observe the bundled binary
  in use.

**Why grep stays as a fallback**:
- The bundled `rg` binary may be present on disk but unexecutable for
  legitimate reasons: antivirus quarantine on Windows (Windows Defender
  has been known to flag less-popular signed binaries on first use),
  filesystem permission strip (corp-policy umask, `noexec` mount), or
  postinstall succeeded but copied into a path the runtime user can't
  read. The `grep` fallback on Linux gives one more layer of "search
  still works" before the user sees a hard error.
- This is **explicitly a safety net, not a primary path**. The vast
  majority of users will hit the bundled-rg path; future maintainers
  should NOT use the existence of the grep fallback as license to
  half-support `rg` features (e.g. structured `--json` output).

### Postinstall failure mode: soft-degrade Linux, hard-error elsewhere

`@vscode/ripgrep`'s postinstall step downloads the platform-appropriate
binary from a Microsoft CDN (~2 MB) and writes it to
`node_modules/@vscode/ripgrep/bin/rg`. If the postinstall fails (corp
proxy blocking the download, `npm install --ignore-scripts`, offline
install, network outage during a one-shot install), `require('@vscode/ripgrep').rgPath`
still resolves to the expected path but the file isn't there.

Server startup behaviour:
- **Linux**: degrades to `grep -rIn` per the existing fallback. User-
  visible search continues to work; logged with a clear "ripgrep binary
  not present; using grep fallback (slower, no .gitignore respect)"
  warning.
- **macOS / Windows**: hard-error at server startup with actionable
  guidance:
  ```
  ai-or-die: search backend unavailable.
  The bundled ripgrep binary is not present at <path>.
  Either:
    - reinstall: rm -rf node_modules && npm ci
    - install ripgrep manually:
        macOS:   brew install ripgrep
        Windows: choco install ripgrep   (or scoop install ripgrep)
    - then restart the server
  ```

We deliberately do NOT add a "search disabled" UI banner for v1 — a
hard server-startup error is a clearer signal than "search just doesn't
do anything." Users who hit this path will hit it once during install
and resolve it immediately.

### CI postinstall sanity check

A small pre-test step in `.github/workflows/ci.yml` after `npm ci`:

```yaml
- name: Verify bundled ripgrep
  run: node -e "const p = require('@vscode/ripgrep').rgPath;
                require('fs').accessSync(p, require('fs').constants.X_OK);
                console.log('rg ok:', p);"
```

Fails the CI job fast with a clear message if the postinstall didn't
deliver an executable binary, rather than producing 50 spec failures
downstream. Runs on both Windows + Linux runners.

### Honest note: postinstall network call

`@vscode/ripgrep`'s install-time download is a real cost worth documenting:

- **Corporate-proxy environments**: HTTP/HTTPS proxies that block
  Microsoft CDN paths will fail the postinstall. Mitigation: users with
  corp proxies should pre-install `rg` via their package manager and the
  detection chain's try-system-first step picks it up automatically; the
  bundled download failure is then irrelevant.
- **Fully-offline installs**: `npm install --offline` (or air-gapped
  runner) cannot pull the binary. Same mitigation: pre-install system
  `rg` and the try-system-first step handles it.
- **`npm install --ignore-scripts`**: explicit user opt-out of
  postinstall hooks. Same mitigation. Users who run with
  `--ignore-scripts` for security reasons are typically the same users
  who pre-install `rg` deliberately.
- **`AI_OR_DIE_NO_BUNDLED_RG=1` env var** (proposed): explicit opt-out
  for users who want to enforce "system `rg` only" without going
  through `--ignore-scripts` for the entire dependency tree. When set,
  `_detectBackend()` skips the bundled step and goes
  system-`rg` → grep-Linux → hard-error. Documented in README + the spec.

These are the same flavour of design honesty the SRI hardening
deferral and the HMAC-token deferral get in [ADR-0016](0016-monaco-based-file-browser-editor.md):
the choice has costs, the costs are real, the mitigations are
documented in code AND prose.

## Consequences

### Positive

- **Cross-platform first-class search.** Windows + macOS + Linux users
  all get the same fast, `.gitignore`-respecting, `--json`-emitting
  ripgrep search via `Cmd/Ctrl+Shift+F`. The conditional skip in the
  `(j)` e2e scenario from `1d87cb9` comes off; the test asserts the
  same `matches.length >= 2` on every platform.
- **Zero-install user UX preserved.** `npx ai-or-die` continues to
  "just work" — the rg binary downloads transparently during the
  initial install.
- **Convention alignment.** VS Code, Cursor, Theia, GitHub Copilot
  Workspace, etc. all use `@vscode/ripgrep` for the same reason. Least-
  surprise for users coming from any of those tools.
- **Removes a CI/test conditional.** `1d87cb9`'s `if (start.backend)`
  comes off; assertions are unconditional everywhere.

### Negative

- **2 MB postinstall download.** Paid once at install; not committed to
  the repo or published tarball. Most users won't notice (already eaten
  by the broader `npm install` time). Users on metered connections eat
  the cost once.
- **Postinstall hook is one more failure surface.** Corp proxies,
  offline installs, `--ignore-scripts` all break the bundled path.
  Mitigated by the try-system-first detection order + the
  `AI_OR_DIE_NO_BUNDLED_RG` env var + the Linux `grep` fallback.
- **One more runtime dependency to track.** `@vscode/ripgrep` is well-
  maintained by Microsoft (used by VS Code itself) but it's still one
  more npm dep + one more CVE surface to monitor. Acceptable for the
  feature payoff.
- **The bundled `rg` binary is opaque.** Unlike vendored JS, we can't
  audit the binary's contents. We trust Microsoft's signing + the same
  registry chain VS Code does. Mitigated by the try-system-first
  detection (users who don't trust the bundled binary install their
  own).

### Neutral

- **Existing `bde844f` `/api/search` SSE contract unchanged.** Same
  query params, same event payload, same rate limit. The backend
  detection change is internal.
- **`/api/search`'s `start` event payload still includes `backend`
  field** (`'rg' | 'grep' | null`); after this ADR, `null` only
  surfaces in the hard-error scenario, never in the steady state.
- **Engineer's `1d87cb9` conditional reverts cleanly** — single-line
  unwrap of the `if (start.backend) {` guard around the assertion.

## Notes

- **Related**: [ADR-0012](0012-file-browser-architecture.md) (the
  original file-browser shape that included `/api/search`'s backend
  choice), [ADR-0017](0017-fs-watcher-push-channel.md) (the agent-vs-
  user concurrent-edit gap whose reversal logic this ADR mirrors:
  "first-class on every supported platform" overrides scope-cost
  reasoning), [`docs/agent-instructions/06-local-first-then-ci.md`](../agent-instructions/06-local-first-then-ci.md)
  (the local-first-then-CI testing posture this ADR's CI sanity check
  fits within).
- **Out of scope**:
  - **Vendoring the binary directly** (committing it to the repo). Would
    bloat the repo + tarball (3 platforms × 2-3 MB). Not VS Code's
    pattern. Not done.
  - **Replacing `rg` with a pure-JS search** (e.g. `mini-rg`, custom
    regex engine). Order-of-magnitude slower on real repos; no
    `.gitignore` respect; no structured `--json`. Pure-JS in this niche
    is a step backward.
  - **Indexed search** (build a search index at startup, query the
    index). ripgrep on a 100k-file repo finishes in ~200 ms — index
    overhead would be net-negative for typical sessions. Re-evaluate
    only if user feedback shows pathological repos where this matters.
- **Migration**: zero user-side migration. On `npm install` /
  `npm ci` after the bump, postinstall pulls the binary; subsequent
  `_detectBackend()` calls find it. Existing users who happen to have
  system `rg` keep using their system one (try-system-first preserves
  their environment).
