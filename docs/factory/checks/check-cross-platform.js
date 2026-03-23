#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const REPO_ROOT = process.env.FACTORY_REPO_ROOT || process.cwd();

const PATTERNS = [
  {
    name: 'hardcoded-home-dir',
    regex: 'process\\.env\\.HOME(?!DIR)',
    description: 'process.env.HOME without USERPROFILE fallback (use os.homedir())',
    exclude: 'node_modules',
  },
  {
    name: 'hardcoded-forward-slash-path',
    regex: "'/[a-z]+/[a-z]+'",
    description: 'Hardcoded Unix path — use path.join()',
    include: 'src/',
    exclude: 'node_modules|public/vendor',
  },
  {
    name: 'which-without-where',
    regex: "\\bwhich\\b.*(?!where)",
    description: 'Unix `which` without Windows `where` alternative',
    include: 'src/',
    exclude: 'node_modules',
  },
  {
    name: 'exact-newline-comparison',
    regex: "===\\s*['\"]\\\\n['\"]",
    description: 'Exact newline comparison — use .includes() or .trim() for cross-platform',
    include: 'src/',
    exclude: 'node_modules',
  },
];

function run() {
  const findings = [];

  for (const p of PATTERNS) {
    try {
      let cmd = `git diff --cached --unified=0 -S "${p.regex}" -- "*.js"`;
      const output = execSync(cmd, {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 30000,
      }).trim();

      if (output) {
        findings.push({
          pattern: p.name,
          description: p.description,
          match: output.slice(0, 300),
        });
      }
    } catch {
      // No matches — expected
    }
  }

  console.log(JSON.stringify({
    check: 'cross-platform',
    status: findings.length === 0 ? 'pass' : 'fail',
    findings,
    details: findings.length === 0
      ? 'No cross-platform issues found in staged changes'
      : `Found ${findings.length} potential cross-platform issue(s)`,
  }));
}

run();
