# ADR-0045: Terminal-first client shell

## Status

Accepted (2026-08-04).

## Context

Non-terminal surfaces used inconsistent presentation rules. In particular, the file browser changed the terminal width on desktop but overlaid it on mobile. Opening it could therefore resize the live PTY even though the user had not changed the browser viewport.

## Decision

The terminal rectangle is owned by the application shell. File browsing, settings, command surfaces, input controls, and artifact review render above that rectangle and never reflow it. A surface may be a desktop drawer, floating panel, or mobile sheet, but opening, closing, or resizing the surface does not trigger terminal fitting.

Split terminals remain a terminal layout mode, not chrome. Split creation is unavailable below 700 CSS pixels because the resulting panes are not usable.

## Consequences

Opening auxiliary surfaces preserves columns, rows, scrollback, and selection. Desktop drawers may cover terminal content temporarily rather than changing the PTY geometry.
