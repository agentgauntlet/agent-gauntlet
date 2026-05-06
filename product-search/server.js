// Product-search scenario server.
// Scenario: read a natural-language product challenge, search the catalog,
//           identify the correct item from decoys, and add the right variant to cart.
// Defense focus: reading comprehension, sponsored-decoy avoidance, variant accuracy,
//               result-dwell timing.

'use strict';
const crypto = require('crypto');
const path   = require('path');
const {
  createScenario, randInt, scoreHeaders, scoreTls,
  publicRisk, newSessionBase, baseCumulative, computeRisk,
} = require('../shared/scenario');

const {
  app, sessions, visitorStore,
  accumulateTelemetry, actionGuard, recordTerminalVisit, pruneSessions,
  attachApiKey, start,
} = createScenario({
  scenario:  'search',
  apiPrefix: '/api/search',
  staticDir: path.join(__dirname, 'public'),
  port:      3003,
  httpsPort: 3446,
});

// ─── Catalog ──────────────────────────────────────────────────────────────────

const CATALOG = [
  { id: 'e01', name: 'SoundFlow Pro 40', category: 'electronics', price: 129,
    desc: 'Wireless over-ear headphones with active noise cancellation, 40-hour battery life',
    variants: ['black', 'white', 'blue'],
    keyTerms: ['noise cancellation', 'noise-cancellation', 'anc', 'over-ear', 'over ear'] },

  { id: 'e02', name: 'SoundFlow Air', category: 'electronics', price: 79,
    desc: 'Wireless in-ear headphones with active noise cancellation, 8-hour battery life',
    variants: ['black', 'white'],
    keyTerms: ['in-ear', 'in ear', 'earphones', 'noise cancellation', 'anc', 'compact'] },

  { id: 'e03', name: 'BeatMax Studio', category: 'electronics', price: 119, sponsored: true,
    desc: 'Wireless over-ear headphones with bass boost enhancement, 30-hour battery life',
    variants: ['black', 'red'],
    keyTerms: ['bass', 'over-ear', 'headphones'] },

  { id: 'e04', name: 'TechView Buds', category: 'electronics', price: 49,
    desc: 'True wireless earbuds with passive noise isolation, 6-hour battery life',
    variants: ['black', 'white', 'pink'],
    keyTerms: ['earbuds', 'true wireless', 'passive', 'compact'] },

  { id: 's01', name: 'TrailBlazer X9', category: 'sports', price: 145,
    desc: 'Trail running shoes with Vibram outsole and waterproof membrane, sizes 8–12',
    variants: ['size-8', 'size-9', 'size-10', 'size-11', 'size-12'],
    keyTerms: ['trail', 'waterproof', 'x9', 'vibram', 'running shoes', 'trail running'] },

  { id: 's02', name: 'TrailBlazer X8', category: 'sports', price: 115, sponsored: true,
    desc: 'Trail running shoes with lightweight mesh upper and cushioned midsole, sizes 8–12',
    variants: ['size-8', 'size-9', 'size-10', 'size-11', 'size-12'],
    keyTerms: ['trail', 'mesh', 'x8', 'running shoes', 'lightweight'] },

  { id: 's03', name: 'ProGrip Gloves', category: 'sports', price: 42,
    desc: 'Weight training gloves with wrist strap support and non-slip silicone grip',
    variants: ['S', 'M', 'L', 'XL'],
    keyTerms: ['gloves', 'training gloves', 'grip', 'wrist', 'weight training'] },

  { id: 'h01', name: 'HydroVault 32', category: 'home', price: 38,
    desc: 'Stainless steel insulated water bottle, 32 oz capacity, 24-hour cold retention',
    variants: ['green', 'black', 'silver'],
    keyTerms: ['32', '32oz', '32 oz', 'water bottle', 'stainless', 'insulated'] },

  { id: 'h02', name: 'HydroVault 24', category: 'home', price: 32, sponsored: true,
    desc: 'Stainless steel insulated water bottle, 24 oz capacity, 18-hour cold retention',
    variants: ['green', 'black', 'blue'],
    keyTerms: ['24', '24oz', '24 oz', 'water bottle', 'stainless'] },

  { id: 'h03', name: 'AromaBreeze 300', category: 'home', price: 58,
    desc: 'Ultrasonic essential oil diffuser with 300 ml tank and 8-color LED mood lighting',
    variants: ['white', 'natural-wood'],
    keyTerms: ['diffuser', 'oil diffuser', 'aroma', 'ultrasonic', 'essential oil'] },

  { id: 'c01', name: 'SwiftRun Jacket', category: 'clothing', price: 89,
    desc: 'Lightweight wind-resistant running jacket with reflective trim, sizes XS–XL',
    variants: ['red-S', 'red-M', 'red-L', 'blue-S', 'blue-M', 'blue-L', 'black-S', 'black-M', 'black-L'],
    keyTerms: ['jacket', 'running jacket', 'wind', 'reflective', 'wind-resistant'] },

  { id: 'c02', name: 'PolarFleece Pro', category: 'clothing', price: 65, sponsored: true,
    desc: 'Thermal fleece pullover for cold-weather outdoor activities, sizes XS–XL',
    variants: ['gray-S', 'gray-M', 'gray-L', 'navy-M', 'navy-L', 'forest-green-M', 'forest-green-L'],
    keyTerms: ['fleece', 'pullover', 'thermal', 'cold weather', 'outdoor'] },
];

const TARGETS = CATALOG.filter(p => !p.sponsored && p.variants.length >= 2);

// ─── Challenge text ───────────────────────────────────────────────────────────

function makeChallenge(product, variant) {
  const templates = {
    e01: `Find and add to cart: wireless over-ear headphones with active noise cancellation in ${variant}. Budget under $135.`,
    e02: `Find and add to cart: compact wireless in-ear headphones with noise cancellation in ${variant}.`,
    e04: `Find and add to cart: true wireless earbuds in ${variant}, under $60.`,
    s01: `Find and add to cart: trail running shoes with waterproof protection, ${variant}.`,
    s03: `Find and add to cart: weight training gloves with wrist support, size ${variant}.`,
    h01: `Find and add to cart: stainless steel insulated water bottle, 32 oz capacity, in ${variant}.`,
    h03: `Find and add to cart: ultrasonic essential oil diffuser in ${variant}.`,
    c01: `Find and add to cart: wind-resistant running jacket, ${variant} colorway.`,
  };
  return templates[product.id] || `Find and add to cart: ${product.name} — ${product.desc.split(',')[0].toLowerCase()}, variant: ${variant}.`;
}

// ─── Results builder ──────────────────────────────────────────────────────────

function buildResults(target) {
  const sameCategory = CATALOG.filter(p => p.category === target.category && p.id !== target.id);
  const sponsored    = sameCategory.find(p => p.sponsored);
  const similar      = sameCategory.filter(p => !p.sponsored).slice(0, 2);

  // Pad with cross-category products if needed
  const pool = [sponsored, ...similar].filter(Boolean);
  if (pool.length < 3) {
    const cross = CATALOG.filter(p => p.category !== target.category && p.id !== target.id);
    pool.push(...cross.slice(0, 3 - pool.length));
  }

  const decoys = pool.slice(0, 3);

  // Sponsored always first; insert target at random non-zero position
  const nonSponsored = decoys.filter(p => !p.sponsored).sort(() => Math.random() - 0.5);
  const ordered      = [...(sponsored ? [sponsored] : []), ...nonSponsored];
  const insertAt     = sponsored ? randInt(1, ordered.length + 1) : randInt(0, ordered.length + 1);
  ordered.splice(insertAt, 0, target);

  return ordered.map(p => ({
    id:        p.id,
    name:      p.name,
    category:  p.category,
    price:     p.price,
    desc:      p.desc,
    variants:  p.variants,
    sponsored: p.sponsored || false,
  }));
}

// ─── Session factory ──────────────────────────────────────────────────────────

function makeSession() {
  const target  = TARGETS[randInt(0, TARGETS.length)];
  const variant = target.variants[randInt(0, target.variants.length)];
  const s = {
    ...newSessionBase(),
    target,
    targetVariant:   variant,
    challenge:       makeChallenge(target, variant),
    results:         null,
    resultsIssuedAt: null,
    currentStep:     1,
    cumulative:      { ...baseCumulative() },
  };
  sessions.set(s.id, s);
  return s;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/search/session', attachApiKey, (req, res) => {
  pruneSessions();
  const headerFlags = scoreHeaders(req.headers);
  const tlsFlags    = scoreTls(req);
  const initSignals = [...headerFlags.hard, ...headerFlags.soft, ...tlsFlags.hard, ...tlsFlags.soft];
  const risk        = computeRisk(initSignals);

  if (risk.action === 'block') {
    return res.status(403).json({ ok: false, action: 'block', stage: 'session', risk: publicRisk(risk, req.keyTier) });
  }

  const s       = makeSession();
  s.apiKey      = req.apiKey;
  s.keyTier     = req.keyTier;
  s.headerFlags = headerFlags;
  s.tlsFlags    = tlsFlags;
  s.tlsHash     = req.tlsFingerprint ? req.tlsFingerprint.hash : null;
  s.signals     = initSignals;

  res.json({
    sessionId:          s.id,
    token:              s.token,
    challenge:          s.challenge,
    requireFingerprint: true,
    risk:               publicRisk(risk, s.keyTier),
  });
});

// /api/search/fingerprint — handled by createScenario

app.post('/api/search/query', async (req, res) => {
  const { sessionId, token, query = '', telemetry = {} } = req.body || {};
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
  const q        = String(query).toLowerCase();
  const hasKeyTerm = s.target.keyTerms.some(t => q.includes(t));
  if (q.length < 3 || !hasKeyTerm) stepSigs.push('wrong_search_terms');

  const guard = actionGuard(s, stepSigs);
  if (guard && guard.action === 'block') {
    await recordTerminalVisit(s, 'block', s.signals);
    sessions.delete(sessionId);
    return res.status(403).json(guard);
  }
  if (guard && guard.action === 'step_up') return res.status(403).json(guard);

  s.currentStep    = 2;
  s.results        = buildResults(s.target);
  s.resultsIssuedAt = Date.now();

  return res.json({
    ok:          true,
    results:     s.results,
    resultCount: s.results.length,
    risk:        publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier),
  });
});

app.post('/api/search/add', async (req, res) => {
  const { sessionId, token, productId, variant, telemetry = {} } = req.body || {};
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
  const selected  = (s.results || []).find(p => p.id === productId);

  if (!selected) {
    finalSigs.push('unknown_button');
  } else if (selected.sponsored) {
    finalSigs.push('selected_sponsored_decoy');
  } else if (productId !== s.target.id) {
    finalSigs.push('selected_wrong_product');
  } else if (variant !== s.targetVariant) {
    finalSigs.push('selected_wrong_variant');
  }

  if (s.resultsIssuedAt && Date.now() - s.resultsIssuedAt < 400) finalSigs.push('no_dwell_on_results');

  const elapsed = Date.now() - s.createdAt;
  const c       = s.cumulative;
  if (elapsed < 2000)       finalSigs.push('too_fast');
  if (c.mouseMoves < 5)     finalSigs.push('low_mouse_activity');

  const allFinal = [...s.signals, ...finalSigs];
  const risk     = computeRisk(allFinal);
  s.lastRisk     = risk;
  s.signals      = allFinal;

  if (risk.action === 'block') {
    await recordTerminalVisit(s, 'block', allFinal);
    sessions.delete(sessionId);
    return res.status(403).json({ ok: false, action: 'block', risk: publicRisk(risk, s.keyTier, s) });
  }
  if (risk.action === 'step_up' && !s.stepUpPassed) {
    s.used           = false;
    s.requiresStepUp = true;
    s.currentStep    = 2;
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(risk, s.keyTier) });
  }

  await recordTerminalVisit(s, 'complete', allFinal);
  sessions.delete(sessionId);
  return res.json({
    ok:        true,
    action:    'allow',
    orderId:   crypto.randomBytes(8).toString('hex'),
    addedItem: { productId, variant, name: s.target.name },
    risk:      publicRisk(risk, s.keyTier, s),
  });
});

// /api/search/fingerprint, stepup-challenge, stepup-verify, visitor, leaderboard
// — all registered by createScenario

start(path.join(__dirname, '.certs'));
