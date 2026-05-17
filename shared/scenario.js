// Scenario factory — shared infrastructure for every AgentGauntlet scenario.
//
// Usage in a new scenario:
//
//   const { createScenario, randInt, newSessionBase, baseCumulative } = require('../shared/scenario');
//
//   const { app, sessions, accumulateTelemetry, actionGuard,
//           recordTerminalVisit, pruneSessions, start } = createScenario({
//     scenario:  'my-scenario',
//     apiPrefix: '/api/my-scenario',
//     staticDir: path.join(__dirname, 'public'),
//     port:      3004,
//     httpsPort: 3447,
//   });
//
//   // Register only your session-init + step routes on `app`.
//   // fingerprint, stepup-challenge, stepup-verify, visitor, leaderboard,
//   // risk-weights and debug/tls are all wired up automatically.
//
//   start(path.join(__dirname, '.certs'));

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express     = require('express');
const crypto      = require('crypto');
const path        = require('path');
const fs          = require('fs');
const { execSync } = require('child_process');
const tlsFp       = require('./tls-fingerprint');
const { computeRisk, computeHostedRisk, SIGNAL_WEIGHTS, THRESHOLDS, isSelfHosted } = require('./scoring');
const rateLimit = require('./rate-limit');
const { computeVisitorId, handleFor }              = require('./visitor-store');
const { PgVisitorStore }                           = require('./pg-visitor-store');
const { initSchema }                               = require('./db');
const https = require('https');
const { validateKey, checkAndIncrementUsage, createKey, getKeyInfo, findOrCreateOAuthKey, FREE_DAILY_LIMIT } = require('./api-keys');

// ─── Pure helpers (also exported at module level) ────────────────────────────

function randInt(min, maxExclusive) {
  return crypto.randomInt(min, maxExclusive);
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function scoreHeaders(headers) {
  const flags = { hard: [], soft: [] };
  const ua = headers['user-agent'] || '';
  if (!ua) flags.hard.push('no_user_agent');
  if (/HeadlessChrome|Headless/i.test(ua)) flags.hard.push('headless_in_ua');
  if (/curl\/|python-requests|Go-http-client|node-fetch|axios|wget|libwww-perl|okhttp/i.test(ua)) {
    flags.hard.push('non_browser_http_client');
  }
  if (!headers['accept-language']) flags.soft.push('no_accept_language');
  if (!headers['accept-encoding']) flags.soft.push('no_accept_encoding');
  if (/Chrome\/(?:1[1-9]\d|[2-9]\d{2})/.test(ua) && !headers['sec-ch-ua']) {
    flags.soft.push('chrome_ua_missing_client_hints');
  }
  return flags;
}

function scoreFingerprint(fp) {
  const flags = { hard: [], soft: [] };
  if (!fp || typeof fp !== 'object') { flags.hard.push('no_fingerprint_object'); return flags; }
  if (fp.webdriver === true) flags.hard.push('navigator_webdriver');
  if (fp.notifMismatch === true) flags.hard.push('headless_chrome_notif_mismatch');
  if (fp.screen && (fp.screen.width === 0 || fp.screen.height === 0)) flags.hard.push('zero_screen');
  if (fp.webglRenderer && /SwiftShader|Mesa Off-?Screen|llvmpipe|ANGLE \(Google,? SwiftShader/i.test(fp.webglRenderer)) {
    flags.soft.push('software_webgl_renderer');
  }
  if (fp.webglMissing === true) flags.soft.push('webgl_missing');
  const ua = fp.userAgent || '';
  const isDesktopChrome = /Chrome\/\d/.test(ua) && !/Mobile|Android/.test(ua);
  if (isDesktopChrome) {
    if (fp.pluginsLength === 0) flags.soft.push('zero_plugins_desktop_chrome');
    if (fp.chrome === false) flags.soft.push('chrome_object_missing');
  }
  if (fp.screen && fp.screen.width === 800 && fp.screen.height === 600) flags.soft.push('default_headless_viewport');
  if (!fp.canvasHash) flags.soft.push('no_canvas_hash');
  if (!fp.audioHash) flags.soft.push('no_audio_hash');
  if (typeof fp.rafFrame === 'number' && fp.rafFrame < 2) flags.soft.push('raf_unthrottled');
  return flags;
}

// Extracts TLS signals from a request; returns empty flags over plain HTTP.
function scoreTls(req) {
  const isHttps = req.protocol === 'https' || req.socket.encrypted === true;
  return isHttps ? tlsFp.scoreTls(req.tlsFingerprint) : { hard: [], soft: [] };
}

// keyTier controls how much detail is exposed in API responses.
//   anonymous           → score, tier, action only
//   free                → + signal names + handle (leaderboard identity)
//   pro / enterprise    → + breakdown, thresholds, handle
//
// Pass meta = { handle, visitorId } to include leaderboard identity for free+.
function publicRisk(risk, keyTier = 'free', meta = {}) {
  const base = { score: risk.score, tier: risk.tier, action: risk.action };
  if (!keyTier || keyTier === 'anonymous') {
    return base;
  }
  const identity = meta.handle ? { handle: meta.handle, visitorId: meta.visitorId } : {};
  if (keyTier === 'pro' || keyTier === 'enterprise') {
    return { ...base, ...identity, breakdown: risk.breakdown, thresholds: THRESHOLDS };
  }
  // free
  return { ...base, ...identity, signals: (risk.breakdown || []).map(b => b.signal) };
}

function send429(res, info) {
  if (info.retryAfterSec) res.set('Retry-After', String(info.retryAfterSec));
  return res.status(429).json({ ok: false, ...info });
}

// risk_tier → action mapping. Mirrors the assignments in shared/risk.js's
// computeRisk(); deriving rather than storing avoids drift when THRESHOLDS
// are tuned (the tier is authoritative at session time).
function actionForTier(tier) {
  if (tier === 'high')   return 'block';
  if (tier === 'medium') return 'step_up';
  return 'allow';
}

// Build the GET /api/session/:id/result payload. Three-tier:
//   anonymous     → never reaches here (attachApiKeyReadOnly returns 401)
//   free          → score / tier / action / scenario / outcome / duration_ms
//   pro / ent     → + breakdown (signal + weight pairs) + thresholds
//
// The breakdown is reconstructed from leaderboard_entries.signal_counts so it
// works after the 7-day TTL on session_signals — same data, denormalised at
// write time and aggregated at read time. Signals are emitted one entry per
// occurrence (matching computeRisk()'s breakdown shape) and sorted by weight
// descending so the highest-impact signals surface first.
function resultResponse(row, keyTier) {
  const base = {
    sessionId:    row.session_id,
    scenario:     row.scenario,
    outcome:      row.outcome,
    score:        row.risk_score,
    tier:         row.risk_tier,
    action:       actionForTier(row.risk_tier),
    duration_ms:  row.elapsed_ms,
    agent_mode:   row.agent_mode,
    ended_at:     Number(row.ended_at),
  };
  if (keyTier === 'pro' || keyTier === 'enterprise') {
    const counts    = row.signal_counts || {};
    const breakdown = [];
    for (const [signal, count] of Object.entries(counts)) {
      const weight = SIGNAL_WEIGHTS[signal] ?? 5; // unknown-signal default matches risk.js
      for (let i = 0; i < count; i++) breakdown.push({ signal, weight });
    }
    breakdown.sort((a, b) => b.weight - a.weight);
    return { ...base, breakdown, thresholds: THRESHOLDS };
  }
  return base;
}

// Middleware: validates x-api-key + enforces all rate limits.
//
// Anonymous: 5 sessions/day per IP, 3/min burst (rate-limit.js)
// Free key:  100/day (api-keys.js) + 20/min burst
// Pro key:   5000/month + 60/min burst
//
// Invalid key → 401. Any limit hit → 429 with Retry-After.
async function attachApiKey(req, res, next) {
  try {
    const ip       = rateLimit.getClientIp(req);
    req.clientIp   = ip;
    const rawKey   = req.headers['x-api-key'] || req.query.api_key;

    if (!rawKey) {
      const burst = await rateLimit.checkBurst(`ip:${ip}`, rateLimit.ANON_BURST_PER_MIN);
      if (!burst.allowed) return send429(res, burst);

      const day = await rateLimit.checkAnonymousDaily(ip);
      if (!day.allowed) {
        return send429(res, { ...day, hint: 'Sign up for a free API key for 100 runs/day.' });
      }
      req.apiKey  = null;
      req.keyTier = 'anonymous';
      return next();
    }

    const keyRow = await validateKey(rawKey);
    if (!keyRow || !keyRow.active) {
      return res.status(401).json({ ok: false, reason: 'invalid_api_key' });
    }

    const burstLimit = keyRow.tier === 'pro' || keyRow.tier === 'enterprise'
      ? rateLimit.PRO_BURST_PER_MIN : rateLimit.FREE_BURST_PER_MIN;
    const burst = await rateLimit.checkBurst(`key:${keyRow.key}`, burstLimit);
    if (!burst.allowed) return send429(res, burst);

    if (keyRow.tier === 'pro' || keyRow.tier === 'enterprise') {
      const month = await rateLimit.checkProMonthly(keyRow.key);
      if (!month.allowed) {
        return send429(res, { ...month, hint: 'Pro tier resets at the start of the next UTC month.' });
      }
    }

    const usage = await checkAndIncrementUsage(keyRow.key, keyRow.tier);
    if (!usage.allowed) {
      return send429(res, { ...usage, hint: 'Upgrade to Pro for higher limits.' });
    }

    req.apiKey  = keyRow.key;
    req.keyTier = keyRow.tier;
    next();
  } catch (e) {
    next(e);
  }
}

// Like attachApiKey but for read-only endpoints (e.g. session result lookup).
// Differences from attachApiKey:
//   • Anonymous → 401. Read endpoints always require a key.
//   • Does NOT increment daily/monthly usage. Daily quota is for runs, not
//     reads. Polling a result you already paid for shouldn't deplete it.
//   • Burst bucket is "key-read:<key>" — separate from "key:<key>" used by
//     run traffic. Heavy reading can't starve runs and vice versa.
//
// Burst limits (per minute, per key):
//   Free:            FREE_BURST_PER_MIN (20)
//   Pro / Enterprise: PRO_BURST_PER_MIN  (60)
async function attachApiKeyReadOnly(req, res, next) {
  try {
    const ip     = rateLimit.getClientIp(req);
    req.clientIp = ip;
    const rawKey = req.headers['x-api-key'] || req.query.api_key;

    if (!rawKey) {
      return res.status(401).json({ ok: false, reason: 'api_key_required' });
    }

    const keyRow = await validateKey(rawKey);
    if (!keyRow || !keyRow.active) {
      return res.status(401).json({ ok: false, reason: 'invalid_api_key' });
    }

    const burstLimit = keyRow.tier === 'pro' || keyRow.tier === 'enterprise'
      ? rateLimit.PRO_BURST_PER_MIN : rateLimit.FREE_BURST_PER_MIN;
    const burst = await rateLimit.checkBurst(`key-read:${keyRow.key}`, burstLimit);
    if (!burst.allowed) return send429(res, burst);

    req.apiKey  = keyRow.key;
    req.keyTier = keyRow.tier;
    next();
  } catch (e) {
    next(e);
  }
}

// Registration limit middleware: 5 keys/day per IP across manual + OAuth.
async function rateLimitRegistration(req, res, next) {
  const ip = rateLimit.getClientIp(req);
  req.clientIp = ip;
  const r = await rateLimit.checkRegistration(ip);
  if (!r.allowed) return send429(res, { ...r, hint: 'Try again tomorrow or use a different network.' });
  next();
}

// Returns the shared base fields every scenario session needs.
function newSessionBase() {
  return {
    id:    crypto.randomBytes(16).toString('hex'),
    token: crypto.randomBytes(24).toString('hex'),
    createdAt: Date.now(), used: false,
    signals: [], fingerprintReceived: false, fingerprint: null,
    headerFlags: null, tlsFlags: null, tlsHash: null,
    visitorId: null, handle: null, visitRecorded: false,
    requiresStepUp: false, stepUpPassed: false, stepUp: null, lastRisk: null,
  };
}

// Returns the shared base telemetry accumulator every scenario cumulative needs.
function baseCumulative() {
  return {
    mouseMoves: 0, keystrokeCount: 0, scrollEvents: 0, focusBlurEvents: 0,
    mouseEntropy: 0, samples: 0,
    clickCount: 0, clickDwellSamples: [],
    velocityMeanSamples: [], velocityStdSamples: [],
    curvatureTotal: 0, scrollDeltaUniformSteps: 0,
    keystrokeIntervalStdSamples: [], firstEventLatenciesMs: [],
    visibilityChanges: 0,
  };
}

// ─── OAuth helpers ───────────────────────────────────────────────────────────

// Short-lived CSRF state tokens: state → { provider, issuedAt }
const _oauthStates = new Map();
function _newState(provider) {
  const state = crypto.randomBytes(16).toString('hex');
  _oauthStates.set(state, { provider, issuedAt: Date.now() });
  // Prune states older than 10 minutes
  for (const [k, v] of _oauthStates) if (Date.now() - v.issuedAt > 600_000) _oauthStates.delete(k);
  return state;
}
function _consumeState(state, provider) {
  const entry = _oauthStates.get(state);
  if (!entry || entry.provider !== provider || Date.now() - entry.issuedAt > 600_000) return false;
  _oauthStates.delete(state);
  return true;
}

function _httpsPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const u    = new URL(url);
    const req  = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'Content-Length': Buffer.byteLength(body), Accept: 'application/json' },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function _httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'AgentGauntlet/1.0', Accept: 'application/json' },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); })
    .on('error', reject);
  });
}

// ─── Scenario factory ─────────────────────────────────────────────────────────

function createScenario({
  scenario,           // string identifier stored in DB (e.g. 'cart')
  apiPrefix,          // route prefix (e.g. '/api/v2')
  staticDir,          // path to public/ for express.static
  port,               // default HTTP port
  httpsPort,          // default HTTPS port
  ttlMs = 15 * 60 * 1000,
  extendTelemetry,    // optional (cumulative, rawTelemetry) => void
}) {
  const visitorStore = new PgVisitorStore();
  const tlsStore     = new Map();
  const sessions     = new Map();

  // ── Express app ──────────────────────────────────────────────────────────
  const app = express();
  app.set('trust proxy', true); // Fly puts real client IP in Fly-Client-IP / X-Forwarded-For
  app.use(express.json({ limit: '256kb' }));

  app.use((req, _res, next) => {
    const sock = req.socket;
    if (sock && sock.remoteAddress) {
      req.tlsFingerprint = tlsStore.get(`${sock.remoteAddress}:${sock.remotePort}`) || null;
    }
    next();
  });

  app.use(express.static(staticDir));

  // ── Helpers closed over scenario context ─────────────────────────────────

  function accumulateTelemetry(s, t = {}) {
    const c = s.cumulative;
    for (const k of ['mouseMoves', 'keystrokeCount', 'scrollEvents', 'focusBlurEvents']) {
      c[k] += t[k] || 0;
    }
    if (typeof t.mouseEntropy === 'number') {
      c.mouseEntropy = (c.mouseEntropy * c.samples + t.mouseEntropy) / (c.samples + 1);
      c.samples += 1;
    }
    c.clickCount += t.clickCount || 0;
    if (t.clickCount > 0 && typeof t.clickDwellMedian === 'number') {
      c.clickDwellSamples.push(t.clickDwellMedian);
    }
    if (typeof t.mouseVelocityMean === 'number' && t.mouseMoves > 5) {
      c.velocityMeanSamples.push(t.mouseVelocityMean);
      c.velocityStdSamples.push(t.mouseVelocityStd || 0);
    }
    c.curvatureTotal += t.mouseCurvature || 0;
    if (t.scrollDeltaUniform === true) c.scrollDeltaUniformSteps += 1;
    if (typeof t.keystrokeIntervalStd === 'number' && t.keystrokeCount > 1) {
      c.keystrokeIntervalStdSamples.push(t.keystrokeIntervalStd);
    }
    c.visibilityChanges += t.visibilityChanges || 0;
    if (typeof t.firstEventLatencyMs === 'number') c.firstEventLatenciesMs.push(t.firstEventLatencyMs);
    if (extendTelemetry) extendTelemetry(c, t);
  }

  function actionGuard(s, extra = []) {
    if (!s.fingerprintReceived) {
      return { ok: false, action: 'block', reasons: ['no_fingerprint'], risk: publicRisk(computeRisk(['no_fingerprint'])) };
    }
    const merged = [...s.signals, ...extra];
    const risk   = computeRisk(merged);
    s.lastRisk   = risk;
    s.signals    = merged;
    if (risk.action === 'block') return { ok: false, action: 'block', risk: publicRisk(risk) };
    if (risk.action === 'step_up' && !s.stepUpPassed) {
      s.requiresStepUp = true;
      return { ok: false, action: 'step_up', risk: publicRisk(risk) };
    }
    return null;
  }

  async function recordTerminalVisit(s, outcome, finalSignals) {
    if (s.visitRecorded || !s.visitorId) return;
    s.visitRecorded = true;
    const sigs = finalSignals || s.signals;
    const risk = await computeHostedRisk(sigs, scenario);
    await visitorStore.recordVisit(
      s.visitorId,
      { handle: s.handle, ja3Hash: s.tlsHash, userAgent: (s.fingerprint && s.fingerprint.userAgent) || null,
        apiKey: s.apiKey || null },
      { sessionId: s.id, scenario, outcome, score: risk.score, tier: risk.tier, signals: sigs,
        hadStepUp: !!s.requiresStepUp || s.stepUpPassed, elapsedMs: Date.now() - s.createdAt,
        agentMode: s.mode || 'headless' },
    );
    visitorStore.clearSession(s.id);
  }

  function pruneSessions() {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt > ttlMs) sessions.delete(id);
    }
  }

  // ── Shared routes ─────────────────────────────────────────────────────────

  app.post(`${apiPrefix}/fingerprint`, async (req, res) => {
    const { sessionId, token, fingerprint } = req.body || {};
    const s = sessions.get(sessionId);
    if (!s || s.token !== token)  return res.status(403).json({ ok: false, reason: 'invalid_session' });
    if (s.used)                   return res.status(403).json({ ok: false, reason: 'session_used' });
    if (s.fingerprintReceived)    return res.status(409).json({ ok: false, reason: 'fingerprint_already_received' });

    const fpFlags = scoreFingerprint(fingerprint);
    const allSigs = [...s.signals, ...fpFlags.hard, ...fpFlags.soft];
    s.fingerprintReceived = true;
    s.fingerprint = fingerprint || {};
    s.signals     = allSigs;

    s.visitorId = computeVisitorId({
      ja3Hash:    s.tlsHash,
      canvasHash: s.fingerprint.canvasHash,
      audioHash:  s.fingerprint.audioHash,
      userAgent:  s.fingerprint.userAgent,
      screen:     s.fingerprint.screen
                    ? `${s.fingerprint.screen.width}x${s.fingerprint.screen.height}` : '',
      tz:         s.fingerprint.tz,
    });
    s.handle = handleFor(s.visitorId);

    const risk = computeRisk(allSigs);
    s.lastRisk = risk;

    if (risk.action === 'block') {
      await recordTerminalVisit(s, 'block', allSigs);
      return res.status(403).json({ ok: false, action: 'block', risk: publicRisk(risk, s.keyTier, s) });
    }
    if (risk.action === 'step_up') {
      s.requiresStepUp = true;
      return res.json({ ok: true, action: 'step_up', risk: publicRisk(risk, s.keyTier, s) });
    }
    res.json({ ok: true, action: 'allow', risk: publicRisk(risk, s.keyTier, s) });
  });

  app.post(`${apiPrefix}/stepup-challenge`, (req, res) => {
    const { sessionId, token } = req.body || {};
    const s = sessions.get(sessionId);
    if (!s || s.token !== token)          return res.status(403).json({ ok: false, reason: 'invalid_session' });
    if (s.used)                           return res.status(403).json({ ok: false, reason: 'session_used' });
    if (!s.requiresStepUp || s.stepUpPassed) return res.status(400).json({ ok: false, reason: 'not_required' });

    const a  = randInt(2, 13);
    const b  = randInt(2, 13);
    const op = ['+', '-', '×'][randInt(0, 3)];
    const answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
    s.stepUp = { a, b, op, answer, issuedAt: Date.now() };
    res.json({ a, b, op, minDwellMs: 2000, risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier, s) });
  });

  app.post(`${apiPrefix}/stepup-verify`, async (req, res) => {
    const { sessionId, token, answer, telemetry } = req.body || {};
    const s = sessions.get(sessionId);
    if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });
    if (s.used)                  return res.status(403).json({ ok: false, reason: 'session_used' });
    if (!s.stepUp)               return res.status(400).json({ ok: false, reason: 'no_stepup_pending' });

    accumulateTelemetry(s, telemetry);
    visitorStore.recordTelemetrySnapshot(s.id, null, telemetry);

    const elapsed  = Date.now() - s.stepUp.issuedAt;
    const failures = [];
    if (Number(answer) !== s.stepUp.answer)        failures.push('stepup_wrong_answer');
    if (elapsed < 2000)                             failures.push('stepup_too_fast');
    if ((telemetry?.keystrokeCount ?? 0) < 1)       failures.push('stepup_no_keystrokes');

    if (failures.length > 0) {
      s.signals = [...s.signals, 'stepup_failed'];
      const risk = computeRisk(s.signals);
      await recordTerminalVisit(s, 'block', s.signals);
      sessions.delete(sessionId);
      return res.status(403).json({ ok: false, action: 'block', reasons: failures, risk: publicRisk(risk, s.keyTier) });
    }

    s.stepUpPassed   = true;
    s.requiresStepUp = false;
    s.stepUp         = null;
    const risk = computeRisk(s.signals);
    s.lastRisk = risk;
    res.json({ ok: true, action: 'allow', risk: publicRisk(risk, s.keyTier, s) });
  });

  app.get(`${apiPrefix}/visitor`, async (req, res) => {
    const s = req.query.sessionId ? sessions.get(req.query.sessionId) : null;
    if (!s || !s.visitorId) return res.status(404).json({ ok: false, reason: 'no_visitor_yet' });
    const v = await visitorStore.get(s.visitorId);
    res.json({ ok: true, history: v,
               currentRisk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier, s) });
  });

  app.post('/api/keys/register', rateLimitRegistration, async (req, res) => {
    const { name, email } = req.body || {};
    if (!name || !email) return res.status(400).json({ ok: false, reason: 'name_and_email_required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, reason: 'invalid_email' });
    }
    try {
      const key = await createKey({ name, email, tier: 'free' });
      res.json({ ok: true, key, tier: 'free', dailyLimit: FREE_DAILY_LIMIT,
                 hint: 'Set x-api-key: <key> on every POST /api/*/session request.' });
    } catch (e) {
      res.status(500).json({ ok: false, reason: 'registration_failed' });
    }
  });

  app.get('/api/keys/me', async (req, res) => {
    const rawKey = req.headers['x-api-key'] || req.query.api_key;
    if (!rawKey) return res.status(401).json({ ok: false, reason: 'missing_api_key' });
    const info = await getKeyInfo(rawKey);
    if (!info) return res.status(401).json({ ok: false, reason: 'invalid_api_key' });
    res.json({ ok: true, ...info });
  });

  // ── OAuth: GitHub ──────────────────────────────────────────────────────────

  app.get('/auth/github', rateLimitRegistration, (req, res) => {
    if (!process.env.GITHUB_CLIENT_ID) return res.status(503).send('GitHub OAuth not configured');
    const appUrl   = process.env.APP_URL || 'http://localhost:3080';
    const state    = _newState('github');
    const redirect = encodeURIComponent(`${appUrl}/auth/github/callback`);
    res.redirect(`https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=read:user+user:email&state=${state}&redirect_uri=${redirect}`);
  });

  app.get('/auth/github/callback', async (req, res) => {
    const appUrl = process.env.APP_URL || 'http://localhost:3080';
    try {
      const { code, state } = req.query;
      if (!_consumeState(state, 'github')) return res.redirect(`${appUrl}/keys.html?error=invalid_state`);

      const tokens = await _httpsPost('https://github.com/login/oauth/access_token', {
        client_id:     process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  `${appUrl}/auth/github/callback`,
      });
      if (!tokens.access_token) return res.redirect(`${appUrl}/keys.html?error=github_token_failed`);

      const user = await _httpsGet('https://api.github.com/user', tokens.access_token);
      const name = user.name || user.login || 'github-user';
      const email = user.email || '';
      const { key, isNew } = await findOrCreateOAuthKey('github', user.id, name, email);
      res.redirect(`${appUrl}/keys.html?key=${encodeURIComponent(key)}&provider=github&new=${isNew ? '1' : '0'}`);
    } catch (e) {
      console.error('[oauth] github callback error:', e.message);
      const appUrl = process.env.APP_URL || 'http://localhost:3080';
      res.redirect(`${appUrl}/keys.html?error=github_error`);
    }
  });

  // ── OAuth: LinkedIn ────────────────────────────────────────────────────────

  app.get('/auth/linkedin', rateLimitRegistration, (req, res) => {
    if (!process.env.LINKEDIN_CLIENT_ID) return res.status(503).send('LinkedIn OAuth not configured');
    const appUrl   = process.env.APP_URL || 'http://localhost:3080';
    const state    = _newState('linkedin');
    const redirect = encodeURIComponent(`${appUrl}/auth/linkedin/callback`);
    res.redirect(`https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&scope=openid+profile+email&state=${state}&redirect_uri=${redirect}`);
  });

  app.get('/auth/linkedin/callback', async (req, res) => {
    const appUrl = process.env.APP_URL || 'http://localhost:3080';
    try {
      const { code, state } = req.query;
      if (!_consumeState(state, 'linkedin')) return res.redirect(`${appUrl}/keys.html?error=invalid_state`);

      const tokens = await _httpsPost('https://www.linkedin.com/oauth/v2/accessToken', {
        grant_type:    'authorization_code',
        code,
        client_id:     process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
        redirect_uri:  `${appUrl}/auth/linkedin/callback`,
      });
      if (!tokens.access_token) return res.redirect(`${appUrl}/keys.html?error=linkedin_token_failed`);

      const user = await _httpsGet('https://api.linkedin.com/v2/userinfo', tokens.access_token);
      const name = user.name || user.given_name || 'linkedin-user';
      const email = user.email || '';
      const { key, isNew } = await findOrCreateOAuthKey('linkedin', user.sub, name, email);
      res.redirect(`${appUrl}/keys.html?key=${encodeURIComponent(key)}&provider=linkedin&new=${isNew ? '1' : '0'}`);
    } catch (e) {
      console.error('[oauth] linkedin callback error:', e.message);
      res.redirect(`${appUrl}/keys.html?error=linkedin_error`);
    }
  });

  app.get('/api/leaderboard', async (req, res) => {
    const metric = req.query.metric || 'persistent';
    const limit  = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    res.json({ total: await visitorStore.count(), metric, limit, selfHosted: isSelfHosted(),
               entries: await visitorStore.leaderboard(metric, limit) });
  });

  // Result lookup for a single past session. Requires an API key (no anonymous
  // access). Three-tier response shape — see resultResponse() in this file.
  //
  // Security model:
  //   • Format check rejects malformed IDs without touching the DB (cheap DoS
  //     guard against random-ID enumeration).
  //   • Ownership: session.api_key must match the requesting key. Mismatch
  //     and "not found" both return 404 so an attacker can't enumerate valid
  //     session IDs by observing the response code.
  //   • Burst rate-limited (key-read bucket) by attachApiKeyReadOnly, separate
  //     from the run-traffic burst bucket — heavy polling can't deplete the
  //     run-quota budget.
  //   • TTL: 7 days from ended_at. After that the underlying sessions /
  //     session_signals rows are gone (cleanup script), so we return 410 even
  //     though the leaderboard_entries row still exists.
  const SESSION_ID_RE = /^[0-9a-f]{32}$/;
  const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  app.get('/api/session/:id/result', attachApiKeyReadOnly, async (req, res) => {
    const sessionId = req.params.id;
    if (!SESSION_ID_RE.test(sessionId)) {
      return res.status(404).json({ ok: false, reason: 'not_found' });
    }
    const row = await visitorStore.getSessionResult(sessionId);
    if (!row || row.api_key !== req.apiKey) {
      return res.status(404).json({ ok: false, reason: 'not_found' });
    }
    if (Date.now() - Number(row.ended_at) > RESULT_TTL_MS) {
      return res.status(410).json({ ok: false, reason: 'expired',
        hint: 'Session detail is retained for 7 days. Aggregated stats remain on the leaderboard.' });
    }
    res.json({ ok: true, ...resultResponse(row, req.keyTier) });
  });

  app.get('/api/risk-weights', (_req, res) => {
    if (isSelfHosted()) {
      // Self-hosted scoring uses shared/risk.js — return the in-process values
      // since they're what's actually being applied.
      return res.json({ selfHosted: true, weights: SIGNAL_WEIGHTS, thresholds: THRESHOLDS });
    }
    // Hosted: real weights live in the private scoring service. The values
    // imported from risk.js here are only the open-source fallback and would
    // be misleading to expose as the production weights.
    res.json({
      selfHosted: false,
      hint: 'Hosted scoring uses private weights to prevent overfitting. The open-source fallback in shared/risk.js is not what determines hosted leaderboard ranks.',
    });
  });

  app.get('/debug/tls', (req, res) => {
    const fp = req.tlsFingerprint;
    const isHttps = req.protocol === 'https' || req.socket.encrypted === true;
    res.json({ https: isHttps, captured: !!fp, ja3Hash: fp ? fp.hash : null,
               flags: isHttps ? tlsFp.scoreTls(fp) : { hard: [], soft: [] } });
  });

  // ── Startup ───────────────────────────────────────────────────────────────

  function start(certsDir) {
    const httpPort   = Number(process.env.PORT) || port;
    const httpsEnv   = process.env.HTTPS_PORT;
    const httpsPort_ = httpsEnv === '0' ? 0 : (Number(httpsEnv) || httpsPort);

    initSchema()
      .then(() => console.log(`[${scenario}] DB schema ready`))
      .catch(e => console.error(`[${scenario}] DB schema error:`, e.message));

    app.listen(httpPort, () =>
      console.log(`[${scenario}] HTTP  → http://localhost:${httpPort}`));

    if (httpsPort_ === 0) return;

    try {
      const keyFile = path.join(certsDir, 'key.pem');
      const crtFile = path.join(certsDir, 'cert.pem');
      if (!fs.existsSync(keyFile) || !fs.existsSync(crtFile)) {
        fs.mkdirSync(certsDir, { recursive: true });
        console.log(`[${scenario}] Generating self-signed cert…`);
        execSync(
          `openssl req -x509 -nodes -newkey rsa:2048 -keyout "${keyFile}" -out "${crtFile}" -days 365 ` +
          `-subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null`,
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
      }
      const tls   = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) };
      const front = tlsFp.createCapturingServer(tls, tlsStore, app);
      front.listen(httpsPort_, () =>
        console.log(`[${scenario}] HTTPS → https://localhost:${httpsPort_}  (JA3 active)`));
    } catch (e) {
      console.warn(`[${scenario}] HTTPS not started: ${e.message}`);
    }
  }

  return {
    app, sessions, tlsStore, visitorStore,
    accumulateTelemetry, actionGuard, recordTerminalVisit, pruneSessions,
    attachApiKey, start,
  };
}

module.exports = {
  createScenario,
  attachApiKey,
  attachApiKeyReadOnly,
  rateLimitRegistration,
  // Pure helpers available without calling createScenario
  randInt, median,
  scoreHeaders, scoreFingerprint, scoreTls,
  publicRisk, newSessionBase, baseCumulative,
  computeRisk,
};
