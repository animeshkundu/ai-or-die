# ADR-0016: Monaco-Based File Browser Editor

## Status

**Accepted**

## Date

2026-05-13

## Context

ADR-0012 chose Ace Editor for the file browser editor. At the time, the bar
for "edit a file in the browser" was modest: load a code file from a CDN-served
editor, get syntax highlighting, save it back. Ace cleared that bar.

Since then, the user requirement has shifted. The latest direction is a
"first-class file browser complete with all types of rich file viewers
(markdown, PDF, images, code with semi-IDE if possible, HTML), defaulting to
terminal cwd, with clickable file links from Claude/Codex output, plus
editing." The implicit comparison set for "semi-IDE" is no longer Ace-class
in-browser editors but vscode.dev, github.dev, StackBlitz, and Cursor. The
2026 user expectation for "code in a tab" is:

- Multi-cursor, command palette, find/replace with regex, minimap.
- Side-by-side diff with intra-line highlighting.
- Built-in JS/TS/JSON/CSS/HTML language services (hovers, completions,
  diagnostics) with no per-language opt-in.
- Multi-file tabs whose state (cursor, scroll, undo) survives tab switches.
- Cross-file search that opens results in those tabs at the matched line.

Ace can be coaxed toward some of these (themes, modes, keybindings) but does
not ship a diff editor, does not virtualize models per tab, and its language
services are thin compared to Monaco's. Adding tabs + diff + cross-file search
on top of Ace is rebuilding the surface that Monaco already exposes.

Three independent reviews informed the decision to migrate before shipping
the larger feature set:

1. **Research fork** — recommended Monaco over Ace for the IDE-feel target;
   PDF.js for cross-browser PDF (iOS Safari refuses inline iframe PDFs);
   panzoom over OpenSeadragon for image zoom (~5 KB vs ~300 KB);
   server-side ripgrep over client-side search.
2. **gemini-3.1-pro** (via peer-review-coordinator) — scored the original
   conservative plan 2/5; flagged tabs and diff as table-stakes-missing;
   identified self-DDoS risk in the link-provider design; raised DOMPurify
   re-injection XSS concerns; flagged the missing Mermaid/KaTeX surface for
   a "rich" markdown viewer.
3. **codex-critic** (gpt-5.5) — timed out twice; gaps it would likely have
   raised (iframe sandbox details, Monaco bundle math, regex precision) were
   addressed by combining the other two reviews.

After this review pass, retrofitting Ace to satisfy the new requirement was
judged more expensive than migrating once.

## Decision

We supersede ADR-0012's editor decision and adopt **Monaco Editor** as the
single rendering engine for both code preview and code editing in the file
browser. ADR-0012's other architectural choices stand: REST (not WebSocket)
for file operations, right-docked panel layout, hash-based optimistic
concurrency on save, server-side `validatePath()` with symlink resolution,
extracted `src/utils/file-utils.js`, and no delete/rename in v1.

Key implementation choices follow.

### AMD loader from CDN, no bundler

Monaco is loaded via its AMD loader (`vs/loader.js`) from a public CDN
(`cdn.jsdelivr.net`), the same delivery model Ace used. The application has
no build step today; preserving that constraint was a hard requirement.

A single shared `loadMonaco()` function, promise-memoized, returns
`Promise<typeof monaco>`. The first caller pays the CDN cost; subsequent
callers reuse the resolved promise. The loader is invoked lazily — only when
the user opens a code preview or editor.

### Same-origin worker shim

Monaco's language workers (`tsWorker`, `jsonWorker`, `cssWorker`,
`htmlWorker`, plus `editorWorker`) must be served from the same origin as the
host page; loading a Worker from a cross-origin URL is blocked by the
browser. The standard solution is a tiny same-origin "shim" worker that
`importScripts()` the real worker from the CDN.

We vendor `src/public/vendor/monaco-worker-shim.js`. It reads its `?label=`
query parameter, maps it to the correct worker filename, and
`importScripts('https://cdn.jsdelivr.net/.../<label>.worker.js')`. The
`MonacoEnvironment.getWorker` callback in `loadMonaco()` constructs new
`Worker('/vendor/monaco-worker-shim.js?label=<label>')` instances. The label
is passed through a fixed allowlist (`editor`, `json`, `css`, `html`,
`typescript`, `javascript`) — unknown labels fall back to the generic
editor worker, eliminating the worker URL as a path-traversal surface.

### Theme map preserved

The seven application themes (Midnight, Classic Dark, Classic Light,
Monokai, Nord, Solarized Dark, Solarized Light) map onto Monaco's two
built-in themes (`vs`, `vs-dark`) plus four custom palettes registered via
`monaco.editor.defineTheme(...)`. The custom palettes pull token colors from
the existing CSS design tokens (`tokens.css`) so editor chrome stays in
visual sync with the rest of the UI when the user changes themes.

### Public API factory

`createCodeViewer(container, { content, language, readOnly, theme })`
returns a Monaco editor instance with the same minimal surface area both the
preview pane and the editor pane need. The editor pane additionally wires
autosave, conflict detection, and Ctrl+S, none of which the preview pane
uses.

### Graceful CDN-blocked fallback

If `loadMonaco()` rejects (CDN blocked, network error, integrity failure),
the preview pane falls back to the existing plain-`<pre>`-with-line-numbers
renderer, and the editor pane displays an inline error banner directing the
user to retry or use the terminal. This preserves the degraded-but-functional
behavior the Ace path already had under ADR-0012.

### Migration is mechanical

The Ace API surface used by `file-editor.js` maps 1:1 onto Monaco:

| Ace                                            | Monaco                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `editor.getValue()` / `setValue(s, -1)`        | `editor.getValue()` / `setValue(s)` + `editor.setPosition(...)`        |
| `editor.session.setMode('ace/mode/X')`         | `monaco.editor.setModelLanguage(model, 'X')`                           |
| `editor.commands.addCommand({ exec, bindKey })`| `editor.addCommand(monaco.KeyMod.CtrlCmd \| monaco.KeyCode.KeyS, fn)`  |
| `editor.on('change', fn)`                      | `editor.onDidChangeModelContent(fn)`                                   |
| `editor.selection.on('changeCursor', fn)`      | `editor.onDidChangeCursorPosition(fn)`                                 |
| `editor.getCursorPosition()` (0-based)         | `editor.getPosition()` returns `{lineNumber, column}` (1-based)        |
| `editor.setReadOnly(true)`                     | `editor.updateOptions({ readOnly: true })`                             |

The public `FileEditorPanel` API does not change: `openEditor`, `save`,
`toggleAutoSave`, `onClose`, `saveDraft`. The hash-based 409 conflict flow
(Keep / Reload / Compare Changes) is preserved end-to-end. The "Compare
Changes" custom modal is replaced with `monaco.editor.createDiffEditor` so
the conflict-resolution view gets the same intra-line diff highlighting as
the explicit "Compare with..." feature.

## Consequences

### Positive

- **IDE-feel parity.** The editor and read-only viewer become directly
  comparable to vscode.dev / github.dev / Cursor for the JS/TS/JSON/CSS/HTML
  family that built-in Monaco language services cover.
- **Free wins on first load.** `createDiffEditor`, minimap, command palette,
  multi-cursor, find/replace with regex, intra-line diff highlighting, and
  large-file virtualization all ship with the core. We were going to need
  most of these anyway; under Monaco they cost zero additional code.
- **Single highlighter across the app.** Markdown fenced-code blocks can
  reuse `monaco.editor.colorize(...)` rather than pulling in a second
  highlighter (highlight.js, prismjs).
- **Tabs become cheap.** Each open file owns a `monaco.editor.createModel(...)`
  with its own URI; switching tabs is instant and preserves cursor, scroll,
  selection, and undo history without bespoke state management.
- **Conflict resolution upgraded.** The "Compare Changes" 409 modal gets a
  real side-by-side diff for free, replacing a custom comparison view.

### Negative

- **First-load weight.** Monaco core is ~800 KB gzipped (raw ~5 MB). The
  bundle is paid only on the first preview/editor open per session and is
  cached by the browser thereafter. We accept this cost in exchange for
  the IDE-feel target.
- **Mobile cost.** Mobile users on metered connections pay the ~800 KB once
  per cache lifetime. The fallback `<pre>` viewer handles offline / blocked
  CDN. We do not lazy-strip language workers per-platform in v1; if mobile
  bundle weight becomes a complaint, splitting the worker manifest is a
  follow-up.
- **CDN dependency widens.** ADR-0012 already accepted CDN delivery for
  Ace; Monaco enlarges the surface (loader + ~5 worker scripts + the editor
  bundle). The same-origin worker shim mitigates one specific category
  (cross-origin worker policy) but does not remove the dependency.
- **Worker shim is one more vendored file** to keep current with Monaco
  version bumps. Mitigated by the label allowlist (the shim is essentially
  six lines of switch-on-label) and a sticky pinned Monaco version.
- **Custom theme palettes deferred.** v1 maps every app accent theme
  (monokai, nord, solarized-dark, solarized-light) onto Monaco's built-in
  `vs` / `vs-dark`. The chrome — terminal, sidebar, panel — stays themed
  via `tokens.css`; only Monaco's editor surface uses its built-in
  palette. An earlier draft of the loader registered four custom themes
  that overrode only chrome colors and inherited `vs-dark` syntax token
  rules; adversarial review (MEDIUM-1) correctly flagged this as worse
  than either alternative — claimed the user's accent theme but rendered
  Monaco-default syntax tokens on a mismatched background. Shipping real
  Monaco token rules per theme (~200 LOC of vendored data via the
  `monaco-themes` package) is a self-contained follow-up if user feedback
  warrants it.

### Neutral

- The preview pane stops using a hand-rolled `<pre>` renderer for code
  files in the happy path; the same `<pre>` renderer remains as the
  fallback path.
- The Ace `<link rel="preload">` tag in `index.html` is removed; the Monaco
  loader script tag replaces it.
- The Ace mode map in `file-browser.js` becomes a Monaco language map.
  Most extension → identifier mappings are identical; the few that change
  (Monaco prefers canonical IDs like `typescript`, `javascript`, `python`,
  `markdown`, `yaml` directly) are mechanical renames.
- Existing security posture is preserved end-to-end: `validatePath()`,
  `nosniff`, `Cache-Control: no-store`, `CSP: sandbox` on raw downloads,
  executable blocklist, write rate-limit, hash-based concurrency.

## Notes

- **Supersedes:** the "Ace Editor from CDN" decision in ADR-0012. The
  remaining decisions in ADR-0012 (REST API surface, right-docked panel,
  hash-based concurrency, extension+null-byte MIME detection, enhanced
  `validatePath()` with realpath, extracted `file-utils.js`, no
  delete/rename in v1) stand as written.
- **Related:** the broader file-browser feature set this migration
  unblocks — multi-file tabs, side-by-side diff, cross-file search,
  Mermaid/KaTeX in markdown preview, sandboxed HTML preview, PDF.js viewer,
  panzoom on images — is captured in `docs/specs/file-browser.md` and the
  rich-viewers history doc at `docs/history/file-browser-rich-viewers.md`.
- **Out of scope** (deferred with rationale to the rich-viewers history doc):
  LSP-style IntelliSense for non-built-in languages (Python/Go/Rust would
  need a real language server), event-driven AI-edit diff
  (auto-detection of agent-written files), OSC 7 cwd tracking inside the
  shell, real expandable file tree, and git decorations in the file list.
