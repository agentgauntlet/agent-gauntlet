// Bank-login scenario server.
// Scenario: credential-stuffing detection + OTP step-up.
// Defense focus: password keystroke timing, OTP canvas, semantic ambiguity
// (Enterprise SSO decoy panel), trap checkbox, honeypot username field.

const crypto = require('crypto');
const path   = require('path');
const {
  createScenario,
  randInt, median,
  scoreHeaders, scoreTls,
  publicRisk, newSessionBase, baseCumulative,
  computeRisk,
} = require('../shared/scenario');

const {
  app, sessions, visitorStore,
  accumulateTelemetry, actionGuard, recordTerminalVisit, pruneSessions,
  attachApiKey, start,
} = createScenario({
  scenario:  'bank',
  apiPrefix: '/api/login',
  staticDir: path.join(__dirname, 'public'),
  port:      3002,
  httpsPort: 3445,
  extendTelemetry: (c, t) => {
    if (typeof t.passwordKeystrokes    === 'number')  c.passwordKeystrokes    = t.passwordKeystrokes;
    if (typeof t.passwordPastedNotTyped === 'boolean') c.passwordPastedNotTyped = t.passwordPastedNotTyped;
    if (typeof t.usernamePastedNotTyped === 'boolean') c.usernamePastedNotTyped = t.usernamePastedNotTyped;
    if (typeof t.keystrokeIntervalStd   === 'number')  c.lastKeystrokeIntervalStd = t.keystrokeIntervalStd;
    if (typeof t.usedSsoDecoy === 'boolean' && t.usedSsoDecoy)           c.usedSsoDecoy       = true;
    if (typeof t.trapCheckboxChecked === 'boolean' && t.trapCheckboxChecked) c.trapCheckboxChecked = true;
  },
});

// ─── Accounts ────────────────────────────────────────────────────────────────

const BANK_ACCOUNTS = [
  { username: 'alex.thornton',  password: 'Maple#7291'  },
  { username: 'priya.sharma',   password: 'Coffee@5847' },
  { username: "james.o'brien",  password: 'River!3306'  },
  { username: 'dana.wu',        password: 'Summit$6612' },
  { username: 'felix.müller',   password: 'Ocean%4423'  },
];

function pickAccount() {
  return BANK_ACCOUNTS[randInt(0, BANK_ACCOUNTS.length)];
}

function makeSession() {
  const account = pickAccount();
  const s = {
    ...newSessionBase(),
    username:     account.username,
    password:     account.password,
    otp:          String(randInt(100000, 999999)),
    realPanelId:  `panel-${randInt(1000, 9999)}`,
    decoyPanelId: `panel-${randInt(1000, 9999)}`,
    currentStep:  1,
    cumulative: {
      ...baseCumulative(),
      passwordKeystrokes: 0, passwordPastedNotTyped: false,
      usernamePastedNotTyped: false, lastKeystrokeIntervalStd: null,
      usedSsoDecoy: false, trapCheckboxChecked: false,
    },
  };
  sessions.set(s.id, s);
  return s;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/login/session', attachApiKey, (req, res) => {
  pruneSessions();
  const headerFlags = scoreHeaders(req.headers);
  const tlsFlags    = scoreTls(req);
  const initSignals = [...headerFlags.hard, ...headerFlags.soft, ...tlsFlags.hard, ...tlsFlags.soft];
  const risk        = computeRisk(initSignals);

  if (risk.action === 'block') {
    return res.status(403).json({ ok: false, action: 'block', stage: 'session', risk: publicRisk(risk, req.keyTier), signals: initSignals });
  }

  const s = makeSession();
  s.apiKey      = req.apiKey;
  s.keyTier     = req.keyTier;
  s.headerFlags = headerFlags;
  s.tlsFlags    = tlsFlags;
  s.tlsHash     = req.tlsFingerprint ? req.tlsFingerprint.hash : null;
  s.signals     = initSignals;

  res.json({
    sessionId: s.id, token: s.token,
    account: { username: s.username, password: s.password },
    panels:  { realPanelId: s.realPanelId, decoyPanelId: s.decoyPanelId },
    requireFingerprint: true,
    risk: publicRisk(risk, s.keyTier),
  });
});

// /api/login/fingerprint — handled by createScenario

app.post('/api/login/step1', async (req, res) => {
  const { sessionId, token, credentials = {}, telemetry = {} } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                  return res.status(403).json({ ok: false, reason: 'session_used' });
  if (s.currentStep !== 1)     return res.status(403).json({ ok: false, reason: 'wrong_step' });
  if (s.requiresStepUp && !s.stepUpPassed) {
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier) });
  }

  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, 1, telemetry);

  const stepSigs = [];
  const c        = s.cumulative;

  if (credentials.honeypotUsernameConfirm)                        stepSigs.push('honeypot_filled');
  if (c.trapCheckboxChecked || credentials.trapChecked === true)   stepSigs.push('honeypot_filled');
  if (c.usedSsoDecoy || credentials.panelId === s.decoyPanelId)   stepSigs.push('clicked_recommended_decoy');
  if (credentials.username !== s.username)                         stepSigs.push('wrong_item_step1');
  if (credentials.password !== s.password)                         stepSigs.push('wrong_item_step1');
  if (c.passwordPastedNotTyped || c.passwordKeystrokes < 4)       stepSigs.push('coupon_no_keystrokes');
  if (c.usernamePastedNotTyped)                                    stepSigs.push('coupon_no_keystrokes');
  if (c.lastKeystrokeIntervalStd !== null && c.passwordKeystrokes > 4 && c.lastKeystrokeIntervalStd < 15) {
    stepSigs.push('uniform_keystroke_timing');
  }

  const guard = actionGuard(s, stepSigs);
  if (guard && guard.action === 'block') {
    await recordTerminalVisit(s, 'block', s.signals);
    sessions.delete(sessionId);
    return res.status(403).json(guard);
  }
  if (guard && guard.action === 'step_up') return res.status(403).json(guard);

  s.currentStep = 2;
  return res.json({
    ok: true, nextStep: 2,
    otp: s.otp,
    step2: { prompt: 'Enter the one-time code displayed above to complete login.' },
    risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier),
  });
});

app.post('/api/login/step2', async (req, res) => {
  const { sessionId, token, otpCode, telemetry = {} } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                  return res.status(403).json({ ok: false, reason: 'session_used' });
  if (s.currentStep !== 2)     return res.status(403).json({ ok: false, reason: 'wrong_step' });
  if (s.requiresStepUp && !s.stepUpPassed) {
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier) });
  }

  s.used = true;
  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, 2, telemetry);

  const finalSigs = [];
  if (String(otpCode || '').replace(/\D/g, '').trim() !== s.otp) finalSigs.push('wrong_item_step1');

  const elapsed = Date.now() - s.createdAt;
  const c       = s.cumulative;
  if (elapsed < 5000)          finalSigs.push('too_fast');
  if (c.mouseMoves < 10)       finalSigs.push('low_mouse_activity');
  if (c.mouseEntropy < 0.4)    finalSigs.push('low_mouse_entropy');

  const dwellMedian = median(c.clickDwellSamples);
  if (c.clickCount >= 2 && dwellMedian < 20) finalSigs.push('synthetic_click_dwell');

  if (c.velocityMeanSamples.length > 0) {
    const vMean = c.velocityMeanSamples.reduce((a, b) => a + b, 0) / c.velocityMeanSamples.length;
    const vStd  = c.velocityStdSamples.reduce((a, b) => a + b, 0)  / c.velocityStdSamples.length;
    if (vMean > 0 && vStd / vMean < 0.15) finalSigs.push('uniform_mouse_velocity');
  }
  if (c.scrollDeltaUniformSteps >= 2) finalSigs.push('synthetic_scroll_pattern');

  const rxMin = c.firstEventLatenciesMs.length > 0 ? Math.min(...c.firstEventLatenciesMs) : null;
  if (rxMin !== null && rxMin < 100)  finalSigs.push('superhuman_reaction_time');

  const allFinal = [...s.signals, ...finalSigs];
  const risk     = computeRisk(allFinal);
  s.lastRisk = risk;
  s.signals  = allFinal;

  if (risk.action === 'block') {
    await recordTerminalVisit(s, 'block', allFinal);
    sessions.delete(sessionId);
    return res.status(403).json({ ok: false, action: 'block', risk: publicRisk(risk, s.keyTier), handle: s.handle, visitorId: s.visitorId });
  }
  if (risk.action === 'step_up' && !s.stepUpPassed) {
    s.requiresStepUp = true;
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(risk, s.keyTier) });
  }

  await recordTerminalVisit(s, 'complete', allFinal);
  sessions.delete(sessionId);
  return res.json({
    ok: true, action: 'allow',
    sessionToken: crypto.randomBytes(16).toString('hex'),
    risk: publicRisk(risk, s.keyTier),
    handle: s.handle, visitorId: s.visitorId,
  });
});

// /api/login/fingerprint, stepup-challenge, stepup-verify, visitor
// /api/leaderboard, /api/risk-weights, /debug/tls
// — all registered by createScenario

start(path.join(__dirname, '.certs'));
