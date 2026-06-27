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
 * @param {RegExp} [input.busyRegex]
 * @returns {object} status
 */
function deriveStatus(input) {
  const session = (input && input.session) || {};
  const jsonl = (input && input.jsonl) || null;
  const renderedTail = (input && input.renderedTail) || '';
  const exit = (input && input.exit) || null;
  const busyRegex = (input && input.busyRegex) || resolveBusyRegex(process.env.AIORDIE_BUSY_REGEX);

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

  // 2) JSONL-bound (claude): the transcript is the source of truth.
  if (jsonl && jsonl.bound) {
    if (jsonl.growing) {
      return base('busy', false);
    }
    if (jsonl.endsOnAssistant) {
      return withAwaiting(base('idle', true), 'next_message');
    }
    // Bound but the last turn isn't a settled assistant reply and nothing is
    // growing: most likely awaiting the user's first/next message.
    return withAwaiting(base('idle', true), 'next_message');
  }

  // 3) Fallback: busy-footer regex over the rendered terminal tail. The footer
  //    (spinner / "esc to interrupt") is always at the very bottom, so match
  //    only the last few rows — renderedTail may be a wide window (so the
  //    screen-await check above can see a tall modal header), and matching the
  //    busy regex across all of it risks a false-busy from stale scrollback.
  if (renderedTail) {
    const footer = renderedTail.split('\n').slice(-6).join('\n');
    if (busyRegex.test(footer)) return base('busy', false);
    return withAwaiting(base('idle', true), 'next_message');
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
  if (/do\s+you\s+want\s+to\s+(proceed|allow|run|make|create|edit|continue)/i.test(t)) {
    return { kind: 'tool_approval' };
  }
  return null;
}

module.exports = { deriveStatus, awaitingKindForPendingTool, awaitingFromScreen, resolveBusyRegex, DEFAULT_BUSY_REGEX };

