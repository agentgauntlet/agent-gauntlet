#!/usr/bin/env node
//
// One-time backfill of gauntlet.leaderboard_entries from the existing
// gauntlet.sessions + gauntlet.session_signals tables.
//
// Run AFTER deploying the dual-write change to recordVisit(), but BEFORE
// switching the leaderboard query to read from leaderboard_entries. After
// this completes, the new table contains every session ever recorded plus
// any new sessions written by the live dual-write.
//
// Idempotent: re-running it skips already-backfilled rows via LEFT JOIN
// and INSERT ... ON CONFLICT DO NOTHING. Safe to interrupt and resume.
//
// Usage:
//   node scripts/backfill-leaderboard-entries.js
//   node scripts/backfill-leaderboard-entries.js --batch 1000
//   node scripts/backfill-leaderboard-entries.js --dry-run

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool }                       = require('../shared/db');
const { aggregateSignals }           = require('../shared/pg-visitor-store');

const G = 'gauntlet';

function parseArgs() {
  const args = process.argv.slice(2);
  const batchIdx = args.indexOf('--batch');
  return {
    batchSize: batchIdx >= 0 ? Math.max(1, Number(args[batchIdx + 1]) || 500) : 500,
    dryRun:    args.includes('--dry-run'),
  };
}

// Fetch one batch of sessions that aren't yet in leaderboard_entries.
// LEFT JOIN ... IS NULL is significantly faster than NOT IN once the new
// table grows large.
async function fetchBatch(limit) {
  const { rows } = await pool.query(`
    SELECT
      s.session_id, s.visitor_id, v.handle,
      s.scenario, s.outcome, s.risk_score, s.risk_tier,
      COALESCE(s.had_step_up, 0)             AS had_step_up,
      COALESCE(s.agent_mode, 'headless')     AS agent_mode,
      s.api_key, s.ja3_hash, s.user_agent, s.elapsed_ms, s.ended_at
    FROM       ${G}.sessions s
    JOIN       ${G}.visitors v  ON v.visitor_id = s.visitor_id
    LEFT JOIN  ${G}.leaderboard_entries le ON le.session_id = s.session_id
    WHERE      le.session_id IS NULL
    ORDER BY   s.ended_at ASC
    LIMIT      $1
  `, [limit]);
  return rows;
}

// Fetch all session_signals rows for a batch of session_ids in one query.
async function signalsForSessions(sessionIds) {
  if (sessionIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT session_id, signal FROM ${G}.session_signals WHERE session_id = ANY($1) ORDER BY id`,
    [sessionIds],
  );
  const byId = new Map();
  for (const r of rows) {
    const arr = byId.get(r.session_id) || [];
    arr.push(r.signal);
    byId.set(r.session_id, arr);
  }
  return byId;
}

async function insertBatch(rows) {
  if (rows.length === 0) return 0;
  const sigsByIdMap = await signalsForSessions(rows.map(r => r.session_id));

  const valueGroups = [];
  const params      = [];
  let   p           = 1;
  for (const r of rows) {
    const signals               = sigsByIdMap.get(r.session_id) || [];
    const { counts, dimensions } = aggregateSignals(signals);
    const stepUpPassed           = r.had_step_up === 1 && r.outcome === 'complete' ? 1 : 0;

    valueGroups.push(
      `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},` +
      `$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`,
    );
    params.push(
      r.session_id, r.visitor_id, r.handle,
      r.scenario || 'unknown', r.outcome,
      r.risk_score, r.risk_tier,
      r.had_step_up, stepUpPassed,
      r.agent_mode || 'headless',
      r.api_key  || null,
      r.ja3_hash || null,
      r.user_agent ? r.user_agent.slice(0, 200) : null,
      r.elapsed_ms ?? null,
      JSON.stringify(dimensions), JSON.stringify(counts),
      Number(r.ended_at),
    );
  }

  await pool.query(`
    INSERT INTO ${G}.leaderboard_entries
      (session_id, visitor_id, handle, scenario, outcome,
       risk_score, risk_tier, had_step_up, step_up_passed,
       agent_mode, api_key, ja3_hash, user_agent, elapsed_ms,
       signal_dimensions, signal_counts, ended_at)
    VALUES ${valueGroups.join(',\n           ')}
    ON CONFLICT (session_id) DO NOTHING
  `, params);

  return valueGroups.length;
}

async function countRemaining() {
  const { rows: [row] } = await pool.query(`
    SELECT COUNT(*)::int AS remaining
    FROM       ${G}.sessions s
    LEFT JOIN  ${G}.leaderboard_entries le ON le.session_id = s.session_id
    WHERE      le.session_id IS NULL
  `);
  return row?.remaining ?? 0;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set. Add it to .env or pass inline.');
    process.exit(1);
  }

  const { batchSize, dryRun } = parseArgs();
  const remaining             = await countRemaining();

  console.log(`Sessions awaiting backfill: ${remaining}`);
  console.log(`Batch size: ${batchSize}${dryRun ? '  (DRY RUN)' : ''}`);

  if (remaining === 0) {
    console.log('Nothing to do — leaderboard_entries already in sync.');
    process.exit(0);
  }
  if (dryRun) {
    const sample = await fetchBatch(Math.min(5, batchSize));
    console.log(`\nFirst ${sample.length} candidate sessions:`);
    for (const r of sample) {
      console.log(`  - ${r.session_id}  visitor=${r.visitor_id.slice(0, 8)}…  scenario=${r.scenario}  ended=${new Date(Number(r.ended_at)).toISOString()}`);
    }
    process.exit(0);
  }

  let inserted   = 0;
  let batchCount = 0;
  const t0       = Date.now();
  for (;;) {
    const batch = await fetchBatch(batchSize);
    if (batch.length === 0) break;
    const n = await insertBatch(batch);
    inserted   += n;
    batchCount += 1;
    const elapsed = (Date.now() - t0) / 1000;
    const rate    = elapsed > 0 ? inserted / elapsed : 0;
    console.log(`Batch ${batchCount}: +${n}  (total ${inserted}/${remaining}, ${rate.toFixed(0)}/s)`);
  }

  console.log(`\nDone. Inserted ${inserted} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  process.exit(0);
}

main().catch(e => {
  console.error('\nBackfill failed:', e.message);
  process.exit(1);
});
