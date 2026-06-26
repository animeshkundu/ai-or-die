'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectAwaiting } = require('../../src/control/jsonl-awaiting');

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
