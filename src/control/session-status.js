'use strict';

// Derive a session's control-plane status from the signals ai-or-die already
// computes (the JSONL transcript binding for claude; a rendered terminal tail
// for everything else). Pure + injected inputs so it is unit-testable without a
// live server (see test/control/session-status.test.js).
//
// Contract (Track B, fleet control plane):
//   status = {
//     lifecycle:        'created' | 'starting' | 'running' | 'exited' | 'crashed',
//     interactionState: 'busy' | 'idle' | 'waiting_input' | 'blocked' | 'unknown',
//     canAcceptInput:   boolean,
//     confidence:       'high' | 'medium' | 'low',
//     blockReason?:     string,
//     lastTurnEndedAt?: number,
//     awaiting?:        { kind, prompt?, options?, default? },
//   }
//
// Reliability is agent-dependent and surfaced via `confidence`: HIGH when the
// state is read from the claude JSONL transcript (ADR-0026 binding), MEDIUM when
// it comes from a busy-footer regex over the rendered terminal, LOW when neither
// signal is available. We never fake certainty.

// Busy footers per harness. claude/codex: "esc to interrupt"; opencode: "esc
// interrupt"; pi/others: "Working...". claude v2.x also shows an animated gerund
// spinner ("Bloviating…", "Creating…", "Pondering…") with a "…" while a turn
// runs, and no such line when idle at the composer — so we also match a gerund +
// ellipsis. Override with AIORDIE_BUSY_REGEX.
const DEFAULT_BUSY_REGEX = /esc (to )?interrupt|Working|Thinking|Compacting|Generating|\b\w*ing\s*(…|\.\.\.)/i;

// F12: coarse busy/idle for UNBOUND active sessions is derived from PTY-output
// recency. This is a LOW-confidence courtesy, not a turn oracle, so we require a
// LARGE quiet window before declaring idle (accept the responsiveness hit) — a
// brief inter-token gap must not flap a streaming turn to idle (review caveat).
const DEFAULT_UNBOUND_QUIET_MS = 4000;

function resolveBusyRegex(envValue) {
  if (!envValue || !String(envValue).trim()) return DEFAULT_BUSY_REGEX;
  try {
    return new RegExp(String(envValue), 'i');
  } catch {
    return DEFAULT_BUSY_REGEX;
  }
}

// A pending user-facing tool_use in the transcript IS the waiting_input state.
// Map the tool name the assistant left unanswered to the interaction kind the
// client must respond to.
function awaitingKindForPendingTool(toolName) {
  switch (toolName) {
    case 'ExitPlanMode':
      return 'plan_approval';
    case 'AskUserQuestion':
      return 'choice_question';
    case 'permission':
    case 'tool_approval':
      return 'tool_approval';
    default:
      return null;
  }
}

/**
 * @param {object} input
 * @param {{active:boolean, agent:?string, lastActivity?:(number|Date), hadOutput?:boolean}} input.session
 * @param {?{bound:boolean, endsOnAssistant?:boolean, growing?:boolean, lastTurnEndedAt?:number,
 *           pendingUserFacingTool?:?string, awaitingPrompt?:string, awaitingOptions?:Array}} [input.jsonl]
 * @param {string} [input.renderedTail]   last few rendered terminal lines (plain text)
 * @param {?{code:?number, signal:?string}} [input.exit]  present once the PTY has exited
 * @param {number} [input.now]
 * @param {number} [input.lastOutputAt]  ms epoch of the last PTY output chunk (F12, unbound recency)
 * @param {number} [input.quietWindowMs] busy↔idle recency window for unbound sessions (F12)
 * @param {RegExp} [input.busyRegex]
 * @returns {object} status
 */
function deriveStatus(input) {
  const session = (input && input.session) || {};
  const jsonl = (input && input.jsonl) || null;
  const renderedTail = (input && input.renderedTail) || '';
  const exit = (input && input.exit) || null;
  const busyRegex = (input && input.busyRegex) || resolveBusyRegex(process.env.AIORDIE_BUSY_REGEX);
  const now = (input && typeof input.now === 'number') ? input.now : Date.now();
  const lastOutputAt = (input && typeof input.lastOutputAt === 'number') ? input.lastOutputAt : undefined;
  const quietWindowMs = (input && typeof input.quietWindowMs === 'number') ? input.quietWindowMs : DEFAULT_UNBOUND_QUIET_MS;

  const lastActivity = toMs(session.lastActivity);
  const lastTurnEndedAt = jsonl && typeof jsonl.lastTurnEndedAt === 'number' ? jsonl.lastTurnEndedAt : undefined;
  const confidence = jsonl && jsonl.bound ? 'high' : renderedTail ? 'medium' : 'low';

  // ---- lifecycle -------------------------------------------------------
  // session.active is true exactly while the PTY runs. A session that ran and
  // exited keeps its `agent`; one that was never started has agent === null.
  let lifecycle;
  if (session.active) {
    lifecycle = session.hadOutput ? 'running' : 'starting';
  } else if (exit) {
    // A non-zero/ signalled exit is a crash; a clean exit is graceful.
    lifecycle = isCrashExit(exit) ? 'crashed' : 'exited';
  } else if (session.agent) {
    lifecycle = 'exited'; // ran before, no longer active, no exit detail captured
  } else {
    lifecycle = 'created'; // created but never started
  }

  // A dead session can never accept input and has no interaction state.
  if (lifecycle === 'exited' || lifecycle === 'crashed' || lifecycle === 'created') {
    return {
      lifecycle,
      interactionState: lifecycle === 'created' ? 'idle' : 'exited',
      canAcceptInput: lifecycle === 'created',
      confidence,
      lastTurnEndedAt,
    };
  }

  // ---- interactionState (running / starting) ---------------------------
  // 1) A pending user-facing tool_use (plan approval / question / permission)
  //    is the strongest signal — it is waiting_input regardless of quiet.
  const awaitingKind = jsonl ? awaitingKindForPendingTool(jsonl.pendingUserFacingTool) : null;
  if (awaitingKind) {
    return {
      lifecycle,
      interactionState: 'waiting_input',
      canAcceptInput: true,
      confidence,
      lastTurnEndedAt,
      awaiting: trimAwaiting({
        kind: awaitingKind,
        prompt: jsonl.awaitingPrompt,
        options: jsonl.awaitingOptions,
      }),
    };
  }

  // 1b) Screen-based approval/question detection — works without a JSONL binding
  //     (e.g. raw claude.exe). The live rendered screen showing an approval modal
  //     is a strong, direct waiting_input signal.
  const screenAwait = awaitingFromScreen(renderedTail);
  if (screenAwait) {
    return {
      lifecycle,
      interactionState: 'waiting_input',
      canAcceptInput: true,
      confidence: jsonl && jsonl.bound ? confidence : 'medium',
      lastTurnEndedAt,
      awaiting: trimAwaiting(screenAwait),
    };
  }

  // 2) JSONL-bound (claude): the transcript is the source of truth for BUSY, but
  //    the polled transcript LAGS the rendered screen. Between a just-submitted
  //    message and the poller detecting the new user turn, the last transcript
  //    line is still the prior settled assistant turn (endsOnAssistant:true,
  //    growing:false) → a spurious idle/high while claude is already mid-turn.
  if (jsonl && jsonl.bound) {
    if (jsonl.growing) {
      return base('busy', false); // authoritative busy from JSONL turn state (high)
    }
    // F8: the rendered footer LEADS the polled transcript, so cross-check it
    // BEFORE returning idle. If it shows a running turn ("esc to interrupt" /
    // spinner gerund) while the JSONL looks settled, the screen wins and we
    // report busy — but at MEDIUM confidence, because the footer is a
    // low-confidence annotation (wording drifts across claude versions; a small
    // or alternate-screen PTY can hide it; a stale footer can linger). It may
    // only RAISE busy; it is NEVER an authoritative idle gate and must never be
    // the sole signal that blocks a send (deadlock risk). The
    // authoritative busy signal remains the JSONL turn state.
    if (footerBusy(renderedTail, busyRegex)) {
      return { lifecycle, interactionState: 'busy', canAcceptInput: false, confidence: 'medium', lastTurnEndedAt };
    }
    // JSONL settled AND the screen agrees (or no footer) → high-confidence idle.
    // (endsOnAssistant, or bound-but-unsettled awaiting the first/next message.)
    return withAwaiting(base('idle', true), 'next_message');
  }

  // 3) Unbound fallback (no JSONL binding). Combine two coarse signals:
  //    - the busy FOOTER over the rendered tail ("esc to interrupt" / spinner) is a
  //      specific busy annotation (MEDIUM confidence when a renderedTail exists);
  //    - PTY OUTPUT RECENCY (F12) is a LOW-confidence freshness signal.
  //    Freshness ARBITRATES staleness: if output has been QUIET beyond the window a
  //    lingering footer is treated as STALE and we report idle, so the coarse
  //    became_idle edge still fires for await_turn (without this, a stale footer
  //    could pin the state busy forever and also swallow the next became_busy).
  //    A footer only RAISES busy while output is not stale-quiet. Neither is a turn
  //    oracle (review caveat): the supported real-turn path is
  //    agent:"claude" (bound), surfaced otherwise as NO_TURN_BINDING. None of these
  //    gate sending — _controlInputBridge only checks session.active — so a stale
  //    footer can never deadlock a send.
  const recent = typeof lastOutputAt === 'number' ? (now - lastOutputAt) < quietWindowMs : null;
  const footer = footerBusy(renderedTail, busyRegex);
  if (footer && recent !== false) {
    // Footer says busy and output is not stale-quiet (fresh, or recency unknown).
    return base('busy', false); // renderedTail present → confidence var = medium
  }
  if (recent === true) {
    // No (or stale) footer but output is genuinely recent → coarse busy (low).
    return { lifecycle, interactionState: 'busy', canAcceptInput: false, confidence: 'low', lastTurnEndedAt };
  }
  if (recent === false) {
    // Quiet beyond the window → coarse idle (low); any footer is treated as stale.
    const status = { lifecycle, interactionState: 'idle', canAcceptInput: true, confidence: 'low', lastTurnEndedAt };
    status.awaiting = { kind: 'next_message' };
    return status;
  }
  // No recency signal at all (recent === null) and the footer didn't match.
  if (renderedTail) {
    return withAwaiting(base('idle', true), 'next_message'); // medium idle
  }

  // 4) No usable signal yet.
  return base('unknown', false);

  function base(interactionState, canAcceptInput) {
    return { lifecycle, interactionState, canAcceptInput, confidence, lastTurnEndedAt };
  }
  function withAwaiting(status, kind) {
    status.awaiting = { kind };
    return status;
  }
}

function isCrashExit(exit) {
  if (!exit) return false;
  if (exit.signal) return exit.signal !== 'SIGTERM' && exit.signal !== 'SIGINT';
  return typeof exit.code === 'number' && exit.code !== 0;
}

// The busy footer (spinner / "esc to interrupt") is always at the very bottom of
// the screen, so match only the last few rows — renderedTail may be a wide window
// (so the screen-await check can see a tall modal header), and matching the busy
// regex across all of it risks a false-busy from stale scrollback.
function footerTail(renderedTail) {
  return String(renderedTail || '').split('\n').slice(-6).join('\n');
}
function footerBusy(renderedTail, busyRegex) {
  if (!renderedTail) return false;
  return busyRegex.test(footerTail(renderedTail));
}

function trimAwaiting(awaiting) {
  const out = { kind: awaiting.kind };
  if (awaiting.prompt) out.prompt = awaiting.prompt;
  if (Array.isArray(awaiting.options) && awaiting.options.length) out.options = awaiting.options;
  if (awaiting.default !== undefined) out.default = awaiting.default;
  return out;
}

function toMs(v) {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? undefined : t;
}

// Detect claude's approval/question modals directly from the RENDERED screen,
// so `awaiting` works even when the JSONL binding isn't available (e.g. a raw
// claude.exe whose Windows project-slug doesn't resolve). Patterns match claude
// v2.x: ExitPlanMode ("...ready to execute. Would you like to proceed? 1. Yes...")
// and a tool/permission prompt ("Do you want to proceed/allow/run... 1. Yes...").
//
// Safety posture: a false POSITIVE here can drive `respond()` to inject a wrong
// keystroke into a live terminal, while a false NEGATIVE only leaves the client
// on the raw `send_keys` path. So we bias hard toward precision:
//   - scope to the BOTTOM rows only — a modal is always the active prompt at the
//     bottom of the screen, so this also prevents STALE scrollback (an old modal,
//     or prose mentioning "proceed"/"plan") from forcing a false waiting_input;
//   - require ALL of a modal's distinctive anchors together (header phrase +
//     numbered options), not independent global matches;
//   - tolerate intra-phrase line wrapping (\s+) so a wrapped header still matches.
const SCREEN_AWAIT_ROWS = 12;

// Single source of truth for the folder-trust modal wording (F7). Claude's exact
// wording is undocumented and shifts between versions, so we match the observed
// variants empirically. Used by awaitingFromScreen (gated on a numbered list) AND
// by the ANSI-buffer auto-accept paths in claude-bridge.js / server.js — exporting
// one constant keeps those sites from drifting apart (they were duplicated and
// out of sync, missing the "Is this a project you trust?" variant).
//   - "Do you trust the files in this folder?"  → `do you trust the files`
//   - "Is this a project you trust?"            → `is this a project you trust`
//   - "1. Yes, I trust this folder"             → `trust this folder`
const TRUST_PROMPT_REGEX = /do you trust the files|trust this folder|is this a project you trust/i;

function awaitingFromScreen(renderedTail) {
  const full = String(renderedTail || '');
  if (!full) return null;
  const t = full.split('\n').slice(-SCREEN_AWAIT_ROWS).join('\n');
  // Numbered option list (the modal's selectable choices), e.g. "❯ 1. Yes".
  const numbered = /(^|\n)\s*❯?\s*1\.\s/.test(t) && /(^|\n)\s*❯?\s*2\.\s/.test(t);
  if (!numbered) return null;
  // ExitPlanMode has two observed wordings, both ending in a numbered modal with
  // "Yes" as option 1: the rich "...ready to execute. Would you like to proceed?"
  // (auto/manual/tell), and the terse "Exit plan mode? / Claude wants to exit plan
  // mode" (Yes/No). Either is plan_approval; accept = Enter selects option 1.
  const richPlan = /would\s+you\s+like\s+to\s+proceed/i.test(t) && /ready\s+to\s+execute/i.test(t);
  const exitPlan = /exit\s+plan\s+mode/i.test(t);
  if (richPlan || exitPlan) {
    return { kind: 'plan_approval', prompt: 'Claude is ready to leave plan mode and execute.' };
  }
  // Folder-trust modal (F7). High precision: the numbered-list guard above already
  // ensures a real "1. Yes / 2. No" choice list, so stray prose mentioning "trust"
  // can't trip it. accept = the EXPLICIT "1" choice (see _controlMapResponseKeys),
  // never a bare Enter that could land on a wrong default.
  if (TRUST_PROMPT_REGEX.test(t)) {
    return { kind: 'trust_prompt', prompt: 'Claude is asking whether to trust this folder before starting.' };
  }
  if (/do\s+you\s+want\s+to\s+(proceed|allow|run|make|create|edit|continue)/i.test(t)) {
    return { kind: 'tool_approval' };
  }
  return null;
}

module.exports = { deriveStatus, awaitingKindForPendingTool, awaitingFromScreen, resolveBusyRegex, DEFAULT_BUSY_REGEX, DEFAULT_UNBOUND_QUIET_MS, TRUST_PROMPT_REGEX };

