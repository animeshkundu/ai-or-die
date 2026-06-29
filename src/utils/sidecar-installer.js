'use strict';

// Sidecar installer — fetches the prebuilt aiordie-mesh tsnet binary for the
// current platform from the matching GitHub release and verifies it against the
// release's published SHA-256 checksums before use. Mirrors the download/verify
// shape of gguf-model-manager (resumable not needed — the binary is ~20MB).
//
// Asset convention (published by .github/workflows/release-on-main.yml):
//   aiordie-mesh-<plat>-<arch>[.exe]   plat: windows|linux|darwin  arch: amd64|arm64
//   aiordie-mesh-checksums.txt         "<sha256>  <assetname>" per line

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO = 'animeshkundu/ai-or-die';
const PLAT = { win32: 'windows', linux: 'linux', darwin: 'darwin' };
const ARCH = { x64: 'amd64', arm64: 'arm64' };

function assetName() {
  const plat = PLAT[process.platform];
  const arch = ARCH[process.arch];
  if (!plat || !arch) return null;
  return `aiordie-mesh-${plat}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
}

function sidecarPath() {
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = process.platform === 'win32' ? path.join(localApp, 'ai-or-die') : path.join(os.homedir(), '.ai-or-die');
  return path.join(base, 'bin', `aiordie-mesh${process.platform === 'win32' ? '.exe' : ''}`);
}

async function _sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function _fetchText(url, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function _download(url, tmp, ms = 120000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    // Exclusive create — never follow/overwrite a pre-planted file or symlink.
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((res, rej) => out.write(value, (e) => (e ? rej(e) : res())));
    }
    await new Promise((res) => out.end(res));
  } finally { clearTimeout(t); }
}

// Ensure the sidecar binary exists locally AND matches the release checksum;
// download + verify if missing or stale. Returns the path; throws on failure.
async function ensureSidecar(version, dest = sidecarPath()) {
  const name = assetName();
  if (!name) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);

  // Resolve the expected hash first so an existing file is also verified.
  const baseUrl = `https://github.com/${REPO}/releases/download/v${version}`;
  const sums = await _fetchText(`${baseUrl}/aiordie-mesh-checksums.txt`);
  const line = sums.split('\n').find((l) => {
    const f = l.trim().split(/\s+/)[1];   // exact filename column, not endsWith
    return f === name;
  });
  if (!line) throw new Error(`no checksum for ${name} in release v${version}`);
  const want = line.trim().split(/\s+/)[0].toLowerCase();

  // Existing file: trust only if it matches; otherwise replace it.
  if (fs.existsSync(dest)) {
    if ((await _sha256(dest)).toLowerCase() === want) return dest;
    try { await fsp.unlink(dest); } catch (_) {}
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${crypto.randomBytes(8).toString('hex')}.incomplete`;
  try {
    await _download(`${baseUrl}/${name}`, tmp);
    // Verify BEFORE the bytes ever reach the runnable path (no TOCTOU window).
    if ((await _sha256(tmp)).toLowerCase() !== want) throw new Error(`checksum mismatch for ${name}`);
    if (process.platform !== 'win32') { try { await fsp.chmod(tmp, 0o755); } catch (_) {} }
    await fsp.rename(tmp, dest);
  } finally {
    try { await fsp.unlink(tmp); } catch (_) {}
  }
  return dest;
}

module.exports = { ensureSidecar, sidecarPath, assetName };
