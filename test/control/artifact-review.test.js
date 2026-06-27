'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ArtifactReviewStore } = require('../../src/artifact-review');

describe('ArtifactReviewStore', function () {
  let tmpDir;
  let file;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-review-store-'));
    file = path.join(tmpDir, 'artifact.html');
    fs.writeFileSync(file, '<html></html>');
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('open creates a review keyed by session id with a realpath-derived asset key', function () {
    const store = new ArtifactReviewStore();
    const review = store.open('s1', file);
    const expectedKey = crypto
      .createHash('sha256')
      .update(fs.realpathSync(file))
      .digest('hex')
      .slice(0, 16);

    assert.equal(review.aiSessionId, 's1');
    assert.equal(review.file, fs.realpathSync(file));
    assert.equal(review.key, expectedKey);
    assert.equal(review.status, 'open');
    assert.deepEqual(review.queuedPrompts, []);
    assert.deepEqual(review.layoutWarnings, []);
    assert.deepEqual(store.get('s1'), review);
  });

  it('queuePrompts and takeFeedback are destructive for prompts and warnings', function () {
    const store = new ArtifactReviewStore();
    store.open('s1', file);
    store.queuePrompts('s1', ['first', 'second'], { bodyText: 'snapshot' });
    store.recordLayoutWarnings('s1', [{ selector: '#root', warning: 'overflow' }]);

    const first = store.takeFeedback('s1');
    assert.deepEqual(first, {
      prompts: ['first', 'second'],
      layout_warnings: [{ selector: '#root', warning: 'overflow' }],
      dom_snapshot: { bodyText: 'snapshot' },
    });

    const second = store.takeFeedback('s1');
    assert.deepEqual(second, {
      prompts: [],
      layout_warnings: [],
      dom_snapshot: { bodyText: 'snapshot' },
    });
  });

  it('addAgentReply and end emit events', function () {
    const store = new ArtifactReviewStore();
    store.open('s1', file);

    const events = [];
    store.on('agent-reply', (evt) => events.push(['agent-reply', evt.aiSessionId, evt.text]));
    store.on('ended', (evt) => events.push(['ended', evt.aiSessionId, evt.review.status]));

    const reply = store.addAgentReply('s1', 'Looks good.');
    const ended = store.end('s1');

    assert.equal(reply.text, 'Looks good.');
    assert.equal(ended.status, 'ended');
    assert.deepEqual(events, [
      ['agent-reply', 's1', 'Looks good.'],
      ['ended', 's1', 'ended'],
    ]);
  });

  it('recordLayoutWarnings emits feedback only for non-empty changed warning sets', function () {
    const store = new ArtifactReviewStore();
    store.open('s1', file);
    let feedbackCount = 0;
    store.on('feedback', () => feedbackCount++);

    store.recordLayoutWarnings('s1', []);
    store.recordLayoutWarnings('s1', [{ warning: 'too wide' }]);
    store.recordLayoutWarnings('s1', [{ warning: 'too wide' }]);
    store.recordLayoutWarnings('s1', []);

    assert.equal(feedbackCount, 1);
  });
});
