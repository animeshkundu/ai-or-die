'use strict';

const assert = require('assert');
const {
  buildPrompt,
  parseNote,
  deriveTitle,
  sanitizeText,
  NOTE_SCHEMA,
  MAX_DONE,
  MAX_REMAINING,
  TITLE_MAX,
} = require('../src/sticky-note-prompt');

describe('sticky-note prompt + parse (v2: goal/done/remaining/update)', function () {
  describe('sanitizeText', function () {
    it('strips bidi-override and control chars but keeps normal text', function () {
      const bidi = String.fromCharCode(0x202e);
      const bel = String.fromCharCode(0x07);
      assert.strictEqual(sanitizeText(`ab${bidi}cd${bel}ef`, 100), 'abcdef');
      assert.strictEqual(sanitizeText('Fix auth redirect', 100), 'Fix auth redirect');
    });

    it('collapses newlines/tabs to single spaces', function () {
      assert.strictEqual(sanitizeText('line1\nline2\tend', 100), 'line1 line2 end');
    });

    it('clamps to maxLen', function () {
      assert.strictEqual(sanitizeText('x'.repeat(60), TITLE_MAX).length, TITLE_MAX);
    });

    it('handles non-strings', function () {
      assert.strictEqual(sanitizeText(null, 10), '');
      assert.strictEqual(sanitizeText(42, 10), '');
    });
  });

  describe('parseNote', function () {
    it('parses valid JSON and clamps array sizes', function () {
      const n = parseNote(
        JSON.stringify({
          goal: 'make login work',
          done: ['a', 'b', 'c', 'd', 'e', 'f'],
          remaining: ['x', 'y', 'z', 'w', 'u', 'v'],
          update: 'fixed the redirect',
        })
      );
      assert.ok(n);
      assert.strictEqual(n.goal, 'make login work');
      assert.strictEqual(n.done.length, MAX_DONE);
      assert.strictEqual(n.remaining.length, MAX_REMAINING);
      assert.strictEqual(n.update, 'fixed the redirect');
    });

    it('accepts a pre-parsed object', function () {
      const n = parseNote({ goal: 'g', done: [], remaining: [], update: 'did a thing' });
      assert.strictEqual(n.goal, 'g');
      assert.strictEqual(n.update, 'did a thing');
    });

    it('recovers JSON embedded in prose', function () {
      const n = parseNote('Sure! {"goal":"g","done":[],"remaining":[],"update":"u"} hope that helps');
      assert.ok(n);
      assert.strictEqual(n.goal, 'g');
      assert.strictEqual(n.update, 'u');
    });

    it('returns null for unparseable / empty output', function () {
      assert.strictEqual(parseNote('not json at all'), null);
      assert.strictEqual(parseNote(''), null);
      assert.strictEqual(parseNote('{}'), null);
      assert.strictEqual(parseNote('{"goal":"","done":[],"remaining":[],"update":""}'), null);
    });

    it('a single non-empty field is enough (e.g. only an update)', function () {
      const n = parseNote('{"goal":"","done":[],"remaining":[],"update":"ran tests"}');
      assert.ok(n);
      assert.strictEqual(n.update, 'ran tests');
    });

    it('sanitises malicious content (no markup / control, length-clamped)', function () {
      const n = parseNote(
        JSON.stringify({ goal: '<img src=x onerror=alert(1)>', done: [], remaining: [], update: 'u' })
      );
      assert.ok(n);
      assert.ok(n.goal.length <= 140);
    });

    it('drops empty bullets', function () {
      const n = parseNote(JSON.stringify({ goal: 'g', done: ['real', '', '   '], remaining: [], update: '' }));
      assert.deepStrictEqual(n.done, ['real']);
    });
  });

  describe('deriveTitle', function () {
    it('takes the first few words of the goal, clamped', function () {
      assert.strictEqual(deriveTitle('Fix the auth redirect bug in the login flow'), 'Fix the auth redirect bug');
      assert.strictEqual(deriveTitle(''), '');
      assert.ok(deriveTitle('x'.repeat(80)).length <= TITLE_MAX);
    });
  });

  describe('buildPrompt', function () {
    it('includes the previous state and the new turns', function () {
      const p = buildPrompt({ goal: 'pg', done: ['x'], remaining: [] }, 'User: do thing\nAssistant: done');
      assert.ok(p.includes('pg'));
      assert.ok(p.includes('do thing'));
      assert.ok(p.includes('JSON only'));
    });

    it('migrates a legacy prev note (progress/waitingOn) into done/remaining context', function () {
      const p = buildPrompt({ goal: 'g', progress: ['didA'], waitingOn: ['needB'] }, 'text');
      assert.ok(p.includes('didA'));
      assert.ok(p.includes('needB'));
    });

    it('handles no previous note and empty text', function () {
      const p = buildPrompt(null, '');
      assert.ok(p.includes('(none yet)'));
      assert.ok(p.includes('(no content captured)'));
    });
  });

  describe('NOTE_SCHEMA', function () {
    it('declares the four required fields', function () {
      assert.deepStrictEqual(NOTE_SCHEMA.required, ['goal', 'done', 'remaining', 'update']);
    });
  });
});
