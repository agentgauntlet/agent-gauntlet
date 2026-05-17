// HMAC-signed envelope tokens used by detect.js.
//
// Flow
// ────
// 1. detect.js on a page loaded from acme-bank.com calls
//      GET https://agentgauntlet.ai/api/detect/token
//      X-Pub-Key: agg_abc123
//    The server validates the pub key and Origin, then signs an envelope:
//      { v:1, pub, tier, dom, iat, exp, nonce }
//    and returns it as token = base64url(envelope) + "." + base64url(hmac).
//
// 2. detect.js collects fingerprint + behavioral signals. When it's ready
//    to submit (form-submit injection or direct-mode POST), it builds a
//    signal bundle, base64-encodes it, and signs it with the SAME server-
//    issued token (the token plays the role of an HMAC key for the bundle).
//
//    Wait — re-read. We have ONE shared signing secret. The envelope token
//    is signed by the server with DETECT_SIGNING_SECRET. detect.js then
//    sends back both:
//      • the envelope token (which the server can verify)
//      • the signal bundle (sent as JSON, signed using the same scheme:
//        another HMAC keyed by the envelope token's signature bytes, so
//        only a holder of the envelope can forge a matching bundle
//        signature)
//
//    The current MVP keeps it simpler: detect.js sends { token, bundle }
//    where the server verifies the token, then trusts `bundle` because
//    detect.js (running in the user's browser) is the only thing that
//    holds the unforgeable token. Forgery requires obtaining a valid
//    token, which itself requires a valid pub key + acceptable Origin.
//
// 3. /api/detect/score verifies the envelope (signature, expiry, optional
//    domain match) and applies the signal bundle to the scoring engine.
//
// Format
// ──────
//   token = base64url(envelope_json) + "." + base64url(hmac_sha256_signature)
//
// Signing secret
// ──────────────
//   Read from DETECT_SIGNING_SECRET env var in production. For self-hosted
//   dev where the var is unset, a deterministic dev fallback is derived
//   from a known string so the process is self-consistent. Production MUST
//   set a real random secret (at least 32 bytes).

const crypto = require('crypto');

const DETECT_TOKEN_TTL_SEC = 5 * 60; // 5 minutes
const ENVELOPE_VERSION     = 1;

let _cachedSecret = null;
function getSigningSecret() {
  if (_cachedSecret) return _cachedSecret;
  const env = process.env.DETECT_SIGNING_SECRET;
  if (env && env.length >= 16) {
    _cachedSecret = Buffer.from(env, 'utf8');
  } else {
    // Self-hosted dev fallback. Deterministic so tokens issued by this
    // process verify within the same process, but obviously NOT safe for
    // production — set DETECT_SIGNING_SECRET to a real random value.
    if (env != null) {
      console.warn('[detect-token] DETECT_SIGNING_SECRET too short, using dev fallback');
    }
    _cachedSecret = crypto.createHash('sha256')
      .update('agentgauntlet-detect-dev-fallback')
      .digest();
  }
  return _cachedSecret;
}

// Reset the cached signing secret. Tests call this between cases when they
// poke at process.env.DETECT_SIGNING_SECRET; production code never needs it.
function _resetSigningSecretForTests() {
  _cachedSecret = null;
}

// Sign an envelope payload. The envelope is a plain object — caller decides
// what fields to include. Returns "<base64url-payload>.<base64url-hmac>".
function signDetectToken(envelope) {
  const body = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  const sig  = crypto.createHmac('sha256', getSigningSecret())
                     .update(body)
                     .digest('base64url');
  return `${body}.${sig}`;
}

// Verify a token. Returns the parsed envelope on success, null on any
// failure (malformed, bad signature, expired). Uses constant-time string
// comparison on the signature to avoid timing-oracle attacks.
function verifyDetectToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig  = token.slice(dot + 1);

  const expectedSig = crypto.createHmac('sha256', getSigningSecret())
                            .update(body)
                            .digest('base64url');

  // Lengths must match before timingSafeEqual; bail early to avoid throw.
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }

  if (!envelope || envelope.v !== ENVELOPE_VERSION) return null;
  if (typeof envelope.exp !== 'number') return null;
  if (envelope.exp < Math.floor(Date.now() / 1000)) return null;
  return envelope;
}

// Convenience for the /api/detect/token route handler. Produces an envelope
// for the given pub key + domain, signs it, returns the token string and
// echoed metadata.
function issueDetectToken({ pubKey, tier, domain }) {
  const now = Math.floor(Date.now() / 1000);
  const envelope = {
    v:     ENVELOPE_VERSION,
    pub:   pubKey,
    tier:  tier || 'free',
    dom:   domain || null,
    iat:   now,
    exp:   now + DETECT_TOKEN_TTL_SEC,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  return {
    token:    signDetectToken(envelope),
    ttl:      DETECT_TOKEN_TTL_SEC,
    expires:  envelope.exp,
    issuedAt: envelope.iat,
  };
}

module.exports = {
  DETECT_TOKEN_TTL_SEC,
  ENVELOPE_VERSION,
  signDetectToken,
  verifyDetectToken,
  issueDetectToken,
  _resetSigningSecretForTests,
};
