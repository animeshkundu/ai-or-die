'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotificationCapability = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function classifyNotificationCapability(options) {
    options = options || {};
    if (!options.secureContext) {
      return { state: 'insecure', supported: false, text: 'System alerts require a secure HTTPS connection.' };
    }
    if (options.permission === 'denied') {
      return { state: 'denied', supported: false, text: 'System alerts are blocked in browser settings.' };
    }
    if (!options.notificationSupported && !options.standalone) {
      return { state: 'not-installed', supported: false, text: 'System alerts are unavailable here. Install the app to check support.' };
    }
    if (!options.notificationSupported) {
      return { state: 'unsupported', supported: false, text: 'System alerts are not supported on this device. In-app activity indicators remain available.' };
    }
    return { state: 'supported', supported: true, text: '' };
  }

  return { classifyNotificationCapability };
});
