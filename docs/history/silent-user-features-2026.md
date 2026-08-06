# Silent user-feature failures (2026-08-05)

Three user-visible paths failed without a useful signal:

- Dev Tunnel authentication was inferred from exit code even though `devtunnel user show` exits zero while logged out. Host startup also discarded the captured process output when no URL appeared.
- Artifact review opening was a one-shot broadcast, so a refreshed or newly attached browser did not learn about an in-memory live review.
- Terminal sessions parsed OSC 7 but did not arrange for PowerShell, bash, or zsh to emit it.

The fixes use positive Dev Tunnel identity detection with bounded probes and actionable per-stage errors, replay live shown reviews to the joining socket, and install session-only shell wrappers with private temporary files and vanilla-shell fallback. Review objects remain intentionally in memory; a server restart still ends them, which is separate from browser refresh recovery.

Regression coverage exercises real shell processes, browser refresh and second-device joins, dismissed-review reconnects, authenticated tunnel behavior through deterministic fixtures, and an unauthenticated real Dev Tunnel CLI probe.
