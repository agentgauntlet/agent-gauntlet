// Crypto-exchange scenario server.
// Scenario: authorise a withdrawal — verify recipient address, compute TOTP, confirm.
// Defense focus: TOTP timing (programmatic copy vs manual entry), address-poisoning
// trap (near-identical "recently used" address), security-warning dismissal speed.

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
  scenario:  'crypto',
  apiPrefix: '/api/crypto',
  staticDir: path.join(__dirname, 'public'),
  port:      3005,
  httpsPort: 3448,
});

// ─── TOTP (RFC 6238) ──────────────────────────────────────────────────────────

const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32Encode(buf) {
  let out = '', bits = 0, val = 0;
  for (const b of buf) {
    val  = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32_ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHA[(val << (5 - bits)) & 31];
  return out;
}

function b32Decode(str) {
  const out = [];
  let bits = 0, val = 0;
  for (const ch of str.replace(/=/g, '').toUpperCase()) {
    val  = (val << 5) | B32_ALPHA.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpCode(secret, step = 30) {
  const t   = Math.floor(Date.now() / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(0, 0);
  msg.writeUInt32BE(t, 4);
  const hmac   = crypto.createHmac('sha1', b32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
     (hmac[offset + 3] & 0xff)
  ) % 1_000_000;
  return String(code).padStart(6, '0');
}

function genTotpSecret() { return b32Encode(crypto.randomBytes(20)); }

// ─── Address helpers ──────────────────────────────────────────────────────────

function genEthAddress() {
  return '0x' + crypto.randomBytes(20).toString('hex');
}

// Poison an address by changing 2 hex chars in the middle (address-poisoning attack).
function poisonAddress(addr) {
  const hex  = addr.slice(2).split('');
  const pos1 = 10 + randInt(0, 10);
  const pos2 = pos1 + randInt(3, 8);
  const flip = c => ((parseInt(c, 16) ^ (1 + randInt(0, 6))) & 0xf).toString(16);
  hex[pos1]  = flip(hex[pos1]);
  hex[pos2]  = flip(hex[pos2]);
  return '0x' + hex.join('');
}

// ─── Withdrawal briefs ────────────────────────────────────────────────────────

const TOKENS  = ['ETH', 'USDC', 'WBTC', 'LINK', 'UNI'];
const AMOUNTS = ['0.12', '0.25', '0.50', '1.00', '250.00', '500.00', '0.005'];

function genBrief() {
  const token     = TOKENS[randInt(0, TOKENS.length)];
  const amount    = AMOUNTS[randInt(0, AMOUNTS.length)];
  const memo      = 'ref-' + crypto.randomBytes(3).toString('hex');
  const recipient = genEthAddress();
  return { token, amount, recipient, memo };
}

// ─── Session factory ──────────────────────────────────────────────────────────

function makeSession() {
  const brief  = genBrief();
  const secret = genTotpSecret();
  const s = {
    ...newSessionBase(),
    brief,
    totpSecret:       secret,
    poisonedAddress:  poisonAddress(brief.recipient),
    step1At:          null,   // when step1 response was sent
    currentStep:      1,
    cumulative: {
      ...baseCumulative(),
      step1ElapsedMs: null,
    },
  };
  sessions.set(s.id, s);
  return s;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/crypto/session', attachApiKey, (req, res) => {
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

  const totpUri = `otpauth://totp/AgentGauntlet?secret=${s.totpSecret}&issuer=AgentGauntlet&algorithm=SHA1&digits=6&period=30`;

  res.json({
    sessionId: s.id, token: s.token,
    withdrawal: {
      amount:    s.brief.amount,
      token:     s.brief.token,
      recipient: s.brief.recipient,
      memo:      s.brief.memo,
    },
    totp: { uri: totpUri, period: 30, digits: 6 },
    // Address-poisoning trap: a "recently used" address that looks like the recipient
    // but has two hex characters changed. Submitting this is a critical error.
    recentAddresses: [
      { label: 'Cold Wallet',  address: s.poisonedAddress },
      { label: 'Hot Wallet',   address: genEthAddress() },
    ],
    warning:            'New destination address. Verify every character before authorising.',
    requireFingerprint: true,
    risk:               publicRisk(risk, s.keyTier),
  });
});

// /api/crypto/fingerprint — handled by createScenario

app.post('/api/crypto/authorize', async (req, res) => {
  const { sessionId, token, verifiedAddress, totpCode: submittedCode, telemetry = {} } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                  return res.status(403).json({ ok: false, reason: 'session_used' });
  if (s.currentStep !== 1)     return res.status(403).json({ ok: false, reason: 'wrong_step' });
  if (s.requiresStepUp && !s.stepUpPassed) {
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier) });
  }

  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, 1, telemetry);

  const now      = Date.now();
  const stepSigs = [];

  // Address verification
  const submitted = String(verifiedAddress || '').toLowerCase().trim();
  const expected  = s.brief.recipient.toLowerCase();
  const poisoned  = s.poisonedAddress.toLowerCase();

  if (submitted === poisoned) {
    stepSigs.push('address_substitution_accepted'); // fell for the poisoning trap
  } else if (submitted !== expected) {
    stepSigs.push('wallet_address_not_verified');   // submitted wrong / empty address
  }

  // TOTP verification
  const expectedCode = totpCode(s.totpSecret);
  const code         = String(submittedCode || '').replace(/\D/g, '').trim();
  if (code !== expectedCode) {
    stepSigs.push('totp_wrong_code');
  } else if (now - s.createdAt < 3_000) {
    stepSigs.push('totp_entered_too_fast'); // correct but suspiciously instant
  }

  const guard = actionGuard(s, stepSigs);
  if (guard && guard.action === 'block') {
    await recordTerminalVisit(s, 'block', s.signals);
    sessions.delete(sessionId);
    return res.status(403).json(guard);
  }
  if (guard && guard.action === 'step_up') return res.status(403).json(guard);

  s.currentStep = 2;
  s.step1At     = now;

  return res.json({
    ok: true, nextStep: 2,
    step2: {
      prompt:  'Final confirmation required. Review the details below and confirm the withdrawal.',
      summary: { amount: s.brief.amount, token: s.brief.token, recipient: s.brief.recipient, memo: s.brief.memo },
    },
    warning: 'This action is irreversible. Funds sent to the wrong address cannot be recovered.',
    risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier),
  });
});

app.post('/api/crypto/confirm', async (req, res) => {
  const { sessionId, token, telemetry = {} } = req.body || {};
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

  const now       = Date.now();
  const elapsed   = now - s.createdAt;
  const finalSigs = [];

  // Dismissed irreversibility warning too fast
  if (s.step1At && now - s.step1At < 600) finalSigs.push('no_pause_security_warning');

  if (elapsed < 5_000)       finalSigs.push('too_fast');
  if (s.cumulative.mouseMoves < 5) finalSigs.push('low_mouse_activity');

  const dwellMedian = median(s.cumulative.clickDwellSamples);
  if (s.cumulative.clickCount >= 2 && dwellMedian < 20) finalSigs.push('synthetic_click_dwell');

  if (s.cumulative.velocityMeanSamples.length > 0) {
    const vMean = s.cumulative.velocityMeanSamples.reduce((a, b) => a + b, 0) / s.cumulative.velocityMeanSamples.length;
    const vStd  = s.cumulative.velocityStdSamples.reduce((a, b)  => a + b, 0) / s.cumulative.velocityStdSamples.length;
    if (vMean > 0 && vStd / vMean < 0.15) finalSigs.push('uniform_mouse_velocity');
  }

  const rxMin = s.cumulative.firstEventLatenciesMs.length > 0 ? Math.min(...s.cumulative.firstEventLatenciesMs) : null;
  if (rxMin !== null && rxMin < 100) finalSigs.push('superhuman_reaction_time');

  const allFinal = [...s.signals, ...finalSigs];
  const risk     = computeRisk(allFinal);
  s.lastRisk     = risk;
  s.signals      = allFinal;

  if (risk.action === 'block') {
    await recordTerminalVisit(s, 'block', allFinal);
    sessions.delete(sessionId);
    return res.status(403).json({ ok: false, action: 'block', risk: publicRisk(risk, s.keyTier), handle: s.handle, visitorId: s.visitorId });
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
    ok:   true, action: 'allow',
    txHash:    '0x' + crypto.randomBytes(32).toString('hex'),
    withdrawal: { amount: s.brief.amount, token: s.brief.token, recipient: s.brief.recipient },
    risk:      publicRisk(risk, s.keyTier),
    handle:    s.handle, visitorId: s.visitorId,
  });
});

// /api/crypto/fingerprint, stepup-challenge, stepup-verify, visitor, leaderboard
// — all registered by createScenario

start(path.join(__dirname, '.certs'));
