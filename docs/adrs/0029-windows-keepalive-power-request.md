# 0029 - Name the Windows keep-alive as GitHub Copilot via a named power request

## Status

Accepted (2026-07). Supersedes the **mechanism** of ADR-0028 (which used
`SetThreadExecutionState` alone). ADR-0028's lifecycle, gating, and degradation
properties are retained.

## Context

ADR-0028 established a Windows keep-alive that P/Invokes
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` from a long-lived
in-box PowerShell helper. The assertion works, but in `powercfg /requests` it
appears only as an anonymous `[PROCESS] ...\powershell.exe` line with **no reason
text** — there is no way to attach a human-readable label to a
`SetThreadExecutionState` assertion.

We want the entry to read as GitHub Copilot, matching the GitHub Copilot CLI's
own `/keep-alive` command. Inspecting the CLI's bundled native addon
(`cli-native.node`, versions 1.0.57-2 and 1.0.71) shows its Windows keep-alive
does **not** use `SetThreadExecutionState`. It calls the modern power-request
API — `PowerCreateRequest` → `PowerSetRequest(PowerRequestSystemRequired)` →
`PowerClearRequest` (all from `kernel32.dll`) — with a `REASON_CONTEXT` whose
`SimpleReasonString` (a wide string) is exactly **`GitHub Copilot CLI session
active`**. That reason string is what `powercfg /requests` displays under the
holding process. Its cross-platform siblings confirm intent: macOS
`caffeinate -dis -w <pid>`, Linux `systemd-inhibit --who="Copilot CLI"
--why="Session active"`.

Key constraint: the only field in a power request that carries a name is the
reason string. The holding-process line in `powercfg /requests` is always the
real executable and **cannot** be renamed — our helper stays `powershell.exe`
(Copilot's is `node.exe`/`copilot.exe`). So "looks like Copilot" means an
identical reason string on a genuine power request; it is a cosmetic label, not
a disguise (the process, its `# aod-keepalive ppid=` command-line tag, and its
parent `node.exe` all remain visible to Task Manager / EDR / `powercfg`).

## Decision

The helper holds **two redundant assertions** in one `Add-Type`:

1. `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` — the ADR-0028
   legacy net (kept, not removed).
2. `PowerCreateRequest` + `PowerSetRequest(PowerRequestSystemRequired)` with
   `REASON_CONTEXT.Version = 0`, `Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING
   (1)`, `SimpleReasonString = "GitHub Copilot CLI session active"`.

`--keepalive-display` additionally sets `ES_DISPLAY_REQUIRED` on (1) and
`PowerRequestDisplayRequired` on (2). Release clears both and `CloseHandle`s the
request handle; process death drops both automatically.

**Why keep both** rather than Power*-only (which would be the exact Copilot
footprint): a deliberate belt-and-suspenders choice for wake-robustness — if
either API is refused at runtime the other still holds the machine awake. The
cost is a second, anonymous `powercfg /requests` entry that Copilot itself does
not produce; the named entry is still present and identical. (The extra
resilience is modest — both calls share one `Add-Type`, so a WDAC/CLM block that
kills the compile kills both — but it is non-zero and was chosen intentionally.)

**Readiness:** the helper prints `OK` once **at least one** assertion is held; it
`exit 1`s (→ ready=false → visible warn) only when **both** are refused.

**Marshalling notes** (Windows PowerShell 5.1, verified on a real Windows host):
- `REASON_CONTEXT` is marshalled `LayoutKind.Sequential, CharSet.Unicode` with
  the reason as an `LPWStr` field — the SIMPLE_STRING union layout (Version,
  Flags, wide-string pointer) on both x86 and x64.
- `POWER_REQUEST_TYPE` values are small ints (System = 1, Display = 0), so they
  avoid the `0x80000001`-as-negative-`Int32` hazard that forces the `ES_` flags
  to be passed as decimal `[uint32]` literals.
- `PowerCreateRequest` returns `NULL` or `INVALID_HANDLE_VALUE` (-1) on failure;
  both are treated as failure before any `PowerSetRequest`.

## Consequences

- `powercfg /requests` shows a `GitHub Copilot CLI session active` line on the
  SYSTEM request (byte-identical to Copilot's), plus an anonymous
  `SetThreadExecutionState` entry for the same `powershell.exe`.
- No new runtime dependencies; still one in-box `powershell.exe`, nothing to
  code-sign. All ADR-0028 release layering, `underTest`/`CI` gating, and
  visible-degradation behavior are unchanged.
- The label is **cosmetic**: it does not hide the tool from Task Manager, EDR, or
  `powercfg`'s process line, and is not a security-evasion mechanism.
- Everything ADR-0028 noted still applies: WDAC / Constrained Language Mode can
  block `Add-Type` (helper degrades to a visible warning); `ES_SYSTEM_REQUIRED` /
  `PowerRequestSystemRequired` prevent classic S3/S4 sleep but **not** Modern
  Standby (S0) on post-2020 laptops; a brief double-assertion can occur across a
  supervisor restart (harmless).
