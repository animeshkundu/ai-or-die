'use strict';

// Sidecar installer — fetches the prebuilt ai-or-die-mesh tsnet binary for the
// current platform and verifies it against a SHA-256 that ships INSIDE this npm
// package (mesh-sidecar.lock.json). Trust is therefore anchored by the signed
// npm artifact, not by a checksums file fetched from the same mutable GitHub
// release (which a tampered release could swap alongside the binary).
//
// Identity is content-addressed: the binary lives at the release tag
// `mesh-<contentHash>` where contentHash is derived from the sidecar source
// (see scripts/mesh-lock.js). Many ai-or-die versions can pin the same sidecar;
// CI only rebuilds when the source — and thus the hash — changes.
//
// Asset convention (published by .github/workflows/release-on-main.yml):
//   ai-or-die-mesh-<plat>-<arch>[.exe]   plat: windows|linux|darwin  arch: amd64|arm64

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO = 'animeshkundu/ai-or-die';
const PLAT = { win32: 'windows', linux: 'linux', darwin: 'darwin' };
const ARCH = { x64: 'amd64', arm64: 'arm64' };

// Typed failure so the manager can print an accurate cause instead of a blanket
// "fetched on next release build".
class SidecarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SidecarError';
    this.code = code; // unsupported-platform | lock-unfinalized | assets-missing | network | checksum-mismatch | locked-binary
  }
}

function loadLock() {
  // The lock ships at the package root, two levels up from src/utils/.
  const p = path.join(__dirname, '..', '..', 'mesh-sidecar.lock.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function assetName() {
  const plat = PLAT[process.platform];
  const arch = ARCH[process.arch];
  if (!plat || !arch) return null;
  return `ai-or-die-mesh-${plat}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
}

function baseDir() {
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return process.platform === 'win32' ? path.join(localApp, 'ai-or-die') : path.join(os.homedir(), '.ai-or-die');
}

// Stable runnable path (NO content hash): the manager LAUNCHES this path, so a
// single-file WDAC/AppLocker allow-list rule matches the executed image across
// every version. This trades ADR-0035's install-alongside for that match; it is
// safe because the stable file is free at process start (the prior ai-or-die and
// its sidecar have exited), and the MOTW/quarantine mark is stripped after the
// SHA-256 verify so a re-download is not re-gated. See ADR-0036.
function stableSidecarPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(baseDir(), 'bin', `ai-or-die-mesh${ext}`);
}

// Best-effort provenance strip AFTER the SHA-256 verify: remove Windows
// mark-of-the-web (Zone.Identifier ADS) / macOS Gatekeeper quarantine so the
// freshly-verified binary is not re-gated by SmartScreen/Gatekeeper on each new
// version. We verified the bytes against the checksum shipped in the signed npm
// package, so this de-gates only a binary we already trust. Never throws.
function stripProvenance(file) {
  try {
    if (process.platform === 'win32') {
      fs.rmSync(`${file}:Zone.Identifier`, { force: true });
    } else if (process.platform === 'darwin') {
      try {
        require('child_process').execFileSync('xattr', ['-d', 'com.apple.quarantine', file], { stdio: 'ignore' });
      } catch (_) { /* xattr absent or attribute not set */ }
    }
  } catch (_) { /* best-effort */ }
}

// The release ref to fetch from. Defaults to mesh-<contentHash>; an explicit
// override is a dev/testing escape hatch and is announced loudly.
function meshRef(lock) {
  const override = process.env.AIORDIE_MESH_REF || process.env.AIORDIE_MESH_VERSION;
  if (override) {
    // Constrain to a safe tag shape — no path segments / traversal — even though
    // the host is fixed. This is a dev/testing escape hatch, announced loudly.
    const ref = /^mesh-/.test(override) ? override : `mesh-${override}`;
    if (!/^mesh-[A-Za-z0-9._-]+$/.test(ref)) {
      throw new SidecarError('unsupported-platform', `invalid AIORDIE_MESH_REF ${JSON.stringify(override)}`);
    }
    console.warn(`  \x1b[33m[mesh] overriding sidecar ref → ${ref} (AIORDIE_MESH_REF/VERSION)\x1b[0m`);
    return ref;
  }
  return `mesh-${lock.contentHash}`;
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

async function _download(url, tmp, ms = 120000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  let r;
  try {
    r = await fetch(url, { signal: ac.signal });
  } catch (e) {
    throw new SidecarError('network', `could not reach ${hostOf(url)} (${e.message})`);
  } finally {
    clearTimeout(t);
  }
  if (r.status === 404) throw new SidecarError('assets-missing', `HTTP 404 for ${url}`);
  if (!r.ok || !r.body) throw new SidecarError('network', `HTTP ${r.status} for ${url}`);
  // Exclusive create — never follow/overwrite a pre-planted file or symlink.
  const out = fs.createWriteStream(tmp, { flags: 'wx' });
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise((res, rej) => out.write(value, (e) => (e ? rej(e) : res())));
  }
  await new Promise((res) => out.end(res));
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return 'github.com'; }
}

// Ensure the sidecar binary exists locally AND matches the lock's checksum;
// download + verify if missing. Returns the path; throws SidecarError on failure.
// `opts.lock` injects a lock object (tests); production reads the committed lock.
async function ensureSidecar(dest, opts = {}) {
  const lock = opts.lock || loadLock();
  const name = assetName();
  if (!name) throw new SidecarError('unsupported-platform', `unsupported platform ${process.platform}/${process.arch}`);

  const want = (lock.assets && lock.assets[name] || '').toLowerCase();
  if (!want) {
    throw new SidecarError('lock-unfinalized', `mesh-sidecar.lock.json has no checksum for ${name} (built without the mesh asset pipeline?)`);
  }

  dest = dest || stableSidecarPath();

  // Existing file: trust only if it matches; otherwise replace it.
  if (fs.existsSync(dest)) {
    if ((await _sha256(dest)).toLowerCase() === want) { stripProvenance(dest); return dest; }
    try { await fsp.unlink(dest); }
    catch (e) {
      if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
        throw new SidecarError('locked-binary', `cannot replace in-use sidecar at ${dest} (${e.code})`);
      }
      throw e; // surface real filesystem faults instead of masking them
    }
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const ref = meshRef(lock);
  const url = `https://github.com/${REPO}/releases/download/${ref}/${name}`;
  const tmp = `${dest}.${crypto.randomBytes(8).toString('hex')}.incomplete`;
  try {
    await _download(url, tmp);
    // Verify BEFORE the bytes ever reach the runnable path (no TOCTOU window).
    if ((await _sha256(tmp)).toLowerCase() !== want) {
      throw new SidecarError('checksum-mismatch', `checksum mismatch for ${name} from ${ref}`);
    }
    if (process.platform !== 'win32') { try { await fsp.chmod(tmp, 0o755); } catch (_) {} }
    try {
      await fsp.rename(tmp, dest);
    } catch (e) {
      // Lost a race to a concurrent installer (or the file is locked). If the
      // destination is now present and valid, accept it; otherwise surface it.
      if (fs.existsSync(dest) && (await _sha256(dest)).toLowerCase() === want) { stripProvenance(dest); return dest; }
      if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
        throw new SidecarError('locked-binary', `cannot install sidecar at ${dest} (${e.code})`);
      }
      throw e;
    }
  } finally {
    try { await fsp.unlink(tmp); } catch (_) {}
  }
  stripProvenance(dest);
  return dest;
}

module.exports = { ensureSidecar, stableSidecarPath, assetName, loadLock, SidecarError };
