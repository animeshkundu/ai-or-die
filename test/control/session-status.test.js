'use strict';

const assert = require('assert');
const { deriveStatus, awaitingKindForPendingTool, awaitingFromScreen } = require('../../src/control/session-status');

describe('control/session-status deriveStatus', function () {
  it('created session: never started, can accept input', function () {
    const s = deriveStatus({ session: { active: false, agent: null } });
    assert.equal(s.lifecycle, 'created');
    assert.equal(s.canAcceptInput, true);
    assert.equal(s.confidence, 'low');
  });

  it('starting: active but no output yet', function () {
    const s = deriveStatus({ session: { active: true, agent: 'claude', hadOutput: false }, jsonl: { bound: true } });
    assert.equal(s.lifecycle, 'starting');
  });

  it('running + busy from growing JSONL', function () {
    const s = deriveStatus({
      session: { active: true, agent: 'claude', hadOutput: true },
      jsonl: { bound: true, growing: true, endsOnAssistant: false },
    });
    assert.equal(s.lifecycle, 'running');
    assert.equal(s.interactionState, 'busy');
    assert.equal(s.canAcceptInput, false);
    assert.equal(s.confidence, 'high');
  });

  it('idle from settled assistant turn → awaiting next_message', function () {
    const s = deriveStatus({
      session: { active: true, agent: 'claude', hadOutput: true },
      jsonl: { bound: true, growing: false, endsOnAssistant: true, lastTurnEndedAt: 123 },
    });
    assert.equal(s.interactionState, 'idle');
    assert.equal(s.canAcceptInput, true);
    assert.equal(s.awaiting.kind, 'next_message');
    assert.equal(s.lastTurnEndedAt, 123);
  });

  it('pending ExitPlanMode → waiting_input plan_approval', function () {
    const s = deriveStatus({
      session: { active: true, agent: 'claude', hadOutput: true },
      jsonl: { bound: true, growing: false, pendingUserFacingTool: 'ExitPlanMode', awaitingPrompt: 'the plan' },
    });
    assert.equal(s.interactionState, 'waiting_input');
    assert.equal(s.canAcceptInput, true);
    assert.equal(s.awaiting.kind, 'plan_approval');
    assert.equal(s.awaiting.prompt, 'the plan');
  });

  it('pending permission → waiting_input tool_approval', function () {
    const s = deriveStatus({
      session: { active: true, agent: 'claude', hadOutput: true },
      jsonl: { bound: true, pendingUserFacingTool: 'permission' },
    });
    assert.equal(s.awaiting.kind, 'tool_approval');
  });

  it('AskUserQuestion → choice_question with options', function () {
    const s = deriveStatus({
      session: { active: true, agent: 'claude', hadOutput: true },
      jsonl: {
        bound: true,
        pendingUserFacingTool: 'AskUserQuestion',
        awaitingOptions: [{ label: 'A', value: 'a' }],
      },
    });
    assert.equal(s.awaiting.kind, 'choice_question');
    assert.deepEqual(s.awaiting.options, [{ label: 'A', value: 'a' }]);
  });

  it('exited: not active, ran before', function () {
    const s = deriveStatus({ session: { active: false, agent: 'claude' } });
    assert.equal(s.lifecycle, 'exited');
    assert.equal(s.interactionState, 'exited');
    assert.equal(s.canAcceptInput, false);
  });

  it('crashed: non-zero exit code', function () {
    const s = deriveStatus({ session: { active: false, agent: 'claude' }, exit: { code: 1, signal: null } });
    assert.equal(s.lifecycle, 'crashed');
  });

  it('clean exit (SIGTERM) is exited, not crashed', function () {
    const s = deriveStatus({ session: { active: false, agent: 'claude' }, exit: { code: null, signal: 'SIGTERM' } });
    assert.equal(s.lifecycle, 'exited');
  });

  it('busy-footer fallback (no JSONL): medium confidence', function () {
    const busy = deriveStatus({
      session: { active: true, agent: 'codex', hadOutput: true },
      renderedTail: 'thinking… (esc to interrupt)',
    });
    assert.equal(busy.interactionState, 'busy');
    assert.equal(busy.confidence, 'medium');

    const idle = deriveStatus({
      session: { active: true, agent: 'codex', hadOutput: true },
      renderedTail: '> ',
    });
    assert.equal(idle.interactionState, 'idle');
    assert.equal(idle.awaiting.kind, 'next_message');
  });

  it('no signal at all → unknown, low confidence', function () {
    const s = deriveStatus({ session: { active: true, agent: 'terminal', hadOutput: true } });
    assert.equal(s.interactionState, 'unknown');
    assert.equal(s.confidence, 'low');
  });

  it('awaitingKindForPendingTool mapping', function () {
    assert.equal(awaitingKindForPendingTool('ExitPlanMode'), 'plan_approval');
    assert.equal(awaitingKindForPendingTool('AskUserQuestion'), 'choice_question');
    assert.equal(awaitingKindForPendingTool('permission'), 'tool_approval');
    assert.equal(awaitingKindForPendingTool('Bash'), null);
  });
});

// claude's ExitPlanMode approval modal, captured live from a headless session
// (the "Would you like to proceed?" header sits ~7 rows above the bottom).
const PLAN_MODAL = [
  ' Change: Create CONTRIBUTING.md with one line.',
  ' Verify: confirm the file exists with that line.',
  '────────────────────────────────────────',
  ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
  ' ❯ 1. Yes, and use auto mode',
  '   2. Yes, manually approve edits',
  '   3. Tell Claude what to change',
  '      shift+tab to approve with this feedback',
  ' ctrl+g to edit · ~\\plans\\make-a-plan.md',
  ' in editor',
].join('\n');

describe('control/session-status awaitingFromScreen (screen-based fallback)', function () {
  it('detects claude plan-approval from the rendered modal', function () {
    const out = awaitingFromScreen(PLAN_MODAL);
    assert.ok(out);
    assert.equal(out.kind, 'plan_approval');
  });

  it('detects the terse "Exit plan mode?" ExitPlanMode variant (Yes/No)', function () {
    // Observed live: a different ExitPlanMode wording than the rich modal above.
    const exitModal = [
      ' Plan: Create NOTES.md containing the single line hello.',
      ' Exit plan mode?',
      '   Claude wants to exit plan mode',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');
    const out = awaitingFromScreen(exitModal);
    assert.ok(out, 'terse exit-plan modal detected');
    assert.equal(out.kind, 'plan_approval');
  });

  it('detects a tool/permission approval modal', function () {
    const screen = [' Do you want to proceed with this edit?', ' ❯ 1. Yes', '   2. No, tell Claude what to do'].join('\n');
    assert.equal(awaitingFromScreen(screen).kind, 'tool_approval');
  });

  it('returns null on an idle composer / plain plan text', function () {
    assert.equal(awaitingFromScreen(' Contributions welcome — open an issue.\n done\n > '), null);
    assert.equal(awaitingFromScreen(''), null);
  });

  it('deriveStatus flips to waiting_input/plan_approval when the modal is in a WIDE rendered tail', function () {
    // Regression: an 8-row snapshot clipped the modal header; the status signal
    // now passes a ~20-row window so the approval header is in range.
    const s = deriveStatus({
      session: { active: true, agent: 'claude', hadOutput: true },
      renderedTail: PLAN_MODAL,
    });
    assert.equal(s.interactionState, 'waiting_input');
    assert.equal(s.awaiting.kind, 'plan_approval');
    assert.equal(s.canAcceptInput, true);
  });

  it('screen-await takes precedence even when a JSONL binding reports endsOnAssistant (idle)', function () {
    const s = deriveStatus({
      session: { active: true, agent: 'claude', hadOutput: true },
      jsonl: { bound: true, endsOnAssistant: true, growing: false },
      renderedTail: PLAN_MODAL,
    });
    assert.equal(s.interactionState, 'waiting_input');
    assert.equal(s.awaiting.kind, 'plan_approval');
  });

  it('busy-footer regex matches only the last few rows (no false-busy from stale scrollback)', function () {
    // A gerund+ellipsis high in the window (stale) with an idle composer footer
    // must NOT read as busy.
    const stale = [
      ' Pondering… (12s)',           // stale spinner line, 8 rows up
      ' some assistant output',
      ' more output',
      ' even more',
      ' and more',
      ' tail line a',
      ' tail line b',
      ' > ',                          // idle composer footer (last 6 rows, no spinner)
    ].join('\n');
    const s = deriveStatus({
      session: { active: true, agent: 'codex', hadOutput: true },
      renderedTail: stale,
    });
    assert.equal(s.interactionState, 'idle');

    // A spinner IN the last few rows still reads busy.
    const live = [' output', ' output', ' output', ' output', ' Working…', ' esc to interrupt'].join('\n');
    const b = deriveStatus({ session: { active: true, agent: 'codex', hadOutput: true }, renderedTail: live });
    assert.equal(b.interactionState, 'busy');
  });
});
