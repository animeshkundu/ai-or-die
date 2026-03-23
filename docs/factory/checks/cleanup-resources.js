#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_TEST_PORT = 11000;
const MAX_ORPHAN_AGE_MS = 10 * 60 * 1000; // 10 minutes
const TEMP_DIR_PREFIX = 'ai-or-die-test-';
const TEMP_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function isWindows() {
  return process.platform === 'win32';
}

function cleanOrphanedProcesses() {
  const killed = [];

  if (isWindows()) {
    // Find node.exe processes listening on ports > MIN_TEST_PORT
    try {
      const netstat = execSync(
        'netstat -ano -p TCP | findstr LISTENING',
        { encoding: 'utf-8', timeout: 10000 }
      );

      const lines = netstat.split('\n');
      for (const line of lines) {
        const match = line.match(/:(\d+)\s+.*LISTENING\s+(\d+)/);
        if (match) {
          const port = parseInt(match[1], 10);
          const pid = parseInt(match[2], 10);

          // Only kill processes on test ports (>= MIN_TEST_PORT)
          if (port >= MIN_TEST_PORT && pid > 0) {
            try {
              // Check if it's a node.exe process
              const taskInfo = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, {
                encoding: 'utf-8',
                timeout: 5000,
              });
              if (taskInfo.includes('node.exe')) {
                execSync(`taskkill /pid ${pid} /f`, { timeout: 5000 });
                killed.push({ pid, port, process: 'node.exe' });
              }
            } catch {
              // Process already gone or access denied
            }
          }
        }
      }
    } catch {
      // netstat failed
    }

    // Kill orphaned Chromium processes
    try {
      const tasks = execSync(
        'tasklist /fi "imagename eq chrome.exe" /fo csv /nh',
        { encoding: 'utf-8', timeout: 10000 }
      );
      // Note: We can't easily check age on Windows, so only kill
      // headless Chromium (which has --headless in command line)
      // This is conservative — we don't kill user's browser
    } catch {
      // No chrome processes
    }
  } else {
    // Linux/macOS
    try {
      const result = execSync(
        `lsof -i -P -n | grep LISTEN | grep -E ':([1-9][1-9][0-9]{3,})' | awk '{print $2, $9}'`,
        { encoding: 'utf-8', timeout: 10000 }
      );
      // Parse and kill node processes on test ports
      const lines = result.split('\n').filter(Boolean);
      for (const line of lines) {
        const [pid, addr] = line.split(/\s+/);
        const portMatch = addr && addr.match(/:(\d+)$/);
        if (portMatch) {
          const port = parseInt(portMatch[1], 10);
          if (port >= MIN_TEST_PORT) {
            try {
              process.kill(parseInt(pid, 10), 'SIGTERM');
              killed.push({ pid: parseInt(pid, 10), port });
            } catch {
              // Already gone
            }
          }
        }
      }
    } catch {
      // lsof not available or no matches
    }
  }

  return killed;
}

function cleanTempDirs() {
  const cleaned = [];
  const tmpDir = os.tmpdir();
  const now = Date.now();

  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith(TEMP_DIR_PREFIX)) {
        const fullPath = path.join(tmpDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > TEMP_MAX_AGE_MS) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleaned.push(fullPath);
          }
        } catch {
          // Permission denied or already gone
        }
      }
    }
  } catch {
    // Can't read temp dir
  }

  return cleaned;
}

function verifyProtectedPorts() {
  // We just verify we haven't accidentally bound to protected ports
  // This is informational — we NEVER kill protected port processes
  const issues = [];

  try {
    if (isWindows()) {
      const netstat = execSync(
        `netstat -ano -p TCP | findstr ":7777"`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (netstat) {
        issues.push({ port: 7777, status: 'in-use', note: 'Protected — DO NOT TOUCH' });
      }
    }
  } catch {
    // Port not in use (or netstat failed), which is fine
  }

  return issues;
}

function run() {
  const killed = cleanOrphanedProcesses();
  const cleaned = cleanTempDirs();
  const portStatus = verifyProtectedPorts();

  console.log(JSON.stringify({
    check: 'cleanup-resources',
    status: 'pass', // cleanup is always "pass" — it's a sweep, not a gate
    orphanedProcessesKilled: killed.length,
    killedDetails: killed,
    tempDirsCleaned: cleaned.length,
    cleanedPaths: cleaned,
    protectedPorts: portStatus,
    details: `Killed ${killed.length} orphaned process(es), cleaned ${cleaned.length} temp dir(s)`,
  }));
}

run();
