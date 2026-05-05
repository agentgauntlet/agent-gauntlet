// Scoring gateway — routes computeRisk() to the private hosted service when
// SCORING_URL is set, or falls back to the local risk.js implementation.
//
// This is the seam between open-source and proprietary scoring:
//   Self-hosted  → SCORING_URL unset  → local fallback (basic count-based weights)
//   Hosted       → SCORING_URL set    → private microservice (real weights, never in repo)

const { computeRisk: _localCompute, SIGNAL_WEIGHTS, THRESHOLDS } = require('./risk');

const SCORING_URL = process.env.SCORING_URL || null;

function isSelfHosted() {
  return !SCORING_URL;
}

async function computeRisk(signals, scenario) {
  if (!SCORING_URL) return _localCompute(signals);
  try {
    const res = await fetch(`${SCORING_URL}/api/score`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ signals, scenario }),
    });
    if (!res.ok) throw new Error(`scoring service responded ${res.status}`);
    return res.json();
  } catch (e) {
    console.error('[scoring] remote error, using fallback:', e.message);
    return _localCompute(signals);
  }
}

module.exports = { computeRisk, isSelfHosted, SIGNAL_WEIGHTS, THRESHOLDS };
