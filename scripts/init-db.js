#!/usr/bin/env node
//
// Bootstrap the gauntlet.* schema in a Postgres database.
//
// Idempotent: safe to run against an existing database — uses CREATE
// SCHEMA / TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS throughout.
//
// Usage:
//   node scripts/init-db.js                       # uses DATABASE_URL from .env
//   DATABASE_URL=postgres://... node scripts/init-db.js
//
// Common cases:
//   - First-time bootstrap on a fresh Neon project
//   - Re-running after pulling a commit that adds new tables (rate-limit, etc.)
//   - Verifying schema state on a target DB before pointing prod at it

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, initSchema } = require('../shared/db');

// Sanitize so we never log the password.
function targetSummary(url) {
  try {
    const u = new URL(url);
    return `${u.username}@${u.hostname}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

const EXPECTED_TABLES = [
  'visitors', 'sessions', 'session_signals', 'telemetry_snapshots',
  'leaderboard_entries',
  'visitor_ja3', 'visitor_ua',
  'api_keys', 'daily_usage', 'monthly_usage',
  'anonymous_usage', 'burst_usage', 'registration_usage',
];

async function tableState() {
  const { rows } = await pool.query(`
    SELECT table_name,
           (SELECT reltuples::bigint
              FROM pg_class
             WHERE oid = ('gauntlet.' || quote_ident(table_name))::regclass) AS approx_rows
    FROM   information_schema.tables
    WHERE  table_schema = 'gauntlet'
    ORDER  BY table_name
  `);
  return rows;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set. Add it to .env or pass inline.');
    process.exit(1);
  }

  console.log(`Target: ${targetSummary(process.env.DATABASE_URL)}`);
  console.log('Running initSchema()…');

  const before = await tableState();
  if (before.length > 0) {
    console.log(`\nFound ${before.length} existing gauntlet.* tables:`);
    for (const r of before) console.log(`  - ${r.table_name}  (~${r.approx_rows} rows)`);
  } else {
    console.log('\nNo existing gauntlet schema — fresh database.');
  }

  await initSchema();

  const after = await tableState();
  const created = after.filter(a => !before.find(b => b.table_name === a.table_name));

  console.log(`\nSchema ready: ${after.length} tables in gauntlet.*`);
  if (created.length > 0) {
    console.log(`Created in this run:`);
    for (const r of created) console.log(`  + ${r.table_name}`);
  } else {
    console.log('No new tables created (schema already up to date).');
  }

  const missing = EXPECTED_TABLES.filter(t => !after.find(r => r.table_name === t));
  if (missing.length > 0) {
    console.error(`\nWARNING: expected tables missing: ${missing.join(', ')}`);
    process.exit(2);
  }

  console.log('\nAll expected tables present. Bootstrap complete.');
  process.exit(0);
}

main().catch(e => {
  console.error('\nBootstrap failed:', e.message);
  process.exit(1);
});
