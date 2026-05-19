const crypto = require('crypto');
const { pool, withTransaction } = require('./db');

const FREE_DAILY_LIMIT = 100;
const VALID_TIERS      = new Set(['free', 'pro', 'enterprise']);
const G                = 'gauntlet';

// Optional daily-limit override provider. Generic hook — any external
// module (operator console, beta program, hackathon hosting, support
// tickets) can register a function that, given an api_key, returns either
// null (use default) or a positive number (elevated daily limit).
//
// The provider is invoked once per free-tier rate-limit check. It must be
// fast and safe (errors are caught, logged, and treated as "no override").
// Only one provider is registered at a time; calling setOverrideProvider
// again replaces the previous one. Pass null to unregister.
//
// This file knows NOTHING about who the provider is or what it does. That
// is the entire point: api-keys.js stays free of any specific feature
// (events, beta, etc.) so adding or removing the consumer is a no-op here.
let _overrideProvider = null;

function setOverrideProvider(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new Error('setOverrideProvider expects a function or null');
  }
  _overrideProvider = fn;
}

async function getDailyLimitForKey(key, fallback) {
  if (!_overrideProvider) return fallback;
  try {
    const override = await _overrideProvider(key);
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return override;
    }
  } catch (err) {
    console.warn('[api-keys] override provider failed:', err.message);
  }
  return fallback;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function createKey({ name, email, tier = 'free' }) {
  if (!VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  const key = 'agg_' + crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO ${G}.api_keys (key, name, email, tier, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [key, name.trim(), email.trim().toLowerCase(), tier, Date.now()],
  );
  return key;
}

async function validateKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return null;
  const key = rawKey.trim();
  if (!key.startsWith('agg_')) return null;
  const { rows } = await pool.query(
    `SELECT key, name, email, tier, active FROM ${G}.api_keys WHERE key = $1`,
    [key],
  );
  return rows[0] || null;
}

async function checkAndIncrementUsage(key, tier) {
  const date = todayUtc();

  if (tier !== 'free') {
    await pool.query(`UPDATE ${G}.api_keys SET last_used = $1 WHERE key = $2`, [Date.now(), key]);
    return { allowed: true };
  }

  // Determine the daily limit for this key. The override provider (if any
  // is registered) may bump the limit for keys that match its rules. If no
  // provider, or provider returns null/error, fall back to FREE_DAILY_LIMIT.
  const dailyLimit = await getDailyLimitForKey(key, FREE_DAILY_LIMIT);

  const { rows } = await pool.query(
    `SELECT runs FROM ${G}.daily_usage WHERE key = $1 AND date = $2`, [key, date],
  );

  if (rows[0] && rows[0].runs >= dailyLimit) {
    return { allowed: false, reason: 'daily_limit_exceeded', runsToday: rows[0].runs, dailyLimit };
  }

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO ${G}.daily_usage (key, date, runs) VALUES ($1,$2,1)
      ON CONFLICT (key, date) DO UPDATE SET runs = ${G}.daily_usage.runs + 1
    `, [key, date]);
    await client.query(`UPDATE ${G}.api_keys SET last_used = $1 WHERE key = $2`, [Date.now(), key]);
  });

  const { rows: updated } = await pool.query(
    `SELECT runs FROM ${G}.daily_usage WHERE key = $1 AND date = $2`, [key, date],
  );
  return { allowed: true, runsToday: updated[0]?.runs ?? 1, dailyLimit };
}

// Look up the OAuth identity attached to an agg_* key. Used by the
// enterprise key management endpoints to authorise add-domain / revoke /
// list operations: only the human who provisioned an ent_pub_* key (via
// their own agg_* OAuth-linked key) can manage it. Returns null if the
// key is unknown, inactive, or has no OAuth identity (manual signup).
async function getOauthIdentityForKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return null;
  const key = rawKey.trim();
  if (!key.startsWith('agg_')) return null;
  const { rows } = await pool.query(`
    SELECT oauth_provider, oauth_id, email, active
    FROM   ${G}.api_keys
    WHERE  key = $1
  `, [key]);
  const row = rows[0];
  if (!row || !row.active) return null;
  if (!row.oauth_provider || !row.oauth_id) return null;
  return {
    oauthProvider: row.oauth_provider,
    oauthId:       String(row.oauth_id),
    email:         row.email,
  };
}

async function getKeyInfo(rawKey) {
  if (!rawKey) return null;
  const date = todayUtc();
  const { rows } = await pool.query(
    `SELECT key, name, email, tier, created_at, last_used FROM ${G}.api_keys WHERE key = $1 AND active = 1`,
    [rawKey.trim()],
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const { rows: usageRows } = await pool.query(
    `SELECT runs FROM ${G}.daily_usage WHERE key = $1 AND date = $2`, [row.key, date],
  );
  return {
    name:       row.name,
    email:      row.email,
    tier:       row.tier,
    createdAt:  Number(row.created_at),
    lastUsed:   row.last_used ? Number(row.last_used) : null,
    runsToday:  usageRows[0]?.runs ?? 0,
    dailyLimit: row.tier === 'free' ? FREE_DAILY_LIMIT : null,
  };
}

// Find an existing key for this OAuth identity or create a new free-tier key.
async function findOrCreateOAuthKey(provider, oauthId, name, email) {
  const { rows } = await pool.query(
    `SELECT key, tier FROM ${G}.api_keys WHERE oauth_provider = $1 AND oauth_id = $2 AND active = 1`,
    [provider, String(oauthId)],
  );
  if (rows[0]) return { key: rows[0].key, tier: rows[0].tier, isNew: false };

  const key = 'agg_' + crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO ${G}.api_keys (key, name, email, tier, created_at, oauth_provider, oauth_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [key, name.trim(), (email || '').trim().toLowerCase(), 'free', Date.now(), provider, String(oauthId)],
  );
  return { key, tier: 'free', isNew: true };
}

module.exports = {
  createKey,
  validateKey,
  checkAndIncrementUsage,
  getKeyInfo,
  findOrCreateOAuthKey,
  getOauthIdentityForKey,
  setOverrideProvider,
  FREE_DAILY_LIMIT,
};
