// SqliteVisitorStore — drop-in replacement for JsonVisitorStore backed by SQLite.
//
// Implements the same VisitorStore interface so no call sites change except the
// constructor import.  Extra methods (recordTelemetrySnapshot) are additive.

const { VisitorStore, handleFor } = require('./visitor-store');
const { getDb, withTransaction } = require('./db');

class SqliteVisitorStore extends VisitorStore {
  constructor() {
    super();
    this._db = getDb();
    // Per-process snapshot sequence counters (reset on restart, that's fine).
    this._snapSeqs = new Map();
    // Pre-compile hot-path statements once.
    this._stmts = this._prepare();
  }

  _prepare() {
    const db = this._db;
    return {
      getVisitor: db.prepare('SELECT * FROM visitors WHERE visitor_id = ?'),

      recentSessions: db.prepare(`
        SELECT session_id, scenario, outcome, risk_score, risk_tier, elapsed_ms,
               had_step_up, ended_at
        FROM   sessions
        WHERE  visitor_id = ?
        ORDER  BY ended_at DESC
        LIMIT  20
      `),

      sessionSignals: db.prepare(`
        SELECT signal FROM session_signals WHERE session_id = ? ORDER BY id
      `),

      signalCounts: db.prepare(`
        SELECT ss.signal, COUNT(*) AS cnt
        FROM   session_signals ss
        JOIN   sessions s ON ss.session_id = s.session_id
        WHERE  s.visitor_id = ?
        GROUP  BY ss.signal
      `),

      recentScores: db.prepare(`
        SELECT risk_score FROM sessions WHERE visitor_id = ?
        ORDER  BY ended_at DESC LIMIT 100
      `),

      signalVariety: db.prepare(`
        SELECT COUNT(DISTINCT ss.signal) AS c
        FROM   session_signals ss
        JOIN   sessions s ON ss.session_id = s.session_id
        WHERE  s.visitor_id = ?
      `),

      topSignals: db.prepare(`
        SELECT ss.signal, COUNT(*) AS cnt
        FROM   session_signals ss
        JOIN   sessions s ON ss.session_id = s.session_id
        WHERE  s.visitor_id = ?
        GROUP  BY ss.signal
        ORDER  BY cnt DESC
        LIMIT  4
      `),

      ja3Count: db.prepare('SELECT COUNT(*) AS c FROM visitor_ja3 WHERE visitor_id = ?'),
      uaCount:  db.prepare('SELECT COUNT(*) AS c FROM visitor_ua  WHERE visitor_id = ?'),

      // Only visitors with at least one keyed (non-anonymous) session appear on leaderboard.
      countLeaderboard: db.prepare(`
        SELECT COUNT(DISTINCT visitor_id) AS c FROM sessions WHERE api_key IS NOT NULL
      `),

      leaderboardVisitors: db.prepare(`
        SELECT * FROM visitors
        WHERE visitor_id IN (SELECT DISTINCT visitor_id FROM sessions WHERE api_key IS NOT NULL)
      `),
    };
  }

  // ------------------------------------------------------------------
  // VisitorStore interface
  // ------------------------------------------------------------------

  async get(visitorId) {
    const v = this._stmts.getVisitor.get(visitorId);
    if (!v) return null;

    const recentSessions = this._stmts.recentSessions.all(visitorId);
    const sigCounts = {};
    for (const { signal, cnt } of this._stmts.signalCounts.all(visitorId)) {
      sigCounts[signal] = cnt;
    }
    const scores = this._stmts.recentScores.all(visitorId).map(r => r.risk_score);

    const recentVisits = recentSessions.map(r => {
      const signals = this._stmts.sessionSignals.all(r.session_id).map(x => x.signal);
      return {
        at:        r.ended_at,
        outcome:   r.outcome,
        score:     r.risk_score,
        tier:      r.risk_tier,
        signals,
        elapsedMs: r.elapsed_ms,
        scenario:  r.scenario,
      };
    });

    return {
      visitorId:        v.visitor_id,
      handle:           v.handle,
      firstSeen:        v.first_seen,
      lastSeen:         v.last_seen,
      visitCount:       v.visit_count,
      outcomes:         { complete: v.complete_count, block: v.block_count },
      stepUpsEncountered: v.stepup_encountered,
      stepUpsPassed:    v.stepup_passed,
      scores,
      signalCounts:     sigCounts,
      recentVisits,
    };
  }

  async recordVisit(visitorId, attrs, visit) {
    const now    = Date.now();
    const handle = attrs.handle || handleFor(visitorId);
    const db     = this._db;

    const isComplete   = visit.outcome === 'complete' ? 1 : 0;
    const isBlock      = visit.outcome === 'block'    ? 1 : 0;
    const hadStepUp    = visit.hadStepUp ? 1 : 0;
    const stepUpPassed = (visit.hadStepUp && visit.outcome === 'complete') ? 1 : 0;

    const insVisitor = db.prepare(`
      INSERT INTO visitors
        (visitor_id, handle, first_seen, last_seen, visit_count,
         complete_count, block_count, stepup_encountered, stepup_passed)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(visitor_id) DO UPDATE SET
        handle             = excluded.handle,
        last_seen          = excluded.last_seen,
        visit_count        = visitors.visit_count        + 1,
        complete_count     = visitors.complete_count     + excluded.complete_count,
        block_count        = visitors.block_count        + excluded.block_count,
        stepup_encountered = visitors.stepup_encountered + excluded.stepup_encountered,
        stepup_passed      = visitors.stepup_passed      + excluded.stepup_passed
    `);

    const insSession = db.prepare(`
      INSERT OR IGNORE INTO sessions
        (session_id, visitor_id, scenario, started_at, ended_at, outcome,
         risk_score, risk_tier, elapsed_ms, had_step_up, ja3_hash, user_agent, api_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insSignal = db.prepare(
      'INSERT INTO session_signals (session_id, signal, fired_at) VALUES (?, ?, ?)',
    );

    const insJa3 = db.prepare(
      'INSERT OR REPLACE INTO visitor_ja3 (visitor_id, ja3_hash, seen_at) VALUES (?, ?, ?)',
    );

    const insUa = db.prepare(
      'INSERT OR REPLACE INTO visitor_ua (visitor_id, user_agent, seen_at) VALUES (?, ?, ?)',
    );

    withTransaction(db, () => {
      insVisitor.run(visitorId, handle, now, now, isComplete, isBlock, hadStepUp, stepUpPassed);

      if (visit.sessionId) {
        insSession.run(
          visit.sessionId, visitorId, visit.scenario || 'unknown',
          now - (visit.elapsedMs || 0), now, visit.outcome,
          visit.score, visit.tier, visit.elapsedMs || null, hadStepUp,
          attrs.ja3Hash || null,
          attrs.userAgent ? attrs.userAgent.slice(0, 200) : null,
          attrs.apiKey   || null,
        );

        if (visit.signals && visit.signals.length > 0) {
          for (const sig of visit.signals) insSignal.run(visit.sessionId, sig, now);
        }
      }

      if (attrs.ja3Hash)   insJa3.run(visitorId, attrs.ja3Hash, now);
      if (attrs.userAgent) insUa.run(visitorId, attrs.userAgent.slice(0, 200), now);
    });

    return this.get(visitorId);
  }

  // ------------------------------------------------------------------
  // Telemetry snapshot — called on every accumulateTelemetry() to persist
  // the raw browser-side payload before it gets aggregated and discarded.
  // ------------------------------------------------------------------

  recordTelemetrySnapshot(sessionId, step, payload) {
    const seq = (this._snapSeqs.get(sessionId) || 0) + 1;
    this._snapSeqs.set(sessionId, seq);
    this._db.prepare(`
      INSERT INTO telemetry_snapshots (session_id, seq, step, captured_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, seq, step ?? null, Date.now(), JSON.stringify(payload));
  }

  // Clean up the in-memory seq counter when a session ends.
  clearSession(sessionId) {
    this._snapSeqs.delete(sessionId);
  }

  // ------------------------------------------------------------------
  // Leaderboard
  // ------------------------------------------------------------------

  async leaderboard(metric = 'persistent', limit = 20) {
    const visitors = this._stmts.leaderboardVisitors.all();

    const enriched = visitors.map(v => {
      const id = v.visitor_id;
      const scores = this._stmts.recentScores.all(id).map(r => r.risk_score);
      const avgScore   = scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;
      const bestScore  = scores.length ? Math.min(...scores) : null;
      const worstScore = scores.length ? Math.max(...scores) : null;

      const signalVariety = this._stmts.signalVariety.get(id)?.c || 0;
      const topSignals    = this._stmts.topSignals.all(id).map(r => [r.signal, r.cnt]);
      const ja3Count      = this._stmts.ja3Count.get(id)?.c || 0;
      const uaCount       = this._stmts.uaCount.get(id)?.c  || 0;

      return {
        visitorId:          id,
        handle:             v.handle,
        visitCount:         v.visit_count,
        outcomes:           { complete: v.complete_count, block: v.block_count },
        stepUpsEncountered: v.stepup_encountered,
        stepUpsPassed:      v.stepup_passed,
        avgScore,
        bestScore,
        worstScore,
        signalVariety,
        topSignals,
        lastSeen:           v.last_seen,
        firstSeen:          v.first_seen,
        ja3Count,
        uaCount,
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
    return this._stmts.countLeaderboard.get().c;
  }
}

module.exports = { SqliteVisitorStore };
