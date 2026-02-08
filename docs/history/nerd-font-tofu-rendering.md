# Nerd Font Tofu Rendering

## Problem
Nerd Font PUA glyphs (powerline separators, folder/git icons, etc.) rendered as tofu boxes in the terminal, especially with Oh My Posh or Starship prompts.

## Root Causes

### 1. Single-font Nerd Font support
Only MesloLGS Nerd Font had Nerd Font glyphs. All other font options (JetBrains Mono, Fira Code, Cascadia Code, Consolas) used standard versions without PUA codepoints.

### 2. Canvas glyph atlas not invalidated
`app.js` called `terminal.refresh()` when fonts loaded, but xterm.js 5.3.0's canvas renderer caches glyph bitmaps in a CharAtlas (texture cache). `refresh()` reuses the cached atlas — it does NOT re-rasterize glyphs. Since `font-display: swap` causes the browser to render with a fallback font initially, the atlas cached tofu/fallback bitmaps. When the web font loaded, `refresh()` redrew from the stale cache.

### 3. Split pane terminals had no font-load handling
`splits.js` never registered `document.fonts.ready` or `loadingdone` listeners.

### 4. `local()` v2 font source priority
`fonts.css` listed `local('MesloLGS NF')` (Nerd Font v2 naming) before the self-hosted WOFF2. On machines with an older v2 font installed, the browser used the v2 version which has different PUA mappings.

## Fix
1. Self-host Nerd Font WOFF2 for JetBrains Mono, Fira Code, and Cascadia Code
2. Append MesloLGS Nerd Font as CSS fallback in all font option stacks
3. Call `terminal.clearTextureAtlas()` before `terminal.refresh()` in all font-load handlers
4. Add font-load handlers to split pane terminals
5. Move `local('MesloLGS NF')` after self-hosted WOFF2 in source order

## Why E2E Tests Didn't Catch It
All existing tests checked logical/metadata properties (font loaded, cursor positions, MIME types) — never actual canvas pixel output. `document.fonts.check()` returns true even when specific glyphs are missing. Cursor width calculations use Unicode tables, not rendered pixels.

## Key API
- `terminal.clearTextureAtlas()` — xterm.js 5.3.0 public API that invalidates the canvas glyph cache
- `document.fonts.addEventListener('loadingdone', ...)` — persistent listener for late-loading font variants
