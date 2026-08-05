# Terminal geometry: measured findings

Measured on Windows 11, current `main`, using the two probes committed alongside this
document. All numbers below were produced by running those probes; none are estimated.

- `scripts/probe-multi-viewer-resize.js` — drives two browser contexts (desktop + phone
  viewport) against one session and reads the PTY's true width from the shell itself
  (`[Console]::WindowWidth`), so the numbers are what the running program actually wraps
  against rather than what the client believes.
- `scripts/probe-file-browser-geometry.js` — opens the docked file-browser panel on a
  desktop viewport and measures the panel rect against the terminal container rect.

## Symptoms

| # | Scenario | Measured | Status |
|---|----------|----------|--------|
| 1 | Desktop browser resized, sole viewer | xterm 110x35, PTY 110x35 | correct |
| 2 | Phone (390px) joins a session a desktop (1440px) is already on | desktop renders 163 cols, PTY is 38 | **broken** |
| 3 | Phone then disconnects | desktop still 163, PTY still 38, permanently | **broken** |
| 4 | File browser opened on desktop | 350px panel hides ~40 of 163 columns; terminal cols unchanged | **broken** |

Raw probe output for scenarios 1-3:

```
1. desktop alone                      xterm=163x45  pty=163x45   PASS
2. phone joined (phone's own view)    xterm=38x39   pty=38x39    PASS
2b. phone joined - DESKTOP vs PTY     xterm=163x45  pty=38x39    FAIL
3. after 4s settle - self-heal?       xterm=163x45  pty=38x39    FAIL
4. phone DISCONNECTED - recover?      xterm=163x45  pty=38x39    FAIL
5. desktop resized (sole viewer)      xterm=110x35  pty=110x35   PASS
```

Raw probe output for scenario 4:

```
viewport 1440x900  innerWidth=1440
overlay mode (innerWidth <= 1024)? NO -> docked panel
BEFORE: terminal cols=163 rows=45  container {"x":0,"y":45,"w":1440,"h":855}
AFTER:  terminal cols=163 rows=45  container {"x":0,"y":45,"w":1440,"h":855}
        panel {"x":1090,"y":44,"w":350,"h":856,"position":"fixed"}
VERDICT: cols 163 -> 163 (UNCHANGED); overlap 350px ~= 40 columns hidden
```

## Root cause

Nothing owns the question "what should this session's geometry be", and nothing re-asks it
when the inputs change. Geometry is computed in exactly one place — a single browser
measuring its own container — and pushed at the PTY. Three inputs that change the correct
answer never enter that computation:

1. **Docked chrome that steals space.** The file-browser panel is `position: fixed`, so the
   terminal container still measures 1440px while only 1090px is visible. The measurement is
   honest about the container and dishonest about reality.
2. **Other viewers attached to the same PTY.** One PTY has one size; N clients each assume
   they are alone.
3. **Viewers arriving and leaving.** No event recomputes anything.

Scenario 1 works precisely because it is the only case where a single browser's own container
*is* the whole truth.

## Relevant existing code

- `src/public/fit-coordinator.js` — `FitCoordinator` is the sole owner of client resize calls
  (ADR-0046). It measures a `container`, applies a live `reserve` callback, refuses geometry
  below 20 cols / 5 rows, and **dedupes** against `target.last`, only calling
  `terminal.resize()` / `send()` when the measurement differs (or `forceSend` is set because a
  previous send failed). Re-fits on `ResizeObserver` and on `visibilitychange`. Bounded
  self-retry (120 ms, max 12).
- `src/server.js:3847` — the `resize` case. Applies any member connection's geometry straight
  to the PTY. **No per-connection state, no policy, no broadcast.**
- `src/public/app.js:820` — `reserve: () => this.isMobile ? {cols:0,rows:1} : {cols:6,rows:2}`.
- `src/public/file-browser.js` —
  - `_isOverlayMode()` is `window.innerWidth <= 1024`, so on desktop the panel is **docked**,
    not a modal overlay: no backdrop, background not inert, terminal still interactive.
  - `_adjustTerminal()` is a deliberate no-op whose comment claims "non-terminal surfaces
    overlay the terminal and never change its geometry". That is true on mobile and false
    above 1024px.
  - `_refitAllTerminals()` is fully implemented (main terminal + split panes) and **never
    called anywhere** — dead code.
- `src/public/splits.js:129` — split panes have their own separate resize send path.

## Why the stale viewer never recovers

`FitCoordinator._apply` computes
`unchanged = target.last && target.last.cols === next.cols && target.last.rows === next.rows`
and only sends when `!unchanged || forceSend`. A viewer whose own container never changed
measures the same geometry forever, so `unchanged` stays true and it never re-sends. Nothing
else re-triggers it: `ResizeObserver` sees no container change, and `visibilitychange` only
fires if the tab is actually hidden and re-shown. The stale state is a fixed point, not a race.

## A design that was tried on paper and refuted

An earlier proposal had a letterboxed viewer set `target.last = applied` so its next
measurement would differ and it would reclaim the PTY "for free". **This oscillates.** Traced:

```
desktop: last=38  capacity=163  -> next fit stimulus: 163 != 38  -> sends 163
phone:   last=163 capacity=38   -> next fit stimulus:  38 != 163 -> sends 38
                                 -> repeat indefinitely
```

A phone emits `visualViewport` events constantly (scroll, URL bar, keyboard), so this thrashes
in practice, and every flip resizes the PTY, forcing a full TUI redraw that can discard
scrollback.

Other errors in that proposal, all of which the implementation must avoid:

- **Letterboxing only works when applied < capacity.** When a desktop wins at 163 columns, a
  390px phone cannot letterbox 163 columns; it must scale or pan.
- **If letterboxing shrinks the observed container**, the desktop subsequently measures the
  small geometry and can never reclaim. Outer capacity and inner rendered grid must be
  separate elements.
- **One variable cannot carry four states.** `localCapacity`, `lastAdvertised`,
  `authoritativeApplied`, and `rendered` are distinct.
- **`Map<wsId, {cols,rows}>` records no recency**, so a "most recent" policy is undefined
  without a server-assigned monotonic sequence.
- **Pixel arithmetic**: `floor(a/c) - floor(b/c) != floor((a-b)/c)`, and panel width is not the
  visible overlap during a transform transition.

## Recommended design

The decisive correction over the refuted proposal: **advertising capacity must not claim the
PTY.** Under a "most recent writer wins" policy, every incidental layout event — orientation
change, soft keyboard, panel drag, a bounded retry, a reconnect `forceSend` — becomes an
ownership claim. That is the feedback mechanism itself; debouncing only limits its rate.
Explicit ownership removes it.

### Layer 1 — real layout, not pixel arithmetic (fixes symptom 4)

Make the terminal's usable area an actual CSS layout region whose width changes when the panel
docks, and have `FitCoordinator` observe *that* element. This removes a whole class of error at
once: no fractional column conversion, no sampling a transform mid-transition, no
`innerWidth > 1024` guess that can disagree with the panel's real responsive mode, and
drag-resizing the panel is handled by `ResizeObserver` for free. `reserve` goes back to meaning
only fixed chrome.

Independent of the other layers. No protocol change.

### Layer 2 — explicit ownership (fixes symptom 2)

- Each attachment **advertises** its capacity. This updates fallback state only and never
  resizes the PTY.
- Exactly one attachment holds an **owner lease**. Only the owner's capacity drives
  `pty.resize`.
- Ownership transfers on a **deliberate act** — real user input from that device, or an
  explicit "take control" — never on a layout event. Typing on your phone is intentional; your
  phone's URL bar collapsing is not.
- On owner disconnect, transfer deterministically to a surviving attachment and apply its
  capacity. This is what fixes symptom 3.
- The server assigns a monotonic **revision**, serializes resize application per session, and
  validates geometry (integer, finite, positive, bounded). `applied` updates only after
  `pty.resize` succeeds. Clients ignore stale revisions.
- A **session epoch** covers restart: the PTY survives but the attachment map does not, so
  persist applied geometry plus revision alongside the session and have reconnecting clients
  re-advertise *without* claiming.
- Key state by `(sessionId, connectionId, viewId)`, not `wsId` — one socket hosts multiple
  split panes, and `splits.js:129` has its own send path that must use the same protocol or it
  becomes a direct feedback loop.

### Layer 3 — non-owner rendering

- Separate client state: `localCapacity`, `lastAdvertised`, `authoritativeApplied + revision`,
  `rendered`.
- Applying authoritative geometry runs under a **suppression guard** that cannot itself emit a
  resize.
- Render the grid in an **inner** element so the observed outer capacity element is never
  perturbed by letterboxing.
- Capacity >= applied: letterbox. Capacity < applied: scale down or pan, since letterboxing is
  impossible in that direction.
- Below the 20x5 floor, send an explicit **withdrawal**; otherwise a stale sub-floor desire
  sits in the server map and can become authoritative when the owner leaves.

There is an ordering hazard to close: `pty.resize()` can make the TUI emit redraw output before
`geometry_applied` reaches clients, so those bytes would be rendered at the old dimensions.
Serialize the resize transaction and order the geometry frame ahead of the resulting output.

## Unmeasured

Not yet probed, and must not be claimed as working without measurement: phone orientation
change, iOS soft keyboard (needs WebKit, not Chromium — there is bespoke `visualViewport`
handling plus a Safari polling fallback in `app.js`), split panes, and reconnect-after-drop.

## Unrelated observation

Both probe runs ended with the known Windows ConPTY teardown crash (`AttachConsole failed` in
`@lydell/node-pty-win32-x64/lib/conpty_console_list_agent.js`). It still reproduces on current
`main` and is tracked separately.
