'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../src/sticky-note-jsonl');

// All fixtures are synthetic — we never read the operator's real ~/.claude transcripts.
function line(o) {
  return JSON.stringify(o) + '\n';
}

describe('sticky-note JSONL reader', function () {
  let dir, projects, projDir, file;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snj-'));
    projects = path.join(dir, 'projects');
    projDir = path.join(projects, J.slugForCwd('/Users/x/proj'));
    fs.mkdirSync(projDir, { recursive: true });
    file = path.join(projDir, 'sess.jsonl');
  });
  afterEach(function () {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  it('slugForCwd replaces path separators with dashes', function () {
    assert.strictEqual(J.slugForCwd('/Users/x/proj'), '-Users-x-proj');
  });

  it('findActiveSession returns the newest .jsonl; null when no project dir', async function () {
    const a = path.join(projDir, 'a.jsonl');
    const b = path.join(projDir, 'b.jsonl');
    fs.writeFileSync(a, line({ type: 'user' }));
    fs.writeFileSync(b, line({ type: 'user' }));
    const t = Date.now() / 1000;
    fs.utimesSync(a, t - 100, t - 100); // make a older
    const r = await J.findActiveSession('/Users/x/proj', { projectsDir: projects });
    assert.strictEqual(r.file, b, 'newest by mtime');
    assert.strictEqual(await J.findActiveSession('/no/such/cwd', { projectsDir: projects }), null);
  });

  it('extracts user/assistant text + tool names; skips thinking/tool_result/sidechain/metadata; strips injected blocks; captures ai-title', async function () {
    fs.writeFileSync(file, [
      line({ type: 'user', message: { role: 'user', content: 'fix the bug' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'text', text: 'on it' },
        { type: 'tool_use', name: 'Edit' },
      ] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }), // skipped
      line({ type: 'user', message: { role: 'user', content: '<task-notification>noise</task-notification>real ask' } }),
      line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }), // skipped
      line({ type: 'ai-title', aiTitle: 'Bug Fix' }),
      line({ type: 'queue-operation' }), // skipped metadata
    ].join(''));

    const { turns, aiTitle, offset } = await J.readNewTurns(file, 0);
    assert.strictEqual(aiTitle, 'Bug Fix');
    assert.deepStrictEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']);
    assert.strictEqual(turns[0].text, 'fix the bug');
    assert.strictEqual(turns[1].text, 'on it');
    assert.deepStrictEqual(turns[1].toolNames, ['Edit']);
    assert.strictEqual(turns[2].text, 'real ask', 'injected block stripped');
    assert.ok(offset > 0);
  });

  it('never advances past an incomplete trailing line', async function () {
    const complete = line({ type: 'user', message: { role: 'user', content: 'one' } });
    fs.writeFileSync(file, complete + '{"type":"user","message":{"role":"user"'); // partial line
    const r1 = await J.readNewTurns(file, 0);
    assert.strictEqual(r1.turns.length, 1, 'only the complete line is parsed');
    assert.strictEqual(r1.offset, Buffer.byteLength(complete), 'offset stops at the last newline');

    fs.appendFileSync(file, ',"content":"two"}}\n'); // complete the partial line
    const r2 = await J.readNewTurns(file, r1.offset);
    assert.strictEqual(r2.turns.length, 1);
    assert.strictEqual(r2.turns[0].text, 'two');
  });

  it('formatTurns + endsOnAssistant', function () {
    const turns = [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a', toolNames: ['Bash'] }];
    assert.strictEqual(J.formatTurns(turns), 'User: q\nAssistant: a [ran: Bash]');
    assert.strictEqual(J.endsOnAssistant(turns), true);
    assert.strictEqual(J.endsOnAssistant([{ role: 'assistant', text: 'a' }, { role: 'user', text: 'q' }]), false);
  });
});
