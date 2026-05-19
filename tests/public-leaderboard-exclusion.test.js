// Unit tests for the public leaderboard's exclusion-window mechanism.
//
// The helpers are deliberately pure (no DB, no state), so they're tested
// in isolation here. The end-to-end behavior — that a row in an excluded
// window doesn't show up on the public board — is exercised by the
// smoke-test in the commit message.

'use strict';

const fs   = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const { parseExcludedWindows, buildExclusionClause } =
  require(path.join(ROOT, 'shared', 'pg-visitor-store'));

const src = fs.readFileSync(path.join(ROOT, 'shared', 'pg-visitor-store.js'), 'utf8');

// ───────── parseExcludedWindows ──────────────────────────────────────────

test('parseExcludedWindows: no env var → empty list', () => {
  const prev = process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  delete process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  try {
    assert.deepEqual(parseExcludedWindows(), []);
  } finally {
    if (prev !== undefined) process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = prev;
  }
});

test('parseExcludedWindows: single valid window', () => {
  const prev = process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS =
    JSON.stringify([{ start: 1000, end: 2000, label: 'aihack' }]);
  try {
    const w = parseExcludedWindows();
    assert.equal(w.length, 1);
    assert.equal(w[0].start, 1000);
    assert.equal(w[0].end, 2000);
    assert.equal(w[0].label, 'aihack');
  } finally {
    if (prev !== undefined) process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = prev;
    else                    delete process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  }
});

test('parseExcludedWindows: multiple windows preserved', () => {
  const prev = process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = JSON.stringify([
    { start: 1000, end: 2000 },
    { start: 5000, end: 6000, label: 'qa' },
  ]);
  try {
    assert.equal(parseExcludedWindows().length, 2);
  } finally {
    if (prev !== undefined) process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = prev;
    else                    delete process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  }
});

test('parseExcludedWindows: malformed JSON → empty list (graceful)', () => {
  const prev = process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = '{not json';
  try {
    assert.deepEqual(parseExcludedWindows(), []);
  } finally {
    if (prev !== undefined) process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = prev;
    else                    delete process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  }
});

test('parseExcludedWindows: non-array → empty list', () => {
  const prev = process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = JSON.stringify({ not: 'array' });
  try {
    assert.deepEqual(parseExcludedWindows(), []);
  } finally {
    if (prev !== undefined) process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = prev;
    else                    delete process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  }
});

test('parseExcludedWindows: drops invalid entries (NaN, end<=start, missing fields)', () => {
  const prev = process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = JSON.stringify([
    { start: 'nope', end: 2000 },          // invalid start
    { start: 1000, end: 'nope' },          // invalid end
    { start: 2000, end: 1000 },            // end < start
    { start: 1000, end: 1000 },            // zero-duration
    null,                                   // not object
    { label: 'no times' },                  // missing fields
    { start: 100, end: 200 },               // VALID
  ]);
  try {
    const w = parseExcludedWindows();
    assert.equal(w.length, 1);
    assert.equal(w[0].start, 100);
    assert.equal(w[0].end, 200);
  } finally {
    if (prev !== undefined) process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS = prev;
    else                    delete process.env.PUBLIC_LEADERBOARD_EXCLUDED_WINDOWS;
  }
});

// ───────── buildExclusionClause ──────────────────────────────────────────

test('buildExclusionClause: no windows → empty sql + empty params', () => {
  const r = buildExclusionClause([], 1);
  assert.equal(r.sql, '');
  assert.deepEqual(r.params, []);
});

test('buildExclusionClause: one window starting at $1', () => {
  const r = buildExclusionClause([{ start: 100, end: 200 }], 1);
  assert.equal(r.sql, ' AND NOT ((ended_at BETWEEN $1 AND $2))');
  assert.deepEqual(r.params, [100, 200]);
});

test('buildExclusionClause: one window starting at $5 (param offset)', () => {
  const r = buildExclusionClause([{ start: 100, end: 200 }], 5);
  assert.equal(r.sql, ' AND NOT ((ended_at BETWEEN $5 AND $6))');
  assert.deepEqual(r.params, [100, 200]);
});

test('buildExclusionClause: two windows OR-joined', () => {
  const r = buildExclusionClause(
    [{ start: 100, end: 200 }, { start: 500, end: 600 }],
    1,
  );
  assert.equal(r.sql,
    ' AND NOT ((ended_at BETWEEN $1 AND $2) OR (ended_at BETWEEN $3 AND $4))');
  assert.deepEqual(r.params, [100, 200, 500, 600]);
});

// ───────── Isolation: source must not reference event-specific concepts ──

test('pg-visitor-store.js exclusion code is generic (no event/hackathon references)', () => {
  // Strip block + line comments so the test inspects only executable code.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  // The exclusion mechanism is generic. It must not name any specific
  // consumer that drives it (events, hackathon, cohort, etc.).
  for (const re of [/\bevents?\b/i, /\bhackathon\b/i, /\bcohort\b/i]) {
    assert.ok(!re.test(stripped),
      `pg-visitor-store.js code (non-comment) must not reference "${re}"`);
  }
});
