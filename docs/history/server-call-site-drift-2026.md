# Server call-site drift fixes (2026)

Three server-side failures came from local copies diverging from an existing
correct implementation.

## Windows extended-length paths

`FileWatcher` removed the first four characters from every `\\?\` path. That
works for `\\?\C:\...` but converted `\\?\UNC\server\share\...` into the
relative path `UNC\server\share\...`, so recursive subscriptions on network
shares never matched descendant events.

The correct two-form conversion already existed in the server path
canonicalizer. It now lives in one dependency-free helper used by the server,
watcher, global test sandbox, short-path coverage, and the HOT-02 fixture. The
helper is deliberately ungated: POSIX paths cannot carry the prefix and pass
through unchanged, while the pure form can be tested on every platform. Bare
prefix-only strings are not returned by `realpathSync.native()`; tests pin their
mechanical results only to detect future drift.

Fail-first coverage reported the extended UNC value as
`UNC\server\share\project` instead of `\\server\share\project`.

## Orphan-host sweep executable

The startup sweep invoked bare `powershell.exe` through `PATH` and ignored the
callback error. A stripped path disabled cleanup silently, while an
attacker-ordered path could select an unintended executable.

The sweep now consumes the same absolute in-box PowerShell resolver already used
by keep-awake and hibernation handling. Its options seam covers platform,
environment, process launch, and logging without changing the zero-argument
startup call. Synchronous and asynchronous launch errors feed one warning guard,
so startup remains non-fatal but never silent.

Fail-first coverage observed zero process launches and zero warnings when the
Windows path was injected on a non-Windows test host.

## Invalid session structure

Malformed JSON was preserved before recovery, but valid JSON with the wrong
shape was discarded without a backup. Autosave could then replace the only
copy.

Both paths now use one preservation helper and one
`sessions.json.corrupted.<timestamp>` naming scheme. Rename is preferred; a
byte-for-byte copy is the fallback. If both operations fail, an in-memory latch
blocks writes with `ESESSIONBACKUPFAILED` while leaving the original bytes
untouched. The latch clears only after the protected file disappears, a later
load is valid, or explicit session clearing succeeds.

Fail-first coverage found no backup for any wrong-shape fixture and no latch
after forced rename and copy failures.

The greater-than-seven-day path remains unchanged by design. Expiry is intended
policy for valid data, and labelling an expired file as corrupted would be
misleading.
