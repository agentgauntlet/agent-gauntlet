// Known-bad JA3 fingerprint hashes for common HTTP clients / automation tools.
//
// When the upstream proxy (Cloudflare with Bot Management paid plan, a
// Caddy build with a JA3 module, or anything else that can compute JA3)
// forwards the real client's JA3 hash to us via a header, /api/detect/score
// looks it up in this set. A hit fires the `known_bot_ja3` signal.
//
// This is intentionally tiny — a curated allowlist of WIDELY-known
// automation tool fingerprints, not an exhaustive bot signature DB. The
// goal is to catch the obvious low-effort cases (curl, Python requests,
// Go HTTP client, etc.) without ever false-positiving on a real browser.
//
// Format: every entry is the lowercase MD5 of the JA3 string. JA3 itself
// is computed from the TLS ClientHello as
//   SSLVersion,Cipher,Extension,EllipticCurve,EllipticCurvePointFormat
// then hex-MD5'd.
//
// Sources: salesforce/ja3 README, abuse.ch ja3er, and direct captures from
// each tool's stock TLS config. Values that drift across versions are not
// included — only stable, distinctive hashes.

const KNOWN_BOT_JA3 = new Set([
  // curl 7.x / 8.x default TLS stack (OpenSSL)
  '6fa3244afc6bb6f9fad207b6b52af26b',

  // Python requests / urllib3 (CPython, default ssl module, no requests
  // session customisation)
  '54328bd36c14bd82ddaa0c04b25ed9ad',

  // Go default net/http client (crypto/tls stock config)
  '19e29534fd49dd27d09234e639c4057e',

  // node-fetch (Node 18 stock TLS, no agent override)
  '7a29c223fb122ec64d10f0a159e07996',

  // axios over Node default https.Agent
  '5d65ea3fb1d4aa7d826733d2f2cbbb1f',

  // Playwright/Puppeteer headless Chromium — distinctive because they
  // ship a different cipher order than upstream Chromium release builds.
  // (Verified against Playwright 1.40 and Puppeteer 21.x as of 2025-Q4.)
  'b32309a26951912be7dba376398abc3b',
]);

// Look up a JA3 hash in the known-bad set. Returns true if it matches.
// The caller normalises (lowercase, strip whitespace) before calling so
// proxy quirks (mixed case, padding) don't slip through.
function isKnownBotJA3(hash) {
  if (!hash || typeof hash !== 'string') return false;
  return KNOWN_BOT_JA3.has(hash.trim().toLowerCase());
}

// Extract the real client's JA3 hash from a request's headers, checking
// known proxy header conventions in priority order:
//   Cf-Ja3-Hash       Cloudflare Bot Management (paid plan)
//   X-Ja3             Caddy `tls-fingerprint` module / other custom proxy
//   X-Ja3-Hash        legacy variant some proxies emit
//
// Returns the lowercase hex hash on hit, or null when no header is
// present. The caller decides what to do with null (ignore for free-tier
// deployments, or fire a `ja3_missing` signal if you expect the proxy to
// always provide one).
function extractClientJA3(req) {
  if (!req || !req.headers) return null;
  const candidates = [
    req.headers['cf-ja3-hash'],
    req.headers['x-ja3'],
    req.headers['x-ja3-hash'],
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) {
      return v.trim().toLowerCase();
    }
  }
  return null;
}

module.exports = { KNOWN_BOT_JA3, isKnownBotJA3, extractClientJA3 };
