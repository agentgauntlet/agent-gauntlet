'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let sessionId, token;
let withdrawal, totpSecret;
let sessionStart, authorizeAt;
let totpInterval;

// Telemetry + fingerprint live in window.AGDetect (loaded by index.html
// from /shared/detect-core.js). buildTelemetry() preserves existing call
// sites while delegating to the shared collector.
const tel = window.AGDetect.startTelemetry();
function buildTelemetry(extra = {}) {
  return { ...tel.snapshot(), ...extra };
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
    if (sessRes.status === 429) {
      document.getElementById('loading').textContent = 'Demo limit reached — get a free API key for more runs.';
      return;
    }
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
    const fp = await window.AGDetect.collectFingerprint();
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
