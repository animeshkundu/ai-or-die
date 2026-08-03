# Test-suite baseline and flake inventory — 2026-08-02

The plan's earlier fixed claim of 15 failures / 1880 passes did not reproduce on
Linux or clean Windows CI evidence available at implementation time. The claimed
mechanism was also impossible for `npm test`: `src/server.js` forces both native
engines inert whenever Mocha is present, so eager model loading cannot change that
suite's result.

Observed rotating families before implementation included upload cap residue,
file-watch delivery, and replay ordering; no single replacement causal story was
assigned without reproduction. Session-store contamination and process-listener
retention were fixed as independent correctness defects, not presented as the
cause of timing failures.

Current local evidence:

- Three consecutive retry-free Linux full-suite passes: 1966 passing, 2 pending,
  0 failing each. The final two structured reports ran for 343.2 s and 337.3 s.
- PowerShell OSC 7 integration passes with the real shell.

The upload-cap failure was a stale cache, not body-parser load. The test harness
removed and recreated the attachment directory out of band but left the server's
incremental byte-count cache intact; a fast cycle could preserve the filesystem
metadata used for freshness and reuse the previous test's 95 KiB total. The harness
now invalidates the cache at the same boundary as production delete/sweep paths.
The cache fingerprint also includes directory identity and nanosecond timestamps.

Later full-suite runs rotated through three file-watch delivery assertions while
the same cases passed repeatedly in isolation. The polling harness was returning
from `subscribe()` before it crossed a post-subscription scan boundary; an
immediate synchronous create could then be classified as ignored initial state.
`FileWatcher.subscribe()` now waits for that backend-specific readiness boundary,
so the HTTP 204 means the subscription can observe a subsequent write. Production
native watchers do not pay this barrier.

The required repeated Windows inventory and final consecutive CI evidence remain
CI-run artifacts rather than locally reproducible data; they must not be inferred
from Linux results. Manual workflow dispatch now uploads exact test titles,
durations, and failures for each Windows and Linux run.
