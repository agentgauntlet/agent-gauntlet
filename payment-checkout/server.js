// Payment-checkout scenario server.
// Scenario: card entry + authorization.
// Defense focus: keystroke timing on card number, Luhn validation,
// canvas-rendered card details, inverted-hierarchy authorization buttons.

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
  scenario:  'payment',
  apiPrefix: '/api/payment',
  staticDir: path.join(__dirname, 'public'),
  port:      3001,
  httpsPort: 3444,
  extendTelemetry: (c, t) => {
    if (Array.isArray(t.cardGroupPauses))          c.cardGroupPauses.push(...t.cardGroupPauses);
    if (typeof t.cardKeystrokes  === 'number')     c.cardKeystrokes  = t.cardKeystrokes;
    if (typeof t.cvvKeystrokes   === 'number')     c.cvvKeystrokes   = t.cvvKeystrokes;
    if (typeof t.cardPastedNotTyped === 'boolean') c.cardPastedNotTyped = t.cardPastedNotTyped;
    if (typeof t.cvvPastedNotTyped  === 'boolean') c.cvvPastedNotTyped  = t.cvvPastedNotTyped;
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genCard(prefix = '4') {
  let s = prefix;
  while (s.length < 15) s += String(randInt(0, 10));
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = parseInt(s[i]);
    if ((s.length - i) % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return s + String((10 - sum % 10) % 10);
}

function luhnValid(num) {
  const s = String(num).replace(/\D/g, '');
  if (s.length < 13) return false;
  let sum = 0, odd = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = parseInt(s[i]);
    if (odd) { d *= 2; if (d > 9) d -= 9; }
    sum += d; odd = !odd;
  }
  return sum % 10 === 0;
}

function makeSession() {
  const expYear = new Date().getFullYear() % 100 + randInt(1, 5);
  const s = {
    ...newSessionBase(),
    cardNumber: genCard('4'),
    expMonth:   randInt(1, 13),
    expYear,
    cvv:        String(randInt(100, 1000)),
    authCode:   String(randInt(1000, 9999)),
    realBtnId:  `pay-${randInt(10000, 99999)}`,
    decoyBtnId: `pay-${randInt(10000, 99999)}`,
    currentStep: 1,
    cumulative: {
      ...baseCumulative(),
      cardGroupPauses: [], cardKeystrokes: 0, cvvKeystrokes: 0,
      cardPastedNotTyped: false, cvvPastedNotTyped: false,
    },
  };
  sessions.set(s.id, s);
  return s;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/payment/session', attachApiKey, (req, res) => {
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
    card: { number: s.cardNumber, expMonth: s.expMonth, expYear: s.expYear, cvv: s.cvv },
    requireFingerprint: true,
    risk: publicRisk(risk, s.keyTier),
  });
});

// /api/payment/fingerprint — handled by createScenario

app.post('/api/payment/step1', async (req, res) => {
  const { sessionId, token, card = {}, telemetry = {} } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token)  return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                   return res.status(403).json({ ok: false, reason: 'session_used' });
  if (s.currentStep !== 1)      return res.status(403).json({ ok: false, reason: 'wrong_step' });
  if (s.requiresStepUp && !s.stepUpPassed) {
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier) });
  }

  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, 1, telemetry);

  const stepSigs = [];
  if (card.honeypotCardBackup) stepSigs.push('honeypot_filled');

  const submittedNum = String(card.number || '').replace(/\D/g, '');
  if (submittedNum !== s.cardNumber || !luhnValid(submittedNum)) stepSigs.push('wrong_item_step1');

  if (parseInt(card.expMonth || '0', 10) !== s.expMonth ||
      parseInt(card.expYear  || '0', 10) !== s.expYear)  stepSigs.push('wrong_shipping_step2');
  if (String(card.cvv || '').replace(/\D/g, '') !== s.cvv) stepSigs.push('wrong_shipping_step2');

  const c = s.cumulative;
  if (c.cardPastedNotTyped || c.cardKeystrokes < 8) stepSigs.push('coupon_no_keystrokes');
  if (c.cvvPastedNotTyped  || c.cvvKeystrokes  < 2) stepSigs.push('coupon_no_keystrokes');

  if (c.cardGroupPauses.length >= 2) {
    const mean     = c.cardGroupPauses.reduce((a, b) => a + b, 0) / c.cardGroupPauses.length;
    const variance = c.cardGroupPauses.reduce((s, x) => s + (x - mean) ** 2, 0) / c.cardGroupPauses.length;
    if (mean > 0 && Math.sqrt(variance) / mean < 0.1) stepSigs.push('uniform_keystroke_timing');
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
    authCode:   s.authCode,
    realBtnId:  s.realBtnId,
    decoyBtnId: s.decoyBtnId,
    step2: { prompt: 'Review your order and click "Confirm Payment" — NOT "Express Checkout" — to authorize.' },
    risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier),
  });
});

app.post('/api/payment/authorize', async (req, res) => {
  const { sessionId, token, clickedBtnId, telemetry = {} } = req.body || {};
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
  if (clickedBtnId === s.decoyBtnId)      finalSigs.push('clicked_recommended_decoy');
  else if (clickedBtnId !== s.realBtnId)  finalSigs.push('unknown_button');

  const elapsed = Date.now() - s.createdAt;
  const c       = s.cumulative;
  if (elapsed < 4000)         finalSigs.push('too_fast');
  if (c.mouseMoves < 10)      finalSigs.push('low_mouse_activity');
  if (c.mouseEntropy < 0.4)   finalSigs.push('low_mouse_entropy');

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
    confirmationId: crypto.randomBytes(8).toString('hex'),
    risk: publicRisk(risk, s.keyTier),
    handle: s.handle, visitorId: s.visitorId,
  });
});

// /api/payment/fingerprint, stepup-challenge, stepup-verify, visitor
// /api/leaderboard, /api/risk-weights, /debug/tls
// — all registered by createScenario

start(path.join(__dirname, '.certs'));
