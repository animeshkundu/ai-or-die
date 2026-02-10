const assert = require('assert');
const AuthManager = require('../src/utils/auth');

describe('AuthManager rate limiter', function() {
  it('should allow requests under the limit', function() {
    const auth = new AuthManager();
    const result = auth.rateLimit('test-ip', 5, 1000);
    assert.strictEqual(result, true);
    auth.destroy();
  });

  it('should block requests over the limit', function() {
    const auth = new AuthManager();
    for (let i = 0; i < 5; i++) {
      auth.rateLimit('test-ip', 5, 1000);
    }
    const result = auth.rateLimit('test-ip', 5, 1000);
    assert.strictEqual(result, false);
    auth.destroy();
  });

  it('should track separate identifiers independently', function() {
    const auth = new AuthManager();
    for (let i = 0; i < 5; i++) {
      auth.rateLimit('ip-a', 5, 1000);
    }
    // ip-a is exhausted
    assert.strictEqual(auth.rateLimit('ip-a', 5, 1000), false);
    // ip-b should still be allowed
    assert.strictEqual(auth.rateLimit('ip-b', 5, 1000), true);
    auth.destroy();
  });

  it('should delete map entries when all requests expire', function(done) {
    const auth = new AuthManager();
    auth.rateLimit('test-ip', 5, 1); // 1ms window
    setTimeout(() => {
      // After expiry, a new request should succeed and old entry should have been replaced
      const result = auth.rateLimit('test-ip', 5, 1);
      assert.strictEqual(result, true);
      auth.destroy();
      done();
    }, 20);
  });

  it('should clean up empty entries on periodic cleanup', function() {
    const auth = new AuthManager();
    auth.rateLimiter.set('stale-ip', []);
    auth.cleanupRateLimit();
    assert.strictEqual(auth.rateLimiter.has('stale-ip'), false);
    auth.destroy();
  });

  it('should clean up entries with only old timestamps', function() {
    const auth = new AuthManager();
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    auth.rateLimiter.set('old-ip', [twoHoursAgo]);
    auth.cleanupRateLimit();
    assert.strictEqual(auth.rateLimiter.has('old-ip'), false);
    auth.destroy();
  });

  it('should keep entries with recent timestamps during cleanup', function() {
    const auth = new AuthManager();
    auth.rateLimiter.set('recent-ip', [Date.now()]);
    auth.cleanupRateLimit();
    assert.strictEqual(auth.rateLimiter.has('recent-ip'), true);
    auth.destroy();
  });

  it('should clear cleanup interval on destroy', function() {
    const auth = new AuthManager();
    assert.ok(auth._rateLimitCleanupInterval);
    auth.destroy();
    assert.strictEqual(auth._rateLimitCleanupInterval, null);
  });

  it('should handle multiple destroy calls safely', function() {
    const auth = new AuthManager();
    auth.destroy();
    auth.destroy(); // should not throw
    assert.strictEqual(auth._rateLimitCleanupInterval, null);
  });
});
