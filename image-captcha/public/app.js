'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let sessionId, token;
let selectedIds   = new Set();
let challengeStart = null;

// Telemetry + fingerprint live in window.AGDetect (loaded by index.html
// from /shared/detect-core.js). The buildTelemetry() wrapper preserves
// existing call sites while delegating to the shared collector.
const tel = window.AGDetect.startTelemetry();
function buildTelemetry(extra = {}) {
  return { ...tel.snapshot(), ...extra };
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
    const fp = await window.AGDetect.collectFingerprint();
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
