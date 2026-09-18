'use strict';

// Update routes — Settings UI "Update Ready / Apply Now" surface.
//
// Mounted by the Server (src/server.js) when a supervisor bridge is present:
//   GET  /api/update/status  -> { currentVersion, pending, idleMs, ptys }
//   POST /api/update/check   -> triggers AutoUpdater.check() via IPC
//   POST /api/update/apply   -> triggers seamless swap via IPC
//
// The Server itself never touches binaries; when running WITHOUT a
// supervisor (plain `node bin/ai-or-die.js`), these routes report
// { supervised: false } and the Apply button is hidden in the UI.

const express = require('express');

function createUpdateRouter(deps = {}) {
  const router = express.Router();
  const getSupervisor = deps.getSupervisor || (() => null);

  router.get('/status', (req, res) => {
    const supervisor = getSupervisor();
    if (!supervisor || typeof supervisor.updateStatus !== 'function') {
      return res.json({ supervised: false, updatable: false });
    }
    try {
      return res.json({ supervised: true, updatable: true, ...supervisor.updateStatus() });
    } catch (err) {
      return res.status(500).json({ error: (err && err.message) || 'status failed' });
    }
  });

  router.post('/check', async (req, res) => {
    const supervisor = getSupervisor();
    if (!supervisor || !supervisor.autoUpdater) {
      return res.status(409).json({ error: 'not supervised' });
    }
    try {
      const result = await supervisor.autoUpdater.check();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err && err.message) || 'check failed' });
    }
  });

  router.post('/apply', async (req, res) => {
    const supervisor = getSupervisor();
    if (!supervisor || typeof supervisor.applyUpdate !== 'function') {
      return res.status(409).json({ error: 'not supervised' });
    }
    try {
      const result = await supervisor.applyUpdate();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err && err.message) || 'apply failed' });
    }
  });

  return router;
}

module.exports = { createUpdateRouter };
