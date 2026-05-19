// Isolation contract tests — enforce the one-way dependency from the
// hackathon events module into core. These run on every PR and fail the
// build if anyone accidentally introduces a coupling that lets event code
// reach into core or vice versa.
//
// What we enforce:
//   1. No core file (shared/*.js, *-checkout/, bank-login/, etc.) imports
//      anything from private/events. Dependency direction is one-way.
//   2. The conditional require() in shared/scenario.js follows the
//      ENABLE_EVENTS feature flag pattern and is wrapped in try/catch.
//   3. scenario.js can be required cleanly with ENABLE_EVENTS unset
//      (the common production state for environments without events).
//   4. Core schema definitions in shared/db.js do not reference the
//      hackathon's tables (events / event_members live in the private
//      package, not in core).
//
// To run locally:
//   node --test tests/isolation.test.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');

// Files that constitute "core" — anything in shared/ plus the per-scenario
// servers. None of these may require ../private/events or @agentgauntlet/events.
const CORE_FILE_GLOBS = [
  'shared/scenario.js',
  'shared/api-keys.js',
  'shared/pg-visitor-store.js',
  'shared/visitor-store.js',
  'shared/sqlite-visitor-store.js',
  'shared/db.js',
  'shared/scoring.js',
  'shared/risk.js',
  'shared/rate-limit.js',
  'shared/detect-token.js',
  'shared/enterprise-keys.js',
  'shared/ja3-known.js',
  'shared/tls-fingerprint.js',
  'cart-checkout/server.js',
  'cart-checkout/visitor-store.js',
  'payment-checkout/server.js',
  'bank-login/server.js',
  'product-search/server.js',
  'auction/server.js',
  'crypto-exchange/server.js',
  'image-captcha/server.js',
  'landing/server.js',
];

function readCore(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('no core file imports private/events directly', () => {
  // The ONE exception is shared/scenario.js, which contains the conditional
  // require() guarded by ENABLE_EVENTS — that's the intentional seam.
  for (const file of CORE_FILE_GLOBS) {
    if (file === 'shared/scenario.js') continue;
    const src = readCore(file);
    const m = src.match(/require\s*\(\s*['"][^'"]*private\/events[^'"]*['"]\s*\)/);
    assert.ok(!m,
      `${file} must not require private/events directly. ` +
      `The only allowed require is the conditional one in shared/scenario.js.`);
    const m2 = src.match(/require\s*\(\s*['"]@agentgauntlet\/events['"]\s*\)/);
    assert.ok(!m2,
      `${file} must not require @agentgauntlet/events directly.`);
  }
});

test('shared/scenario.js mounts events behind ENABLE_EVENTS flag with try/catch', () => {
  const src = readCore('shared/scenario.js');

  // Must reference the env var
  assert.ok(/ENABLE_EVENTS/.test(src),
    'shared/scenario.js must gate the events mount on ENABLE_EVENTS env var');

  // Must require the events module from the submodule path
  assert.ok(/require\s*\(\s*['"]\.\.\/private\/events\/src['"]\s*\)/.test(src),
    'shared/scenario.js must require events from the submodule path ../private/events/src');

  // The require must be wrapped in try/catch so missing submodule doesn't crash core
  const eventsRegion = src.match(/ENABLE_EVENTS[\s\S]{0,2000}/);
  assert.ok(eventsRegion, 'expected to find ENABLE_EVENTS region');
  assert.ok(/try\s*\{/.test(eventsRegion[0]) && /catch/.test(eventsRegion[0]),
    'events require must be wrapped in try/catch');
});

test('shared/scenario.js loads cleanly with ENABLE_EVENTS unset', () => {
  // We can't fully instantiate createScenario without a DATABASE_URL etc.,
  // but the module itself must require() cleanly — that's what the deploy
  // syntax-check job tests against in CI.
  const prev = process.env.ENABLE_EVENTS;
  delete process.env.ENABLE_EVENTS;
  try {
    // Clear require cache so we test a fresh load
    const scenarioPath = require.resolve(path.join(ROOT, 'shared/scenario.js'));
    delete require.cache[scenarioPath];
    const mod = require(scenarioPath);
    assert.ok(typeof mod.createScenario === 'function',
      'shared/scenario.js must export createScenario');
  } finally {
    if (prev !== undefined) process.env.ENABLE_EVENTS = prev;
  }
});

test('core db.js does not define hackathon tables', () => {
  // The events and event_members tables live in the private events
  // package's schema.js, not in core. If they ever leak into shared/db.js,
  // core has implicitly taken ownership of hackathon state and the
  // isolation contract is broken.
  const src = readCore('shared/db.js');
  assert.ok(!/CREATE TABLE[^;]*\bgauntlet\.events\b/i.test(src),
    'shared/db.js must not define gauntlet.events — that schema is owned by the events package');
  assert.ok(!/CREATE TABLE[^;]*\bgauntlet\.event_members\b/i.test(src),
    'shared/db.js must not define gauntlet.event_members — that schema is owned by the events package');
});

test('core pg pool is sized for production load', () => {
  // The events package owns its own small pool. Core needs enough
  // connections to handle agent-builder + agent-defender + leaderboard
  // traffic without being starved.
  const src = readCore('shared/db.js');
  const m = src.match(/max:\s*(\d+)/);
  assert.ok(m, 'shared/db.js must declare an explicit max on the core pool');
  const max = Number(m[1]);
  assert.ok(max >= 10,
    `core pg pool max should be at least 10 (got ${max}); events package owns a separate small pool`);
});

test('events host scenario default matches an actual scenario name', () => {
  // Regression test for the bug that bricked Phases 0-5 in production:
  // the events mount block in scenario.js guards on
  //   scenario === (process.env.EVENTS_HOST_SCENARIO || 'cart')
  // The default value MUST match one of the scenario names that the
  // per-scenario servers actually pass to createScenario() — otherwise
  // the condition is never satisfied and the events module silently
  // fails to mount on any service.
  //
  // Previously this defaulted to 'cart-checkout' (the directory name)
  // while cart-checkout/server.js registers as scenario: 'cart'. The
  // bug was invisible until production smoke-test because all unit
  // tests stubbed createScenario.
  const scenarioSrc = readCore('shared/scenario.js');
  const defaultMatch = scenarioSrc.match(/EVENTS_HOST_SCENARIO\s*\|\|\s*['"]([^'"]+)['"]/);
  assert.ok(defaultMatch,
    `expected to find EVENTS_HOST_SCENARIO default in shared/scenario.js`);
  const defaultName = defaultMatch[1];

  // Scenario services that actually mount endpoints via createScenario().
  // 'landing' is not in this list — it's a thin proxy with no scenario.
  const serverDirs = [
    'cart-checkout', 'bank-login', 'payment-checkout', 'product-search',
    'auction', 'crypto-exchange', 'image-captcha',
  ];
  const realNames = [];
  for (const dir of serverDirs) {
    const src = readCore(path.join(dir, 'server.js'));
    const m   = src.match(/scenario:\s*['"]([^'"]+)['"]/);
    if (m) realNames.push(m[1]);
  }

  assert.ok(realNames.length > 0,
    'could not extract any scenario names from per-scenario servers');
  assert.ok(realNames.includes(defaultName),
    `EVENTS_HOST_SCENARIO default '${defaultName}' must match one of the actual ` +
    `scenario names (${realNames.join(', ')}). Otherwise the events mount block ` +
    `in shared/scenario.js becomes dead code and ENABLE_EVENTS=true has no effect.`);
});
