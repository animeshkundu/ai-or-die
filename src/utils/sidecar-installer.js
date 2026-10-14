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

// Provenance: which release ref the runnable binary was verified against.
// The stable path is replaced in place across versions, so the bytes alone
// cannot tell the manager what is running. Written on every successful
// install/verify; read by MeshManager to decide whether a refresh is due.
// Best-effort, never throws. Mode 0600 (no secrets inside, but cheap).
function provenancePath(dest) {
  try {
    const binDir = path.dirname(dest || stableSidecarPath());
    const base = path.basename(binDir) === 'bin' ? path.dirname(binDir) : baseDir();
    return path.join(base, 'mesh', 'sidecar.json');
  } catch (_) {
    return path.join(baseDir(), 'mesh', 'sidecar.json');
  }
}

function loadProvenance(dest) {
  try {
    return JSON.parse(fs.readFileSync(provenancePath(dest), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeProvenance(dest, info) {
  try {
    const p = provenancePath(dest);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ ...info, updatedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 }
    );
  } catch (_) { /* best-effort */ }
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

async function _download(url, tmp, ms = 120000, fetchImpl) {
  const t0 = Date.now();
  // Total deadline covers the body stream too (headers-only timeout would let
  // a slow-drip body hold the caller — and the refresh in-flight flag — forever).
  const totalMs = ms * 5;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  let r;
  try {
    r = await (fetchImpl || fetch)(url, { signal: ac.signal });
  } catch (e) {
    throw new SidecarError('network', `could not reach ${hostOf(url)} (${e.message})`);
  } finally {
    clearTimeout(t);
  }
  if (r.status === 404) throw new SidecarError('assets-missing', `HTTP 404 for ${url}`);
  if (!r.ok || !r.body) throw new SidecarError('network', `HTTP ${r.status} for ${url}`);
  // Exclusive create — never follow/overwrite a pre-planted file or symlink.
  let out;
  try {
    out = fs.createWriteStream(tmp, { flags: 'wx' });
  } catch (e) {
    throw new SidecarError('network', `cannot stage download at ${tmp} (${e.code || e.message})`);
  }
  const reader = r.body.getReader();
  try {
    for (;;) {
      if (Date.now() - t0 > totalMs) throw new SidecarError('network', `download timed out for ${url}`);
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((res, rej) => out.write(value, (e) => (e ? rej(e) : res())));
    }
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (_) {}
    throw e;
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
  const ref = meshRef(lock);

  // Existing file: trust only if it matches; otherwise replace it.
  if (fs.existsSync(dest)) {
    if ((await _sha256(dest)).toLowerCase() === want) {
      stripProvenance(dest);
      writeProvenance(dest, { ref, contentHash: lock.contentHash || null, sha256: want });
      return dest;
    }
    try { await fsp.unlink(dest); }
    catch (e) {
      if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
        throw new SidecarError('locked-binary', `cannot replace in-use sidecar at ${dest} (${e.code})`);
      }
      throw e; // surface real filesystem faults instead of masking them
    }
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
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
  writeProvenance(dest, { ref, contentHash: lock.contentHash || null, sha256: want });
  return dest;
}

// Release metadata for the auto-refresh check (MeshManager): the newest
// published, non-draft `mesh-*` release. `fetchImpl` injects fetch (tests).
async function listMeshReleases(fetchImpl) {
  const impl = fetchImpl || fetch;
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
  let r;
  try {
    r = await impl(url, {
      headers: { 'User-Agent': 'ai-or-die-mesh-refresh', Accept: 'application/vnd.github+json' },
    });
  } catch (e) {
    throw new SidecarError('network', `could not list mesh releases (${e.message})`);
  }
  if (!r.ok) throw new SidecarError('network', `releases API HTTP ${r.status}`);
  let releases;
  try {
    releases = await r.json();
  } catch (e) {
    throw new SidecarError('network', `could not parse releases API (${e.message})`);
  }
  return (Array.isArray(releases) ? releases : [])
    .filter((rel) => rel && typeof rel.tag_name === 'string'
      && /^mesh-[A-Za-z0-9._-]+$/.test(rel.tag_name)
      && !rel.draft && !rel.prerelease)
    .map((rel) => ({ tag: rel.tag_name, publishedAt: rel.published_at || '' }))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
}

// Parse a checksums manifest (`"<sha256>  <assetName>"` per line, as emitted
// by scripts/build-mesh-sidecar.sh) into { assetName: sha256 }.
function parseChecksums(text) {
  const out = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

// Fetch one sidecar asset from an explicit release ref into a temp path and
// verify it against that release's checksums manifest. Used by the
// auto-refresh path, where no shipped lock covers the new ref: trust here is
// GitHub-TLS + manifest consistency (asset present AND the manifest lists the
// full platform matrix, so a truncated/forged-single-entry manifest fails),
// documented in docs/specs/mesh.md. Returns { path, sha256, ref }.
// Never writes the runnable path; the caller swaps after stopping the child.
async function fetchSidecarRef(ref, tmpPath, opts = {}) {
  if (!/^mesh-[A-Za-z0-9._-]+$/.test(ref)) {
    throw new SidecarError('unsupported-platform', `invalid mesh ref ${JSON.stringify(ref)}`);
  }
  const fetchImpl = opts.fetch || fetch;
  const name = opts.assetName || assetName();
  if (!name) throw new SidecarError('unsupported-platform', `unsupported platform ${process.platform}/${process.arch}`);
  const base = `https://github.com/${REPO}/releases/download/${ref}`;
  const manifestUrl = `${base}/ai-or-die-mesh-checksums.txt`;
  let manifestRes;
  try {
    manifestRes = await fetchImpl(manifestUrl);
  } catch (e) {
    throw new SidecarError('network', `could not reach ${hostOf(manifestUrl)} (${e.message})`);
  }
  if (manifestRes.status === 404) throw new SidecarError('assets-missing', `HTTP 404 for ${manifestUrl}`);
  if (!manifestRes.ok) throw new SidecarError('network', `HTTP ${manifestRes.status} for ${manifestUrl}`);
  const manifest = parseChecksums(await manifestRes.text());
  const want = manifest[name];
  // The manifest must cover EXACTLY the expected platform matrix — a count
  // check is vacuous (victim asset + filler lines would pass). A same-origin
  // manifest that cannot name every platform binary is rejected.
  let expected = null;
  try {
    expected = require('../../scripts/mesh-lock').ASSET_NAMES;
  } catch (_) {
    expected = [
      'ai-or-die-mesh-windows-amd64.exe',
      'ai-or-die-mesh-windows-arm64.exe',
      'ai-or-die-mesh-linux-amd64',
      'ai-or-die-mesh-linux-arm64',
      'ai-or-die-mesh-darwin-amd64',
      'ai-or-die-mesh-darwin-arm64',
    ];
  }
  const complete = want && Array.isArray(expected)
    && expected.length > 0
    && expected.every((n) => manifest[n]);
  if (!complete) {
    throw new SidecarError('checksum-mismatch', `checksums manifest from ${ref} is incomplete (no entry for ${name})`);
  }
  // Stale tmp from a killed prior run would fail the exclusive create below
  // permanently (predictable refresh path) — clear it before downloading.
  try { await fsp.unlink(tmpPath); } catch (_) {}
  await _download(`${base}/${name}`, tmpPath, 120000, fetchImpl);
  if ((await _sha256(tmpPath)).toLowerCase() !== want) {
    try { await fsp.unlink(tmpPath); } catch (_) {}
    throw new SidecarError('checksum-mismatch', `checksum mismatch for ${name} from ${ref}`);
  }
  if (process.platform !== 'win32') { try { await fsp.chmod(tmpPath, 0o755); } catch (_) {} }
  return { path: tmpPath, sha256: want, ref };
}

module.exports = {
  ensureSidecar,
  stableSidecarPath,
  assetName,
  loadLock,
  SidecarError,
  provenancePath,
  loadProvenance,
  writeProvenance,
  listMeshReleases,
  parseChecksums,
  fetchSidecarRef,
};
