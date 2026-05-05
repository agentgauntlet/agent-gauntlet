// Image-grid CAPTCHA scenario server.
// Scenario: identify the correct category from a 3×3 grid of generated PNG images.
// Challenge types: traffic lights (vs street lights), fire hydrants (vs bollards),
//                  bicycles (vs motorcycles).
// Defense focus: visual processing time, brute-force selection, category discrimination.
//
// All images are generated server-side as real PNGs using only Node built-ins (zlib).
// No external dependencies required.

'use strict';
const crypto = require('crypto');
const zlib   = require('zlib');
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
  scenario:  'captcha',
  apiPrefix: '/api/captcha',
  staticDir: path.join(__dirname, 'public'),
  port:      3006,
  httpsPort: 3449,
});

// ─── PNG encoder (pure Node.js, no native deps) ───────────────────────────────

const _CRC_T = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  _CRC_T[n] = c;
}
function _crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = _CRC_T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function _pngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(_crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}
function _toPng(rgb, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = y * (1 + w * 3) + 1 + x * 3;
      raw[d] = rgb[s]; raw[d + 1] = rgb[s + 1]; raw[d + 2] = rgb[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    _pngChunk('IHDR', ihdr),
    _pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    _pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Drawing primitives ───────────────────────────────────────────────────────

const W = 96, H = 96;

function _px(buf, x, y, r, g, b) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
}
function _rect(buf, x, y, rw, rh, r, g, b) {
  for (let dy = 0; dy < rh; dy++)
    for (let dx = 0; dx < rw; dx++)
      _px(buf, x + dx, y + dy, r, g, b);
}
function _circle(buf, cx, cy, rad, r, g, b) {
  const rad2 = rad * rad;
  for (let dy = -rad; dy <= rad; dy++)
    for (let dx = -rad; dx <= rad; dx++)
      if (dx * dx + dy * dy <= rad2) _px(buf, cx + dx, cy + dy, r, g, b);
}
function _line(buf, x1, y1, x2, y2, r, g, b, t = 1) {
  const dx = x2 - x1, dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let i = 0; i <= steps; i++) {
    const px = x1 + dx * i / steps, py = y1 + dy * i / steps;
    for (let ty = -t; ty <= t; ty++)
      for (let tx = -t; tx <= t; tx++)
        _px(buf, px + tx, py + ty, r, g, b);
  }
}
function _noise(buf, rng, amount) {
  for (let i = 0; i < W * H * 3; i++) {
    if (rng() < amount) buf[i] = Math.max(0, Math.min(255, buf[i] + Math.round((rng() - 0.5) * 80)));
  }
}
function _bg(buf, r, g, b) { buf.fill(0); for (let i = 0; i < W * H * 3; i += 3) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; } }

// ─── Background generators ────────────────────────────────────────────────────

function _makeBg(rng) {
  const t = Math.floor(rng() * 5);
  if (t === 0) { // day sky
    const b = Math.round(200 + rng() * 55);
    return [Math.round(100 + rng() * 50), Math.round(160 + rng() * 40), b];
  }
  if (t === 1) { // road
    const g = Math.round(140 + rng() * 50);
    return [g, g, Math.round(g + rng() * 20)];
  }
  if (t === 2) { // night
    return [Math.round(15 + rng() * 25), Math.round(15 + rng() * 25), Math.round(25 + rng() * 35)];
  }
  if (t === 3) { // wall/building
    return [Math.round(180 + rng() * 40), Math.round(165 + rng() * 40), Math.round(145 + rng() * 40)];
  }
  // overcast / fog
  const v = Math.round(180 + rng() * 50);
  return [v, v, v];
}

// Add road-surface texture to a road background
function _roadTexture(buf, rng) {
  for (let y = 0; y < H; y += Math.round(12 + rng() * 8)) {
    const shade = Math.round(rng() * 20 - 10);
    for (let x = 0; x < W; x++)
      for (let dy = 0; dy < 2; dy++) {
        const i = ((y + dy) * W + x) * 3;
        if (i < buf.length) {
          buf[i]   = Math.max(0, Math.min(255, buf[i]   + shade));
          buf[i+1] = Math.max(0, Math.min(255, buf[i+1] + shade));
          buf[i+2] = Math.max(0, Math.min(255, buf[i+2] + shade));
        }
      }
  }
}

// ─── Object drawers ───────────────────────────────────────────────────────────

function _drawTrafficLight(buf, cx, cy, sc, rng) {
  const bw = Math.round(16 * sc), bh = Math.round(38 * sc), lr = Math.round(5 * sc);
  const ph = Math.round(14 * sc);
  // pole
  _line(buf, cx, cy + bh / 2, cx, cy + bh / 2 + ph, 75, 75, 85, Math.max(1, Math.round(2 * sc)));
  // optional horizontal arm at top
  if (rng() > 0.4) _line(buf, cx - Math.round(6 * sc), cy - bh / 2, cx, cy - bh / 2, 75, 75, 85, 1);
  // housing with slight rounded feel (inner lighter border)
  _rect(buf, cx - bw / 2 - 1, cy - bh / 2 - 1, bw + 2, bh + 2, 55, 55, 60);
  _rect(buf, cx - bw / 2, cy - bh / 2, bw, bh, 28, 28, 30);
  // visor shades above each light
  for (let i = 0; i < 3; i++) {
    const ly = cy - bh / 2 + lr + i * (bh / 3);
    _rect(buf, cx - bw / 2, ly - lr - 2, bw, 3, 15, 15, 15);
  }
  // lights — vary which is lit based on rng (harder: only one lit circle visible)
  const litIdx  = Math.floor(rng() * 3); // 0=red 1=yellow 2=green
  const lights  = [[220, 40, 40], [200, 190, 20], [30, 190, 50]];
  const dimmed  = [[60, 10, 10],  [55, 50,  5],   [8,  50, 12]];
  for (let i = 0; i < 3; i++) {
    const ly  = Math.round(cy - bh / 2 + lr * 1.6 + i * (bh - lr * 3) / 2);
    const col = (i === litIdx) ? lights[i] : dimmed[i];
    _circle(buf, cx, ly, lr, ...col);
    if (i === litIdx) { // glow halo
      _circle(buf, cx, ly, lr + 2, Math.min(255, col[0] + 30), Math.min(255, col[1] + 20), Math.min(255, col[2] + 20));
      _circle(buf, cx, ly, lr, ...col);
    }
  }
}

function _drawStreetLight(buf, cx, cy, sc, rng) {
  const ph = Math.round(52 * sc); // pole height
  const hw = Math.round(22 * sc), hh = Math.round(7 * sc);
  const armLen = Math.round(18 * sc);
  const pc = [85, 85, 100]; // pole color
  // pole
  _line(buf, cx, cy - ph / 2, cx, cy + ph / 2, ...pc, Math.max(1, Math.round(2 * sc)));
  // outreach arm
  const armY = cy - ph / 2 + Math.round(4 * sc);
  _line(buf, cx, armY, cx + armLen, armY - Math.round(4 * sc), ...pc, 1);
  // luminaire head
  const hx = cx + armLen - hw / 2, hy = armY - Math.round(4 * sc) - hh;
  _rect(buf, hx, hy, hw, hh + 2, 170, 170, 160);
  // glow — warm yellow/white
  const glowR = Math.round(hw / 2) - 1;
  _circle(buf, cx + armLen, hy + hh / 2, glowR, 255, 240, 175);
  _circle(buf, cx + armLen, hy + hh / 2, glowR - 2, 255, 252, 220);
  // sometimes add a second lamp (makes it look even more like traffic light at distance)
  if (rng() > 0.5) {
    _circle(buf, cx + armLen - Math.round(8 * sc), hy + hh / 2, Math.round(glowR * 0.6), 255, 235, 160);
  }
}

function _drawFireHydrant(buf, cx, cy, sc, rng) {
  // Hydrants come in red OR yellow — same palette as bollards
  const isRed    = rng() > 0.35;
  const body     = isRed ? [195, 30, 30] : [210, 185, 15];
  const dark     = isRed ? [130, 15, 15] : [145, 125, 8];
  const bw = Math.round(22 * sc), bh = Math.round(28 * sc);
  const capR = Math.round(8 * sc);
  // shadow / base
  _rect(buf, cx - bw / 2 + 2, cy + bh / 2 - 4, bw - 2, 4, ...dark);
  // body barrel
  _rect(buf, cx - bw / 2, cy - bh / 2 + capR, bw, bh - capR, ...body);
  // dome cap
  _circle(buf, cx, cy - bh / 2 + capR, capR, ...body);
  // top bolt
  _circle(buf, cx, cy - bh / 2, Math.round(3 * sc), ...dark);
  // side outlet nozzles
  const nr = Math.round(5 * sc), ny = cy - Math.round(4 * sc);
  _circle(buf, cx - bw / 2 - nr + 1, ny, nr, ...body);
  _circle(buf, cx + bw / 2 + nr - 1, ny, nr, ...body);
  _circle(buf, cx - bw / 2 - nr + 1, ny, Math.round(nr / 2), ...dark);
  _circle(buf, cx + bw / 2 + nr - 1, ny, Math.round(nr / 2), ...dark);
  // highlight stripe
  _rect(buf, cx - bw / 2 + 2, cy, bw - 4, Math.round(3 * sc), Math.min(255, body[0] + 40), Math.min(255, body[1] + 40), Math.min(255, body[2] + 40));
}

function _drawBollard(buf, cx, cy, sc, rng) {
  // Bollards: orange or white/gray post — confusable with hydrant at small scale
  const isOrange = rng() > 0.3;
  const main  = isOrange ? [250, 130, 10] : [220, 220, 225];
  const dark  = isOrange ? [160, 80, 5]   : [140, 140, 145];
  const bw = Math.round(11 * sc), bh = Math.round(42 * sc);
  // post body
  _rect(buf, cx - bw / 2, cy - bh / 2, bw, bh, ...main);
  // reflective band (1-3 bands)
  const nBands = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < nBands; i++) {
    const by = Math.round(cy - bh / 2 + bh * (0.25 + i * 0.25));
    _rect(buf, cx - bw / 2, by, bw, Math.round(4 * sc), 20, 20, 20);
  }
  // rounded cap top
  _circle(buf, cx, cy - bh / 2, Math.round(bw / 2), ...main);
  // base widening
  _rect(buf, cx - bw / 2 - 3, cy + bh / 2 - 5, bw + 6, 5, ...dark);
}

function _drawBicycle(buf, cx, cy, sc, rng) {
  const wr  = Math.round(15 * sc); // wheel radius
  const sep = Math.round(36 * sc); // wheel separation
  const lx  = cx - sep / 2, rx = cx + sep / 2;
  const wy  = cy + Math.round(10 * sc);
  const fc  = [30 + Math.round(rng() * 80), 30 + Math.round(rng() * 80), 150 + Math.round(rng() * 80)];
  const wc  = [25, 25, 25];
  const rim = [110, 110, 115];
  // wheels
  for (const wx of [lx, rx]) {
    _circle(buf, wx, wy, wr, ...wc);
    _circle(buf, wx, wy, wr - 3, ...rim);
    // spokes (4 diagonal lines)
    for (let a = 0; a < 4; a++) {
      const ang = a * Math.PI / 4;
      _line(buf, wx, wy, wx + Math.cos(ang) * (wr - 4), wy + Math.sin(ang) * (wr - 4), 90, 90, 90, 0);
    }
    _circle(buf, wx, wy, 3, ...wc); // hub
  }
  // frame triangle
  const topY = cy - Math.round(12 * sc);
  _line(buf, lx, wy, cx, topY, ...fc, 2);         // seat stay
  _line(buf, rx, wy, cx, topY, ...fc, 2);         // chain/top tube
  _line(buf, cx, topY, rx, wy, ...fc, 1);          // down tube (overlaps)
  // seat post + saddle
  _line(buf, cx, topY, cx, topY - Math.round(8 * sc), 50, 50, 50, 1);
  _line(buf, cx - Math.round(5 * sc), topY - Math.round(8 * sc), cx + Math.round(5 * sc), topY - Math.round(8 * sc), 40, 40, 40, 1);
  // handlebar
  const hbY = Math.round(topY + (wy - topY) * 0.15);
  _line(buf, rx, wy, rx, hbY, 50, 50, 50, 1);
  _line(buf, rx - Math.round(5 * sc), hbY, rx + Math.round(5 * sc), hbY - Math.round(4 * sc), 40, 40, 40, 2);
}

function _drawMotorcycle(buf, cx, cy, sc, rng) {
  const wr  = Math.round(16 * sc); // heavier wheels than bicycle
  const sep = Math.round(40 * sc);
  const lx  = cx - sep / 2, rx = cx + sep / 2;
  const wy  = cy + Math.round(8 * sc);
  const bc  = [Math.round(100 + rng() * 100), 20 + Math.round(rng() * 40), 20]; // red/dark body
  const wc  = [20, 20, 20];
  const rim = [80, 80, 85];
  // wheels (wide/heavier)
  for (const wx of [lx, rx]) {
    _circle(buf, wx, wy, wr, ...wc);
    _circle(buf, wx, wy, wr - 4, ...rim);
    _circle(buf, wx, wy, 5, ...wc); // big hub
  }
  // engine block — heavy rectangle between wheels
  const ey = cy - Math.round(4 * sc);
  const ew = Math.round(32 * sc), eh = Math.round(20 * sc);
  _rect(buf, cx - ew / 2, ey - eh / 2, ew, eh, 55, 55, 60);
  _rect(buf, cx - ew / 2 + 2, ey - eh / 2 + 2, ew - 4, eh - 4, 70, 70, 75);
  // fuel tank + fairing on top
  _rect(buf, cx - ew / 2 + 3, ey - eh, ew - 6, Math.round(10 * sc), ...bc);
  _circle(buf, cx, ey - eh, Math.round(7 * sc), ...bc);
  // exhaust pipe
  _line(buf, rx, wy, rx + Math.round(8 * sc), wy + Math.round(6 * sc), 100, 90, 80, 2);
  // front fork
  _line(buf, rx, wy, rx - Math.round(4 * sc), ey - eh / 2, 75, 75, 80, 2);
  // handlebar wide
  const hbY = Math.round(ey - eh * 0.7);
  _line(buf, rx - Math.round(12 * sc), hbY, rx + Math.round(8 * sc), hbY - Math.round(5 * sc), 60, 60, 65, 2);
}

// ─── Image generation ─────────────────────────────────────────────────────────

const DRAWERS = {
  traffic_light: _drawTrafficLight,
  street_light:  _drawStreetLight,
  fire_hydrant:  _drawFireHydrant,
  bollard:       _drawBollard,
  bicycle:       _drawBicycle,
  motorcycle:    _drawMotorcycle,
};

function generateImage(category, seed) {
  const rng  = seededRng(seed);
  const buf  = Buffer.alloc(W * H * 3);
  const bg   = _makeBg(rng);
  _bg(buf, ...bg);

  // Road texture on road-gray backgrounds
  if (bg[0] > 120 && bg[0] < 200 && Math.abs(bg[0] - bg[1]) < 20) _roadTexture(buf, rng);

  const sc = 0.72 + rng() * 0.28; // 72–100% scale
  const cx = Math.round(W * 0.38 + rng() * W * 0.24); // 38–62% horizontal
  const cy = Math.round(H * 0.38 + rng() * H * 0.24); // 38–62% vertical

  DRAWERS[category](buf, cx, cy, sc, rng);

  // Partial occlusion (25% chance) — random edge bar
  if (rng() < 0.25) {
    const side = Math.floor(rng() * 4);
    const thick = Math.round(8 + rng() * 14);
    if (side === 0) _rect(buf, 0, 0, W, thick, 0, 0, 0);
    if (side === 1) _rect(buf, 0, H - thick, W, thick, 0, 0, 0);
    if (side === 2) _rect(buf, 0, 0, thick, H, 0, 0, 0);
    if (side === 3) _rect(buf, W - thick, 0, thick, H, 0, 0, 0);
  }

  // Per-pixel noise (makes it harder to programmatically classify from raw bytes)
  _noise(buf, rng, 0.12 + rng() * 0.10);

  return 'data:image/png;base64,' + _toPng(buf, W, H).toString('base64');
}

function seededRng(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (Math.imul(31, s) + seed.charCodeAt(i)) | 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

// ─── Challenge catalogue ──────────────────────────────────────────────────────

const CHALLENGES = [
  {
    type:        'traffic_lights',
    instruction: 'Select all squares containing a traffic light. Click all that apply.',
    target:      'traffic_light',
    // Street lights have a single glowing lamp on an arm — easily confused at small scale.
    // Bollards are tall vertical objects with glowing tops — another plausible confusion.
    decoys:      ['street_light', 'street_light', 'bollard', 'motorcycle', 'fire_hydrant'],
  },
  {
    type:        'fire_hydrants',
    instruction: 'Select all squares containing a fire hydrant. Click all that apply.',
    target:      'fire_hydrant',
    // Orange bollards have very similar proportions and colour to yellow hydrants.
    // Street lights are a visual distractor.
    decoys:      ['bollard', 'bollard', 'street_light', 'bicycle', 'traffic_light'],
  },
  {
    type:        'bicycles',
    instruction: 'Select all squares containing a bicycle. Click all that apply.',
    target:      'bicycle',
    // Motorcycles share the two-wheel silhouette — the main confusion.
    decoys:      ['motorcycle', 'motorcycle', 'bollard', 'street_light', 'fire_hydrant'],
  },
];

// ─── Grid builder ─────────────────────────────────────────────────────────────

function buildGrid(challenge, sessionId) {
  const targetCount = 3 + Math.floor(Math.random() * 2); // 3 or 4 correct images
  const decoyCount  = 9 - targetCount;

  const categories = [
    ...Array(targetCount).fill(challenge.target),
    ...challenge.decoys.slice(0, decoyCount),
  ];

  // Fisher-Yates shuffle
  for (let i = categories.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [categories[i], categories[j]] = [categories[j], categories[i]];
  }

  const grid = categories.map((cat, idx) => ({
    id:       `img-${idx}`,
    category: cat,
    data:     generateImage(cat, `${sessionId}-${idx}`),
  }));

  const correctIds = grid.filter(g => g.category === challenge.target).map(g => g.id);
  return { grid, correctIds };
}

// ─── Session factory ──────────────────────────────────────────────────────────

function makeSession() {
  const challenge = CHALLENGES[randInt(0, CHALLENGES.length)];
  const base      = newSessionBase();
  const { grid, correctIds } = buildGrid(challenge, base.id);

  const s = {
    ...base,
    challenge,
    grid,
    correctIds,
    challengeIssuedAt: null,
    currentStep:       1,
    cumulative:        { ...baseCumulative() },
  };
  sessions.set(s.id, s);
  return s;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/captcha/session', attachApiKey, (req, res) => {
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
  s.challengeIssuedAt = Date.now();

  // Strip category from grid before sending (agent must classify visually)
  const publicGrid = s.grid.map(({ id, data }) => ({ id, data }));

  res.json({
    sessionId:          s.id,
    token:              s.token,
    challenge: {
      instruction: s.challenge.instruction,
      gridSize:    3,
      images:      publicGrid,
    },
    requireFingerprint: true,
    risk:               publicRisk(risk, s.keyTier),
  });
});

// /api/captcha/fingerprint — handled by createScenario

app.post('/api/captcha/solve', async (req, res) => {
  const { sessionId, token, selectedIds = [], telemetry = {} } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) return res.status(403).json({ ok: false, reason: 'invalid_session' });
  if (s.used)                  return res.status(403).json({ ok: false, reason: 'session_used' });
  if (s.currentStep !== 1)     return res.status(403).json({ ok: false, reason: 'wrong_step' });
  if (s.requiresStepUp && !s.stepUpPassed) {
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(s.lastRisk || computeRisk(s.signals), s.keyTier) });
  }

  s.used = true;
  accumulateTelemetry(s, telemetry);
  visitorStore.recordTelemetrySnapshot(s.id, 1, telemetry);

  const now      = Date.now();
  const elapsed  = now - s.createdAt;
  const dwellMs  = s.challengeIssuedAt ? now - s.challengeIssuedAt : elapsed;
  const finalSigs = [];
  const selected  = Array.isArray(selectedIds) ? selectedIds : [];

  // ── Comprehension signals ──
  const allIds     = s.grid.map(g => g.id);
  const correctSet = new Set(s.correctIds);
  const selectedSet = new Set(selected.filter(id => allIds.includes(id)));

  if (selectedSet.size === 9) {
    finalSigs.push('captcha_selected_all');     // clicked everything (brute force)
  } else if (selectedSet.size === 0) {
    finalSigs.push('captcha_selected_none');    // gave up or misunderstood
  } else {
    // Check if selections are correct
    const correct = [...selectedSet].every(id => correctSet.has(id)) &&
                    [...correctSet].every(id => selectedSet.has(id));
    if (!correct) finalSigs.push('captcha_wrong_selection');
  }

  // ── Behavioral / timing signals ──
  if (dwellMs < 1_500) finalSigs.push('captcha_solved_too_fast');  // <1.5s to classify 9 images

  // Perfect answer with no hesitation: correct AND very fast AND no retries
  const isCorrect = [...selectedSet].every(id => correctSet.has(id)) &&
                    selectedSet.size === correctSet.size;
  if (isCorrect && dwellMs < 3_000) finalSigs.push('captcha_immediate_perfect');

  if (elapsed < 3_000)          finalSigs.push('too_fast');
  if (s.cumulative.mouseMoves < 3) finalSigs.push('low_mouse_activity');

  const dwellMedian = median(s.cumulative.clickDwellSamples);
  if (s.cumulative.clickCount >= 2 && dwellMedian < 20) finalSigs.push('synthetic_click_dwell');

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
    s.used = false; s.requiresStepUp = true;
    return res.status(403).json({ ok: false, action: 'step_up', risk: publicRisk(risk, s.keyTier) });
  }

  const outcome = isCorrect ? 'complete' : 'block';
  await recordTerminalVisit(s, outcome, allFinal);
  sessions.delete(sessionId);

  if (outcome === 'complete') {
    return res.json({
      ok: true, action: 'allow',
      verificationId: crypto.randomBytes(8).toString('hex'),
      risk: publicRisk(risk, s.keyTier),
      handle: s.handle, visitorId: s.visitorId,
    });
  }
  return res.status(403).json({
    ok: false, action: 'block',
    reason:   finalSigs.includes('captcha_selected_all') ? 'brute_force_detected' : 'wrong_selection',
    risk:     publicRisk(risk, s.keyTier),
    handle:   s.handle, visitorId: s.visitorId,
  });
});

// /api/captcha/fingerprint, stepup-challenge, stepup-verify, visitor, leaderboard
// — all registered by createScenario

start(path.join(__dirname, '.certs'));
