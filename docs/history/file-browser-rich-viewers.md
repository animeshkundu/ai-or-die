# File Browser Rich Viewers — Monaco, Tabs, Diff, Search

**Date:** 2026-05-13
**Branch:** `feat/file-browser-monaco`
**Files:**
`src/public/file-viewer-monaco.js` (new),
`src/public/vendor/monaco-worker-shim.js` (new),
`src/public/vendor/panzoom.min.js` (new),
`src/public/vendor/pdfjs/` (new),
`src/public/markdown-render.js` (new),
`src/public/file-tabs.js` (new),
`src/public/file-diff.js` (new),
`src/public/file-search.js` (new),
`src/public/file-browser.js` (refactor),
`src/public/file-editor.js` (Ace → Monaco),
`src/public/app.js` (link provider, tabs container, search keybinding),
`src/public/index.html` (Ace preload removed; Monaco loader script tag),
`src/public/components/file-browser.css`,
`src/server.js` (`/api/search`, `/api/files/git-show`),
`src/utils/search.js` (new)
**Tests:** `test/file-browser.test.js`, `test/file-browser-getcwd.test.js`,
`test/file-viewer-monaco.test.js`, `test/file-browser-api.test.js`,
`test/file-editor.test.js`, `e2e/tests/file-browser.spec.js`
**Specs:** `docs/specs/file-browser.md` (rewritten), `docs/specs/server.md`
**ADRs:** [ADR-0016](../adrs/0016-monaco-based-file-browser-editor.md),
supersedes the editor section of
[ADR-0012](../adrs/0012-file-browser-architecture.md)

## What the user asked for

> "first-class file browser complete with all types of rich file viewers
> (markdown, PDF, images, code with semi-IDE if possible, HTML), defaulting
> to terminal cwd, with clickable file links from Claude/Codex output, plus
> editing"

The implicit comparison set in this phrasing is no longer Ace-class
in-browser editors — it is vscode.dev / github.dev / StackBlitz / Cursor.
The 2026 expectation for "code in a tab" includes multi-cursor, command
palette, side-by-side diff with intra-line highlighting, multi-file tabs
that survive switches, cross-file search that opens results at the matched
line, and built-in language services for at least the JS/TS/JSON/CSS/HTML
family. The pre-Monaco file browser cleared none of these bars.

## Gap analysis

What we found in the existing implementation when this work started:

1. **`TerminalPathDetector` was dead code.** Defined at
   `file-browser.js:1398-1562`; never instantiated anywhere in the
   codebase. The "right-click on a file path in terminal output → context
   menu" flow that the spec advertised was a doc lie. The class itself
   worked — the wiring was missing.

2. **Stale `initialPath` on `FileBrowserPanel`.** The constructor captured
   `options.initialPath` at construction time
   (`file-browser.js:112`) and `open()` re-used that captured value
   (`file-browser.js:408`). When the user switched between Claude
   sessions while the panel was closed and re-opened it, the panel still
   pointed at the original session's cwd. Every "default to terminal
   cwd" support request mapped to this bug.

3. **No clickable file links in terminal output.** Claude and Codex
   constantly emit `src/foo.js:42` references; users had to copy them
   manually into Cmd-Shift-O. xterm's `registerLinkProvider` was loaded
   as part of the addon bundle but never used for paths.

4. **No syntax highlighting in preview.** Code preview rendered as plain
   `<pre>` with line numbers (`_renderCode` at `file-browser.js:1318-1339`)
   — readable for tiny files, useless for navigating real code. Editing
   went through Ace, but only after the user explicitly clicked Edit.

5. **No markdown render** despite `marked.min.js` and `purify.min.js`
   already vendored at `src/public/vendor/`. Markdown files showed as
   their raw source text. Mermaid blocks and KaTeX math obviously didn't
   render either, since the source-text path bypassed everything.

6. **No HTML preview.** HTML files fell through the `_renderCode` path,
   showing markup as text. There was no sandboxed-iframe path, no
   Source/Rendered toggle.

7. **PDF viewer broken on iOS Safari.** `_renderPdf` (`file-browser.js:1287-1293`)
   used `<iframe>` with `Content-Disposition: inline`. iOS Safari refuses
   to render inline-PDF iframes — it forces a download instead. Stack
   Overflow consensus (cross-checked during research): PDF.js is the only
   working cross-browser option for in-page PDF.

8. **No image zoom.** `_renderImage` (`file-browser.js:1254-1266`) capped
   the image at `max-height: 300px`. For inspecting screenshots, design
   mockups, or PDFs-rendered-as-images, this was unusable.

9. **No multi-file tabs.** Opening file B replaced the preview of file A
   with no breadcrumb or way back. The implicit model was "browse one
   file at a time" — not the multi-file editing model of any modern IDE.

10. **No diff view.** No way to see what an AI agent edited. No way to
    `git diff HEAD` from inside the panel.

11. **No cross-file search.** The existing search input filtered the
    current directory listing client-side only. There was no equivalent
    of VS Code's Cmd+Shift+F across the whole tree.

12. **CSV cap was 100 rows** with no virtualization, no column sort.
    Real CSVs run thousands of rows.

13. **Notebook (.ipynb) files** rendered as JSON source — useless.

## Decisions

The decisions below were taken with cross-lab adversarial review at the
plan stage. The scoring scale matches what gemini-3.1-pro used during the
review pass.

### Monaco over Ace (the editor engine)

**Decision:** Monaco. Captured in
[ADR-0016](../adrs/0016-monaco-based-file-browser-editor.md). Supersedes
ADR-0012's "Ace Editor from CDN" section; the rest of ADR-0012 stands.

**Provenance — three reviews informed this:**

1. **Research fork (market analysis).** Compared Ace, CodeMirror 6, and
   Monaco for the "semi-IDE in a remote tunnel" use case. Concluded
   Monaco is the implicit comparison set — vscode.dev, github.dev,
   StackBlitz, Cursor all use it. Same delivery model as Ace today (AMD
   loader from CDN, lazy, no bundler). Ships diff editor, minimap,
   command palette, multi-cursor, find/replace with regex, intra-line
   diff, and built-in JS/TS/JSON/CSS/HTML/Markdown language services.
   None of these are free under Ace.
2. **gemini-3.1-pro-preview** scored the original conservative
   "incrementally improve Ace" plan **2/5**. Specifically flagged tabs
   and diff as table-stakes-missing for the "feels like VS Code" bar
   the user explicitly named.
3. **codex-critic (gpt-5.5)** timed out twice on the original plan. Its
   likely findings (iframe sandbox details, Monaco bundle math, regex
   precision) were back-filled by combining the other two reviews.

**Cost we accept:** ~800 KB gzipped on first preview/editor open
(~5 MB raw). Pays once per browser cache lifetime; nothing on page load.
Mobile users on metered connections eat the cost once.

**Why not the obvious alternatives:**
- *Stay on Ace and bolt on tabs/diff.* We'd be rebuilding the surface
  Monaco already exposes. The migration is mechanical (1:1 API mapping
  in the ADR); rebuilding is open-ended.
- *CodeMirror 6.* Excellent library. Smaller bundle. But the diff
  editor is a third-party plugin, the markdown live preview ecosystem
  is thinner, and the implicit comparison set the user named uses
  Monaco. CodeMirror would be the right pick if bundle weight were
  the primary constraint; the user's stated requirement makes it
  secondary.

### Same-origin worker shim for Monaco

**Decision:** vendor a tiny `src/public/vendor/monaco-worker-shim.js`
that the host page references via `MonacoEnvironment.getWorker`. The
shim does `importScripts(<CDN base>/vs/base/worker/workerMain.js)` after
validating the CDN host against an allowlist
(`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`).

**Why:** the browser blocks `new Worker(<cross-origin URL>)`. Monaco's
language workers live on jsdelivr alongside the editor bundle. The shim
satisfies the same-origin requirement without bundling. Allowlist on
`?base=` makes the Worker URL safe even if a future bug lets a caller
choose the base — it can't be redirected to an attacker origin.

### PDF.js (vendored, lazy) over iframe

**Decision:** vendor `pdfjs-dist@4.x`'s `pdf.min.mjs` + `pdf.worker.min.mjs`
into `src/public/vendor/pdfjs/`; lazy-load on first PDF preview.

**Why:** iOS Safari refuses inline-iframe PDFs and forces a download —
research-fork-confirmed via Stack Overflow consensus. `<iframe>` was
silently broken for every iPhone/iPad user on a tunnel. PDF.js is the
only cross-browser solution.

**Cost:** ~600 KB gz core + worker. Lazy means PDF-less sessions pay zero.

**Why not pdf-lib or other render-only libs:** they need the user to
roll their own viewer chrome (page nav, zoom, fit-to-width). PDF.js
ships a viewer surface we can wrap in ~80 LOC.

### panzoom over OpenSeadragon for image zoom

**Decision:** vendor `@panzoom/panzoom@4.6.0` (`src/public/vendor/panzoom.min.js`,
~10 KB MIT, lazy-loaded) for `_renderImage`.

**Why:** OpenSeadragon is the gold standard for tiled deep-zoom images
(museum scans, satellite imagery) but ships ~150 KB and is overkill for
the screenshots / mockups / PNG / SVG / single-tile JPEG we're actually
showing. panzoom does pan + wheel-zoom + pinch on raster *and* SVG in
~10 KB. The factor-of-15 size difference would be defensible only if we
needed deep-zoom tiling, and we don't.

### ripgrep server-side over client-side full-text search

**Decision:** `GET /api/search?q=...` shells out to `rg --json --max-count
50 --max-filesize 10M`, streams results via SSE; falls back to
`grep -rIn` if ripgrep isn't installed (Linux only — Windows without rg
fails gracefully). Rate-limited 10 searches/min/IP.

**Why server-side:** to match a real "Cmd+Shift+F" experience the search
must traverse the whole tree, respect `.gitignore`, and stream results
as they arrive. Doing this in the browser would mean shipping every text
file's content to the client on demand — orders of magnitude more
bandwidth than ripgrep's already-filtered match lines, and slower.

**Why SSE not WebSocket:** server-to-client streaming only; HTTP/1.1
keep-alive friendly; trivial cancellation by closing the EventSource.
Reuses the auth middleware path already wired for `/api/files/*`.

**Why not full-text indexing (lunr / minisearch):** indexing requires a
build step and stale-index handling. ripgrep is fast enough on a 100k-file
repo to make indexing pointless.

### Mermaid + KaTeX lazy on detection

**Decision:** in the markdown renderer, scan the rendered DOM for
`code.language-mermaid` (only then dynamic-import mermaid from CDN, ~500
KB) and scan source for `$...$` / `$$...$$` (only then dynamic-import
KaTeX, ~70 KB). Both gracefully badge "preview unavailable" if the import
fails.

**Why detection-driven:** typical markdown files have neither. Eager-
loading both per markdown preview would more than triple the markdown
viewer's payload for the 95% case that doesn't use them. Memoised import
means the first-with-mermaid file pays it; subsequent are free.

### DOMPurify hook over post-walk innerHTML rewrite

**Decision:** rewrite relative `<img src="./...">` and
`<a href="./...">` inside `DOMPurify.addHook('afterSanitizeAttributes', ...)`,
not by walking `container.querySelectorAll(...)` after `innerHTML = ...`.

**Why (gemini review finding, MEDIUM-3):** the post-walk approach reads
sanitised HTML out of the DOM, mutates it, and writes it back. Any
encoding bug in the read-mutate-write loop reopens an XSS hole that
DOMPurify already closed. Hooking inside the sanitiser keeps the pipeline
single-pass and tamper-proof: by the time the HTML reaches the DOM it is
already final.

### xterm `registerLinkProvider` — optimistic, validate-on-click

**Decision:** the link provider's `provideLinks(bufferLineNumber, callback)`
returns links **synchronously** based on regex match alone. No
network I/O. Validation against `/api/files/stat` happens lazily in the
click handler.

**Why (gemini review finding, HIGH-1):** an `npm install` log scrolls
hundreds of lines through the buffer in a fraction of a second. Each
line triggers `provideLinks`. If `provideLinks` made network calls, a
single `npm install` would fire hundreds of `/api/files/stat` requests
inside one render frame — a self-DDoS that would saturate the browser's
6-connection-per-host cap and freeze the terminal. Optimistic match +
on-click validation is the only viable pattern.

**Tightened regex** — exclude version-shaped tokens (`1.2.3`),
require an extension allowlist or path separator, match `path:line` and
`path:line:col` suffixes (Claude/Codex emit these). Stripping the
suffix before the stat call.

### CSV: virtualization + column sort, raise cap to 1000

**Decision:** keep `_renderCsv`'s table approach but add `IntersectionObserver`
windowing (~50 visible rows mounted at any time), click-header column
sort, sticky header, raise the row cap from 100 to 1000.

**Why not pull in a grid library (ag-grid / Tabulator):** the CSV preview
is a *preview*, not a spreadsheet. We're not editing cells, freezing
panes, or grouping rows. ~80 LOC of vanilla virtualization beats a
~150 KB dependency for the same UX.

### Each tab owns its Monaco model

**Decision:** `TabManager.openFile(path, mode)` creates a
`monaco.editor.createModel(content, language, uri)` per tab. Switching
tabs is `editor.setModel(otherTab.model)` — instant, preserves cursor,
scroll, selection, and undo history.

**Why:** the alternative (one shared editor, swap content on tab switch)
loses undo history per file and forces a full re-tokenize on every
switch. Models are cheap; the user gets an IDE-feel tab switch for free.

### `getCwd` callback over `initialPath`

**Decision:** `FileBrowserPanel` accepts `getCwd: () => string|null` and
calls it on **every `open()`**, not at construction. `initialPath` stays
as a final fallback for tests and tooling without a session context.

**Why:** the user expectation "panel defaults to the active session's
cwd" is incompatible with construction-time capture as soon as the user
switches sessions. A callback called per-open keeps the panel in sync
with whichever session is active right now. A throwing callback falls
through to `initialPath` (defensive coding).

## Out of scope (deferred with rationale)

These were considered and explicitly punted:

- **Real expandable file tree.** No vanilla-JS library in 2026 ships
  virtualization + lazy-load + DnD + ARIA in one package. Rolling our
  own is a ~500 LOC follow-up; the current breadcrumbs + flat list is
  fine for v1. Plan a custom `role="tree"` extension of the existing
  list — it already uses the right ARIA pattern.
- **Git decorations (M/U/A badges in the file list).** ~120 LOC,
  self-contained, real "IDE-feel" win. Worth doing, just not in the
  first PR.
- **Event-driven AI-edit diff.** Bridges would need to detect which
  files an agent wrote and surface a "Diff this edit" prompt. The
  manual "Compare with..." path covers the user's stated need today;
  auto-detection is a separate observability project with its own
  surface area (which agent? which session? which write?).
- **OSC 7 cwd tracking.** For real-time `cd` follow inside the shell.
  Session `workingDir` is the launch dir; the `getCwd` callback fixes
  the user's complaint. OSC 7 (`ESC ] 7 ; file://...BEL`) parser is
  ~30 LOC of follow-up.
- **LSP-style IntelliSense for non-built-in languages.** Monaco gives
  JS/TS/JSON/CSS/HTML/Markdown for free. Python/Go/Rust IntelliSense
  needs a real language server (pyright, gopls, rust-analyzer running
  somewhere). Not in scope for this PR — would dwarf it.
- **Delete / rename in the file browser.** Per ADR-0012, terminal
  handles destructive ops. Unchanged.
- **Chunked upload > 10 MB.** Per ADR-0012. Unchanged.

## Why we didn't…

- **…SRI-pin the Monaco loader script.** Considered. The pinned version
  on jsdelivr (`monaco-editor@0.52.2`) is immutable, and the worker
  shim's CDN allowlist already constrains the host the editor can pull
  from. Adding SRI hashes for `loader.js` and a half-dozen worker bundles
  was judged nice-to-have not required. Worth revisiting if a CDN
  compromise becomes plausible.
- **…lazy-load Monaco only on Edit.** Tried in early planning. Rejected
  because code preview also needs Monaco — splitting "preview is plain
  pre, editor is Monaco" undoes the unified-highlighter win and re-opens
  the "no syntax highlighting in preview" gap. One shared lazy load,
  triggered by either preview or editor, keeps the model simple.
- **…add a search index.** ripgrep on a 100k-file repo finishes in
  ~200 ms. An index buys ~20 ms but adds index staleness, build steps,
  and storage. Not worth it.
- **…use `WebSocket` for `/api/search`.** SSE is the right shape:
  one-way server-to-client streaming, trivial cancellation by closing
  the `EventSource`, automatic reconnect handled by the browser, no
  protocol upgrade dance. WebSocket would buy us full-duplex we don't
  need.
- **…use `<iframe sandbox="allow-scripts">` for HTML preview.** Empty
  sandbox is strictest — disables scripts, plugins, forms, same-origin,
  popups, top-nav, downloads. Inline `<style>` inside the file still
  works under sandbox because the iframe origin is "null" and same-origin
  style is permitted there. Allowing scripts re-opens the XSS surface
  the sandbox is the whole point of closing.
- **…rebuild the right-click `TerminalPathDetector` dead code from
  scratch.** It worked — only the wiring was missing. We instantiate it
  alongside the new `registerLinkProvider` so users get both: hover-to-click
  on emitted paths AND right-click on selected paths. Both share the
  same regex/extraction code.

## Peer review

Plan was reviewed by:

- **gemini-3.1-pro-preview** — scored 2/5 on the original conservative
  plan, drove the Monaco-vs-Ace decision, raised four substantive
  HIGH/MEDIUM findings (self-DDoS link provider, missing tabs+diff,
  DOMPurify XSS surface, missing Mermaid+KaTeX). All fixed in the
  shipped plan.
- **codex-critic (gpt-5.5)** — timed out twice. Likely findings
  (iframe sandbox details, Monaco bundle math, regex precision)
  back-filled from the other reviews. **Recommended re-running before
  merge.**
- **research fork** — confirmed Monaco for IDE-feel target, PDF.js
  for iOS, panzoom over OpenSeadragon (size), ripgrep server-side over
  client-side full-text, lazy mermaid + KaTeX patterns from the Mermaid
  docs.

## Test posture

- **Unit (mocha):** loader constants + label normalisation + language
  map + theme map (`test/file-viewer-monaco.test.js`); `getCwd`
  resolution order incl. throwing-callback path
  (`test/file-browser-getcwd.test.js`); link-detection regex precision
  for `path:line:col`, version-token exclusion, extension allowlist
  (`test/file-browser.test.js`); DOMPurify hook behaviour with
  relative-link rewriting; editor migration smoke (`test/file-editor.test.js`).
- **Server integration (mocha):** `/api/search` SSE roundtrip;
  `/api/files/git-show` 404-on-not-a-repo; existing
  `/api/files/*` endpoints unchanged (`test/file-browser-api.test.js`).
- **E2E (Playwright):** 11 scenarios spanning every renderer, tab
  switch, diff, search, mobile viewport, CDN-blocked degradation
  (`e2e/tests/file-browser.spec.js`). Cross-platform: `windows-latest`
  + `ubuntu-latest`, headless and headed.
- **CI-only per `docs/agent-instructions/06-ci-first-testing.md`.** No
  local dev-server smoke loops; iterate via push → draft PR → CI.
- **Tests use ports >11000.** Never 7777.

## What this unblocks for v2

- Auto-detected AI-edit diff (bridges emit `file-changed` → tab opens
  with a diff view of the change). Same `createDiffEditor` surface;
  just needs a server-side observation channel.
- Custom ARIA file tree built on top of the existing `role="tree"`
  list pattern — virtualization, lazy expand, DnD reorder.
- Git decorations on file-list items — `git status --porcelain` once
  per directory navigate; M/U/A badges inline.
- LSP integration for at least Python (pyright running server-side,
  Monaco language client over WebSocket). Real IntelliSense without
  shipping a language server bundle to the browser.
