'use strict';

const assert = require('assert');
const { classifyNotificationCapability } = require('../src/public/notification-capability');
const { SessionTabManager } = require('../src/public/session-manager');

describe('notification capability', function () {
  it('distinguishes insecure, not-installed, unsupported and denied states', function () {
    assert.strictEqual(classifyNotificationCapability({}).state, 'insecure');
    assert.strictEqual(classifyNotificationCapability({ secureContext: true }).state, 'not-installed');
    assert.strictEqual(classifyNotificationCapability({ secureContext: true, standalone: true }).state, 'unsupported');
    assert.strictEqual(classifyNotificationCapability({
      secureContext: true, notificationSupported: true, permission: 'denied'
    }).state, 'denied');
  });

  it('enables the live control only when the API is available', function () {
    assert.deepStrictEqual(
      classifyNotificationCapability({ secureContext: true, notificationSupported: true, permission: 'default' }),
      { state: 'supported', supported: true, text: '' }
    );
  });

  it('requests permission only after an explicit action', function () {
    const originalWindow = global.window;
    const originalNotification = global.Notification;
    let requests = 0;
    let refreshes = 0;
    const Notification = {
      permission: 'default',
      requestPermission(callback) {
        requests++;
        callback('granted');
      },
    };
    global.window = { Notification };
    global.Notification = Notification;
    try {
      const manager = new SessionTabManager({
        _setupNotificationCapability() { refreshes++; },
      });
      assert.strictEqual(requests, 0, 'constructor must not prompt');
      manager.requestNotificationPermission();
      assert.strictEqual(requests, 1);
      assert.strictEqual(manager.notificationsEnabled, true);
      assert.strictEqual(refreshes, 1);
    } finally {
      global.window = originalWindow;
      global.Notification = originalNotification;
    }
  });
});
