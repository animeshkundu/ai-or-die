# Windows 8.3 short names silently voided the HOT-02 watcher test (2026)

## Symptom

`Longevity Smoke (PR-blocking)` → `smoke (windows-latest)` failed at the
"Longevity regression tests" step, before the soak ever ran:

```
1) HOT-02: FileWatcher sync MD5 on hot path (event-loop block under bulk edits)
   AssertionError [ERR_ASSERTION]: expected >= 20 flush events; got 0
     — debounce window misconfigured?
```

Ubuntu and macOS passed. The failure is Windows-only and reproduces on the
unrelated `fix/ci-signal-integrity` branch (run 30882481148), so it predates the
client-shell work, which touches neither `test/longevity/` nor
`src/utils/file-watcher.js`.

## Root cause

The assertion that fired is the test's own **sanity** check, not its
load-bearing one. Zero flush events means every synthetic change event was
dropped before reaching `_flush()`.

Two canonicalization paths disagree on Windows:

- `FileWatcher._canonicalize()` (`src/utils/file-watcher.js:386`) resolves
  through `_realpathStrict()` (`:80`), which uses **`fs.realpathSync.native`**
  and strips a `\\?\` prefix. `.native` **expands 8.3 short names**.
- `FileWatcher.hasSubscription()` (`:549`) only calls **`path.resolve`**. It does
  no realpath and therefore no 8.3 expansion.

The test seeded its subscription set with `w._canonicalize(p)` but built its
paths from `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), ...)))`. Plain
`fs.realpathSync` does not expand 8.3 names, and GitHub's Windows runners report
`os.tmpdir()` as `C:\Users\RUNNER~1\AppData\Local\Temp`. So:

- stored key: `C:\Users\runneradmin\...\f0.bin`  (expanded by `.native`)
- lookup key: `C:\Users\RUNNER~1\...\f0.bin`     (unexpanded by `path.resolve`)

No match → `_onChokidar` returned at the `hasSubscription` guard (`:587`) → no
debounce, no flush, zero events.

This is exactly the trap `CLAUDE.md` calls out: canonicalize via
`realpathSync.native` (handles 8.3 expansion) and strip `\\?\` **on both sides**
before any lexical compare.

## Fix

`test/longevity/event-loop/hot-02-filewatcher-hash.test.js` now canonicalizes
`tmpRoot` with a local `realpathNative()` that mirrors the product's
`_realpathStrict` — `fs.realpathSync.native` plus the `\\?\` strip, falling back
to `fs.realpathSync`. The subscription key and the lookup key now agree on every
platform.

This **strengthens** the test rather than relaxing it. Previously, both
assertions in the file were vacuous on Windows: with zero events, no
`fs.readFileSync` could be counted and no event-loop lag could accumulate, so the
second test passed for the wrong reason. Only the sanity assertion, doing its
job, kept that from being a silent false green.

A third case was added ahead of the two burst tests. It asserts directly that a
key produced by `_canonicalize()` is reachable via `hasSubscription()`, so a
future regression of this class fails with a precise message instead of
resurfacing as "got 0".

## Latent product issue — recorded, deliberately NOT fixed here

The same `_canonicalize` / `hasSubscription` asymmetry exists in the product. A
path subscribed in short-name form is stored expanded, while events arriving in
short-name form are looked up unexpanded, so watching a short-name path on
Windows would silently observe nothing. It did not surface as a product failure
because chokidar derives event paths from the watch root the application already
canonicalized.

It is not fixed here on purpose. The obvious repair — canonicalizing inside
`hasSubscription()` — puts a `realpathSync.native` syscall on the per-event hot
path, which is precisely the hot path HOT-02 exists to keep unblocked, and the
file watcher sits on the do-not-break list. A correct fix caches the
canonicalization or normalizes the watch root once, and belongs in its own change
with Windows verification. Windows is the primary target, so this should not be
left indefinitely.

## Honest limitation

Verified on Linux only: the three tests pass, and the full
`npm run test:longevity:server` suite goes from 119 to 120 passing with no other
change. The Windows path could not be executed — this work was done in a Linux
container with no Windows runner — so the 8.3 mechanism is established from the
runner logs and the two source paths above, not from a local reproduction.
