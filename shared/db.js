const { Pool } = require('pg');

// Pool is constructed even without DATABASE_URL so this module loads cleanly
// in CI / static analysis. The actual env-var check happens in initSchema()
// and any query will fail naturally if the connection string is missing.
const local = process.env.DATABASE_URL && /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

// Core pg pool. Sized for the agent-builder + agent-defender critical path.
// The hackathon events module owns a SEPARATE pool (max=3) inside the
// private events package so a runaway event query cannot starve core
// endpoints. Keep these sizes coordinated with Neon's connection cap.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 15,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[db] pool error:', err.message));

// All tables live in the gauntlet schema to avoid collisions with other
// projects on the same Neon database. Every query uses gauntlet.<table>.
async function initSchema() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const stmts = [
    'CREATE SCHEMA IF NOT EXISTS gauntlet',
    `CREATE TABLE IF NOT EXISTS gauntlet.visitors (
      visitor_id          TEXT    PRIMARY KEY,
      handle              TEXT    NOT NULL,
      first_seen          BIGINT  NOT NULL,
      last_seen           BIGINT  NOT NULL,
      visit_count         INTEGER NOT NULL DEFAULT 0,
      complete_count      INTEGER NOT NULL DEFAULT 0,
      block_count         INTEGER NOT NULL DEFAULT 0,
      stepup_encountered  INTEGER NOT NULL DEFAULT 0,
      stepup_passed       INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.sessions (
      session_id   TEXT    PRIMARY KEY,
      visitor_id   TEXT    NOT NULL REFERENCES gauntlet.visitors(visitor_id),
      scenario     TEXT    NOT NULL,
      started_at   BIGINT  NOT NULL,
      ended_at     BIGINT  NOT NULL,
      outcome      TEXT    NOT NULL,
      risk_score   INTEGER NOT NULL,
      risk_tier    TEXT    NOT NULL,
      elapsed_ms   INTEGER,
      had_step_up  INTEGER NOT NULL DEFAULT 0,
      agent_mode   TEXT    NOT NULL DEFAULT 'headless',
      ja3_hash     TEXT,
      user_agent   TEXT,
      api_key      TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.session_signals (
      id          SERIAL  PRIMARY KEY,
      session_id  TEXT    NOT NULL,
      signal      TEXT    NOT NULL,
      fired_at    BIGINT  NOT NULL
    )`,
    // Denormalised per-session rollup that survives the 7-day TTL on sessions /
    // session_signals / telemetry_snapshots. This is the durable source of truth
    // for the leaderboard. Every recordTerminalVisit() writes one row here in
    // addition to the existing sessions / session_signals writes.
    `CREATE TABLE IF NOT EXISTS gauntlet.leaderboard_entries (
      session_id        TEXT     PRIMARY KEY,
      visitor_id        TEXT     NOT NULL,
      handle            TEXT     NOT NULL,
      scenario          TEXT     NOT NULL,
      outcome           TEXT     NOT NULL,
      risk_score        INTEGER  NOT NULL,
      risk_tier         TEXT     NOT NULL,
      had_step_up       INTEGER  NOT NULL DEFAULT 0,
      step_up_passed    INTEGER  NOT NULL DEFAULT 0,
      agent_mode        TEXT     NOT NULL DEFAULT 'headless',
      api_key           TEXT,
      ja3_hash          TEXT,
      user_agent        TEXT,
      elapsed_ms        INTEGER,
      signal_dimensions JSONB    NOT NULL DEFAULT '{}'::jsonb,
      signal_counts     JSONB    NOT NULL DEFAULT '{}'::jsonb,
      ended_at          BIGINT   NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.telemetry_snapshots (
      id          SERIAL  PRIMARY KEY,
      session_id  TEXT    NOT NULL,
      seq         INTEGER NOT NULL,
      step        INTEGER,
      captured_at BIGINT  NOT NULL,
      payload     TEXT    NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.visitor_ja3 (
      visitor_id  TEXT    NOT NULL,
      ja3_hash    TEXT    NOT NULL,
      seen_at     BIGINT  NOT NULL,
      PRIMARY KEY (visitor_id, ja3_hash)
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.visitor_ua (
      visitor_id  TEXT    NOT NULL,
      user_agent  TEXT    NOT NULL,
      seen_at     BIGINT  NOT NULL,
      PRIMARY KEY (visitor_id, user_agent)
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.api_keys (
      key        TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      email      TEXT    NOT NULL,
      tier       TEXT    NOT NULL DEFAULT 'free',
      created_at BIGINT  NOT NULL,
      last_used  BIGINT,
      active     INTEGER NOT NULL DEFAULT 1
    )`,
    // Enterprise pub/secret key pair for detect.js customers — separate
    // from the agg_* agent-builder keys. The pub key is embedded in
    // <script data-key="..."> on customer sites; the secret never leaves
    // the customer's backend. Each pair is linked to an OAuth identity
    // (the human who provisioned it) so the management UI can list/edit.
    `CREATE TABLE IF NOT EXISTS gauntlet.enterprise_keys (
      pub_key              TEXT    PRIMARY KEY,
      secret_hash          TEXT    NOT NULL,
      name                 TEXT    NOT NULL,
      owner_oauth_provider TEXT,
      owner_oauth_id       TEXT,
      owner_email          TEXT,
      created_at           BIGINT  NOT NULL,
      last_used            BIGINT,
      active               INTEGER NOT NULL DEFAULT 1
    )`,
    // Domains registered per enterprise pub key. /api/detect/token rejects
    // any Origin whose hostname isn't in this list (Phase 3b domain
    // locking). Many-to-one with enterprise_keys; ON DELETE CASCADE so
    // revoking a pub key cleans up its domains.
    `CREATE TABLE IF NOT EXISTS gauntlet.enterprise_domains (
      pub_key   TEXT   NOT NULL REFERENCES gauntlet.enterprise_keys(pub_key) ON DELETE CASCADE,
      domain    TEXT   NOT NULL,
      added_at  BIGINT NOT NULL,
      PRIMARY KEY (pub_key, domain)
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.daily_usage (
      key   TEXT    NOT NULL REFERENCES gauntlet.api_keys(key),
      date  TEXT    NOT NULL,
      runs  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key, date)
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.monthly_usage (
      key        TEXT    NOT NULL REFERENCES gauntlet.api_keys(key),
      year_month TEXT    NOT NULL,
      runs       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key, year_month)
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.anonymous_usage (
      ip    TEXT    NOT NULL,
      date  TEXT    NOT NULL,
      runs  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip, date)
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.burst_usage (
      bucket  TEXT    NOT NULL,
      minute  TEXT    NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, minute)
    )`,
    `CREATE TABLE IF NOT EXISTS gauntlet.registration_usage (
      ip    TEXT    NOT NULL,
      date  TEXT    NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip, date)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_sessions_visitor  ON gauntlet.sessions(visitor_id)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_scenario ON gauntlet.sessions(scenario)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_ended    ON gauntlet.sessions(ended_at)',
    'CREATE INDEX IF NOT EXISTS idx_signals_session   ON gauntlet.session_signals(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_lb_entries_visitor  ON gauntlet.leaderboard_entries(visitor_id)',
    'CREATE INDEX IF NOT EXISTS idx_lb_entries_scenario ON gauntlet.leaderboard_entries(scenario, ended_at)',
    'CREATE INDEX IF NOT EXISTS idx_lb_entries_ended_at ON gauntlet.leaderboard_entries(ended_at)',
    'CREATE INDEX IF NOT EXISTS idx_lb_entries_api_key  ON gauntlet.leaderboard_entries(api_key) WHERE api_key IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_telemetry_session ON gauntlet.telemetry_snapshots(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_visitor_ja3       ON gauntlet.visitor_ja3(visitor_id)',
    'CREATE INDEX IF NOT EXISTS idx_visitor_ua        ON gauntlet.visitor_ua(visitor_id)',
    'CREATE INDEX IF NOT EXISTS idx_daily_usage_key   ON gauntlet.daily_usage(key)',
    'CREATE INDEX IF NOT EXISTS idx_ent_keys_owner    ON gauntlet.enterprise_keys(owner_oauth_provider, owner_oauth_id) WHERE owner_oauth_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_ent_keys_active   ON gauntlet.enterprise_keys(pub_key) WHERE active = 1',
    'CREATE INDEX IF NOT EXISTS idx_ent_domains_pub   ON gauntlet.enterprise_domains(pub_key)',
    'CREATE INDEX IF NOT EXISTS idx_anon_usage_date   ON gauntlet.anonymous_usage(date)',
    'CREATE INDEX IF NOT EXISTS idx_burst_usage_min   ON gauntlet.burst_usage(minute)',
    'CREATE INDEX IF NOT EXISTS idx_reg_usage_date    ON gauntlet.registration_usage(date)',
    // OAuth columns — safe to run on existing tables
    'ALTER TABLE gauntlet.api_keys ADD COLUMN IF NOT EXISTS oauth_provider TEXT',
    'ALTER TABLE gauntlet.api_keys ADD COLUMN IF NOT EXISTS oauth_id       TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_oauth ON gauntlet.api_keys(oauth_provider, oauth_id) WHERE oauth_provider IS NOT NULL',
    // CV mode column — safe to run on existing tables
    "ALTER TABLE gauntlet.sessions ADD COLUMN IF NOT EXISTS agent_mode TEXT NOT NULL DEFAULT 'headless'",
    'CREATE INDEX IF NOT EXISTS idx_sessions_mode ON gauntlet.sessions(agent_mode)',
  ];
  for (const sql of stmts) await pool.query(sql);
}

// Runs fn(client) inside a BEGIN/COMMIT block on a dedicated client.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction, initSchema };
