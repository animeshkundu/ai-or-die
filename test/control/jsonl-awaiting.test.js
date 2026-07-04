'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectAwaiting, detectTurnState } = require('../../src/control/jsonl-awaiting');

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiod-jsonl-awaiting-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

describe('control/jsonl-awaiting detectAwaiting', function () {
  it('detects pending ExitPlanMode and extracts the plan prompt', async function () {
    const file = tmpFile(line({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'ExitPlanMode', input: { plan: 'Step 1\nStep 2' } }],
      },
    }));

    const awaiting = await detectAwaiting(file);
    assert.equal(awaiting.pendingUserFacingTool, 'ExitPlanMode');
    assert.equal(awaiting.awaitingPrompt, 'Step 1 Step 2');
  });

  it('detects pending AskUserQuestion and extracts prompt/options', async function () {
    const file = tmpFile(line({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_2',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Choose a path',
              options: [
                { label: 'Fast', value: 'fast' },
                { label: 'Safe', value: 'safe' },
              ],
            }],
          },
        }],
      },
    }));

    const awaiting = await detectAwaiting(file);
    assert.equal(awaiting.pendingUserFacingTool, 'AskUserQuestion');
    assert.equal(awaiting.awaitingPrompt, 'Choose a path');
    assert.deepEqual(awaiting.awaitingOptions, [
      { label: 'Fast', value: 'fast' },
      { label: 'Safe', value: 'safe' },
    ]);
  });

  it('returns null when ExitPlanMode has a matching tool_result', async function () {
    const file = tmpFile(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_3', name: 'ExitPlanMode', input: { plan: 'Plan' } }],
        },
      }) +
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'approved' }] },
      })
    );

    assert.equal(await detectAwaiting(file), null);
  });

  it('returns null for a normal assistant text turn', async function () {
    const file = tmpFile(line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Done.' }] },
    }));

    assert.equal(await detectAwaiting(file), null);
  });
});

describe('control/jsonl-awaiting detectTurnState (artifact idle gate)', function () {
  it('awaiting_input when a user-facing tool is pending (never push free text)', async function () {
    const file = tmpFile(line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'ExitPlanMode', input: { plan: 'P' } }] },
    }));
    const turn = await detectTurnState(file);
    assert.equal(turn.state, 'awaiting_input');
    assert.equal(turn.pendingUserFacingTool, 'ExitPlanMode');
  });

  it('idle_at_prompt when the last assistant turn is a completed text turn', async function () {
    const file = tmpFile(line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'All done.' }] },
    }));
    assert.equal((await detectTurnState(file)).state, 'idle_at_prompt');
  });

  it('working when the last assistant has an unresolved (non-user-facing) tool_use', async function () {
    const file = tmpFile(line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'ls' } }] },
    }));
    assert.equal((await detectTurnState(file)).state, 'working');
  });

  it('working when a trailing tool_result is queued for the agent to continue', async function () {
    const file = tmpFile(
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_c', name: 'Bash', input: {} }] } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_c', content: 'ok' }] } })
    );
    assert.equal((await detectTurnState(file)).state, 'working');
  });

  it('idle_at_prompt after a tool_use is resolved AND the assistant speaks again', async function () {
    const file = tmpFile(
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_d', name: 'Bash', input: {} }] } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_d', content: 'ok' }] } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Finished.' }] } })
    );
    assert.equal((await detectTurnState(file)).state, 'idle_at_prompt');
  });

  it('unknown for a missing/unreadable binding (caller falls back to PTY-quiet)', async function () {
    assert.equal((await detectTurnState('/no/such/file.jsonl')).state, 'unknown');
  });
});
