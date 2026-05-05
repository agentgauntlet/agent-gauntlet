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
                     'no_user_agent', 'no_accept_language', 'no_accept_encoding', 'no_fingerprint_object'],
};

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
             risk_score, risk_tier, elapsed_ms, had_step_up, ja3_hash, user_agent, api_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (session_id) DO NOTHING
        `, [
          visit.sessionId, visitorId, visit.scenario || 'unknown',
          now - (visit.elapsedMs || 0), now, visit.outcome,
          visit.score, visit.tier, visit.elapsedMs || null, hadStepUp,
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
    const { rows: visitors } = await pool.query(`
      SELECT * FROM ${G}.visitors
      WHERE visitor_id IN (
        SELECT DISTINCT visitor_id FROM ${G}.sessions WHERE api_key IS NOT NULL
      )
    `);

    const enriched = await Promise.all(visitors.map(async (v) => {
      const id = v.visitor_id;

      const { rows: scoreRows } = await pool.query(
        `SELECT risk_score FROM ${G}.sessions WHERE visitor_id = $1 ORDER BY ended_at DESC LIMIT 100`, [id],
      );
      const scores     = scoreRows.map(r => r.risk_score);
      const avgScore   = scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;
      const bestScore  = scores.length ? Math.min(...scores) : null;

      const { rows: allSigRows } = await pool.query(`
        SELECT ss.signal, COUNT(*)::int AS cnt
        FROM   ${G}.session_signals ss
        JOIN   ${G}.sessions s ON ss.session_id = s.session_id
        WHERE  s.visitor_id = $1
        GROUP  BY ss.signal
      `, [id]);
      const sigCounts = {};
      for (const r of allSigRows) sigCounts[r.signal] = r.cnt;

      const dimensionScores = {};
      for (const [dim, sigs] of Object.entries(DIMENSIONS)) {
        dimensionScores[dim] = sigs.reduce((sum, s) => sum + (sigCounts[s] || 0), 0);
      }

      const { rows: scenarioRows } = await pool.query(
        `SELECT DISTINCT scenario FROM ${G}.sessions WHERE visitor_id = $1 AND api_key IS NOT NULL`,
        [id],
      );
      const scenarioList = scenarioRows.map(r => r.scenario).filter(s => s && s !== 'unknown');

      const { rows: [ja3Row] } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM ${G}.visitor_ja3 WHERE visitor_id = $1`, [id],
      );
      const { rows: [uaRow] } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM ${G}.visitor_ua  WHERE visitor_id = $1`, [id],
      );

      return {
        visitorId:          id,
        handle:             v.handle,
        visitCount:         v.visit_count,
        outcomes:           { complete: v.complete_count, block: v.block_count },
        stepUpsEncountered: v.stepup_encountered,
        stepUpsPassed:      v.stepup_passed,
        avgScore,
        bestScore,
        signalVariety:      Object.keys(sigCounts).length,
        dimensionScores,
        scenariosRun:       scenarioList.length,
        scenarioList,
        lastSeen:           Number(v.last_seen),
        firstSeen:          Number(v.first_seen),
        ja3Count:           ja3Row?.c || 0,
        uaCount:            uaRow?.c  || 0,
      };
    }));

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
      `SELECT COUNT(DISTINCT visitor_id)::int AS c FROM ${G}.sessions WHERE api_key IS NOT NULL`,
    );
    return row?.c || 0;
  }
}

module.exports = { PgVisitorStore };
