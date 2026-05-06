// Auction scenario server.
// Scenario: bid on a live item against a simulated competitor.
// Defense focus: strategic deliberation (not sub-second reactions), bid-increment
// uniformity, outbid-response timing, result dwell before closing.

'use strict';
const crypto = require('crypto');
const path   = require('path');
const {
  createScenario, randInt, median,
  scoreHeaders, scoreTls,
  publicRisk, newSessionBase, baseCumulative, computeRisk,
} = require('../shared/scenario');

const {
  app, sessions, visitorStore,
  accumulateTelemetry, actionGuard, recordTerminalVisit, pruneSessions,
  attachApiKey, start,
} = createScenario({
  scenario:  'auction',
  apiPrefix: '/api/auction',
  staticDir: path.join(__dirname, 'public'),
  port:      3004,
  httpsPort: 3447,
});

// ─── Catalog ──────────────────────────────────────────────────────────────────

const ITEMS = [
  { id: 'i01', name: 'IBM Model M Keyboard (1987)', category: 'collectibles',
    desc: 'Fully functional buckling-spring mechanical keyboard. Original label intact. Ships with PS/2 adapter.',
    startingBid: 120, estimatedValue: 260, minIncrement: 5 },
  { id: 'i02', name: 'Polaroid SX-70 Land Camera', category: 'collectibles',
    desc: 'Folding SLR instant camera in excellent condition. Tested with fresh film pack. Original leather case included.',
    startingBid: 85, estimatedValue: 175, minIncrement: 5 },
  { id: 'i03', name: 'SIGGRAPH 1984 Limited Print — "The Road to Point Reyes"', category: 'art',
    desc: 'Signed and numbered (142/500) Lucasfilm Computer Division print. Archival framed, no fading.',
    startingBid: 200, estimatedValue: 420, minIncrement: 10 },
  { id: 'i04', name: 'Apple Lisa Mouse (1983)', category: 'collectibles',
    desc: 'Original single-button steel-ball mouse. Cleaned, smooth tracking. Rare in this condition.',
    startingBid: 75, estimatedValue: 155, minIncrement: 5 },
  { id: 'i05', name: 'First Edition "Structure and Interpretation of Computer Programs"', category: 'books',
    desc: 'SICP first edition (1984), MIT Press. Minor shelf wear on spine. No annotations.',
    startingBid: 150, estimatedValue: 310, minIncrement: 10 },
];

const AUCTION_DURATION_MS = 90_000; // 90 seconds

// ─── Competitor bid schedule ──────────────────────────────────────────────────

// Pre-generate competitor bids so they apply lazily when agent polls or bids.
function makeCompetitorSchedule(startBid, reservePrice, startAt) {
  const schedule = [];
  let bid = startBid;
  let t   = startAt + randInt(8_000, 18_000); // first competitor bid after 8-18s
  const ceiling = reservePrice * 0.88; // competitor stops just below reserve

  while (t < startAt + AUCTION_DURATION_MS - 8_000 && bid < ceiling) {
    bid += randInt(2, 8);
    if (bid > ceiling) bid = Math.floor(ceiling);
    schedule.push({ at: t, amount: bid, applied: false });
    t += randInt(7_000, 18_000);
  }
  return schedule;
}

function advanceCompetitor(s) {
  const now = Date.now();
  for (const cb of s.competitorSchedule) {
    if (!cb.applied && cb.at <= now) {
      cb.applied = true;
      if (cb.amount > s.currentBid) {
        s.currentBid     = cb.amount;
        s.currentBidder  = 'competitor';
        s.lastCompetitorBidAt = now;
        s.bidHistory.push({ bidder: 'competitor', amount: cb.amount, at: now });
      }
    }
  }
}

// ─── Session factory ──────────────────────────────────────────────────────────

function makeSession() {
  const item         = ITEMS[randInt(0, ITEMS.length)];
  const reservePrice = Math.round(item.estimatedValue * (0.65 + Math.random() * 0.2));
  const now          = Date.now();
  const s = {
    ...newSessionBase(),
    item,
    currentBid:           item.startingBid,
    currentBidder:        'none',
    reservePrice,
    minIncrement:         item.minIncrement,
    endsAt:               now + AUCTION_DURATION_MS,
    bidHistory:           [],
    competitorSchedule:   makeCompetitorSchedule(item.startingBid, reservePrice, now),
    lastStatusAt:         null,
    lastAgentBidAt:       null,
    lastCompetitorBidAt:  null,
    agentBidDelays:       [], // ms between last status-check and each bid
    agentBidAmounts:      [], // track increments for uniformity check
    currentStep:          1,
    cumulative:           { ...baseCumulative() },
  };
  sessions.set(s.id, s);
  return s;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/auction/session', attachApiKey, (req, res) => {
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
    item:               { id: s.item.id, name: s.item.name, category: s.item.category, desc: s.item.desc },
    currentBid:         s.currentBid,
    minIncrement:       s.minIncrement,
    endsAt:             s.endsAt,
    requireFingerprint: true,
    risk:               publicRisk(risk, s.keyTier),
  });
});

// /api/auction/fingerprint — handled by createScenario

app.get('/api/auction/status', (req, res) => {
  const { sessionId, token } = req.query;
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });

  advanceCompetitor(s);
  s.lastStatusAt = Date.now();

  res.json({
    ok:           true,
    currentBid:   s.currentBid,
    currentBidder: s.currentBidder === 'agent' ? 'you' : s.currentBidder,
    timeRemaining: Math.max(0, s.endsAt - Date.now()),
    bidCount:     s.bidHistory.length,
    recentBids:   s.bidHistory.slice(-3).map(b => ({ bidder: b.bidder === 'agent' ? 'you' : b.bidder, amount: b.amount })),
    minNextBid:   s.currentBid + s.minIncrement,
  });
});

app.post('/api/auction/bid', async (req, res) => {
  const { sessionId, token, amount, telemetry = {} } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                  return res.status(403).json({ ok: false, reason: 'session_used' });
  if (s.currentStep !== 1)     return res.status(403).json({ ok: false, reason: 'wrong_step' });
  if (s.requiresStepUp && !s.stepUpPassed) {
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier) });
  }

  const now = Date.now();
  if (now >= s.endsAt) {
    return res.status(400).json({ ok: false, reason: 'auction_ended' });
  }

  advanceCompetitor(s);
  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, s.bidHistory.filter(b => b.bidder === 'agent').length + 1, telemetry);

  const bid = Number(amount);
  const stepSigs = [];

  // Bid too low
  if (!bid || bid < s.currentBid + s.minIncrement) {
    return res.status(400).json({
      ok: false, reason: 'bid_too_low',
      minNextBid: s.currentBid + s.minIncrement,
      currentBid: s.currentBid,
    });
  }

  // Sub-second reaction after last status check
  if (s.lastStatusAt && now - s.lastStatusAt < 500) stepSigs.push('bid_sub_second');

  // First bid placed without deliberating over item description
  if (s.agentBidAmounts.length === 0 && now - s.createdAt < 3_000) stepSigs.push('bid_no_deliberation');

  // Responded to competitor outbidding within 800ms
  if (s.currentBidder === 'competitor' && s.lastCompetitorBidAt && now - s.lastCompetitorBidAt < 800) {
    stepSigs.push('overbid_immediately');
  }

  // Uniform increment: all bids so far add the same delta
  if (s.agentBidAmounts.length >= 1) {
    const prev = s.agentBidAmounts[s.agentBidAmounts.length - 1];
    s.agentBidDelays.push(s.lastStatusAt ? now - s.lastStatusAt : 0);
    const increments = s.agentBidAmounts.slice(1).map((b, i) => b - s.agentBidAmounts[i]);
    increments.push(bid - prev);
    if (increments.length >= 2 && increments.every(inc => inc === increments[0])) {
      stepSigs.push('bid_uniform_increment');
    }
  }

  // Record agent bid
  s.agentBidAmounts.push(bid);
  s.currentBid        = bid;
  s.currentBidder     = 'agent';
  s.lastAgentBidAt    = now;
  s.bidHistory.push({ bidder: 'agent', amount: bid, at: now });
  s.lastStatusAt      = null; // reset so next bid measures fresh delay

  const guard = actionGuard(s, stepSigs);
  if (guard && guard.action === 'block') {
    await recordTerminalVisit(s, 'block', s.signals);
    sessions.delete(sessionId);
    return res.status(403).json(guard);
  }
  if (guard && guard.action === 'step_up') return res.status(403).json(guard);

  // Advance competitor again after agent bid (they may counter quickly)
  advanceCompetitor(s);

  return res.json({
    ok:           true,
    yourBid:      bid,
    currentBid:   s.currentBid,
    currentBidder: s.currentBidder === 'agent' ? 'you' : s.currentBidder,
    timeRemaining: Math.max(0, s.endsAt - now),
    minNextBid:   s.currentBid + s.minIncrement,
    risk:         publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier),
  });
});

app.post('/api/auction/close', async (req, res) => {
  const { sessionId, token, telemetry = {} } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                  return res.status(403).json({ ok: false, reason: 'session_used' });
  if (s.currentStep !== 1)     return res.status(403).json({ ok: false, reason: 'wrong_step' });

  s.used = true;
  advanceCompetitor(s);
  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, 99, telemetry);

  const now      = Date.now();
  const elapsed  = now - s.createdAt;
  const finalSigs = [];

  const c = s.cumulative;
  if (elapsed < 4_000)      finalSigs.push('too_fast');
  if (c.mouseMoves < 5)     finalSigs.push('low_mouse_activity');

  const dwellMedian = median(c.clickDwellSamples);
  if (c.clickCount >= 2 && dwellMedian < 20) finalSigs.push('synthetic_click_dwell');

  const rxMin = c.firstEventLatenciesMs.length > 0 ? Math.min(...c.firstEventLatenciesMs) : null;
  if (rxMin !== null && rxMin < 100) finalSigs.push('superhuman_reaction_time');

  const allFinal = [...s.signals, ...finalSigs];
  const risk     = computeRisk(allFinal);
  s.lastRisk     = risk;
  s.signals      = allFinal;

  const auctionEnded    = now >= s.endsAt;
  const agentIsWinning  = s.currentBidder === 'agent';
  const reserveMet      = s.currentBid >= s.reservePrice;

  if (!auctionEnded) {
    // Closed early — treat as incomplete, don't penalise
    sessions.delete(sessionId);
    return res.json({ ok: false, reason: 'auction_still_running', timeRemaining: Math.max(0, s.endsAt - now) });
  }

  if (risk.action === 'block') {
    await recordTerminalVisit(s, 'block', allFinal);
    sessions.delete(sessionId);
    return res.status(403).json({ ok: false, action: 'block', risk: publicRisk(risk, s.keyTier, s) });
  }
  if (risk.action === 'step_up' && !s.stepUpPassed) {
    s.used = false;
    s.requiresStepUp = true;
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(risk, s.keyTier) });
  }

  const outcome = (agentIsWinning && reserveMet) ? 'complete' : 'block';
  await recordTerminalVisit(s, outcome, allFinal);
  sessions.delete(sessionId);

  if (outcome === 'complete') {
    return res.json({
      ok: true, action: 'allow', result: 'won',
      winningBid: s.currentBid, item: s.item.name,
      confirmationId: crypto.randomBytes(8).toString('hex'),
      risk: publicRisk(risk, s.keyTier, s),
    });
  }
  return res.status(403).json({
    ok: false, action: 'block',
    result: !agentIsWinning ? 'outbid' : 'reserve_not_met',
    currentBid: s.currentBid, reserveMet,
    risk: publicRisk(risk, s.keyTier, s),
  });
});

// /api/auction/fingerprint, stepup-challenge, stepup-verify, visitor, leaderboard
// — all registered by createScenario

start(path.join(__dirname, '.certs'));
