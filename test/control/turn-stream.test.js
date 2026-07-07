'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TurnStream = require('../../src/control/turn-stream');

function line(obj) {
  return JSON.stringify(obj) + '\n';
}

function userText(uuid, text) {
  return { type: 'user', uuid, timestamp: `t-${uuid}`, message: { content: text } };
}

function assistantText(uuid, text) {
  return { type: 'assistant', uuid, timestamp: `t-${uuid}`, message: { content: [{ type: 'text', text }] } };
}

describe('control/turn-stream', function () {
  let dir;
  let file;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-stream-'));
    file = path.join(dir, 'session-1.jsonl');
  });

  afterEach(function () {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  it('resumes from a byte cursor and returns only newly appended items', async function () {
    fs.writeFileSync(file, [line(userText('u1', 'hello')), line(assistantText('a1', 'hi'))].join(''));

    const first = await TurnStream.readItems(file, null);
    assert.deepEqual(first.items.map((i) => i.id), ['u1', 'a1']);
    assert.equal(first.items[0].kind, 'user-text');
    assert.equal(first.items[1].kind, 'assistant-text');
    assert.ok(first.cursor.offset > 0);

    fs.appendFileSync(file, line(userText('u2', 'next')));
    const second = await TurnStream.readItems(file, first.cursor);
    assert.deepEqual(second.items.map((i) => i.id), ['u2']);
    assert.equal(second.items[0].text, 'next');
    assert.equal(second.reset, false);
    assert.equal(second.epoch, first.epoch);
  });

  it('detects compact_boundary, resets to the post-compact stream, and bumps epoch', async function () {
    fs.writeFileSync(file, line(userText('u1', 'before compact')));
    const before = await TurnStream.readItems(file, null);
    assert.equal(before.reset, false);
    assert.deepEqual(before.items.map((i) => i.id), ['u1']);

    fs.appendFileSync(file, [
      line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { kept: 1 } }),
      line({ type: 'user', uuid: 'summary-1', message: { content: [{ type: 'text', text: 'summary continuation' }] } }),
    ].join(''));

    const after = await TurnStream.readItems(file, before.cursor);
    assert.equal(after.reset, true);
    assert.notEqual(after.epoch, before.epoch);
    assert.match(after.epoch, /:compact:/);
    assert.deepEqual(after.items.map((i) => i.id), ['summary-1']);
    assert.equal(after.items[0].text, 'summary continuation');
    assert.equal(after.cursor.epoch, after.epoch);
  });

  it('does not emit or advance past a trailing partial line until it is complete', async function () {
    const complete = line(userText('u1', 'complete'));
    fs.writeFileSync(file, complete + '{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text"');

    const first = await TurnStream.readItems(file, null);
    assert.deepEqual(first.items.map((i) => i.id), ['u1']);
    assert.equal(first.cursor.offset, Buffer.byteLength(complete));

    fs.appendFileSync(file, ',"text":"now complete"}]}}\n');
    const second = await TurnStream.readItems(file, first.cursor);
    assert.deepEqual(second.items.map((i) => i.id), ['a1']);
    assert.equal(second.items[0].kind, 'assistant-text');
    assert.equal(second.items[0].text, 'now complete');
  });

  it('maps tool calls, tool results, thinking, and text with stable ids and preserved payloads', async function () {
    fs.writeFileSync(file, [
      line({
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId: 'claude-session',
        cwd: '/work',
        timestamp: '2026-07-07T00:00:00.000Z',
        message: { content: [
          { type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'npm test', timeout: 120000 } },
          { type: 'text', text: 'I will run the tests.' },
          { type: 'thinking', thinking: 'Need to verify behavior.', signature: 'sig-1' },
        ] },
      }),
      line({
        type: 'user',
        uuid: 'result-1',
        message: { content: [
          { type: 'tool_result', tool_use_id: 'toolu-1', content: { stdout: 'ok', code: 0 }, is_error: true },
        ] },
        toolUseResult: { stdout: 'ok', code: 0 },
      }),
      line({ type: 'assistant', uuid: 'sidechain-1', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
    ].join(''));

    const out = await TurnStream.readItems(file, null);
    assert.deepEqual(out.items.map((i) => i.kind), ['tool-call', 'assistant-text', 'thinking', 'tool-result']);
    assert.equal(new Set(out.items.map((i) => i.id)).size, out.items.length, 'ids are unique per semantic item');
    assert.deepEqual(out.items.map((i) => i.id), [
      'assistant-1:tool-call:toolu-1:0',
      'assistant-1:assistant-text:1',
      'assistant-1:thinking:2',
      'result-1',
    ]);

    const call = out.items[0];
    assert.equal(call.toolUseId, 'toolu-1');
    assert.equal(call.name, 'Bash');
    assert.deepEqual(call.input, { command: 'npm test', timeout: 120000 });
    assert.equal(call.parentUuid, 'user-1');
    assert.equal(call.sessionId, 'claude-session');
    assert.equal(call.cwd, '/work');

    const thinking = out.items[2];
    assert.equal(thinking.thinking, 'Need to verify behavior.');
    assert.equal(thinking.signature, 'sig-1');

    const result = out.items[3];
    assert.equal(result.toolUseId, 'toolu-1');
    assert.deepEqual(result.content, { stdout: 'ok', code: 0 });
    assert.equal(result.isError, true);
    assert.deepEqual(result.toolUseResult, { stdout: 'ok', code: 0 });
  });

  it('does not forward-skip after a large offline gap', async function () {
    const count = 300;
    const big = 'x'.repeat(3000);
    const lines = [];
    for (let i = 0; i < count; i++) lines.push(line(userText(`u-${i}`, `${i}:${big}`)));
    fs.writeFileSync(file, lines.join(''));
    assert.ok(fs.statSync(file).size > 512 * 1024, 'fixture exceeds the old sticky-note tail window');

    const epoch = TurnStream.fileEpoch(file, fs.statSync(file));
    const out = await TurnStream.readItems(file, { epoch, offset: 0 }, { limit: count + 10 });
    assert.equal(out.items.length, count);
    assert.equal(out.items[0].id, 'u-0');
    assert.equal(out.items[count - 1].id, `u-${count - 1}`);
    assert.equal(out.more, false);
  });

  it('skips agent-*.jsonl subagent transcript files', async function () {
    const agentFile = path.join(dir, 'agent-subtask.jsonl');
    fs.writeFileSync(agentFile, line(userText('u1', 'from subagent')));
    const out = await TurnStream.readItems(agentFile, null);
    assert.deepEqual(out.items, []);
  });

  it('bounds each read window, reports more, and returns a resumable cursor', async function () {
    const maxBytes = 32 * 1024;
    const count = 1000;
    const lines = [];
    for (let i = 0; i < count; i++) lines.push(line(userText(`u-${i}`, `${i}:${'x'.repeat(200)}`)));
    fs.writeFileSync(file, lines.join(''));
    assert.ok(fs.statSync(file).size > maxBytes * 4, 'fixture is much larger than the read window');

    const first = await TurnStream.readItems(file, null, { limit: count, maxBytes });
    assert.ok(first.items.length > 0, 'returns bounded items from complete lines');
    assert.equal(first.more, true);
    assert.ok(first.cursor.offset > 0, 'cursor advances');
    assert.ok(first.cursor.offset <= maxBytes, 'cursor advances no farther than the configured window');

    const lastFirst = Number(first.items[first.items.length - 1].id.slice(2));
    const second = await TurnStream.readItems(file, first.cursor, { limit: count, maxBytes });
    assert.equal(second.reset, false);
    assert.ok(second.items.length > 0, 'cursor can be resumed');
    assert.equal(second.items[0].id, `u-${lastFirst + 1}`);
    assert.ok(second.cursor.offset > first.cursor.offset);
    assert.ok(second.cursor.offset - first.cursor.offset <= maxBytes, 'resumed read also stays within the window');
  });

  it('skips an oversized JSONL line without parsing or emitting a giant item', async function () {
    this.timeout(10000);
    const oversized = line(userText('huge', 'x'.repeat(5 * 1024 * 1024)));
    fs.writeFileSync(file, oversized);

    const out = await TurnStream.readItems(file, null);
    assert.deepEqual(out.items, []);
    assert.equal(out.cursor.offset, Buffer.byteLength(oversized));
    assert.equal(out.more, false);
  });

  it('does not spin on an oversized unterminated trailing line', async function () {
    const partial = JSON.stringify(userText('huge-partial', 'x'.repeat(128 * 1024)));
    fs.writeFileSync(file, partial);

    const first = await TurnStream.readItems(file, null, { maxBytes: 32 * 1024, maxLineBytes: 8 * 1024 });
    assert.deepEqual(first.items, []);
    assert.equal(first.cursor.offset, 0);
    assert.equal(first.more, false);

    fs.appendFileSync(file, '\n');
    const second = await TurnStream.readItems(file, first.cursor, { maxBytes: 32 * 1024, maxLineBytes: 8 * 1024 });
    assert.deepEqual(second.items, []);
    assert.equal(second.cursor.offset, Buffer.byteLength(partial) + 1);
    assert.equal(second.more, false);
  });

  it('detects a stale cursor after a same-inode in-place rewrite and rereads from zero', async function () {
    const firstLine = line(userText('u1', 'before rewrite'));
    fs.writeFileSync(file, firstLine + line(userText('u2', 'second')));
    const first = await TurnStream.readItems(file, null, { limit: 1 });
    assert.equal(first.cursor.offset, Buffer.byteLength(firstLine));

    const beforeStat = fs.statSync(file);
    const rewritten = line(userText('n1', 'reshaped '.repeat(100))) + line(userText('n2', 'after rewrite'));
    const fd = fs.openSync(file, 'r+');
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, rewritten, 0, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    const afterStat = fs.statSync(file);
    assert.equal(afterStat.ino, beforeStat.ino, 'fixture rewrites the same inode');
    assert.notEqual(fs.readFileSync(file)[first.cursor.offset - 1], 0x0a, 'old cursor now points into a line');

    const out = await TurnStream.readItems(file, first.cursor);
    assert.equal(out.reset, true);
    assert.deepEqual(out.items.map((i) => i.id), ['n1', 'n2']);
    assert.equal(out.cursor.offset, Buffer.byteLength(rewritten));
  });

  it('treats forged giant epochs as mismatches and never uses them in emitted ids', async function () {
    fs.writeFileSync(file, line({ type: 'user', message: { content: 'no uuid fallback' } }));
    const forged = `deadbeefdeadbeef:compact:${'x'.repeat(1024 * 1024)}`;

    const out = await TurnStream.readItems(file, { epoch: forged, offset: 0 });
    assert.equal(out.reset, true);
    assert.match(out.epoch, /^[0-9a-f]{16}$/);
    assert.equal(out.cursor.epoch, out.epoch);
    assert.equal(out.items.length, 1);
    assert.ok(out.items[0].id.length <= 200);
    assert.ok(!out.items[0].id.includes('deadbeefdeadbeef:compact:'));
  });

  it('floors non-positive limits so reads make progress instead of spinning', async function () {
    fs.writeFileSync(file, line(userText('u1', 'one')) + line(userText('u2', 'two')));

    const zero = await TurnStream.readItems(file, null, { limit: 0 });
    assert.deepEqual(zero.items.map((i) => i.id), ['u1']);
    assert.equal(zero.more, true);
    assert.ok(zero.cursor.offset > 0);

    const negative = await TurnStream.readItems(file, null, { limit: -5 });
    assert.deepEqual(negative.items.map((i) => i.id), ['u1']);
    assert.equal(negative.more, true);
    assert.ok(negative.cursor.offset > 0);
  });

  it('sanitizes and caps uuid-derived ids', async function () {
    const longUuid = 'a'.repeat(10 * 1024);
    fs.writeFileSync(file, line(userText('__proto__', 'reserved key')) + line(userText(longUuid, 'long id')));

    const out = await TurnStream.readItems(file, null);
    assert.equal(typeof out.items[0].id, 'string');
    assert.equal(out.items[0].id, 'id-__proto__');
    assert.ok(out.items[0].id.length <= 200);
    assert.equal(typeof out.items[1].id, 'string');
    assert.ok(out.items[1].id.length <= 200);
    assert.equal(out.items[1].id, 'a'.repeat(80));
  });
});
