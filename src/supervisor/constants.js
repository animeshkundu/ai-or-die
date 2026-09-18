'use strict';

// Shared constants for the autoupdating supervisor.
// See docs/specs/autoupdate-service.md (planned) and docs/specs/process-shutdown.md.

const path = require('path');
const os = require('os');

const RESTART_EXIT_CODE = 75;
const NON_RETRYABLE_EXIT_CODE = 78;

const STABLE_BASE = process.env.AI_OR_DIE_HOME
  || path.join(os.homedir(), '.ai-or-die');
const STABLE_BIN = path.join(STABLE_BASE, 'bin');
const STABLE_SUPERVISOR_JS = path.join(STABLE_BIN, 'ai-or-die-supervisor.js');
const STABLE_SERVER_BIN = path.join(STABLE_BIN,
  process.platform === 'win32' ? 'ai-or-die-server.exe' : 'ai-or-die-server');
const STAGING_DIR = path.join(STABLE_BASE, 'staging');
const SERVICE_META_FILE = path.join(STABLE_BASE, 'service.json');
const FLEET_TOKEN_FILE = path.join(STABLE_BASE, 'fleet-token');
const SUPERVISOR_LOG_FILE = path.join(STABLE_BASE, 'logs', 'supervisor.log');

const GITHUB_OWNER = 'animeshkundu';
const GITHUB_REPO = 'ai-or-die';
const GITHUB_RELEASES_API =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

const HANDOFF_TIMEOUT_MS = 30000;
// Update-check defaults (hybrid model: auto-download, user applies or idle auto-apply).
const DEFAULT_UPDATE_INTERVAL_MS = 3600000;
const DEFAULT_AUTO_APPLY_IDLE_MS = 14400000;
const SERVER_READY_TIMEOUT_MS = 30000;
const SHUTDOWN_GRACE_MS = 15000;

module.exports = {
  RESTART_EXIT_CODE,
  NON_RETRYABLE_EXIT_CODE,
  STABLE_BASE,
  STABLE_BIN,
  STABLE_SUPERVISOR_JS,
  STABLE_SERVER_BIN,
  STAGING_DIR,
  SERVICE_META_FILE,
  FLEET_TOKEN_FILE,
  SUPERVISOR_LOG_FILE,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_RELEASES_API,
  HANDOFF_TIMEOUT_MS,
  SERVER_READY_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
};
