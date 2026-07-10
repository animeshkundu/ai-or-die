/**
 * terminal-wheel.js — trackpad / mouse-wheel policy for xterm terminals.
 *
 * Problem it fixes: when a full-screen app is on the ALTERNATE screen buffer
 * (the Claude Code TUI, `less`, `vim`, ...), xterm.js unconditionally converts
 * every wheel notch into cursor Up/Down key bytes (ESC O A / ESC O B, or the
 * CSI form) and cancels native scroll. Inside the Claude Code TUI those arrows
 * jump menus/history instead of scrolling — so the trackpad "presses the
 * up/down buttons" rather than scrolling.
 *
 * There is no xterm option to disable this. On xterm >= 5.4 we use the official
 * `attachCustomWheelEventHandler` (returning false cancels xterm's own wheel
 * processing — both the scrollback scroll and the alt-buffer arrow translation).
 * On older xterm we fall back to a CAPTURE-PHASE wheel listener installed on an
 * ANCESTOR of `.xterm`, which fires BEFORE xterm's own wheel listener so
 * stopImmediatePropagation() there preempts the translation. Either way the
 * decision is identical (decideWheelAction).
 *
 * Behaviour (see decideWheelAction):
 *   - Normal buffer            -> passthrough (xterm scrolls scrollback natively)
 *   - Alt buffer + mouse mode  -> passthrough (xterm reports wheel as mouse events)
 *   - Alt buffer, no mouse     -> governed by the user's `wheelScrollMode`:
 *        'dontHijack' (default): suppress   -> no arrows, no menu hijack
 *        'altScroll'           : passthrough -> xterm sends arrows (pagers scroll)
 *   - An app that explicitly sets DEC private mode 1007 (alternate scroll mode)
 *     overrides the default for that app: 1007h -> passthrough, 1007l -> suppress.
 *
 * Honest note: in the alt buffer the Claude Code TUI and a pager are otherwise
 * indistinguishable (both alt-screen, no mouse, no 1007), so the toggle is the
 * real control; the default is tuned for the Claude-Code-primary workflow.
 */
(function () {
  'use strict';

  /**
   * Pure decision function (exported for unit tests).
   * @param {object} terminal  xterm Terminal (needs .buffer.active.type and .modes)
   * @param {string} mode      'dontHijack' | 'altScroll'
   * @param {('on'|'off'|null)} force1007  explicit DEC 1007 state, overrides `mode`
   * @returns {'passthrough'|'suppress'}
   */
  function decideWheelAction(terminal, mode, force1007) {
    try {
      var active = terminal && terminal.buffer && terminal.buffer.active;
      var isAlt = !!(active && active.type === 'alternate');
      // Normal buffer: never interfere — xterm scrolls the scrollback natively.
      if (!isAlt) return 'passthrough';

      // Alt buffer but the app enabled mouse tracking: let xterm report the wheel
      // as mouse events so mouse-aware apps keep scrolling.
      var modes = terminal.modes || {};
      if (modes.mouseTrackingMode && modes.mouseTrackingMode !== 'none') {
        return 'passthrough';
      }

      // An app's explicit DEC 1007 wins over the user's wheelScrollMode:
      // 1007h forces passthrough even under dontHijack; 1007l forces suppress
      // even under altScroll (the app explicitly opted out of alternate scroll).
      if (force1007 === 'on') return 'passthrough';
      if (force1007 === 'off') return 'suppress';

      // Ambiguous alt-buffer case: user setting decides.
      if (mode === 'altScroll') return 'passthrough';
      return 'suppress'; // 'dontHijack' default
    } catch (_) {
      // Never break scrolling on an unexpected terminal shape.
      return 'passthrough';
    }
  }

  /**
   * Attach the wheel policy to a terminal.
   * @param {object} terminal      xterm Terminal instance
   * @param {HTMLElement} containerEl  an ANCESTOR of the `.xterm` element (the element passed to terminal.open())
   * @param {function(): string} getMode  returns the current 'wheelScrollMode'
   * @returns {{dispose: function}} handle whose dispose() removes the listener + parser hooks
   */
  function attachTerminalWheel(terminal, containerEl, getMode) {
    if (!terminal) {
      return { dispose: function () {} };
    }

    // Track explicit DEC private mode 1007 (alternate scroll mode). xterm does
    // not expose 1007, so we observe the control sequences via the parser. We
    // ALWAYS return false so the sequence still flows to xterm's own handlers
    // (xterm ignores 1007, but returning true would swallow every other
    // DEC-private set/reset — cursor, alt buffer, mouse, bracketed paste).
    //
    // CRITICAL: the flag is per-alt-screen-app, not per-session. Entering OR
    // leaving the alt buffer (1049/1047/47) and a full reset (RIS, ESC c) clear
    // it, so a stale 1007 from a previous app (e.g. tmux) can't hijack the next
    // one (e.g. the Claude Code TUI).
    var alt1007 = null; // null = the current alt-screen app never set it
    var disposers = [];
    try {
      var parser = terminal.parser;
      if (parser && typeof parser.registerCsiHandler === 'function') {
        var scan = function (value) {
          return function (params) {
            try {
              var toggleAlt = false, set1007 = false;
              for (var i = 0; i < params.length; i++) {
                var p = params[i];
                if (p === 1007) set1007 = true;
                else if (p === 1049 || p === 1047 || p === 47) toggleAlt = true;
              }
              if (toggleAlt) alt1007 = null; // alt-buffer enter/exit resets the per-app preference
              if (set1007) alt1007 = value;  // explicit 1007 wins
            } catch (_) {}
            return false; // never consume
          };
        };
        disposers.push(parser.registerCsiHandler({ prefix: '?', final: 'h' }, scan('on')));
        disposers.push(parser.registerCsiHandler({ prefix: '?', final: 'l' }, scan('off')));
      }
      if (parser && typeof parser.registerEscHandler === 'function') {
        // RIS (ESC c) — full terminal reset clears the 1007 preference too.
        disposers.push(parser.registerEscHandler({ final: 'c' }, function () { alt1007 = null; return false; }));
      }
    } catch (_) {
      // Parser API differences: degrade gracefully to setting-only behaviour.
    }

    var decide = function () {
      var mode = 'dontHijack';
      try {
        var m = typeof getMode === 'function' ? getMode() : null;
        if (m) mode = m;
      } catch (_) {}
      return decideWheelAction(terminal, mode, alt1007);
    };

    var disposeParser = function () {
      for (var i = 0; i < disposers.length; i++) {
        try { if (disposers[i] && disposers[i].dispose) disposers[i].dispose(); } catch (_) {}
      }
      disposers = [];
    };

    // Preferred (xterm >= 5.4): the official custom wheel handler. Returning
    // false cancels xterm's own wheel processing. Re-attaching replaces the
    // handler (naturally idempotent), and terminal.dispose() tears it down.
    if (typeof terminal.attachCustomWheelEventHandler === 'function') {
      terminal.attachCustomWheelEventHandler(function () {
        return decide() !== 'suppress';
      });
      return {
        dispose: function () {
          try { terminal.attachCustomWheelEventHandler(function () { return true; }); } catch (_) {}
          disposeParser();
        }
      };
    }

    // Fallback (older xterm without the API): capture-phase listener on an
    // ancestor of `.xterm` preempts xterm's own wheel listener.
    if (!containerEl || typeof containerEl.addEventListener !== 'function') {
      disposeParser();
      return { dispose: function () {} };
    }
    var onWheel = function (ev) {
      if (decide() === 'suppress') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
      // 'passthrough' -> do nothing; xterm's own wheel listener runs next.
    };
    // passive:false because we may preventDefault().
    containerEl.addEventListener('wheel', onWheel, { capture: true, passive: false });

    return {
      dispose: function () {
        try { containerEl.removeEventListener('wheel', onWheel, { capture: true }); } catch (_) {}
        disposeParser();
      }
    };
  }

  var api = { attachTerminalWheel: attachTerminalWheel, decideWheelAction: decideWheelAction };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.attachTerminalWheel = attachTerminalWheel;
    window.terminalWheel = api;
  }
})();
