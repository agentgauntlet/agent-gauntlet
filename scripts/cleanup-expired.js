#!/usr/bin/env node
//
// Daily TTL cleanup. Hard-deletes detail rows older than the retention window:
//   • gauntlet.telemetry_snapshots   (largest table — biggest storage win)
//   • gauntlet.session_signals
//   • gauntlet.sessions
//
// gauntlet.leaderboard_entries is NEVER touched — it's the durable ranking
// record and outlives session detail by design.
//
// Idempotent: re-running on the same day finds nothing to delete. Wrapped in
// a single transaction so a failure mid-cleanup leaves the DB consistent.
//
// Usage:
//   node scripts/cleanup-expired.js                 # 7-day retention
//   node scripts/cleanup-expired.js --days 14       # override
//   node scripts/cleanup-expired.js --dry-run       # report counts, no deletes

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, withTransaction } = require('../shared/db');

const G = 'gauntlet';
const DEFAULT_RETENTION_DAYS = 7;

function parseArgs() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  return {
    days:   daysIdx >= 0 ? Math.max(1, Number(args[daysIdx + 1]) || DEFAULT_RETENTION_DAYS) : DEFAULT_RETENTION_DAYS,
    dryRun: args.includes('--dry-run'),
  };
}

async function countWhere(table, whereClause, params) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM ${G}.${table} WHERE ${whereClause}`,
    params,
  );
  return r?.c ?? 0;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set');
    process.exit(1);
  }

  const { days, dryRun } = parseArgs();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  console.log(`Retention: ${days} days   cutoff: ${new Date(cutoff).toISOString()}`);
  console.log(`Mode:      ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  // Eligible counts. The child tables (session_signals, telemetry_snapshots)
  // are joined via session_id rather than their own timestamp so a single
  // cutoff drives all three deletes — and so the deletes can use the indexed
  // sessions.ended_at lookup rather than full-scanning the bigger child tables.
  const eligibleSessions = await countWhere('sessions',
    'ended_at < $1', [cutoff]);
  const eligibleSignals  = await countWhere('session_signals',
    `session_id IN (SELECT session_id FROM ${G}.sessions WHERE ended_at < $1)`, [cutoff]);
  const eligibleTel      = await countWhere('telemetry_snapshots',
    `session_id IN (SELECT session_id FROM ${G}.sessions WHERE ended_at < $1)`, [cutoff]);

  console.log('\nEligible for deletion:');
  console.log(`  telemetry_snapshots: ${eligibleTel}`);
  console.log(`  session_signals:     ${eligibleSignals}`);
  console.log(`  sessions:            ${eligibleSessions}`);

  if (eligibleSessions === 0) {
    console.log('\nNothing to delete.');
    process.exit(0);
  }
  if (dryRun) {
    console.log('\n(--dry-run) — no deletes performed.');
    process.exit(0);
  }

  const t0 = Date.now();
  const deleted = await withTransaction(async (client) => {
    // Order matters: child rows (telemetry, signals) reference sessions.session_id
    // in their WHERE subquery. Delete sessions LAST so those lookups still resolve.
    const r1 = await client.query(
      `DELETE FROM ${G}.telemetry_snapshots
       WHERE session_id IN (SELECT session_id FROM ${G}.sessions WHERE ended_at < $1)`,
      [cutoff],
    );
    const r2 = await client.query(
      `DELETE FROM ${G}.session_signals
       WHERE session_id IN (SELECT session_id FROM ${G}.sessions WHERE ended_at < $1)`,
      [cutoff],
    );
    const r3 = await client.query(
      `DELETE FROM ${G}.sessions WHERE ended_at < $1`, [cutoff],
    );
    return { tel: r1.rowCount, sigs: r2.rowCount, sessions: r3.rowCount };
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDeleted in ${elapsed}s:`);
  console.log(`  telemetry_snapshots: ${deleted.tel}`);
  console.log(`  session_signals:     ${deleted.sigs}`);
  console.log(`  sessions:            ${deleted.sessions}`);
  process.exit(0);
}

main().catch(e => {
  console.error('\nCleanup failed:', e.message);
  process.exit(1);
});
