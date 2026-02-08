# ADR-0010: Holistic Nerd Font Support for All Terminal Fonts

## Status
Accepted

## Context
The application offers multiple terminal font choices (MesloLGS, JetBrains Mono, Fira Code, Cascadia Code, Consolas, System Monospace) but only MesloLGS Nerd Font included PUA (Private Use Area) glyphs for Nerd Font icons. Users who switched to any other font lost all powerline separators, folder icons, git branch icons, and other Nerd Font glyphs — they rendered as tofu boxes.

Additionally, the canvas renderer's glyph atlas (CharAtlas) was not being invalidated when fonts loaded, causing stale fallback-font bitmaps to persist even after the correct web font became available.

## Decision
1. **Self-host Nerd Font WOFF2 variants** for JetBrains Mono (JetBrainsMonoNerdFont), Fira Code (FiraCodeNerdFont), and Cascadia Code (CaskaydiaCoveNerdFont) alongside the existing MesloLGS files. All sourced from mshaugh/nerdfont-webfonts@v3.3.0.

2. **Append MesloLGS Nerd Font as a CSS fallback** in every font option value, ensuring PUA glyphs render even for fonts without Nerd Font variants (Consolas, System Monospace).

3. **Call `terminal.clearTextureAtlas()`** before `terminal.refresh()` in all font-loading event handlers (both main terminal and split panes) to invalidate the canvas renderer's cached glyph bitmaps.

4. **Deprioritize `local('MesloLGS NF')`** (v2 naming) in @font-face source order, placing it after the self-hosted WOFF2 to prevent stale v2 local installs from taking precedence.

## Consequences

### Positive
- Nerd Font glyphs render correctly regardless of selected terminal font
- Offline support via service worker: default font (MesloLGS) pre-cached, others cached on first use
- Canvas atlas properly invalidated on font load, eliminating tofu persistence

### Negative
- Repository size increases by ~10MB (10 additional WOFF2 files)
- Initial page load fetches more font resources (mitigated by on-demand loading; only default font is preloaded)
- Fira Code has no italic variants — italic text falls back to regular weight
