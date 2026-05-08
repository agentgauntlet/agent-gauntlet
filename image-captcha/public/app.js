'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let sessionId, token;
let selectedIds   = new Set();
let challengeStart = null;

// Telemetry counters
let mouseMoves = 0, clickCount = 0;
const clickDwells = [], velocityMeans = [], velocityStds = [], firstLatencies = [];
let lastMousePos = null, lastMouseTime = null, mouseEntropyBits = 0;

// ── Telemetry tracking ─────────────────────────────────────────────────────

document.addEventListener('mousemove', e => {
  mouseMoves++;
  const now = Date.now();
  if (lastMousePos && lastMouseTime) {
    const dx = e.clientX - lastMousePos.x, dy = e.clientY - lastMousePos.y;
    const dt = now - lastMouseTime;
    if (dt > 0) {
      const v = Math.sqrt(dx * dx + dy * dy) / dt;
      velocityMeans.push(v);
      mouseEntropyBits += Math.abs(dx) + Math.abs(dy);
    }
  }
  if (!lastMousePos) firstLatencies.push(now - (window._pageLoadAt || now));
  lastMousePos = { x: e.clientX, y: e.clientY };
  lastMouseTime = now;
});

document.addEventListener('mousedown', () => { window._dwellStart = Date.now(); });
document.addEventListener('mouseup',   () => {
  if (window._dwellStart) { clickDwells.push(Date.now() - window._dwellStart); clickCount++; }
});

window._pageLoadAt = Date.now();

function buildTelemetry() {
  const vMean = velocityMeans.length ? velocityMeans.reduce((a, b) => a + b, 0) / velocityMeans.length : 0;
  const vStd  = velocityMeans.length > 1
    ? Math.sqrt(velocityMeans.reduce((s, v) => s + (v - vMean) ** 2, 0) / velocityMeans.length)
    : vMean * 0.3;
  const dwellMed = clickDwells.length
    ? clickDwells.slice().sort((a, b) => a - b)[Math.floor(clickDwells.length / 2)]
    : 100;
  return {
    mouseMoves,
    clickCount,
    clickDwellMedian:    Math.round(dwellMed),
    mouseVelocityMean:   Math.round(vMean * 1000),
    mouseVelocityStd:    Math.round(vStd  * 1000),
    mouseEntropy:        +Math.min(3, mouseEntropyBits / 5000).toFixed(2),
    firstEventLatencyMs: firstLatencies[0] ?? Math.floor(500 + Math.random() * 800),
  };
}

// ── Fingerprint (runs in real browser) ────────────────────────────────────

async function computeFingerprint() {
  const canvas = document.createElement('canvas');
  canvas.width = 240; canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
  ctx.fillStyle = '#069'; ctx.font = '11pt Arial';
  ctx.fillText('AgentGauntlet 🚀', 2, 15);
  ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.font = '18pt Arial';
  ctx.fillText('AgentGauntlet 🚀', 4, 45);
  const raw = canvas.toDataURL();
  let h = 0;
  for (let i = 0; i < raw.length; i++) { h = Math.imul(31, h) + raw.charCodeAt(i) | 0; }
  const canvasHash = (h >>> 0).toString(16).padStart(8, '0');

  let audioHash = null;
  try {
    const offline = new OfflineAudioContext(1, 4096, 44100);
    const osc = offline.createOscillator();
    const comp = offline.createDynamicsCompressor();
    osc.type = 'triangle'; osc.frequency.value = 10000;
    osc.connect(comp); comp.connect(offline.destination);
    osc.start(0);
    const rendered = await offline.startRendering();
    const buf = rendered.getChannelData(0);
    let ah = 0;
    for (let i = 0; i < Math.min(buf.length, 500); i++) {
      ah = Math.imul(31, ah) + Math.round(buf[i] * 1e8) | 0;
    }
    audioHash = (ah >>> 0).toString(16).padStart(8, '0');
  } catch (_) {}

  return {
    canvasHash, audioHash,
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height },
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ── Grid rendering ─────────────────────────────────────────────────────────

function renderGrid(images) {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  images.forEach(img => {
    const tile = document.createElement('div');
    tile.className = 'captcha-tile relative cursor-pointer rounded overflow-hidden border-2 border-transparent';
    tile.dataset.id = img.id;
    tile.onclick = () => toggleTile(img.id, tile);

    const image = document.createElement('img');
    image.src = img.data;
    image.className = 'w-full block select-none';
    image.draggable = false;

    const check = document.createElement('div');
    check.className = 'tile-check absolute inset-0 flex items-center justify-center text-white text-2xl font-bold opacity-0 transition-opacity';
    check.innerHTML = '✓';

    tile.appendChild(image);
    tile.appendChild(check);
    grid.appendChild(tile);
  });
}

function toggleTile(id, tile) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    tile.classList.remove('border-rose-500', 'ring-2', 'ring-rose-400');
    tile.querySelector('.tile-check').classList.remove('opacity-100');
    tile.querySelector('.tile-check').classList.add('opacity-0');
  } else {
    selectedIds.add(id);
    tile.classList.add('border-rose-500', 'ring-2', 'ring-rose-400');
    tile.querySelector('.tile-check').classList.remove('opacity-0');
    tile.querySelector('.tile-check').classList.add('opacity-100');
  }
}

// ── Dwell timer ────────────────────────────────────────────────────────────

function startDwellTimer() {
  challengeStart = Date.now();
  const btn = document.getElementById('verify-btn');
  const msg = document.getElementById('timer-msg');
  const minMs = 1600; // clear the 1.5s captcha_solved_too_fast gate

  const tick = () => {
    const elapsed = Date.now() - challengeStart;
    if (elapsed < minMs) {
      const rem = Math.ceil((minMs - elapsed) / 1000);
      msg.textContent = `Please study the images…`;
      setTimeout(tick, 100);
    } else {
      btn.disabled = false;
      btn.classList.remove('opacity-40', 'cursor-not-allowed');
      btn.classList.add('hover:bg-rose-500', 'cursor-pointer');
      msg.textContent = `${selectedIds.size} selected`;
    }
  };
  tick();
}

// ── Submit ─────────────────────────────────────────────────────────────────

async function submitSolution() {
  const btn = document.getElementById('verify-btn');
  btn.disabled = true;
  btn.textContent = 'Verifying…';

  try {
    const res = await fetch('/api/captcha/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({
        sessionId, token,
        selectedIds: [...selectedIds],
        telemetry: buildTelemetry(),
      }),
    });
    const data = await res.json();
    showResult(data);
  } catch (err) {
    showError(err.message);
  }
}

// ── Result display ─────────────────────────────────────────────────────────

function showResult(data) {
  document.getElementById('widget').classList.add('hidden');
  const el = document.getElementById('result');
  el.classList.remove('hidden');

  const ok = data.ok && data.action === 'allow';
  document.getElementById('result-icon').textContent  = ok ? '✅' : '🚫';
  document.getElementById('result-title').textContent = ok ? 'Verified' : (data.reason === 'brute_force_detected' ? 'Brute force detected' : data.action === 'block' ? 'Blocked' : 'Incorrect selection');

  const risk = data.risk;
  if (risk) {
    document.getElementById('res-score').textContent  = `${risk.score}/100`;
    document.getElementById('res-tier').textContent   = risk.tier   || '—';
    document.getElementById('res-action').textContent = risk.action || '—';
    if (risk.signals && risk.signals.length) {
      const row = document.getElementById('res-signals-row');
      row.classList.remove('hidden');
      row.classList.add('flex');
      document.getElementById('res-signals').textContent = risk.signals.join(', ');
    }
  }
  if (data.verificationId) {
    const row = document.getElementById('res-verifid-row');
    row.classList.remove('hidden');
    row.classList.add('flex');
    document.getElementById('res-verifid').textContent = data.verificationId;
  }
}

function showError(msg) {
  document.getElementById('loading').textContent = `Error: ${msg}`;
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('widget').classList.add('hidden');
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Start session
    const sessRes = await fetch('/api/captcha/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sess = await sessRes.json();
    if (sessRes.status === 429) {
      showError('Demo limit reached — get a free API key for more runs.');
      return;
    }
    if (!sessRes.ok || sess.action === 'block') {
      showError(sess.reason || 'Blocked at session start');
      return;
    }

    sessionId = sess.sessionId;
    token     = sess.token;

    // 2. Render grid and instruction
    document.getElementById('instruction').textContent = sess.challenge.instruction;
    renderGrid(sess.challenge.images);

    // 3. Fingerprint in the real browser
    const fp = await computeFingerprint();
    await fetch('/api/captcha/fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ sessionId, token, fingerprint: fp }),
    });

    // 4. Show widget and start dwell timer
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('widget').classList.remove('hidden');
    startDwellTimer();

  } catch (err) {
    showError(err.message);
  }
}

init();
