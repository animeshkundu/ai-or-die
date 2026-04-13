'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CERT_DIR = path.join(os.homedir(), '.ai-or-die', 'certs');
const CERT_PATH = path.join(CERT_DIR, 'server.cert');
const KEY_PATH = path.join(CERT_DIR, 'server.key');
const META_PATH = path.join(CERT_DIR, 'cert-meta.json');
const CERT_DAYS = 365;

/**
 * Get all non-internal IPv4 addresses from network interfaces.
 * @returns {string[]}
 */
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

/**
 * Check if the cached certificate covers the current LAN IPs and is not expired.
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateCachedCert() {
  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH) || !fs.existsSync(META_PATH)) {
    return { valid: false, reason: 'missing' };
  }

  try {
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

    // Check expiry
    const expiresAt = new Date(meta.expiresAt);
    if (expiresAt <= new Date()) {
      return { valid: false, reason: 'expired' };
    }

    // Check if current LAN IPs match what was in the cert
    const currentIPs = getLocalIPs().sort();
    const certIPs = (meta.lanIPs || []).sort();
    if (JSON.stringify(currentIPs) !== JSON.stringify(certIPs)) {
      return { valid: false, reason: 'ip-changed' };
    }

    return { valid: true };
  } catch (_) {
    return { valid: false, reason: 'corrupt' };
  }
}

/**
 * Generate a self-signed certificate with SANs for localhost and LAN IPs.
 * Caches the result at ~/.ai-or-die/certs/ for reuse.
 *
 * @returns {{ cert: string, key: string, ips: string[] }}
 */
function generateCert() {
  const selfsigned = require('selfsigned');
  const ips = getLocalIPs();

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...ips.map(ip => ({ type: 7, ip })),
  ];

  const attrs = [{ name: 'commonName', value: 'ai-or-die' }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: CERT_DAYS,
    algorithm: 'sha256',
    extensions: [
      { name: 'subjectAltName', altNames },
    ],
  });

  // Ensure cert directory with restricted permissions
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });

  // Write cert and key with restricted permissions
  fs.writeFileSync(CERT_PATH, pems.cert, { mode: 0o644 });
  fs.writeFileSync(KEY_PATH, pems.private, { mode: 0o600 });

  // Write metadata for cache validation
  const meta = {
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + CERT_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    lanIPs: ips,
  };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), { mode: 0o644 });

  return { cert: pems.cert, key: pems.private, ips };
}

/**
 * Ensure a valid self-signed certificate exists, generating one if needed.
 * Returns the cert and key as strings.
 *
 * @returns {{ cert: string, key: string, certPath: string, ips: string[], generated: boolean }}
 */
function ensureCert() {
  const validation = validateCachedCert();

  if (validation.valid) {
    const cert = fs.readFileSync(CERT_PATH, 'utf8');
    const key = fs.readFileSync(KEY_PATH, 'utf8');
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    return { cert, key, certPath: CERT_PATH, ips: meta.lanIPs || [], generated: false };
  }

  const { cert, key, ips } = generateCert();
  return { cert, key, certPath: CERT_PATH, ips, generated: true };
}

module.exports = { ensureCert, getLocalIPs, CERT_DIR };
