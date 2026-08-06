# ADR-0053: Design system foundations and accessibility floor

## Status

Accepted (2026-08-06). Complements [ADR-0045](0045-terminal-first-client-shell.md), which
established that this is a terminal-first client and that chrome serves the terminal rather than
competing with it. This ADR records the foundations that chrome is built on, and the accessibility
floor it must clear.

## Context

The client had real design foundations already — a token layer (`tokens.css`), a component CSS
split, an icon module, and light/dark themes. What it did not have was a way to *know* they held.

Contrast was asserted for five hand-picked token pairs. That check can only confirm combinations
someone already believed were fine; it cannot fail for a pair nobody thought about. Hit-target sizes
were hardcoded as `44px` in eleven separate files, so there was no single definition to change and no
way to tell whether a new component had honoured it. Nothing verified what the browser actually
painted, as opposed to what the CSS declared.

The gap this closes is not "the design is wrong" — it is "the design's guarantees were unfalsifiable".

## Decision

**Accessibility is proven by measurement, not inspection.** Two layers, because they catch different
things:

1. **Static audit** (`test/design-system-audit.test.js`). Derives every foreground/background pair
   from the authored CSS — any rule setting both through tokens becomes a case — and asserts WCAG AA
   in both themes. It resolves `var()` chains and the `base.css` alias layer, and composites
   translucent tints over the surface behind them, because a tint like
   `--accent-soft: rgba(…, 0.12)` never renders alone. It also asserts the presence of
   `prefers-reduced-motion` handling, that no `:focus` rule removes the outline without a replacement
   affordance, and that a hit-target token exists at >= 44px.

2. **Rendered audit** (`e2e/tests/84-theme-accessibility.spec.js`). Walks the live DOM in both
   themes, finds each text node's first opaque painted ancestor, and measures the real contrast. A
   static check cannot see the cascade: an override, a specificity accident or an inherited colour
   can produce a rendered combination no single rule declares.

**Target size follows the input modality.** WCAG 2.2 AA (2.5.8) requires 24px on any pointer; 44px is
the touch figure. Asserting 44 against a mouse-driven desktop would be the wrong standard and would
force chrome to be needlessly large, so the audit picks the threshold from `pointer: coarse` /
`maxTouchPoints` / viewport. `--hit-target-min` (44px) is the single definition; components reference
it instead of hardcoding.

**Translucent tokens are tints, not colours.** Any token with alpha < 1 is defined to composite over
a surface, and must be measured that way.

## Consequences

- A new component with an inaccessible colour pair fails at source, and one that only fails once
  rendered fails in the e2e audit. Neither requires anyone to remember to check.
- Two real defects were found and fixed on adoption: `.extra-key-clipboard:active` used
  `--text-inverse` (white, intended for solid accent) on a 10% tint, giving a 1.18 ratio; and
  `.tab-new-dropdown` was 16px wide, below even the desktop 24px minimum.
- Light-theme `--accent-default` and `--text-muted` were darkened (`#007b9d` → `#006d8c`,
  `#5f6f81` → `#58677a`) to clear AA on tertiary and elevated surfaces. The values were computed
  against the failing constraints rather than chosen by eye.
- The audit's own correctness matters. Its first run reported ten failures, three of which were
  artefacts of not compositing alpha — it would have driven "fixes" to colours that were already
  fine. A measurement that can be wrong in the safe-looking direction is worse than none, so
  `derives real foreground/background pairs` guards against the extraction silently matching
  nothing and passing vacuously.

## Alternatives rejected

**Auditing a fixed list of pairs.** This is what existed. It cannot fail for anything unforeseen,
which is precisely the case worth catching.

**A single global 44px target.** Wrong standard for pointer input, and it inflates desktop chrome for
no accessibility gain. WCAG's own thresholds are modality-dependent.

**Static analysis only.** Cannot see the cascade. The rendered audit exists because a declared pair
and a painted pair are different claims.

**Rendered analysis only.** Requires a browser and a running server, so it cannot guard a pure CSS
edit in a unit run, and it only covers surfaces a test happens to visit.
