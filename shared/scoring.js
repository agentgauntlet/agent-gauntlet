// Scoring gateway — two entry points:
//
//   computeRisk(signals)              — synchronous, local weights, used for
//                                       real-time gating (allow/block/step_up)
//                                       during a live session.
//
//   computeHostedRisk(signals, scen)  — async, calls private scoring service
//                                       when SCORING_URL is set.  Used only in
//                                       recordTerminalVisit() for the official
//                                       leaderboard score.  Falls back to local
//                                       on error or when self-hosted.
//
// This is the open-core seam:
//   Self-hosted  → SCORING_URL unset  → both functions use local risk.js
//   Hosted       → SCORING_URL set    → real-time uses local; final score uses
//                                       private service (weights never in repo)

const { computeRisk: _localCompute, SIGNAL_WEIGHTS, THRESHOLDS } = require('./risk');

const SCORING_URL   = process.env.SCORING_URL || null;
const SCORING_TOKEN = process.env.SCORING_AUTH_TOKEN || null;

function isSelfHosted() {
  return !SCORING_URL;
}

// Synchronous — safe to call anywhere, no await needed.
function computeRisk(signals) {
  return _localCompute(signals);
}

// Async — only call from async contexts where awaiting is safe (recordTerminalVisit).
async function computeHostedRisk(signals, scenario) {
  if (!SCORING_URL) return _localCompute(signals);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (SCORING_TOKEN) headers.Authorization = `Bearer ${SCORING_TOKEN}`;
    const res = await fetch(`${SCORING_URL}/api/score`, {
      method: 'POST',
      headers,
      body:   JSON.stringify({ signals, scenario }),
    });
    if (!res.ok) throw new Error(`scoring service responded ${res.status}`);
    return res.json();
  } catch (e) {
    console.error('[scoring] remote error, using fallback:', e.message);
    return _localCompute(signals);
  }
}

module.exports = { computeRisk, computeHostedRisk, isSelfHosted, SIGNAL_WEIGHTS, THRESHOLDS };
