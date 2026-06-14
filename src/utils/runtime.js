'use strict';

// Runtime detection helpers. Values are read at call-time (not cached at module
// load) so tests can stub `process.versions` to simulate a runtime.

/**
 * True when the process is running under Bun instead of Node.js.
 * Bun sets `process.versions.bun`; Node never does.
 * @returns {boolean}
 */
function isBun() {
  return !!(process.versions && process.versions.bun);
}

module.exports = { isBun };
