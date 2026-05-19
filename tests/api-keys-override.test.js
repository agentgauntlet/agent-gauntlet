// Contract tests for the daily-limit override provider hook in api-keys.js.
//
// The hook is intentionally GENERIC: api-keys.js knows nothing about who
// the provider is or what it represents. Any module (event hosting, beta
// program, support tickets, paid-tier promotions) can register a provider
// and api-keys.js calls it without coupling.
//
// These tests verify:
//   1. setOverrideProvider is exported and accepts function or null
//   2. setOverrideProvider rejects invalid input (non-function, non-null)
//   3. api-keys.js source has no references to any specific consumer
//      (no mention of "events", no require of private/, etc.)
//
// The functional path — that checkAndIncrementUsage actually uses the
// provider's return value as the daily limit — is verified by the events
// package's own smoke test against a live DB, since it requires the full
// Postgres usage table flow.

'use strict';

const fs   = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT       = path.join(__dirname, '..');
const apiKeys    = require(path.join(ROOT, 'shared', 'api-keys'));
const apiKeysSrc = fs.readFileSync(path.join(ROOT, 'shared', 'api-keys.js'), 'utf8');

test('setOverrideProvider is exported as a function', () => {
  assert.equal(typeof apiKeys.setOverrideProvider, 'function');
});

test('setOverrideProvider accepts a function', () => {
  assert.doesNotThrow(() => apiKeys.setOverrideProvider(async () => null));
  // Reset to null afterward so other tests don't leak state.
  apiKeys.setOverrideProvider(null);
});

test('setOverrideProvider accepts null (unregister)', () => {
  assert.doesNotThrow(() => apiKeys.setOverrideProvider(null));
});

test('setOverrideProvider rejects non-function, non-null input', () => {
  for (const bad of [42, 'string', {}, [], true]) {
    assert.throws(() => apiKeys.setOverrideProvider(bad),
      `should reject ${typeof bad}: ${JSON.stringify(bad)}`);
  }
});

test('api-keys.js does not mention any specific consumer (events, beta, etc.)', () => {
  // Strip block + line comments so the test inspects only executable code.
  const stripped = apiKeysSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  // The override hook is generic — it must not name any specific feature
  // that consumes it.
  const banned = [
    /\bevents?\b/i,           // "event" or "events"
    /\bhackathon\b/i,
    /\bcohort\b/i,
    /\bbeta\b/i,
    /private\/events/,
  ];

  for (const re of banned) {
    assert.ok(!re.test(stripped),
      `shared/api-keys.js code (non-comment) must not reference "${re}". ` +
      `The override-provider hook is generic; specific consumers register from outside.`);
  }
});

test('api-keys.js does not require anything from private/ or @agentgauntlet/events', () => {
  assert.ok(!/require\s*\(\s*['"][^'"]*private[^'"]*['"]\s*\)/.test(apiKeysSrc),
    'shared/api-keys.js must not require anything under private/');
  assert.ok(!/require\s*\(\s*['"]@agentgauntlet\/events['"]\s*\)/.test(apiKeysSrc),
    'shared/api-keys.js must not require @agentgauntlet/events');
});

test('checkAndIncrementUsage signature unchanged (still takes key, tier)', () => {
  // Smoke check that we didn't accidentally change the public API shape.
  // The function still takes 2 args and returns a promise — anything that
  // calls it from scenario.js continues to work.
  assert.equal(typeof apiKeys.checkAndIncrementUsage, 'function');
  assert.equal(apiKeys.checkAndIncrementUsage.length, 2,
    'checkAndIncrementUsage should still accept (key, tier)');
});
