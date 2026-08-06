# File watcher startup failure cleanup

## What happened

A chokidar `error` before `ready` rejected `FileWatcher.start()`, but the failed
chokidar instance remained assigned to `_watcher`. Its native watcher handle and
the four long-lived event listeners remained open. A later `start()` then
returned without creating another watcher because `_watcher` was still set.

## Root cause

`start()` assigned the chokidar instance before waiting for readiness, but its
rejection path did not undo that partially initialized state. Startup also had
no shared in-flight promise, so overlapping lifecycle operations had no single
attempt to coordinate around.

## Fix

Startup is now single-flight. A failed attempt removes its `add`, `change`,
`unlink`, and `error` listeners, closes the chokidar instance once, clears
`_watcher`, and rethrows the original startup error. Cleanup-close failures are
reported separately; if native close rejects, an inert listener prevents later
native errors from terminating the process. Closing during startup rejects the
joined start promise and shares the same one-time native close.

Stub-driven regression tests cover the original error identity, listener and
handle cleanup, retry, cleanup-close failure, overlapping starts, successful
readiness, and close-during-start behavior without depending on OS watcher
timing.

## Watch for

Any future startup path that stores a native resource before initialization
completes must restore all instance state on rejection. Do not mark a failed
watcher closed: retry depends on `_closed` remaining false.
