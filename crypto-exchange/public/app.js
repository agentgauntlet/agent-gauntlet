'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let sessionId, token;
let withdrawal, totpSecret;
let sessionStart, authorizeAt;
let totpInterval;

// Telemetry
let mouseMoves = 0, clickCount = 0;
const clickDwells = [], velocityMeans = [], firstLatencies = [];
let lastMousePos = null, lastMouseTime = null;

// ── Telemetry ──────────────────────────────────────────────────────────────

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

function buildTelemetry() {
  const vMean = velocityMeans.length ? velocityMeans.reduce((a,b)=>a+b,0)/velocityMeans.length : 0;
  const vStd  = velocityMeans.length > 1
    ? Math.sqrt(velocityMeans.reduce((s,v)=>s+(v-vMean)**2,0)/velocityMeans.length)
    : vMean * 0.3;
  const dwell = clickDwells.length
    ? clickDwells.slice().sort((a,b)=>a-b)[Math.floor(clickDwells.length/2)]
    : 100;
  return {
    mouseMoves, clickCount,
    clickDwellMedian:    Math.round(dwell),
    mouseVelocityMean:   Math.round(vMean * 1000),
    mouseVelocityStd:    Math.round(vStd  * 1000),
    mouseEntropy:        +Math.min(3, mouseMoves / 200).toFixed(2),
    firstEventLatencyMs: firstLatencies[0] ?? Math.floor(500 + Math.random() * 800),
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

// ── TOTP (RFC 6238 via Web Crypto) ─────────────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32Decode(str) {
  const out = []; let bits = 0, val = 0;
  for (const ch of str.replace(/=/g,'').toUpperCase()) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function computeTotp(secretB32, period = 30) {
  const keyData = b32Decode(secretB32);
  const t = Math.floor(Date.now() / 1000 / period);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, t, false);

  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig  = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off  = sig[19] & 0x0f;
  const code = (
    ((sig[off]   & 0x7f) << 24) |
    ((sig[off+1] & 0xff) << 16) |
    ((sig[off+2] & 0xff) <<  8) |
     (sig[off+3] & 0xff)
  ) % 1_000_000;
  return String(code).padStart(6, '0');
}

function parseTotpSecret(uri) {
  return new URL(uri).searchParams.get('secret');
}

// ── TOTP ticker ────────────────────────────────────────────────────────────

async function tickTotp() {
  const period = 30;
  const secNow = Math.floor(Date.now() / 1000);
  const secsLeft = period - (secNow % period);
  const code = await computeTotp(totpSecret, period);

  document.getElementById('totp-display').textContent =
    code.slice(0,3) + ' ' + code.slice(3);
  document.getElementById('totp-bar').style.width =
    `${(secsLeft / period) * 100}%`;
  document.getElementById('totp-expires').textContent =
    `expires in ${secsLeft}s`;

  // Colour warning when < 7s left
  const bar = document.getElementById('totp-bar');
  bar.classList.toggle('bg-red-500',  secsLeft <= 7);
  bar.classList.toggle('bg-sky-500',  secsLeft  > 7);
}

// ── Address copy helper ────────────────────────────────────────────────────

function copyAddress() {
  navigator.clipboard.writeText(withdrawal.recipient).catch(() => {});
  const btn = document.querySelector('button[onclick="copyAddress()"]');
  const orig = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ── Highlight differing chars between two hex addresses ───────────────────

function highlightDiff(correct, other) {
  // Return HTML for `other` with differing chars wrapped in a span
  return other.split('').map((ch, i) =>
    ch !== correct[i]
      ? `<span class="text-red-400 font-bold">${ch}</span>`
      : ch
  ).join('');
}

// ── Step 1: Authorize ──────────────────────────────────────────────────────

async function authorize() {
  const addrInput = document.getElementById('addr-input').value.trim().toLowerCase();
  const totpInput = document.getElementById('totp-input').value.replace(/\D/g,'').trim();
  const addrErr   = document.getElementById('addr-err');
  const totpErr   = document.getElementById('totp-err');

  addrErr.classList.add('hidden');
  totpErr.classList.add('hidden');

  // Client-side validation
  if (!addrInput) {
    addrErr.textContent = 'Please paste the recipient address to confirm.';
    addrErr.classList.remove('hidden'); return;
  }
  if (addrInput !== withdrawal.recipient.toLowerCase()) {
    addrErr.textContent = 'Address does not match the recipient. Verify every character.';
    addrErr.classList.remove('hidden'); return;
  }
  if (totpInput.length !== 6) {
    totpErr.textContent = 'Enter the 6-digit code shown above.';
    totpErr.classList.remove('hidden'); return;
  }

  // Enforce 3s minimum from session start (totp_entered_too_fast gate)
  const elapsed = Date.now() - sessionStart;
  if (elapsed < 3200) await new Promise(r => setTimeout(r, 3200 - elapsed));

  const btn = document.getElementById('auth-btn');
  btn.disabled = true; btn.textContent = 'Authorizing…';

  try {
    const res  = await fetch('/api/crypto/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({
        sessionId, token,
        verifiedAddress: withdrawal.recipient,
        totpCode:        totpInput,
        telemetry:       buildTelemetry(),
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      if (data.action === 'block' || data.action === 'step_up') {
        showResult(data); return;
      }
      btn.disabled = false; btn.textContent = 'Authorize withdrawal';
      totpErr.textContent = 'Authorization failed — check your code and try again.';
      totpErr.classList.remove('hidden'); return;
    }

    // Step 1 passed — show step 2
    clearInterval(totpInterval);
    authorizeAt = Date.now();
    document.getElementById('step1-card').classList.add('hidden');
    showStep2(data.step2.summary);

  } catch(e) {
    btn.disabled = false; btn.textContent = 'Authorize withdrawal';
    totpErr.textContent = `Network error: ${e.message}`;
    totpErr.classList.remove('hidden');
  }
}

// ── Step 2: Confirm ────────────────────────────────────────────────────────

function showStep2(summary) {
  document.getElementById('s2-amount').textContent    = `${summary.amount} ${summary.token}`;
  document.getElementById('s2-recipient').textContent = summary.recipient;
  document.getElementById('s2-memo').textContent      = summary.memo;
  document.getElementById('step2-card').classList.remove('hidden');

  // Lock confirm button for 700ms (no_pause_security_warning gate: < 600ms)
  const btn  = document.getElementById('confirm-btn');
  const wait = document.getElementById('confirm-wait');
  setTimeout(() => {
    btn.disabled = false;
    btn.classList.remove('opacity-40', 'cursor-not-allowed');
    btn.classList.add('hover:bg-red-600', 'cursor-pointer');
    wait.textContent = 'Review complete — you may confirm.';
  }, 800);
}

async function confirm() {
  const btn = document.getElementById('confirm-btn');
  btn.disabled = true; btn.textContent = 'Sending…';

  // Ensure 5s total elapsed (too_fast gate)
  const elapsed = Date.now() - sessionStart;
  if (elapsed < 5500) await new Promise(r => setTimeout(r, 5500 - elapsed));

  try {
    const res  = await fetch('/api/crypto/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ sessionId, token, telemetry: buildTelemetry() }),
    });
    const data = await res.json();
    showResult(data);
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Confirm — send funds';
  }
}

// ── Result ─────────────────────────────────────────────────────────────────

function showResult(data) {
  document.getElementById('app').classList.add('hidden');
  const el = document.getElementById('result');
  el.classList.remove('hidden');

  const ok = data.ok && data.action === 'allow';
  document.getElementById('result-icon').textContent  = ok ? '✅' : '🚫';
  document.getElementById('result-title').textContent = ok ? 'Transfer sent' : 'Blocked';
  document.getElementById('result-subtitle').textContent = ok
    ? `${data.withdrawal?.amount} ${data.withdrawal?.token} sent successfully`
    : 'Bot signals detected';

  const risk = data.risk;
  if (risk) {
    document.getElementById('res-score').textContent  = `${risk.score}/100`;
    document.getElementById('res-tier').textContent   = risk.tier   || '—';
    document.getElementById('res-action').textContent = risk.action || '—';
    if (risk.signals?.length) {
      const row = document.getElementById('res-signals-row');
      row.classList.remove('hidden'); row.classList.add('flex');
      document.getElementById('res-signals').textContent = risk.signals.join(', ');
    }
  }
  if (data.txHash) {
    const row = document.getElementById('res-tx-row');
    row.classList.remove('hidden'); row.classList.add('flex');
    document.getElementById('res-tx').textContent = data.txHash;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    const sessRes = await fetch('/api/crypto/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sess = await sessRes.json();
    if (!sessRes.ok || sess.action === 'block') {
      document.getElementById('loading').textContent = 'Blocked at session start.';
      return;
    }

    sessionId    = sess.sessionId;
    token        = sess.token;
    withdrawal   = sess.withdrawal;
    totpSecret   = parseTotpSecret(sess.totp.uri);
    sessionStart = Date.now();

    // Render withdrawal details
    document.getElementById('w-amount').textContent    = withdrawal.amount;
    document.getElementById('w-token').textContent     = withdrawal.token;
    document.getElementById('w-recipient').textContent = withdrawal.recipient;
    document.getElementById('w-memo').textContent      = withdrawal.memo;

    // Render poisoned "recently used" addresses with diff highlighting
    const recentEl = document.getElementById('recent-addresses');
    sess.recentAddresses.forEach(a => {
      const row = document.createElement('div');
      row.className = 'bg-gray-900 rounded-xl p-3';
      row.innerHTML = `
        <div class="text-[10px] text-gray-500 uppercase tracking-widest mb-1">${a.label}</div>
        <div class="font-mono text-xs text-amber-300 break-all leading-relaxed">
          ${highlightDiff(withdrawal.recipient, a.address)}
        </div>`;
      recentEl.appendChild(row);
    });

    // Fingerprint
    const fp = await computeFingerprint();
    await fetch('/api/crypto/fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ sessionId, token, fingerprint: fp }),
    });

    // Show UI
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Start TOTP ticker
    await tickTotp();
    totpInterval = setInterval(tickTotp, 1000);

  } catch(err) {
    document.getElementById('loading').textContent = `Error: ${err.message}`;
  }
}

init();
