// Enterprise pub/secret key management.
//
// Two key types live in this project:
//   agg_*       agent-builder keys — single tier-controlled string used to
//               run benchmarks. Managed by shared/api-keys.js.
//   ent_pub_*   public enterprise key — embedded in detect.js script tags
//               on customer sites. Visible in page source by design.
//   ent_sec_*   secret enterprise key — paired with a pub key, lives only
//               on the customer's backend. Used to call /api/detect/score
//               server-to-server. Stored as sha256 in the DB; the raw
//               value is shown once at creation and never again.
//
// Each enterprise key pair is owned by an OAuth identity (the human who
// provisioned it via the management UI). Multiple pub keys can be owned
// by the same identity — e.g. one per environment (prod, staging, dev).
//
// Domain locking: every enterprise key has a list of allowed domains.
// /api/detect/token rejects requests whose Origin hostname isn't in the
// list; /api/detect/score does the same against the token's signed `dom`
// field. Phase 3b wires this in; this module exposes the helpers.

const crypto = require('crypto');
const { pool } = require('./db');

const G = 'gauntlet';

// ─── Secret hashing ────────────────────────────────────────────────────────
//
// The raw secret has 32 bytes of entropy (256 bits) — bcrypt's slow-hash
// iteration counts exist to mitigate brute-force on low-entropy passwords
// and add no real security here. Plain sha256 is sufficient, plus
// constant-time comparison via crypto.timingSafeEqual at lookup time.

function hashSecret(rawSecret) {
  return crypto.createHash('sha256').update(rawSecret, 'utf8').digest('hex');
}

// ─── Key creation ──────────────────────────────────────────────────────────
//
// Returns the raw secret only this once — store it on the caller side
// before responding to the user. We persist only the sha256.
//
// owner.oauthProvider / owner.oauthId are optional but strongly recommended
// — without them the key is "unowned" and only DB admins can manage it.

async function createEnterpriseKey({ name, email, owner = {} }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('name_required');
  }
  const pubKey    = 'ent_pub_' + crypto.randomBytes(24).toString('hex');
  const secretKey = 'ent_sec_' + crypto.randomBytes(32).toString('hex');
  const secretHash = hashSecret(secretKey);

  await pool.query(`
    INSERT INTO ${G}.enterprise_keys
      (pub_key, secret_hash, name,
       owner_oauth_provider, owner_oauth_id, owner_email,
       created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [
    pubKey, secretHash, name.trim(),
    owner.oauthProvider || null,
    owner.oauthId ? String(owner.oauthId) : null,
    (email || owner.email || '').trim().toLowerCase() || null,
    Date.now(),
  ]);

  return { pubKey, secretKey };
}

// ─── Validation ────────────────────────────────────────────────────────────
//
// validateEnterprisePub: identity-only lookup, used by /api/detect/token
// where the caller proves knowledge of the pub key (which is public) +
// Origin (which is checked against the registered domains).
//
// validateEnterpriseSecret: full authentication, used by /api/detect/score
// when called server-to-server with X-Ent-Secret. Updates last_used.

async function validateEnterprisePub(rawPub) {
  if (!rawPub || typeof rawPub !== 'string') return null;
  const pubKey = rawPub.trim();
  if (!pubKey.startsWith('ent_pub_')) return null;
  const { rows } = await pool.query(
    `SELECT pub_key, name, owner_email, active
     FROM   ${G}.enterprise_keys
     WHERE  pub_key = $1 AND active = 1`,
    [pubKey],
  );
  return rows[0] || null;
}

async function validateEnterpriseSecret(rawSecret) {
  if (!rawSecret || typeof rawSecret !== 'string') return null;
  const secret = rawSecret.trim();
  if (!secret.startsWith('ent_sec_')) return null;
  const candidateHash = hashSecret(secret);
  // sha256 is deterministic so an indexed lookup is safe. timingSafeEqual
  // adds defense-in-depth against side-channel attacks at the network /
  // proxy layer — even though Postgres's own comparison isn't constant
  // time, the attacker can't observe its timing directly.
  const { rows } = await pool.query(`
    SELECT pub_key, secret_hash, name, owner_email, active
    FROM   ${G}.enterprise_keys
    WHERE  active = 1 AND secret_hash = $1
  `, [candidateHash]);
  if (!rows[0]) return null;
  const storedBuf    = Buffer.from(rows[0].secret_hash, 'hex');
  const candidateBuf = Buffer.from(candidateHash,        'hex');
  if (storedBuf.length !== candidateBuf.length) return null;
  if (!crypto.timingSafeEqual(storedBuf, candidateBuf)) return null;

  // Fire-and-forget last_used touch — don't block validation on the write.
  pool.query(
    `UPDATE ${G}.enterprise_keys SET last_used = $1 WHERE pub_key = $2`,
    [Date.now(), rows[0].pub_key],
  ).catch((e) => console.error('[ent-keys] last_used update failed:', e.message));

  return rows[0];
}

// ─── Domain management ─────────────────────────────────────────────────────

// Returns array of registered domains for the pub key, alphabetical.
async function getDomains(pubKey) {
  const { rows } = await pool.query(
    `SELECT domain FROM ${G}.enterprise_domains WHERE pub_key = $1 ORDER BY domain`,
    [pubKey],
  );
  return rows.map((r) => r.domain);
}

// Returns the normalised domain on success; throws on invalid format or
// non-existent pub_key (caught by the FK).
//
// Hostname validation follows RFC 1035 + RFC 3696 § 2: labels are 1-63
// chars, alphanumeric + hyphens, no leading/trailing hyphen, at least one
// dot. No IPs, no ports, no schemes — Origin's hostname only.
function normaliseDomain(raw) {
  const d = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)) {
    throw new Error('invalid_domain');
  }
  return d;
}

async function addDomain(pubKey, rawDomain) {
  const domain = normaliseDomain(rawDomain);
  await pool.query(`
    INSERT INTO ${G}.enterprise_domains (pub_key, domain, added_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (pub_key, domain) DO NOTHING
  `, [pubKey, domain, Date.now()]);
  return domain;
}

async function removeDomain(pubKey, rawDomain) {
  const domain = String(rawDomain || '').trim().toLowerCase();
  await pool.query(
    `DELETE FROM ${G}.enterprise_domains WHERE pub_key = $1 AND domain = $2`,
    [pubKey, domain],
  );
}

// Domain-list membership check. Used by Phase 3b's domain locking on the
// /api/detect/* endpoints.
async function isDomainRegistered(pubKey, candidate) {
  if (!candidate) return false;
  const host = String(candidate).trim().toLowerCase();
  if (!host) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM ${G}.enterprise_domains WHERE pub_key = $1 AND domain = $2 LIMIT 1`,
    [pubKey, host],
  );
  return rows.length > 0;
}

// ─── Listing / read-only views ─────────────────────────────────────────────

async function listEnterpriseKeysForOwner({ oauthProvider, oauthId }) {
  if (!oauthProvider || !oauthId) return [];
  const { rows } = await pool.query(`
    SELECT pub_key, name, created_at, last_used, active
    FROM   ${G}.enterprise_keys
    WHERE  owner_oauth_provider = $1 AND owner_oauth_id = $2
    ORDER  BY created_at DESC
  `, [oauthProvider, String(oauthId)]);

  // Attach domains. Single query for the whole set avoids N+1.
  const pubKeys = rows.map((r) => r.pub_key);
  let byPub = {};
  if (pubKeys.length > 0) {
    const { rows: dRows } = await pool.query(
      `SELECT pub_key, domain FROM ${G}.enterprise_domains WHERE pub_key = ANY($1) ORDER BY domain`,
      [pubKeys],
    );
    for (const r of dRows) (byPub[r.pub_key] ??= []).push(r.domain);
  }

  return rows.map((r) => ({
    pubKey:    r.pub_key,
    name:      r.name,
    createdAt: Number(r.created_at),
    lastUsed:  r.last_used ? Number(r.last_used) : null,
    active:    !!r.active,
    domains:   byPub[r.pub_key] || [],
  }));
}

// Verify a pub key is owned by a given OAuth identity. Used by management
// endpoints to authorise add-domain / remove-domain / revoke.
async function isOwnedBy(pubKey, { oauthProvider, oauthId }) {
  if (!pubKey || !oauthProvider || !oauthId) return false;
  const { rows } = await pool.query(`
    SELECT 1 FROM ${G}.enterprise_keys
    WHERE pub_key = $1 AND owner_oauth_provider = $2 AND owner_oauth_id = $3
    LIMIT 1
  `, [pubKey, oauthProvider, String(oauthId)]);
  return rows.length > 0;
}

async function revoke(pubKey) {
  await pool.query(
    `UPDATE ${G}.enterprise_keys SET active = 0 WHERE pub_key = $1`,
    [pubKey],
  );
}

module.exports = {
  createEnterpriseKey,
  validateEnterprisePub,
  validateEnterpriseSecret,
  getDomains,
  addDomain,
  removeDomain,
  isDomainRegistered,
  listEnterpriseKeysForOwner,
  isOwnedBy,
  revoke,
  hashSecret,  // exported for tests only
};
