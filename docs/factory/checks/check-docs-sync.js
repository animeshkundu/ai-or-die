#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.FACTORY_REPO_ROOT || process.cwd();

// Map source files to their specs
const SOURCE_TO_SPEC = {
  'src/server.js': 'docs/specs/server.md',
  'src/base-bridge.js': 'docs/specs/bridges.md',
  'src/claude-bridge.js': 'docs/specs/bridges.md',
  'src/copilot-bridge.js': 'docs/specs/bridges.md',
  'src/gemini-bridge.js': 'docs/specs/bridges.md',
  'src/codex-bridge.js': 'docs/specs/bridges.md',
  'src/public/app.js': 'docs/specs/client-app.md',
  'src/public/session-manager.js': 'docs/specs/session-store.md',
  'src/public/plan-detector.js': 'docs/specs/plan-viewer.md',
  'src/public/file-browser.js': 'docs/specs/file-browser.md',
  'src/public/voice-handler.js': 'docs/specs/voice-input.md',
  'src/public/feedback-manager.js': 'docs/specs/notifications.md',
  'src/public/input-overlay.js': 'docs/specs/input-overlay.md',
  'src/install-advisor.js': 'docs/specs/install-advisor.md',
  'src/vscode-tunnel.js': 'docs/specs/vscode-tunnel.md',
  'src/stt-engine.js': 'docs/specs/voice-input.md',
  'src/usage-analytics.js': 'docs/specs/usage-analytics.md',
};

function run() {
  try {
    // Get staged source files
    const staged = execSync('git diff --cached --name-only -- "src/**/*.js"', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim().split('\n').filter(Boolean);

    if (staged.length === 0) {
      console.log(JSON.stringify({
        check: 'docs-sync',
        status: 'pass',
        details: 'No source files staged',
      }));
      return;
    }

    // Check which staged source files have specs
    const missingSpecUpdates = [];
    const stagedAll = execSync('git diff --cached --name-only', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim().split('\n').filter(Boolean);

    for (const srcFile of staged) {
      const specFile = SOURCE_TO_SPEC[srcFile];
      if (specFile && !stagedAll.includes(specFile)) {
        // Source changed but spec not staged — check if spec exists
        const specPath = path.join(REPO_ROOT, specFile);
        if (fs.existsSync(specPath)) {
          missingSpecUpdates.push({ source: srcFile, spec: specFile });
        }
      }
    }

    console.log(JSON.stringify({
      check: 'docs-sync',
      status: missingSpecUpdates.length === 0 ? 'pass' : 'fail',
      stagedSourceFiles: staged.length,
      missingSpecUpdates,
      details: missingSpecUpdates.length === 0
        ? `${staged.length} source files staged, all specs in sync`
        : `${missingSpecUpdates.length} source file(s) changed without spec update`,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      check: 'docs-sync',
      status: 'error',
      details: err.message,
    }));
  }
}

run();
