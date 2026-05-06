// Cart-checkout scenario server.
// v1: simple one-shot challenge (visual + slide + honeypot).
// v2: vision-agent multi-step flow (cart → shipping → review).

const crypto = require('crypto');
const path   = require('path');
const {
  createScenario,
  randInt, median,
  scoreHeaders, scoreTls,
  publicRisk, newSessionBase, baseCumulative,
  computeRisk, THRESHOLDS,
} = require('../shared/scenario');

const {
  app, sessions, visitorStore,
  accumulateTelemetry, actionGuard, recordTerminalVisit, pruneSessions,
  attachApiKey, start,
} = createScenario({
  scenario:  'cart',
  apiPrefix: '/api/v2',
  staticDir: path.join(__dirname, 'public'),
  port:      3000,
  httpsPort: 3443,
  // cart v2 uses only the base telemetry fields — no extendTelemetry needed
});

// ─── v1: simple one-shot checkout ────────────────────────────────────────────

const V1_TTL_MS  = 10 * 60 * 1000;
const v1Sessions = new Map();

function newV1Session() {
  const id    = crypto.randomBytes(16).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const realButtonId  = `btn-${randInt(10000, 99999)}`;
  const decoyButtonIds = [`btn-${randInt(10000, 99999)}`, `btn-${randInt(10000, 99999)}`];
  const visualTargets  = ['apple', 'banana', 'orange', 'grape'];
  const requiredVisual = visualTargets[randInt(0, visualTargets.length)];
  const minSlidePercent = 90 + randInt(0, 8);
  const s = { id, token, realButtonId, decoyButtonIds, requiredVisual, minSlidePercent, createdAt: Date.now(), used: false };
  v1Sessions.set(id, s);
  return s;
}

function pruneV1() {
  const now = Date.now();
  for (const [id, s] of v1Sessions) {
    if (now - s.createdAt > V1_TTL_MS) v1Sessions.delete(id);
  }
}

app.post('/api/session', (_req, res) => {
  pruneV1();
  const s = newV1Session();
  res.json({ sessionId: s.id, token: s.token, realButtonId: s.realButtonId,
             decoyButtonIds: s.decoyButtonIds, requiredVisual: s.requiredVisual,
             minSlidePercent: s.minSlidePercent, issuedAt: s.createdAt });
});

app.post('/api/checkout', (req, res) => {
  const { sessionId, token, telemetry = {}, challenges = {} } = req.body || {};
  const s = v1Sessions.get(sessionId);
  if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used) return res.status(403).json({ ok: false, reason: 'session_already_used' });
  s.used = true;

  const reasons = [];
  if (challenges.honeypotEmail || challenges.honeypotPromo)      reasons.push('honeypot_filled');
  if (challenges.clickedButtonId !== s.realButtonId)             reasons.push('wrong_button');
  if (!challenges.slideCompleted)                                 reasons.push('slide_not_completed');
  if (challenges.visualSelected !== s.requiredVisual)            reasons.push('visual_wrong');
  if (challenges.robotCheckbox === true)                          reasons.push('robot_checkbox_checked');

  const elapsedMs = Date.now() - s.createdAt;
  if (elapsedMs < 3000)                                          reasons.push('too_fast');
  if ((telemetry.mouseMoves ?? 0) < 5)                           reasons.push('low_mouse_activity');
  if ((telemetry.mouseEntropy ?? 0) < 0.4)                      reasons.push('low_mouse_entropy');
  if ((telemetry.scrollEvents ?? 0) === 0 && (telemetry.mouseMoves ?? 0) < 30) {
    reasons.push('no_scroll_low_activity');
  }
  if ((telemetry.focusBlurEvents ?? 0) > 80)                    reasons.push('focus_thrashing');
  if (challenges.couponEntered && (telemetry.keystrokeCount ?? 0) < 2) {
    reasons.push('coupon_no_keystrokes');
  }

  v1Sessions.delete(sessionId);
  if (reasons.length > 0) return res.status(403).json({ ok: false, blocked: true, reasons });
  return res.json({ ok: true, orderId: crypto.randomBytes(8).toString('hex') });
});

// ─── v2: vision-agent multi-step flow ────────────────────────────────────────

function makeStep1Challenge(cart) {
  const sorted = cart.slice().sort((a, b) => a.unitPrice - b.unitPrice);
  const idx    = randInt(0, sorted.length);
  const target = sorted[idx];
  const prevP  = idx > 0 ? sorted[idx - 1].unitPrice : 0;
  const nextP  = idx < sorted.length - 1 ? sorted[idx + 1].unitPrice : target.unitPrice * 2;
  const low    = Math.round(prevP  + (target.unitPrice - prevP)  * (0.3 + Math.random() * 0.4));
  const high   = Math.round(target.unitPrice + (nextP - target.unitPrice) * (0.3 + Math.random() * 0.4));
  return { targetItemId: target.id, low, high };
}

function makeStep2Challenge(shipping, subtotal) {
  const enriched = shipping.map(s => ({ ...s, pct: (s.cost / subtotal) * 100 }));
  const sorted   = enriched.slice().sort((a, b) => a.pct - b.pct);
  const idx      = randInt(0, sorted.length);
  const target   = sorted[idx];
  const prevPct  = idx > 0 ? sorted[idx - 1].pct : 0;
  const nextPct  = idx < sorted.length - 1 ? sorted[idx + 1].pct : target.pct * 3;
  const lowPct   = +(prevPct  + (target.pct - prevPct)  * (0.3 + Math.random() * 0.4)).toFixed(1);
  const highPct  = +(target.pct + (nextPct - target.pct) * (0.3 + Math.random() * 0.4)).toFixed(1);
  return { targetShippingId: target.id, lowPct, highPct };
}

const CART = [
  { id: 'a', name: 'Wireless Headphones', emoji: '🎧', qty: 1, unitPrice: 89.99 },
  { id: 'b', name: 'USB-C Cable (3-pack)', emoji: '🔌', qty: 2, unitPrice: 12.50 },
  { id: 'c', name: 'Mechanical Keyboard',  emoji: '⌨️', qty: 1, unitPrice: 129.00 },
];
const SUBTOTAL = +CART.reduce((s, i) => s + i.qty * i.unitPrice, 0).toFixed(2);
const SHIPPING = [
  { id: 's', name: 'Standard',  cost: 7.99,  eta: '5–7 business days', badge: null },
  { id: 'e', name: 'Express',   cost: 15.99, eta: '2–3 business days', badge: 'MOST POPULAR' },
  { id: 'o', name: 'Overnight', cost: 24.99, eta: 'Next day',           badge: 'RECOMMENDED' },
];

function makeV2Session() {
  const s = {
    ...newSessionBase(),
    currentStep: 1, cart: CART, subtotal: SUBTOTAL, shipping: SHIPPING,
    step1: makeStep1Challenge(CART),
    step2: makeStep2Challenge(SHIPPING, SUBTOTAL),
    step3: { realBtnId: `pl-${randInt(10000, 99999)}`, decoyBtnId: `pl-${randInt(10000, 99999)}` },
    chosenShippingId: null,
    cumulative: { ...baseCumulative() },
  };
  sessions.set(s.id, s);
  return s;
}

app.get('/v2', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'v2.html')));

app.post('/api/v2/session', attachApiKey, (req, res) => {
  pruneSessions();
  const headerFlags = scoreHeaders(req.headers);
  const tlsFlags    = scoreTls(req);
  const initSignals = [...headerFlags.hard, ...headerFlags.soft, ...tlsFlags.hard, ...tlsFlags.soft];
  const risk        = computeRisk(initSignals);

  if (risk.action === 'block') {
    return res.status(403).json({ ok: false, action: 'block', stage: 'session', risk: publicRisk(risk, req.keyTier), signals: initSignals });
  }

  const s = makeV2Session();
  s.apiKey      = req.apiKey;
  s.keyTier     = req.keyTier;
  s.headerFlags = headerFlags;
  s.tlsFlags    = tlsFlags;
  s.tlsHash     = req.tlsFingerprint ? req.tlsFingerprint.hash : null;
  s.signals     = initSignals;

  res.json({
    sessionId: s.id, token: s.token,
    cart: s.cart, subtotal: s.subtotal,
    step1: {
      prompt: `Click the item whose unit price is between $${s.step1.low} and $${s.step1.high}.`,
      low: s.step1.low, high: s.step1.high,
    },
    requireFingerprint: true,
    risk: publicRisk(risk, s.keyTier, s),
  });
});

// /api/v2/fingerprint — handled by createScenario

app.post('/api/v2/step', async (req, res) => {
  const { sessionId, token, step, answer = {}, telemetry } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token)     return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                      return res.status(403).json({ ok: false, reason: 'session_used' });
  if (step !== s.currentStep)      return res.status(403).json({ ok: false, reason: 'step_mismatch' });
  if (!s.fingerprintReceived)      return res.status(403).json({ ok: false, action: 'block', reasons: ['no_fingerprint'] });
  if (s.requiresStepUp && !s.stepUpPassed) {
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier) });
  }

  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, s.currentStep, telemetry);

  const stepSignals = [];
  if (step === 1) {
    if (answer.honeypotEmail || answer.honeypotPromo) stepSignals.push('honeypot_filled');
    if (answer.clickedDecoy)                          stepSignals.push('clicked_decoy_step1');
    if (answer.itemId !== s.step1.targetItemId)       stepSignals.push('wrong_item_step1');
  } else if (step === 2) {
    if (answer.shippingId !== s.step2.targetShippingId) stepSignals.push('wrong_shipping_step2');
  }

  const guard = actionGuard(s, stepSignals);
  if (guard && guard.action === 'block') {
    await recordTerminalVisit(s, 'block', s.signals);
    sessions.delete(sessionId);
    return res.status(403).json(guard);
  }
  if (guard && guard.action === 'step_up') return res.status(403).json(guard);

  if (step === 1) {
    s.currentStep = 2;
    return res.json({
      ok: true, nextStep: 2,
      shipping: s.shipping,
      step2: {
        prompt: `Choose the shipping option whose cost is between ${s.step2.lowPct}% and ${s.step2.highPct}% of your subtotal ($${s.subtotal.toFixed(2)}).`,
        lowPct: s.step2.lowPct, highPct: s.step2.highPct,
      },
      risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier),
    });
  }

  if (step === 2) {
    s.chosenShippingId = answer.shippingId;
    s.currentStep = 3;
    const chosen = s.shipping.find(x => x.id === answer.shippingId);
    const tax    = +(s.subtotal * 0.0875).toFixed(2);
    const total  = +(s.subtotal + chosen.cost + tax).toFixed(2);
    return res.json({
      ok: true, nextStep: 3,
      summary: { subtotal: s.subtotal, shippingName: chosen.name, shippingCost: chosen.cost, tax, total },
      step3: {
        prompt: 'To complete your order, click the button that is NOT marked as Recommended.',
        realBtnId: s.step3.realBtnId, decoyBtnId: s.step3.decoyBtnId,
      },
    });
  }

  return res.status(400).json({ ok: false, reason: 'unknown_step' });
});

app.post('/api/v2/checkout', async (req, res) => {
  const { sessionId, token, clickedBtnId, telemetry } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token)  return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                   return res.status(403).json({ ok: false, reason: 'session_used' });
  if (s.currentStep !== 3)      return res.status(403).json({ ok: false, reason: 'wrong_step' });
  if (!s.fingerprintReceived)   return res.status(403).json({ ok: false, action: 'block', reasons: ['no_fingerprint'] });
  if (s.requiresStepUp && !s.stepUpPassed) {
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier) });
  }

  s.used = true;
  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, 3, telemetry);

  const checkoutSignals = [];
  if (clickedBtnId === s.step3.decoyBtnId)      checkoutSignals.push('clicked_recommended_decoy');
  else if (clickedBtnId !== s.step3.realBtnId)  checkoutSignals.push('unknown_button');

  const elapsed = Date.now() - s.createdAt;
  const c       = s.cumulative;
  if (elapsed < 5000)                           checkoutSignals.push('too_fast');
  if (c.mouseMoves < 15)                        checkoutSignals.push('low_mouse_activity');
  if (c.mouseEntropy < 0.5)                     checkoutSignals.push('low_mouse_entropy');
  if (c.scrollEvents === 0 && c.mouseMoves < 60) checkoutSignals.push('no_scroll_low_activity');

  const dwellMedian = median(c.clickDwellSamples);
  if (c.clickCount >= 2 && dwellMedian < 20)    checkoutSignals.push('synthetic_click_dwell');

  if (c.velocityMeanSamples.length > 0) {
    const vMean = c.velocityMeanSamples.reduce((a, b) => a + b, 0) / c.velocityMeanSamples.length;
    const vStd  = c.velocityStdSamples.reduce((a, b) => a + b, 0)  / c.velocityStdSamples.length;
    if (vMean > 0 && vStd / vMean < 0.15) checkoutSignals.push('uniform_mouse_velocity');
  }
  if (c.mouseMoves > 30 && c.curvatureTotal < 5)  checkoutSignals.push('straight_line_cursor');
  if (c.scrollDeltaUniformSteps >= 2)              checkoutSignals.push('synthetic_scroll_pattern');

  const rxMin = c.firstEventLatenciesMs.length > 0 ? Math.min(...c.firstEventLatenciesMs) : null;
  if (rxMin !== null && rxMin < 100)               checkoutSignals.push('superhuman_reaction_time');

  if (c.keystrokeIntervalStdSamples.length > 0) {
    const ksStd = c.keystrokeIntervalStdSamples.reduce((a, b) => a + b, 0) / c.keystrokeIntervalStdSamples.length;
    if (c.keystrokeCount >= 4 && ksStd < 5)        checkoutSignals.push('uniform_keystroke_timing');
  }

  const finalSignals = [...s.signals, ...checkoutSignals];
  const risk         = computeRisk(finalSignals);
  s.lastRisk = risk;
  s.signals  = finalSignals;

  if (risk.action === 'block') {
    await recordTerminalVisit(s, 'block', finalSignals);
    sessions.delete(sessionId);
    return res.status(403).json({ ok: false, action: 'block', risk: publicRisk(risk, s.keyTier, s) });
  }
  if (risk.action === 'step_up' && !s.stepUpPassed) {
    s.requiresStepUp = true;
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(risk, s.keyTier) });
  }

  await recordTerminalVisit(s, 'complete', finalSignals);
  sessions.delete(sessionId);
  return res.json({
    ok: true, action: 'allow',
    orderId: crypto.randomBytes(8).toString('hex'),
    risk: publicRisk(risk, s.keyTier, s),
  });
});

// /api/v2/stepup-challenge, /api/v2/stepup-verify, /api/v2/visitor
// /api/leaderboard, /api/risk-weights, /debug/tls
// — all registered by createScenario

app.get('/leaderboard', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html')));

start(path.join(__dirname, '.certs'));
