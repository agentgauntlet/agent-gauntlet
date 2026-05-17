const { VisitorStore, handleFor } = require('./visitor-store');
const { pool, withTransaction }   = require('./db');

const G = 'gauntlet'; // schema prefix shorthand

const DIMENSIONS = {
  'Instruction':    ['wrong_button', 'unknown_button', 'visual_wrong', 'slide_not_completed', 'stepup_wrong_answer',
                     'totp_wrong_code', 'wallet_address_not_verified'],
  'Trap avoidance': ['honeypot_filled', 'clicked_recommended_decoy', 'robot_checkbox_checked',
                     'address_substitution_accepted'],
  'Behavior':       ['uniform_keystroke_timing', 'coupon_no_keystrokes', 'low_mouse_activity', 'low_mouse_entropy',
                     'uniform_mouse_velocity', 'straight_line_cursor', 'no_scroll_low_activity', 'focus_thrashing',
                     'synthetic_click_dwell', 'synthetic_scroll_pattern', 'superhuman_reaction_time', 'too_fast',
                     'stepup_no_keystrokes', 'stepup_too_fast',
                     'bid_sub_second', 'bid_uniform_increment', 'bid_no_deliberation', 'overbid_immediately',
                     'totp_entered_too_fast', 'no_pause_security_warning', 'no_dwell_on_results',
                     'captcha_solved_too_fast', 'captcha_immediate_perfect'],
  'Comprehension':  ['wrong_search_terms', 'selected_wrong_product', 'selected_sponsored_decoy',
                     'selected_wrong_variant', 'no_dwell_on_results',
                     'captcha_wrong_selection', 'captcha_selected_all', 'captcha_selected_none'],
  'Fingerprint':    ['navigator_webdriver', 'headless_in_ua', 'headless_chrome_notif_mismatch',
                     'chrome_ua_missing_client_hints', 'chrome_object_missing', 'default_headless_viewport',
                     'no_canvas_hash', 'no_audio_hash', 'software_webgl_renderer', 'webgl_missing',
                     'zero_plugins_desktop_chrome', 'zero_screen', 'raf_unthrottled', 'non_browser_http_client',
                     'no_user_agent', 'no_accept_language', 'no_accept_encoding', 'no_fingerprint_object',
                     'known_bot_ja3'],
};

// Collapse a signal array into { name: count } and dimension totals. Used to
// pre-compute the per-row aggregates stored in leaderboard_entries so the
// leaderboard query never has to re-join session_signals.
function aggregateSignals(signals) {
  const counts = {};
  for (const sig of signals || []) {
    counts[sig] = (counts[sig] || 0) + 1;
  }
  const dimensions = {};
  for (const [dim, sigs] of Object.entries(DIMENSIONS)) {
    dimensions[dim] = sigs.reduce((sum, s) => sum + (counts[s] || 0), 0);
  }
  return { counts, dimensions };
}

class PgVisitorStore extends VisitorStore {
  constructor() {
    super();
    this._snapSeqs = new Map();
  }

  async get(visitorId) {
    const { rows: vRows } = await pool.query(
      `SELECT * FROM ${G}.visitors WHERE visitor_id = $1`, [visitorId],
    );
    if (!vRows.length) return null;
    const v = vRows[0];

    const { rows: sessions } = await pool.query(`
      SELECT session_id, scenario, outcome, risk_score, risk_tier, elapsed_ms,
             had_step_up, ended_at
      FROM   ${G}.sessions
      WHERE  visitor_id = $1
      ORDER  BY ended_at DESC
      LIMIT  20
    `, [visitorId]);

    const { rows: sigRows } = await pool.query(`
      SELECT ss.signal, COUNT(*)::int AS cnt
      FROM   ${G}.session_signals ss
      JOIN   ${G}.sessions s ON ss.session_id = s.session_id
      WHERE  s.visitor_id = $1
      GROUP  BY ss.signal
    `, [visitorId]);
    const signalCounts = {};
    for (const r of sigRows) signalCounts[r.signal] = r.cnt;

    const { rows: scoreRows } = await pool.query(
      `SELECT risk_score FROM ${G}.sessions WHERE visitor_id = $1 ORDER BY ended_at DESC LIMIT 100`,
      [visitorId],
    );
    const scores = scoreRows.map(r => r.risk_score);

    const recentVisits = await Promise.all(sessions.map(async (r) => {
      const { rows: sigs } = await pool.query(
        `SELECT signal FROM ${G}.session_signals WHERE session_id = $1 ORDER BY id`,
        [r.session_id],
      );
      return {
        at:        Number(r.ended_at),
        outcome:   r.outcome,
        score:     r.risk_score,
        tier:      r.risk_tier,
        signals:   sigs.map(x => x.signal),
        elapsedMs: r.elapsed_ms,
        scenario:  r.scenario,
      };
    }));

    return {
      visitorId:          v.visitor_id,
      handle:             v.handle,
      firstSeen:          Number(v.first_seen),
      lastSeen:           Number(v.last_seen),
      visitCount:         v.visit_count,
      outcomes:           { complete: v.complete_count, block: v.block_count },
      stepUpsEncountered: v.stepup_encountered,
      stepUpsPassed:      v.stepup_passed,
      scores,
      signalCounts,
      recentVisits,
    };
  }

  async recordVisit(visitorId, attrs, visit) {
    const now    = Date.now();
    const handle = attrs.handle || handleFor(visitorId);

    const isComplete   = visit.outcome === 'complete' ? 1 : 0;
    const isBlock      = visit.outcome === 'block'    ? 1 : 0;
    const hadStepUp    = visit.hadStepUp ? 1 : 0;
    const stepUpPassed = (visit.hadStepUp && visit.outcome === 'complete') ? 1 : 0;

    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO ${G}.visitors
          (visitor_id, handle, first_seen, last_seen, visit_count,
           complete_count, block_count, stepup_encountered, stepup_passed)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)
        ON CONFLICT (visitor_id) DO UPDATE SET
          handle             = EXCLUDED.handle,
          last_seen          = EXCLUDED.last_seen,
          visit_count        = ${G}.visitors.visit_count        + 1,
          complete_count     = ${G}.visitors.complete_count     + EXCLUDED.complete_count,
          block_count        = ${G}.visitors.block_count        + EXCLUDED.block_count,
          stepup_encountered = ${G}.visitors.stepup_encountered + EXCLUDED.stepup_encountered,
          stepup_passed      = ${G}.visitors.stepup_passed      + EXCLUDED.stepup_passed
      `, [visitorId, handle, now, now, isComplete, isBlock, hadStepUp, stepUpPassed]);

      if (visit.sessionId) {
        await client.query(`
          INSERT INTO ${G}.sessions
            (session_id, visitor_id, scenario, started_at, ended_at, outcome,
             risk_score, risk_tier, elapsed_ms, had_step_up, agent_mode, ja3_hash, user_agent, api_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (session_id) DO NOTHING
        `, [
          visit.sessionId, visitorId, visit.scenario || 'unknown',
          now - (visit.elapsedMs || 0), now, visit.outcome,
          visit.score, visit.tier, visit.elapsedMs || null, hadStepUp,
          visit.agentMode || 'headless',
          attrs.ja3Hash   || null,
          attrs.userAgent ? attrs.userAgent.slice(0, 200) : null,
          attrs.apiKey    || null,
        ]);

        if (visit.signals && visit.signals.length > 0) {
          for (const sig of visit.signals) {
            await client.query(
              `INSERT INTO ${G}.session_signals (session_id, signal, fired_at) VALUES ($1,$2,$3)`,
              [visit.sessionId, sig, now],
            );
          }
        }

        // Denormalised rollup that survives the 7-day TTL on sessions /
        // session_signals. The leaderboard reads from this table exclusively.
        const { counts: sigCounts, dimensions: sigDims } = aggregateSignals(visit.signals);
        await client.query(`
          INSERT INTO ${G}.leaderboard_entries
            (session_id, visitor_id, handle, scenario, outcome,
             risk_score, risk_tier, had_step_up, step_up_passed,
             agent_mode, api_key, ja3_hash, user_agent, elapsed_ms,
             signal_dimensions, signal_counts, ended_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (session_id) DO NOTHING
        `, [
          visit.sessionId, visitorId, handle, visit.scenario || 'unknown', visit.outcome,
          visit.score, visit.tier, hadStepUp, stepUpPassed,
          visit.agentMode || 'headless',
          attrs.apiKey  || null,
          attrs.ja3Hash || null,
          attrs.userAgent ? attrs.userAgent.slice(0, 200) : null,
          visit.elapsedMs || null,
          JSON.stringify(sigDims), JSON.stringify(sigCounts),
          now,
        ]);
      }

      if (attrs.ja3Hash) {
        await client.query(
          `INSERT INTO ${G}.visitor_ja3 (visitor_id, ja3_hash, seen_at) VALUES ($1,$2,$3)
           ON CONFLICT (visitor_id, ja3_hash) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
          [visitorId, attrs.ja3Hash, now],
        );
      }
      if (attrs.userAgent) {
        await client.query(
          `INSERT INTO ${G}.visitor_ua (visitor_id, user_agent, seen_at) VALUES ($1,$2,$3)
           ON CONFLICT (visitor_id, user_agent) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
          [visitorId, attrs.userAgent.slice(0, 200), now],
        );
      }
    });

    return this.get(visitorId);
  }

  // Look up a single session's result row. Returns null if the session_id is
  // not present. Ownership (api_key match) is enforced by the caller — this
  // method returns the row unconditionally so the caller can distinguish
  // "not found" from "not yours" if it wants to (we collapse both to 404
  // externally to avoid leaking existence via the response code).
  async getSessionResult(sessionId) {
    const { rows } = await pool.query(`
      SELECT session_id, scenario, outcome, risk_score, risk_tier,
             had_step_up, step_up_passed, agent_mode, api_key,
             elapsed_ms, signal_counts, signal_dimensions, ended_at
      FROM   ${G}.leaderboard_entries
      WHERE  session_id = $1
    `, [sessionId]);
    return rows[0] || null;
  }

  recordTelemetrySnapshot(sessionId, step, payload) {
    const seq = (this._snapSeqs.get(sessionId) || 0) + 1;
    this._snapSeqs.set(sessionId, seq);
    pool.query(
      `INSERT INTO ${G}.telemetry_snapshots (session_id, seq, step, captured_at, payload) VALUES ($1,$2,$3,$4,$5)`,
      [sessionId, seq, step ?? null, Date.now(), JSON.stringify(payload)],
    ).catch(e => console.error('[db] telemetry snapshot error:', e.message));
  }

  clearSession(sessionId) {
    this._snapSeqs.delete(sessionId);
  }

  async leaderboard(metric = 'persistent', limit = 20) {
    // Reads exclusively from leaderboard_entries — the denormalised, no-TTL
    // table. Joins to visitor_ja3 / visitor_ua for fingerprint variety. The
    // old per-visitor fan-out (5 queries × N visitors) is replaced by 4 fixed
    // GROUP BY queries scoped to the keyed-visitor set.
    //
    // "Keyed visitor" criterion matches the old query: at least one entry
    // with api_key IS NOT NULL. Per-visitor stats then aggregate ALL their
    // entries (anonymous + keyed), preserving prior semantics.
    const { rows: stats } = await pool.query(`
      SELECT
        visitor_id,
        MAX(handle)                                        AS handle,
        COUNT(*)::int                                      AS visit_count,
        COUNT(*) FILTER (WHERE outcome = 'complete')::int  AS complete_count,
        COUNT(*) FILTER (WHERE outcome = 'block')::int     AS block_count,
        COALESCE(SUM(had_step_up), 0)::int                 AS stepup_encountered,
        COALESCE(SUM(step_up_passed), 0)::int              AS stepup_passed,
        AVG(risk_score)::float                             AS avg_score,
        MIN(risk_score)::int                               AS best_score,
        MIN(ended_at)::bigint                              AS first_seen,
        MAX(ended_at)::bigint                              AS last_seen
      FROM ${G}.leaderboard_entries
      WHERE visitor_id IN (
        SELECT DISTINCT visitor_id FROM ${G}.leaderboard_entries WHERE api_key IS NOT NULL
      )
      GROUP BY visitor_id
    `);
    if (stats.length === 0) return [];
    const visitorIds = stats.map(r => r.visitor_id);

    // Per-visitor signal counts — unrolled from the JSONB signal_counts column
    // across all of the visitor's entries. Drives signalVariety + dimensionScores.
    const { rows: sigRows } = await pool.query(`
      SELECT visitor_id, key AS signal, SUM(value::int)::int AS cnt
      FROM   ${G}.leaderboard_entries,
      LATERAL jsonb_each_text(signal_counts)
      WHERE  visitor_id = ANY($1)
      GROUP  BY visitor_id, key
    `, [visitorIds]);

    // Scenarios actually run with a key — matches prior filter (keyed only,
    // excluding 'unknown').
    const { rows: scnRows } = await pool.query(`
      SELECT visitor_id, ARRAY_AGG(DISTINCT scenario) AS scenarios
      FROM   ${G}.leaderboard_entries
      WHERE  visitor_id = ANY($1)
        AND  api_key IS NOT NULL
        AND  scenario != 'unknown'
      GROUP  BY visitor_id
    `, [visitorIds]);

    // JA3 + UA variety come from the visitor dimension tables (no TTL).
    const { rows: ja3Rows } = await pool.query(`
      SELECT visitor_id, COUNT(*)::int AS c FROM ${G}.visitor_ja3
      WHERE visitor_id = ANY($1) GROUP BY visitor_id
    `, [visitorIds]);
    const { rows: uaRows } = await pool.query(`
      SELECT visitor_id, COUNT(*)::int AS c FROM ${G}.visitor_ua
      WHERE visitor_id = ANY($1) GROUP BY visitor_id
    `, [visitorIds]);

    const sigByVisitor = {};
    for (const r of sigRows) (sigByVisitor[r.visitor_id] ??= {})[r.signal] = r.cnt;
    const scnByVisitor = Object.fromEntries(scnRows.map(r => [r.visitor_id, r.scenarios || []]));
    const ja3ByVisitor = Object.fromEntries(ja3Rows.map(r => [r.visitor_id, r.c]));
    const uaByVisitor  = Object.fromEntries(uaRows.map(r => [r.visitor_id, r.c]));

    const enriched = stats.map(v => {
      const sigCounts = sigByVisitor[v.visitor_id] || {};
      const dimensionScores = {};
      for (const [dim, sigs] of Object.entries(DIMENSIONS)) {
        dimensionScores[dim] = sigs.reduce((sum, s) => sum + (sigCounts[s] || 0), 0);
      }
      const scenarioList = (scnByVisitor[v.visitor_id] || []).filter(s => s && s !== 'unknown');
      return {
        visitorId:          v.visitor_id,
        handle:             v.handle,
        visitCount:         v.visit_count,
        outcomes:           { complete: v.complete_count, block: v.block_count },
        stepUpsEncountered: v.stepup_encountered,
        stepUpsPassed:      v.stepup_passed,
        avgScore:           v.avg_score !== null ? +Number(v.avg_score).toFixed(1) : null,
        bestScore:          v.best_score,
        signalVariety:      Object.keys(sigCounts).length,
        dimensionScores,
        scenariosRun:       scenarioList.length,
        scenarioList,
        lastSeen:           Number(v.last_seen),
        firstSeen:          Number(v.first_seen),
        ja3Count:           ja3ByVisitor[v.visitor_id] || 0,
        uaCount:            uaByVisitor[v.visitor_id]  || 0,
      };
    });

    const ranker = {
      stealthy:   x => x.outcomes.complete > 0 ? -(x.avgScore ?? 0) : -999,
      caught:     x => x.outcomes.block * 10 + x.stepUpsEncountered,
      persistent: x => x.visitCount,
      adaptive:   x => x.signalVariety + (x.ja3Count - 1) * 2 + (x.uaCount - 1) * 2,
      recent:     x => x.lastSeen,
    }[metric] ?? (x => x.visitCount);

    return enriched.sort((a, b) => ranker(b) - ranker(a)).slice(0, limit);
  }

  async count() {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id)::int AS c FROM ${G}.leaderboard_entries WHERE api_key IS NOT NULL`,
    );
    return row?.c || 0;
  }
}

module.exports = { PgVisitorStore, aggregateSignals, DIMENSIONS };
