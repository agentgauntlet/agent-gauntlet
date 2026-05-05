// Visitor history persistence.
//
// VisitorStore is the abstract interface; the rest of the server depends
// only on this. JsonVisitorStore is the prototype implementation backed
// by an atomic-write JSON file. Swap to SQLite or Postgres later by
// writing a sibling class with the same shape — call sites don't change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ADJECTIVES = [
  'Sneaky', 'Curious', 'Bold', 'Swift', 'Quiet', 'Loud', 'Crafty',
  'Eager', 'Gentle', 'Wild', 'Calm', 'Lucky', 'Brave', 'Wise', 'Shy',
  'Cheerful', 'Grumpy', 'Mighty', 'Tiny', 'Fancy', 'Plain', 'Sleepy',
  'Hungry', 'Stealthy', 'Daring', 'Patient', 'Restless', 'Quick',
  'Sly', 'Nimble', 'Plucky', 'Smug',
];
const ANIMALS = [
  'Fox', 'Salamander', 'Otter', 'Wolf', 'Owl', 'Bear', 'Hawk', 'Lynx',
  'Mole', 'Toad', 'Crab', 'Eel', 'Newt', 'Stoat', 'Vole', 'Heron',
  'Badger', 'Shrew', 'Falcon', 'Raven', 'Quail', 'Mink', 'Marten',
  'Skunk', 'Beaver', 'Coyote', 'Ferret', 'Hedgehog', 'Ibex', 'Jackal',
  'Kestrel', 'Loris',
];

function handleFor(visitorId) {
  const a = parseInt(visitorId.slice(0, 4), 16) % ADJECTIVES.length;
  const b = parseInt(visitorId.slice(4, 8), 16) % ANIMALS.length;
  const c = visitorId.slice(8, 11).toUpperCase();
  return `${ADJECTIVES[a]} ${ANIMALS[b]} #${c}`;
}

function computeVisitorId(parts) {
  const s = [
    parts.ja3Hash || '',
    parts.canvasHash || '',
    parts.audioHash || '',
    parts.userAgent || '',
    parts.screen || '',
    parts.tz || '',
  ].join('|');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

// ---------- Abstract interface ----------
class VisitorStore {
  /* eslint-disable no-unused-vars */
  async get(_visitorId) { throw new Error('not implemented'); }
  async recordVisit(_visitorId, _attrs, _visit) { throw new Error('not implemented'); }
  async leaderboard(_metric, _limit) { throw new Error('not implemented'); }
  async count() { throw new Error('not implemented'); }
  /* eslint-enable no-unused-vars */
}

// ---------- JSON-file implementation ----------
class JsonVisitorStore extends VisitorStore {
  constructor(filePath) {
    super();
    this.path = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.data = this._load();
    this.flushTimer = null;
  }

  _load() {
    try {
      if (fs.existsSync(this.path)) {
        return JSON.parse(fs.readFileSync(this.path, 'utf8'));
      }
    } catch (_e) { /* corrupted file → start fresh */ }
    return { visitors: {}, version: 1 };
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        const tmp = this.path + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.path);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('visitor-store flush failed:', e.message);
      }
    }, 200);
  }

  async get(visitorId) {
    return this.data.visitors[visitorId] || null;
  }

  async recordVisit(visitorId, attrs, visit) {
    const now = Date.now();
    let v = this.data.visitors[visitorId];
    if (!v) {
      v = {
        visitorId,
        handle: attrs.handle || handleFor(visitorId),
        firstSeen: now,
        lastSeen: now,
        visitCount: 0,
        outcomes: { complete: 0, block: 0 },
        stepUpsEncountered: 0,
        stepUpsPassed: 0,
        scores: [],
        signalCounts: {},
        ja3Hashes: [],
        uaSamples: [],
        recentVisits: [],
      };
      this.data.visitors[visitorId] = v;
    }
    v.lastSeen = now;
    v.visitCount += 1;
    if (visit.outcome && v.outcomes[visit.outcome] != null) {
      v.outcomes[visit.outcome] += 1;
    }
    if (visit.hadStepUp) v.stepUpsEncountered += 1;
    if (visit.hadStepUp && visit.outcome === 'complete') v.stepUpsPassed += 1;
    if (typeof visit.score === 'number') {
      v.scores.push(visit.score);
      if (v.scores.length > 100) v.scores = v.scores.slice(-100);
    }
    for (const sig of visit.signals || []) {
      v.signalCounts[sig] = (v.signalCounts[sig] || 0) + 1;
    }
    if (attrs.ja3Hash && !v.ja3Hashes.includes(attrs.ja3Hash)) {
      v.ja3Hashes.push(attrs.ja3Hash);
      if (v.ja3Hashes.length > 5) v.ja3Hashes = v.ja3Hashes.slice(-5);
    }
    if (attrs.userAgent) {
      const trimmedUA = attrs.userAgent.slice(0, 160);
      if (!v.uaSamples.includes(trimmedUA)) {
        v.uaSamples.push(trimmedUA);
        if (v.uaSamples.length > 5) v.uaSamples = v.uaSamples.slice(-5);
      }
    }
    v.recentVisits.push({
      at: now,
      outcome: visit.outcome,
      score: visit.score,
      tier: visit.tier,
      signals: visit.signals || [],
      elapsedMs: visit.elapsedMs || null,
    });
    if (v.recentVisits.length > 20) v.recentVisits = v.recentVisits.slice(-20);

    this._scheduleFlush();
    return v;
  }

  _avg(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  _signalVariety(v) {
    return Object.keys(v.signalCounts).length;
  }

  async leaderboard(metric = 'persistent', limit = 20) {
    const list = Object.values(this.data.visitors);
    const enriched = list.map(v => ({
      visitorId: v.visitorId,
      handle: v.handle,
      visitCount: v.visitCount,
      outcomes: v.outcomes,
      stepUpsEncountered: v.stepUpsEncountered || 0,
      stepUpsPassed: v.stepUpsPassed || 0,
      avgScore: +this._avg(v.scores).toFixed(1),
      bestScore: v.scores.length ? Math.min(...v.scores) : null,
      worstScore: v.scores.length ? Math.max(...v.scores) : null,
      signalVariety: this._signalVariety(v),
      topSignals: Object.entries(v.signalCounts).sort((a, b) => b[1] - a[1]).slice(0, 4),
      lastSeen: v.lastSeen,
      firstSeen: v.firstSeen,
      ja3Count: (v.ja3Hashes || []).length,
      uaCount: (v.uaSamples || []).length,
    }));
    const ranker = {
      stealthy:   (x) => x.outcomes.complete > 0 ? -x.avgScore : -999,
      caught:     (x) => x.outcomes.block * 10 + x.stepUpsEncountered,
      persistent: (x) => x.visitCount,
      adaptive:   (x) => x.signalVariety + (x.ja3Count - 1) * 2 + (x.uaCount - 1) * 2,
      recent:     (x) => x.lastSeen,
    }[metric] || ((x) => x.visitCount);
    return enriched.sort((a, b) => ranker(b) - ranker(a)).slice(0, limit);
  }

  async count() {
    return Object.keys(this.data.visitors).length;
  }
}

module.exports = { VisitorStore, JsonVisitorStore, handleFor, computeVisitorId };
