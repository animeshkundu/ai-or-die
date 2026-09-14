'use strict';

// PointerCorrection — fix mouse-report coordinates under the geometry
// presentation transform.
//
// A non-owner viewer presents the authoritative grid through a CSS transform
// (translate + scale) on the inner stage. xterm hit-tests pointer events
// against the TRANSFORMED element rect but divides by UNSCALED cell metrics,
// so under pan/scale regimes the TUI is told the wrong cell (measured:
// drawn col 26 reported as col 11 at scale 0.415). The pure presentation
// module (pointerToCell) knows the true drawn cell; this module rewrites the
// event coordinates so xterm reports it.
//
// Design constraints:
// - Active ONLY when regime !== 'exact' AND xterm mouse tracking is on.
//   Exact-regime and non-mouse paths are untouched (zero behavior change in
//   the common case).
// - Only mousedown/mousemove/mouseup are remapped. Wheel keeps flowing to
//   terminal-wheel.js untouched (scroll direction/count are exact; only the
//   reported wheel position is approximate under pan/scale — documented).
// - Link hover, selection, context menu: untouched (no mouse mode, or
//   separate UI paths).
// - Corrected clones are marked so the capture listener never reprocesses
//   them (no loops).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PointerCorrection = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CORRECTED = '__aiorCorrected';

  // Observability: how many events were remapped (also lets tests assert
  // the listener engaged). Reset by reading via takeStats().
  const stats = { corrected: 0 };

  // Where must a pointer event land (client coords, xterm's own screen-rect
  // space) for xterm to report the given 1-based SGR cell?
  // xterm computes col = floor((clientX - rect.left) / cellW) + 1, so aim at
  // the cell center.
  function correctedPointForCell(sgrCol, sgrRow, screenRect, cell) {
    return {
      x: screenRect.left + (sgrCol - 1 + 0.5) * cell.width,
      y: screenRect.top + (sgrRow - 1 + 0.5) * cell.height,
    };
  }

  // Decide whether an event needs remapping. Returns null when the event
  // should flow untouched, otherwise the corrected client point.
  // state: { regime, applied, presentation, cell, outerRect, screenRect, inset }
  //   inset = screen-element layout origin relative to the stage origin, in
  //   unscaled layout px (measured from offsetParent chains, which ignore
  //   transforms). The inset lives INSIDE the transformed stage, so in
  //   client space it contributes inset*scale; subtract it before the
  //   shared pointerToCell mapping, which is defined from the stage origin.
  // pointerToCell: (presentation, applied, cell, outerRelative) -> {col,row}|null
  // _debugOut: optional object receiving {outer, outerAdj, drawn} diagnostics.
  function correctionForEvent(state, pointerToCell, clientX, clientY, _debugOut) {
    if (!state || !state.presentation || state.presentation.regime === 'exact') return null;
    if (typeof pointerToCell !== 'function') return null;
    const pres = state.presentation;
    const s = pres.scale || 1;
    const inset = state.inset || { x: 0, y: 0 };
    const outer = {
      x: clientX - state.outerRect.left - inset.x * s,
      y: clientY - state.outerRect.top - inset.y * s,
    };
    const drawn = pointerToCell(pres, state.applied, state.cell, outer);
    if (!drawn || !(drawn.col >= 0) || !(drawn.row >= 0)) return null;
    if (_debugOut && typeof _debugOut === 'object') {
      _debugOut.outer = { x: outer.x, y: outer.y };
      _debugOut.drawn = { col: drawn.col, row: drawn.row };
    }
    // pointerToCell is 0-based; SGR is 1-based.
    return correctedPointForCell(drawn.col + 1, drawn.row + 1, state.screenRect, state.cell);
  }

  // Wire the capture listener. getState() must return the live state object  // (or null) on every event; wrapperEl bounds the interception to terminal
  // hits. Returns a detach function.
  //
  // Safety properties (see review):
  // - Remap only when the target is inside the xterm screen element AND the
  //   drawn cell re-projects within ~1 cell of the pointer. Scrollbar,
  //   viewport chrome, find widget, and padding hits flow raw (native
  //   behavior preserved exactly).
  // - One gesture, one epoch: mousedown snapshots {outerRect, screenRect,
  //   presentation, applied, cell, inset}; moves/up reuse it, so a layout
  //   or re-pan mid-drag cannot teleport the gesture. Hover (no buttons)
  //   uses live state.
  // - Fail-open ordering: the clone is fully constructed (and marked via a
  //   WeakSet, which cannot throw) BEFORE the original is stopped. The only
  //   residual loss is a dispatch throw on a detached element — in which
  //   case xterm is gone and the report has nowhere to go anyway.
  // - screenEl is scoped to wrapperEl (never document-wide), so split-pane
  //   screens can never be grabbed or polluted.
  // - mouseup is also watched at document level so a release outside the
  //   wrapper still ends the gesture at a clamped edge cell instead of
  //   leaving the TUI drag-stuck (only while a corrected gesture is open).
  function attach(wrapperEl, getState, pointerToCell) {
    if (!wrapperEl || typeof wrapperEl.addEventListener !== 'function') {
      return function () {};
    }
    const seen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
    const doc = (typeof document !== 'undefined') ? document : null;
    let epoch = null; // per-gesture snapshot, set on corrected mousedown

    function screenIn(scopeEl) {
      try {
        return scopeEl ? scopeEl.querySelector('.xterm-screen') : null;
      } catch (_) {
        return null;
      }
    }

    const rootView = (typeof window !== 'undefined') ? window : null;

  function buildClone(e, fixed) {
      const init = {
        bubbles: true,
        cancelable: true,
        view: (e.view || rootView),
        detail: e.detail || 0,
        screenX: e.screenX || 0,
        screenY: e.screenY || 0,
        clientX: fixed.x,
        clientY: fixed.y,
        ctrlKey: !!e.ctrlKey,
        shiftKey: !!e.shiftKey,
        altKey: !!e.altKey,
        metaKey: !!e.metaKey,
        button: typeof e.button === 'number' ? e.button : 0,
        buttons: typeof e.buttons === 'number' ? e.buttons : 0,
        relatedTarget: e.relatedTarget || null,
      };
      const clone = new MouseEvent(e.type, init);
      if (seen) {
        try {
          seen.add(clone);
        } catch (_) { /* ignore */
        }
      } else {
        try {
          clone[CORRECTED] = true;
        } catch (_) { /* ignore */
        }
      }
      return clone;
    }

    function isSelf(clone) {
      if (seen) {
        try {
          return seen.has(clone);
        } catch (_) {
          return false;
        }
      }
      return !!(clone && clone[CORRECTED]);
    }

    function snapshot(state, screenRect) {
      return {
        presentation: state.presentation,
        applied: state.applied,
        cell: state.cell,
        outerRect: state.outerRect,
        screenRect,
        screenEl: state.screenEl,
        inset: state.inset,
      };
    }

    function remap(e, snap) {
      return correctionForEvent(
        snap,
        pointerToCell,
        e.clientX,
        e.clientY,
        (typeof window !== 'undefined' && window.__pointerCorrectionDebug) ? (window.__pointerCorrectionDiag = {}) : undefined
      );
    }

    function deliver(e, snap, fixed) {
      const clone = buildClone(e, fixed);
      if (!clone) return false;
      stats.corrected++;
      if (typeof window !== 'undefined' && window.__pointerCorrectionDebug) {
        try {
          const ring = window.__pointerCorrectionDebug;
          ring.push({
            client: { x: e.clientX, y: e.clientY },
            fixed: { x: fixed.x, y: fixed.y },
            diag: window.__pointerCorrectionDiag || null,
          });
          if (ring.length > 200) ring.splice(0, ring.length - 200);
        } catch (_) { /* ignore */
        }
      }
      e.stopPropagation();
      try {
        if (typeof e.preventDefault === 'function') e.preventDefault();
      } catch (_) { /* non-cancelable */ }
      try {
        snap.screenEl.dispatchEvent(clone);
        return true;
      } catch (_) {
        return false;
      }
    }

    function liveState() {
      let state = null;
      try {
        state = getState();
      } catch (_) {
        return null;
      }
      if (!state) return null;
      // Scope the screen lookup to this wrapper: with split panes open,
      // document-wide lookup could grab another terminal's screen.
      const scoped = screenIn(wrapperEl) || state.screenEl;
      if (!scoped) return null;
      let screenRect = null;
      try {
        screenRect = scoped.getBoundingClientRect();
      } catch (_) {
        return null;
      }
      return { state, scoped, screenRect };
    }

    // True when the event targets grid content (not scrollbar/chrome) AND
    // the pointer lies on the drawn grid. The grid-space bounds check
    // defeats pointerToCell clamping: out-of-grid points would otherwise
    // forge edge-cell clicks (e.g. scrollbar drags reported to the TUI).
    function mappable(e, snap) {
      try {
        if (!snap.screenEl.contains(e.target)) return false;
      } catch (_) {
        return false;
      }
      const fixed = remap(e, snap);
      if (!fixed) return false;
      const s = snap.presentation.scale || 1;
      const ox = e.clientX - snap.outerRect.left;
      const oy = e.clientY - snap.outerRect.top;
      const gx = (ox + snap.presentation.offsetX) / s - snap.inset.x;
      const gy = (oy + snap.presentation.offsetY) / s - snap.inset.y;
      const tolX = snap.cell.width * 1.5 + 2 / s;
      const tolY = snap.cell.height * 1.5 + 2 / s;
      return (
        gx >= -tolX &&
        gx <= snap.applied.cols * snap.cell.width + tolX &&
        gy >= -tolY &&
        gy <= snap.applied.rows * snap.cell.height + tolY
      );
    }

    function debugNote(entry) {
      if (typeof window === 'undefined' || !window.__pointerCorrectionDebug) return;
      try {
        const ring = window.__pointerCorrectionDebug;
        ring.push(entry);
        if (ring.length > 200) ring.splice(0, ring.length - 200);
      } catch (_) { /* ignore */
      }
    }

    function onPointer(e) {
      if (!e || isSelf(e)) return;
      const isUp = e.type === 'mouseup';
      // Document-level mouseup only matters while a corrected gesture is
      // open (release outside the wrapper); otherwise ignore.
      if (isUp && !(e.target && wrapperEl.contains(e.target)) && !epoch) {
        debugNote({ skipped: 'up-outside-no-epoch', type: e.type });
        return;
      }
      const live = liveState();
      if (!live) {
        debugNote({ skipped: 'no-live-state', type: e.type });
        if (isUp) epoch = null;
        return;
      }
      const snap = snapshot(live.state, live.screenRect);
      snap.screenEl = live.scoped;
      if (e.type === 'mousedown' || e.type === 'dblclick') {
        const fixed = mappable(e, snap) ? remap(e, snap) : null;
        if (!fixed) {
          debugNote({ skipped: 'down-unmappable', type: e.type });
          return;
        }
        if (deliver(e, snap, fixed)) epoch = snap;
        return;
      }
      if (e.type === 'mousemove') {
        // Hover without buttons and without an open gesture: live mapping.
        // Inside a gesture: frozen epoch for consistency.
        const useSnap = epoch || snap;
        const fixed = mappable(e, useSnap) ? remap(e, useSnap) : null;
        if (!fixed) return;
        deliver(e, useSnap, fixed);
        return;
      }
      if (isUp) {
        const useSnap = epoch || snap;
        let fixed = null;
        if (epoch) {
          // Closing an open gesture: always remap (clamped edge release),
          // even outside the wrapper — otherwise the TUI drag sticks.
          // The epoch mapping is self-consistent by construction.
          fixed = remap(e, useSnap);
        } else {
          fixed = mappable(e, useSnap) ? remap(e, useSnap) : null;
        }
        epoch = null;
        if (!fixed) return;
        deliver(e, useSnap, fixed);
      }
    }

    const types = ['mousedown', 'mousemove', 'mouseup', 'dblclick'];
    for (const t of types) {
      try {
        wrapperEl.addEventListener(t, onPointer, true);
      } catch (_) { /* ignore */
      }
    }
    let docUp = null;
    if (doc && typeof doc.addEventListener === 'function') {
      docUp = function (e) {
        if (e && e.type === 'mouseup') onPointer(e);
      };
      try {
        docUp && doc.addEventListener('mouseup', docUp, true);
      } catch (_) { /* ignore */
      }
    }
    return function detach() {
      epoch = null;
      for (const t of types) {
        try {
          wrapperEl.removeEventListener(t, onPointer, true);
        } catch (_) { /* ignore */
        }
      }
      if (docUp) {
        try {
          doc.removeEventListener('mouseup', docUp, true);
        } catch (_) { /* ignore */
        }
      }
    };
  }

  function takeStats() {
    const out = { corrected: stats.corrected };
    stats.corrected = 0;
    return out;
  }

  return { correctedPointForCell, correctionForEvent, attach, takeStats };
});
