# Transient `Cannot GET /api/sessions/:id/repo-root` — 2026-05-17

## Symptom

While diagnosing the file-browser-v2-followup click-to-open regression, a
`curl` against `/api/sessions/<id>/repo-root` on a long-running (~16 min)
dev server returned Express's **default** 404:

```
HTTP/1.1 404 Not Found
Content-Type: text/html
<pre>Cannot GET /api/sessions/.../repo-root</pre>
```

— rather than the route's own `{"error":"session not found"}` JSON 404.
Restarting the server made the route serve correctly (`200 {"root":...}`).

## What we verified

- The route IS in `src/server.js` (line ~1880, `this.app.get('/api/sessions/:sessionId/repo-root', ...)`).
- The route IS registered: a fresh `new ClaudeCodeWebServer()` walk of
  `app._router.stack` lists it.
- Tested against a clean restart of the SAME source → route works.
- Same Express also serves sibling routes (`/api/sessions/:sessionId`,
  `/api/sessions/list`) correctly on the broken process — only
  `repo-root` was returning the default-handler 404.

## Status

**Unresolved.** No clean theory for how an in-memory Express router
loses a single registered route without a process restart. The
investigating engineer (PE on task #2) noted the process had been alive
across `src/server.js` edits made by another teammate (team-lead's
Windows-CI fix work, ~152 LOC change at hunks 77/254/275/330/1776 —
NOT the repo-root region itself). Nodemon / hot-reload was not active.

## What to check if this resurfaces

1. Confirm the server's loaded source matches disk:
   ```js
   require.cache[require.resolve('./src/server')].exports
   ```
2. Walk `app._router.stack` and check if the route's layer was somehow
   removed:
   ```js
   app._router.stack.filter(l => l.route && l.route.path.includes('repo-root'))
   ```
3. Check for any code that calls `app._router.stack.splice(...)` or
   re-binds `app._router` mid-flight (we have none today; would be the
   suspect if added).
4. Reproduce on a fresh server, monkey-patch `app._router` to log any
   mutation, then perform the edits / WebSocket / session operations
   that preceded the failure.

## Why we're not pursuing now

- Single observation, couldn't reproduce after restart.
- User-reported `click-to-open` failure (the bug the investigation was
  chasing) is NOT caused by this — the route only contributes the
  optional 4th candidate in the resolver chain (`join(repoRoot, hint)`).
  Hits 1–3 (absolute / liveCwd / workingDir) cover every realistic
  Claude-bridge case.
- Net cost of investigation > value if it doesn't reproduce in CI.

If users on long-running production sessions report similar route
flakiness, escalate.
