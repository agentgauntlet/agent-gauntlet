// Rate limiting backed by Postgres so all scenario servers share counters.
//
// Limits enforced:
//   Anonymous (no API key)  →  5 sessions/day per IP, 3/min burst
//   Free key                →  100/day (api-keys.js)  + 20/min burst
//   Pro key                 →  5000/month             + 60/min burst
//   Key registration        →  5/day per IP (manual + OAuth)
//
// Fail-open policy: if Postgres errors, we allow the request but log the
// error. Better to over-serve during a DB hiccup than block legitimate traffic.

const { pool } = require('./db');
const G = 'gauntlet';

const ANON_DAILY_LIMIT       = 50;
const ANON_BURST_PER_MIN     = 10;
const FREE_BURST_PER_MIN     = 20;
const PRO_MONTHLY_LIMIT      = 5000;
const PRO_BURST_PER_MIN      = 60;
const REGISTRATION_PER_IP    = 5;

function todayUtc()      { return new Date().toISOString().slice(0, 10); }    // 2026-05-04
function monthUtc()      { return new Date().toISOString().slice(0, 7);  }    // 2026-05
function minuteFloorUtc() { return new Date().toISOString().slice(0, 16); }   // 2026-05-04T03:21

// Header precedence for client-IP detection:
//   1. CF-Connecting-IP   — Cloudflare proxy (orange cloud) is in front
//   2. Fly-Client-IP      — direct Fly traffic (no Cloudflare, or grey cloud)
//   3. req.ip             — Express's parsed X-Forwarded-For (trust proxy)
// Treat 127.0.0.1 and Fly's internal 6PN (fdaa::/16) as health-check / internal — bypass.
function getClientIp(req) {
  const cfIp  = req.headers['cf-connecting-ip'];
  const flyIp = req.headers['fly-client-ip'];
  const raw   = cfIp || flyIp || req.ip || '';
  const ip    = Array.isArray(raw) ? raw[0] : raw;
  return String(ip).split(',')[0].trim();
}

function isInternalIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('fdaa:')) return true; // Fly internal 6PN
  if (ip.startsWith('::ffff:127.')) return true;
  return false;
}

// Atomic UPSERT-and-read. Returns the new count after increment.
async function _bumpCounter(table, keys, valueColumn = 'runs') {
  const colNames  = Object.keys(keys);
  const colValues = Object.values(keys);
  const placeholders = colValues.map((_, i) => `$${i + 1}`).join(',');
  const conflictCols = colNames.join(',');
  const sql = `
    INSERT INTO ${G}.${table} (${colNames.join(',')}, ${valueColumn})
    VALUES (${placeholders}, 1)
    ON CONFLICT (${conflictCols}) DO UPDATE
      SET ${valueColumn} = ${G}.${table}.${valueColumn} + 1
    RETURNING ${valueColumn}
  `;
  const { rows } = await pool.query(sql, colValues);
  return rows[0][valueColumn];
}

async function _readCounter(table, keys, valueColumn = 'runs') {
  const where = Object.keys(keys).map((k, i) => `${k} = $${i + 1}`).join(' AND ');
  const { rows } = await pool.query(
    `SELECT ${valueColumn} FROM ${G}.${table} WHERE ${where}`,
    Object.values(keys),
  );
  return rows[0]?.[valueColumn] ?? 0;
}

// ─── Anonymous IP daily limit ─────────────────────────────────────────────

async function checkAnonymousDaily(ip) {
  if (isInternalIp(ip)) return { allowed: true, runsToday: 0, dailyLimit: ANON_DAILY_LIMIT };
  try {
    const current = await _readCounter('anonymous_usage', { ip, date: todayUtc() });
    if (current >= ANON_DAILY_LIMIT) {
      return { allowed: false, reason: 'anon_daily_limit_exceeded',
               runsToday: current, dailyLimit: ANON_DAILY_LIMIT, retryAfterSec: secondsUntilUtcMidnight() };
    }
    const after = await _bumpCounter('anonymous_usage', { ip, date: todayUtc() });
    return { allowed: true, runsToday: after, dailyLimit: ANON_DAILY_LIMIT };
  } catch (e) {
    console.error('[ratelimit] anon daily check failed (fail-open):', e.message);
    return { allowed: true, runsToday: 0, dailyLimit: ANON_DAILY_LIMIT };
  }
}

// ─── Burst / per-minute limit ─────────────────────────────────────────────
// bucket: "ip:1.2.3.4" or "key:agg_..." — caller decides the namespace.

async function checkBurst(bucket, perMinuteLimit) {
  try {
    const current = await _readCounter('burst_usage', { bucket, minute: minuteFloorUtc() }, 'count');
    if (current >= perMinuteLimit) {
      return { allowed: false, reason: 'burst_limit_exceeded',
               count: current, limit: perMinuteLimit, retryAfterSec: 60 };
    }
    const after = await _bumpCounter('burst_usage', { bucket, minute: minuteFloorUtc() }, 'count');
    return { allowed: true, count: after, limit: perMinuteLimit };
  } catch (e) {
    console.error('[ratelimit] burst check failed (fail-open):', e.message);
    return { allowed: true, count: 0, limit: perMinuteLimit };
  }
}

// ─── Pro tier monthly cap ──────────────────────────────────────────────────

async function checkProMonthly(key) {
  try {
    const current = await _readCounter('monthly_usage', { key, year_month: monthUtc() });
    if (current >= PRO_MONTHLY_LIMIT) {
      return { allowed: false, reason: 'monthly_limit_exceeded',
               runsThisMonth: current, monthlyLimit: PRO_MONTHLY_LIMIT,
               retryAfterSec: secondsUntilNextMonthUtc() };
    }
    const after = await _bumpCounter('monthly_usage', { key, year_month: monthUtc() });
    return { allowed: true, runsThisMonth: after, monthlyLimit: PRO_MONTHLY_LIMIT };
  } catch (e) {
    console.error('[ratelimit] pro monthly check failed (fail-open):', e.message);
    return { allowed: true, runsThisMonth: 0, monthlyLimit: PRO_MONTHLY_LIMIT };
  }
}

// ─── Key registration daily cap ────────────────────────────────────────────

async function checkRegistration(ip) {
  if (isInternalIp(ip)) return { allowed: true };
  try {
    const current = await _readCounter('registration_usage', { ip, date: todayUtc() }, 'count');
    if (current >= REGISTRATION_PER_IP) {
      return { allowed: false, reason: 'registration_limit_exceeded',
               attemptsToday: current, dailyLimit: REGISTRATION_PER_IP,
               retryAfterSec: secondsUntilUtcMidnight() };
    }
    const after = await _bumpCounter('registration_usage', { ip, date: todayUtc() }, 'count');
    return { allowed: true, attemptsToday: after, dailyLimit: REGISTRATION_PER_IP };
  } catch (e) {
    console.error('[ratelimit] registration check failed (fail-open):', e.message);
    return { allowed: true };
  }
}

// ─── Time helpers ─────────────────────────────────────────────────────────

function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((next - now) / 1000);
}
function secondsUntilNextMonthUtc() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.ceil((next - now) / 1000);
}

module.exports = {
  getClientIp, isInternalIp,
  checkAnonymousDaily, checkBurst, checkProMonthly, checkRegistration,
  ANON_DAILY_LIMIT, ANON_BURST_PER_MIN,
  FREE_BURST_PER_MIN,
  PRO_MONTHLY_LIMIT, PRO_BURST_PER_MIN,
  REGISTRATION_PER_IP,
};
