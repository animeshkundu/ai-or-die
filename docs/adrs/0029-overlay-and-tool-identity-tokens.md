# ADR-0029: Overlay and Tool Identity Tokens

## Status

**Accepted**

## Date

2026-06-19

## Context

ADR-0007 established the design-token system: primitives feed semantic tokens,
themes override semantics, and component CSS should prefer semantic tokens. The
recent UI pass found two gaps in that system:

- Full-screen scrims had drifted across modals, menus, file-browser previews,
  input overlay, and terminal overlays. Each component picked its own hardcoded
  black alpha, so perceived depth changed from surface to surface.
- Tool identity colors were duplicated in JavaScript inline styles and component
  CSS. Tab badges and tool-card hover states need stable Claude/Codex/Copilot/
  Gemini/Terminal identity colors, but those colors are brand labels, not the
  current theme's accent.

The pass also exposed a subtle-border bug: some light-theme surfaces used
hardcoded/fallback borders that disappeared on white backgrounds (notably the
sticky-note/file-browser borders and split-drop-zone-adjacent surfaces).

## Decision

Add three theme-independent overlay scrim primitives to `tokens.css`:

- `--overlay-backdrop: rgba(0, 0, 0, 0.70)` for standard modal/dialog scrims.
- `--overlay-backdrop-light: rgba(0, 0, 0, 0.40)` for non-blocking dim layers.
- `--overlay-backdrop-strong: rgba(0, 0, 0, 0.92)` for blocking terminal/auth overlays.

Add tool-identity component tokens plus RGB triples:

- `--tool-claude` / `--tool-claude-rgb`
- `--tool-codex` / `--tool-codex-rgb`
- `--tool-copilot` / `--tool-copilot-rgb`
- `--tool-gemini` / `--tool-gemini-rgb`
- `--tool-terminal` / `--tool-terminal-rgb`

These are a deliberate exception to ADR-0007's "components use semantic tokens"
rule. Tool colors identify external assistants; they must remain stable across
all themes and must not become the active theme accent.

Add `--border-subtle` to every theme block: white alpha on dark themes and black
alpha on light themes. Use it for low-emphasis separators and borders that must
remain visible without becoming as strong as `--border-default`.

## Consequences

### Positive

- Scrim darkness is consistent across modals, menus, file browser overlays,
  input overlay, terminal blocking states, and the auth overlay.
- Tab badges can use `data-tool` plus CSS instead of inline background colors.
- Tool-card hover tints can be generated from `--tool-*-rgb` without duplicating
  brand color constants.
- `--border-subtle` gives sticky notes, file-browser controls, settings rows,
  and similar low-emphasis chrome a theme-safe border.

### Negative

- Tool identity tokens are another component-token family developers must know.
- The exception to ADR-0007 needs to stay narrow: brand/identity colors only, not
  general component styling shortcuts.

### Neutral

- The overlay scrims remain black and theme-independent by design; themes do not
  override them.
- Existing semantic tokens (`--surface-*`, `--border-default`, `--accent-*`) stay
  the default choice for component styling.

## Notes

- Related: [ADR-0007: Design Token System and Multi-Theme Architecture](0007-design-token-system.md).
- Implemented in `src/public/tokens.css` and consumed by component CSS plus the
  tab-badge rendering path in `src/public/session-manager.js`.
