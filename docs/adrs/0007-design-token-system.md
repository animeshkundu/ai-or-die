# ADR-0007: Design Token System and Multi-Theme Architecture

## Status

**Accepted**

## Date

2026-02-07

## Context

The ai-or-die frontend uses a monolithic 2161-line `style.css` with 15 ad-hoc CSS custom properties in `:root`. Colors, spacing, shadows, and z-index values are hardcoded throughout. The app supports only two themes (dark and light) via a `[data-theme="light"]` override block that duplicates every variable.

This creates several problems:
- Adding a new theme requires finding and updating every hardcoded value
- No formal spacing or typography scale leads to inconsistent sizing
- No z-index hierarchy makes layering unpredictable
- Inline styles scattered in HTML and JS (install button, warning text) bypass the theme system entirely
- The single CSS file is hard to navigate and risky to modify

The terminal emulator community has standardized on popular color schemes (Monokai, Nord, Solarized) that users expect to be available. Competitors like Warp and iTerm2 ship with 10+ built-in themes.

## Decision

We adopt a three-tier design token architecture in a dedicated `tokens.css` file:

1. **Primitive tokens** define raw values (color hex codes, pixel sizes). These are named by their visual property (e.g., `--color-gray-200: #27272a`). Components never reference primitives directly.

2. **Semantic tokens** define role-based references (e.g., `--surface-primary`, `--text-secondary`, `--accent-default`). All component CSS uses only semantic tokens.

3. **Component tokens** (optional) provide per-component overrides when a semantic token is too generic. Used sparingly.

Themes override only semantic tokens via `[data-theme="name"]` CSS selectors. The default theme (Midnight) is defined on `:root`. Adding a new theme requires only one `[data-theme]` block.

The monolithic `style.css` will be split into component-specific CSS files (`components/tabs.css`, `components/modals.css`, etc.) loaded via `<link>` tags in `index.html`. This is acceptable because the app is served from localhost, where HTTP overhead is negligible.

Seven themes ship at launch: Midnight (default), Classic Dark, Classic Light, Monokai, Nord, Solarized Dark, Solarized Light.

## Consequences

### Positive

- Adding a new theme is a single `[data-theme]` block (~20 lines)
- Components automatically support all themes with no per-theme CSS
- Consistent spacing, typography, and z-index across all components
- CSS files are smaller and focused, easier to review and modify
- Inline styles can be replaced with token-backed CSS classes

### Negative

- Multiple `<link>` tags increase the number of HTTP requests (mitigated: localhost only)
- Renaming semantic tokens requires updating all consuming CSS files
- Developers must learn the token naming conventions

### Neutral

- The existing `[data-theme="light"]` selector continues to work (aliased to `classic-light`)
- No build step is introduced — all CSS remains plain vanilla
- Token file serves as living documentation of the design system

## Notes

- Theme color values sourced from official specifications: [Nord](https://www.nordtheme.com/docs/colors-and-palettes/), [Monokai](https://monokai.pro/), [Solarized](https://ethanschoonover.com/solarized/)
- Meslo Nerd Font added as the default terminal font via CDN (nerdfont-webfonts on jsDelivr)
- xterm.js has a known limitation with double-width Nerd Font glyphs (issue #3342)
