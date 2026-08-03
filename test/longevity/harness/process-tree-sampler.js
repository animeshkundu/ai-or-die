'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

function execFileText(command, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
  });
}

function descendants(rows, rootPid) {
  const wanted = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (wanted.has(row.ppid) && !wanted.has(row.pid)) {
        wanted.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => wanted.has(row.pid));
}

function parseLinuxStatus(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const readKb = (name) => {
      const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
      return match ? Number(match[1]) * 1024 : null;
    };
    const name = /^Name:\s+(.+)$/m.exec(text);
    const ppid = /^PPid:\s+(\d+)$/m.exec(text);
    let fdCount = null;
    try { fdCount = fs.readdirSync(`/proc/${pid}/fd`).length; } catch (_) {}
    return {
      pid: Number(pid),
      ppid: ppid ? Number(ppid[1]) : null,
      name: name ? name[1].trim() : null,
      rss_bytes: readKb('VmRSS'),
      private_bytes: readKb('RssAnon'),
      virtual_bytes: readKb('VmSize'),
      handle_count: fdCount,
    };
  } catch (_) {
    return null;
  }
}

function sampleLinux(rootPid) {
  const rows = fs.readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(parseLinuxStatus)
    .filter(Boolean);
  return descendants(rows, rootPid);
}

async function sampleWindows(rootPid) {
  const script = [
    '$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name',
    '$procs = @{}',
    'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $procs[[int]$_.Id] = $_ }',
    '$rows | ForEach-Object {',
    '  $p = $procs[[int]$_.ProcessId]',
    '  [pscustomobject]@{',
    '    pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=$_.Name;',
    '    rss_bytes=$(if($p){[long]$p.WorkingSet64}else{$null});',
    '    private_bytes=$(if($p){[long]$p.PrivateMemorySize64}else{$null});',
    '    virtual_bytes=$(if($p){[long]$p.VirtualMemorySize64}else{$null});',
    '    handle_count=$(if($p){[int]$p.HandleCount}else{$null})',
    '  }',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
  const stdout = await execFileText('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ]);
  const parsed = JSON.parse(stdout || '[]');
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.pid),
    ppid: Number(row.ppid),
    name: row.name || null,
    rss_bytes: row.rss_bytes == null ? null : Number(row.rss_bytes),
    private_bytes: row.private_bytes == null ? null : Number(row.private_bytes),
    virtual_bytes: row.virtual_bytes == null ? null : Number(row.virtual_bytes),
    handle_count: row.handle_count == null ? null : Number(row.handle_count),
  }));
  return descendants(rows, rootPid);
}

async function samplePs(rootPid) {
  const stdout = await execFileText('ps', ['-axo', 'pid=,ppid=,rss=,vsz=,comm=']);
  const rows = stdout.trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss_bytes: Number(match[3]) * 1024,
      private_bytes: null,
      virtual_bytes: Number(match[4]) * 1024,
      handle_count: null,
      name: match[5],
    };
  }).filter(Boolean);
  return descendants(rows, rootPid);
}

async function sampleProcessTree(rootPid) {
  if (process.platform === 'linux') return sampleLinux(rootPid);
  if (process.platform === 'win32') return sampleWindows(rootPid);
  return samplePs(rootPid);
}

module.exports = {
  descendants,
  sampleProcessTree,
};
