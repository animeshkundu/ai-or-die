# Plan Viewer Specification

## Overview

The Plan Viewer detects and renders AI-generated implementation plans from Claude, Copilot, Codex, and Gemini. It uses a dual strategy: file-based reading for tools that write plan files to disk, and terminal output parsing for all tools (including Copilot, which writes no files).

## Plan Detection

### Tool-Aware PlanDetector

`src/public/plan-detector.js` maintains a `currentTool` field set via `setTool(toolId)` when a session starts. Only tool-specific patterns are checked for the active tool.

| Tool | Start Markers | Content Pattern | End Markers | Writes Files? |
|------|--------------|-----------------|-------------|---------------|
| **Claude** | `Plan mode is active`, `MUST NOT make any edits` | `## Implementation Plan:`, `### N.` | `approved your plan`, `Plan mode exited` | Yes: `.claude/plans/*.md` |
| **Copilot** | `PLAN MODE` | Numbered steps `1. ...` | `Plan accepted`, `All steps complete` | No (session state JSON only) |
| **Codex** | `[DRAFT PLAN]` | `## Action items`, `## Scope` | `[APPROVED PLAN]` | Yes: `PLAN.md`, `.codex/plan.json` |
| **Gemini** | Context-dependent | `## Analysis`, `## Plan` | Approval markers | Yes: `.gemini/plans/*.md` |

### Trigger Keywords (Safe Only)

Added to `_triggerKeywords`: `PLAN MODE`, `Plan accepted`, `Executing on autopilot`, `All steps complete`, `[DRAFT PLAN]`, `[APPROVED PLAN]`, `[REFINED PLAN]`.

**Explicitly excluded** (false positive risk): `Plan:`, `Step `, `## Scope`, `[APPROVED]`.

### Step Progress Tracking (Copilot)

`detectStepProgress(text)` matches `Step N/M: description` regex only when plan mode is already active. Throttled to 500ms minimum between emissions. Fires `onStepProgress` callback.

### Suppression

`_suppressDetection` flag prevents false positives when the input overlay echoes text containing plan-like keywords.

## Plan File Reading

### Workdir Plans (Claude, Codex, Gemini)

Uses existing `/api/files/content` endpoint — already has path validation and symlink resolution.

### Home Directory Plans (`~/.claude/plans/`)

Dedicated endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/plans/content?name=<filename>&scope=workspace\|global` | Read plan file content |
| `GET /api/plans/list?scope=workspace\|global` | List plan files by mtime |

Security (layered):
1. `sanitizeFileName()` strips path separators and dangerous characters
2. `path.basename()` defense-in-depth
3. `PLAN_DIRS` whitelist map (only `.claude/plans/` for workspace/global)
4. `path.relative()` containment check (rejects `..` escape)
5. `lstat.isSymbolicLink()` rejects symlinks
6. 512KB size limit

### Polling Strategy

Client-side polling when plan mode is active:
- Poll `/api/files/stat` every 3 seconds via recursive `setTimeout`
- Track `mtime` — only fetch content after 2 consecutive same mtime readings (6s stability)
- Stop polling when modal closes or plan mode exits
- 404 → return silently

## Rendering

### Markdown (Claude, Gemini)

- **marked.js** (v15, ~40KB vendored) + **DOMPurify** (v3, ~7KB vendored)
- Lazy-loaded on first plan viewer open via `_loadPlanLibraries()`
- Render: `DOMPurify.sanitize(marked.parse(cleaned))`
- Fallback: if libraries fail to load, render as `<pre>` with escaped text (`.plan-content--raw`)
- ANSI codes stripped before rendering (SGR, CSI, OSC sequences)

### Codex JSON (`plan.json`)

Separate `_renderCodexPlan(json)` template:
- Extracts `context`, `scope.in`, `scope.out`, `action_items` (with done/pending status), `open_questions`
- All values HTML-escaped via DOM textContent pattern
- Sanitized with DOMPurify

### CSS (`.plan-content`)

Full markdown element styling: h1-h3, p, ul/ol/li, links, blockquotes (left accent border), code/pre, tables (borders, header bg), horizontal rules. Semantic tokens only.

## Plan Indicator

- Button `#planIndicatorBtn` in header with document icon
- Hidden by default (`display:none`)
- Shown when plan mode activates; hidden when it exits
- Pulsing animation (`.plan-pulse` class) when new plan content detected
- **Does NOT auto-open modal** — user clicks to view
- Click opens `showPlanModal()` and clears pulse

## Files

| File | Role |
|------|------|
| `src/public/plan-detector.js` | Detection, extraction, tool-awareness, step progress |
| `src/public/app.js` | Plan indicator wiring, `showPlanModal()`, `_renderCodexPlan()`, `_loadPlanLibraries()`, polling |
| `src/public/vendor/marked.min.js` | Vendored markdown parser |
| `src/public/vendor/purify.min.js` | Vendored HTML sanitizer |
| `scripts/update-vendor.sh` | Re-vendor script (curl from jsdelivr) |
| `src/server.js` | `/api/plans/content`, `/api/plans/list` endpoints |
| `src/public/components/modals.css` | `.plan-content` markdown styles |
| `src/public/index.html` | Plan indicator button, vendor script tags |

## Accessibility

- Plan indicator button: `aria-label="View Plan"`, `title="View Plan"`
- Plan modal: focus trap via `focusTrap.activate(modal)`
- Accept/Reject buttons preserved for plan approval flow
