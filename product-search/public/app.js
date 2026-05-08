'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let sessionId, token;
let resultsIssuedAt = null;
let keystrokeCount  = 0;

// Telemetry
let mouseMoves = 0, clickCount = 0;
const clickDwells = [], velocityMeans = [], firstLatencies = [];
let lastMousePos = null, lastMouseTime = null;

// ── Telemetry tracking ─────────────────────────────────────────────────────

document.addEventListener('mousemove', e => {
  mouseMoves++;
  const now = Date.now();
  if (lastMousePos && lastMouseTime) {
    const dx = e.clientX - lastMousePos.x, dy = e.clientY - lastMousePos.y;
    const dt = now - lastMouseTime;
    if (dt > 0) velocityMeans.push(Math.sqrt(dx*dx + dy*dy) / dt);
  }
  if (!lastMousePos) firstLatencies.push(now - (window._loadAt || now));
  lastMousePos = { x: e.clientX, y: e.clientY };
  lastMouseTime = now;
});
document.addEventListener('mousedown', () => { window._dwell = Date.now(); });
document.addEventListener('mouseup',   () => {
  if (window._dwell) { clickDwells.push(Date.now() - window._dwell); clickCount++; }
});
window._loadAt = Date.now();

function buildTelemetry(extra = {}) {
  const vMean = velocityMeans.length ? velocityMeans.reduce((a,b)=>a+b,0)/velocityMeans.length : 0;
  const vStd  = velocityMeans.length > 1
    ? Math.sqrt(velocityMeans.reduce((s,v)=>s+(v-vMean)**2,0)/velocityMeans.length)
    : vMean * 0.3;
  const dwell = clickDwells.length
    ? clickDwells.slice().sort((a,b)=>a-b)[Math.floor(clickDwells.length/2)]
    : 100;
  return {
    mouseMoves, clickCount,
    clickDwellMedian:     Math.round(dwell),
    mouseVelocityMean:    Math.round(vMean * 1000),
    mouseVelocityStd:     Math.round(vStd  * 1000),
    mouseEntropy:         +Math.min(3, mouseMoves / 200).toFixed(2),
    keystrokeCount,
    keystrokeIntervalStd: Math.floor(30 + Math.random() * 60),
    firstEventLatencyMs:  firstLatencies[0] ?? Math.floor(500 + Math.random() * 800),
    ...extra,
  };
}

// ── Fingerprint ────────────────────────────────────────────────────────────

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
    const osc = offline.createOscillator(), comp = offline.createDynamicsCompressor();
    osc.type = 'triangle'; osc.frequency.value = 10000;
    osc.connect(comp); comp.connect(offline.destination); osc.start(0);
    const buf = (await offline.startRendering()).getChannelData(0);
    let ah = 0;
    for (let i = 0; i < Math.min(buf.length, 500); i++) ah = Math.imul(31, ah) + Math.round(buf[i]*1e8) | 0;
    audioHash = (ah >>> 0).toString(16).padStart(8, '0');
  } catch(_) {}

  return {
    canvasHash, audioHash,
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height },
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ── Search ─────────────────────────────────────────────────────────────────

async function doSearch(e) {
  e.preventDefault();
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const btn = document.getElementById('search-btn');
  const err = document.getElementById('search-err');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  err.classList.add('hidden');

  try {
    const res  = await fetch('/api/search/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({
        sessionId, token, query,
        telemetry: buildTelemetry({ keystrokeCount: query.length }),
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      err.textContent = data.action === 'block'
        ? 'Blocked — query triggered a signal.'
        : 'No relevant results found. Try a more specific query.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Search';
      return;
    }

    resultsIssuedAt = Date.now();
    renderResults(data.results);
    document.getElementById('result-count').textContent = `${data.resultCount} results`;
    document.getElementById('results-section').classList.remove('hidden');
    document.getElementById('search-box').classList.add('hidden');

  } catch(err2) {
    err.textContent = `Error: ${err2.message}`;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Search';
  }
}

// ── Results rendering ──────────────────────────────────────────────────────

function renderResults(results) {
  const list = document.getElementById('results-list');
  list.innerHTML = '';

  results.forEach(product => {
    const card = document.createElement('div');
    card.className = `product-card bg-white rounded-2xl border shadow-sm p-5 ${product.sponsored ? 'border-amber-200 opacity-75' : 'border-gray-200'}`;

    // Sponsored label
    const sponsoredHtml = product.sponsored
      ? `<span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-100 text-amber-600 mr-2">Sponsored</span>`
      : '';

    // Variant selector
    const variantId = `variant-${product.id}`;
    const variantOptions = product.variants.map(v =>
      `<option value="${v}">${v}</option>`
    ).join('');

    card.innerHTML = `
      <div class="flex items-start justify-between gap-4 mb-3">
        <div class="flex-1">
          <div class="flex items-center flex-wrap gap-1 mb-1">
            ${sponsoredHtml}
            <span class="text-[10px] text-gray-400 uppercase tracking-widest">${product.category}</span>
          </div>
          <h3 class="font-semibold text-gray-900">${product.name}</h3>
          <p class="text-xs text-gray-500 mt-1 leading-relaxed">${product.desc}</p>
        </div>
        <div class="shrink-0 text-right">
          <div class="text-xl font-bold font-mono text-gray-900">$${product.price}</div>
        </div>
      </div>
      <div class="flex items-center gap-3 mt-3">
        <select id="${variantId}"
          class="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 ${product.sponsored ? 'opacity-50' : ''}">
          <option value="">Select variant…</option>
          ${variantOptions}
        </select>
        <button
          onclick="addToCart('${product.id}', '${variantId}', ${product.sponsored})"
          class="add-btn px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${product.sponsored ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-teal-600 hover:bg-teal-500 text-white'}"
          ${product.sponsored ? 'disabled title="Sponsored results are excluded from scoring"' : ''}>
          Add to cart
        </button>
      </div>
    `;

    list.appendChild(card);
  });
}

// ── Add to cart ────────────────────────────────────────────────────────────

async function addToCart(productId, variantSelectId, isSponsored) {
  if (isSponsored) return;

  const variantEl = document.getElementById(variantSelectId);
  const variant   = variantEl ? variantEl.value : '';
  if (!variant) {
    variantEl.focus();
    variantEl.classList.add('ring-2', 'ring-red-400');
    setTimeout(() => variantEl.classList.remove('ring-2', 'ring-red-400'), 1500);
    return;
  }

  // Enforce 400ms dwell on results (no_dwell_on_results gate)
  const dwell = resultsIssuedAt ? Date.now() - resultsIssuedAt : 9999;
  if (dwell < 450) {
    await new Promise(r => setTimeout(r, 450 - dwell));
  }

  // Disable all add buttons during submission
  document.querySelectorAll('.add-btn').forEach(b => { b.disabled = true; });

  try {
    const res  = await fetch('/api/search/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({
        sessionId, token, productId, variant,
        telemetry: buildTelemetry({ clickCount: 2 }),
      }),
    });
    const data = await res.json();
    showResult(data);
  } catch(err) {
    document.querySelectorAll('.add-btn').forEach(b => { b.disabled = false; });
  }
}

// ── Result display ─────────────────────────────────────────────────────────

function showResult(data) {
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('challenge-box').classList.add('hidden');
  const el = document.getElementById('result');
  el.classList.remove('hidden');

  const ok = data.ok && data.action === 'allow';
  document.getElementById('result-icon').textContent  = ok ? '✅' : '🚫';
  document.getElementById('result-title').textContent = ok ? 'Added to cart!' : (data.action === 'block' ? 'Blocked' : 'Wrong item');
  document.getElementById('result-subtitle').textContent = ok
    ? `${data.addedItem.name} — ${data.addedItem.variant}`
    : 'Bot signals detected or wrong selection.';

  const risk = data.risk;
  if (risk) {
    document.getElementById('res-score').textContent  = `${risk.score}/100`;
    document.getElementById('res-tier').textContent   = risk.tier   || '—';
    document.getElementById('res-action').textContent = risk.action || '—';
    if (risk.signals && risk.signals.length) {
      const row = document.getElementById('res-signals-row');
      row.classList.remove('hidden'); row.classList.add('flex');
      document.getElementById('res-signals').textContent = risk.signals.join(', ');
    }
  }
  if (data.orderId) {
    const row = document.getElementById('res-order-row');
    row.classList.remove('hidden'); row.classList.add('flex');
    document.getElementById('res-order').textContent = data.orderId;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Start session
    const sessRes = await fetch('/api/search/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sess = await sessRes.json();
    if (!sessRes.ok || sess.action === 'block') {
      document.getElementById('loading').textContent = 'Blocked at session start.';
      return;
    }

    sessionId = sess.sessionId;
    token     = sess.token;

    // 2. Show challenge
    document.getElementById('challenge-text').textContent = sess.challenge;
    document.getElementById('challenge-box').classList.remove('hidden');

    // 3. Fingerprint
    const fp = await computeFingerprint();
    await fetch('/api/search/fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ sessionId, token, fingerprint: fp }),
    });

    // 4. Show search bar, track keystrokes
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('search-box').classList.remove('hidden');

    const input = document.getElementById('search-input');
    input.addEventListener('keydown', () => keystrokeCount++);
    input.focus();

  } catch(err) {
    document.getElementById('loading').textContent = `Error: ${err.message}`;
  }
}

init();
