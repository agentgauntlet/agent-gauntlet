'use strict';

// ---------- Telemetry ----------
//
// window.AGDetect (loaded by index.html from /shared/detect-core.js) owns
// fingerprint + generic behavioral telemetry. Login-specific signals are
// tracked locally and merged into snapshotTelemetry():
//   passwordKeystrokes      count of keydowns on the password field
//   passwordPastedNotTyped  paste event fired on password field
//   usernamePastedNotTyped  paste event fired on username field
//   usedSsoDecoy            user clicked one of the SSO decoy buttons
//   trapCheckboxChecked     user ticked the "I am a human" trap checkbox

const tel = window.AGDetect.startTelemetry();
let passwordKeystrokes       = 0;
let passwordPastedNotTyped   = false;
let usernamePastedNotTyped   = false;
let usedSsoDecoy             = false;
let trapCheckboxChecked      = false;
const passwordKeystrokeTimes = [];

function snapshotTelemetry() {
  const snap = tel.snapshot();

  // Compute std-dev of password-only keystroke intervals — the
  // uniform_keystroke_timing signal is scored against this scoped value,
  // not the document-level keystrokeIntervalStd produced by AGDetect.
  let passwordKsStd = 0;
  if (passwordKeystrokeTimes.length > 1) {
    const intervals = [];
    for (let i = 1; i < passwordKeystrokeTimes.length; i++) {
      intervals.push(passwordKeystrokeTimes[i] - passwordKeystrokeTimes[i - 1]);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    passwordKsStd = Math.sqrt(
      intervals.reduce((s, x) => s + (x - mean) ** 2, 0) / intervals.length,
    );
  }

  return {
    ...snap,
    passwordKeystrokes,
    passwordPastedNotTyped,
    usernamePastedNotTyped,
    usedSsoDecoy,
    trapCheckboxChecked,
    // Scope the keystroke-interval std to password input only.
    keystrokeIntervalStd: passwordKsStd || snap.keystrokeIntervalStd,
  };
}

// ---------- Risk badge ----------

function updateBadge(risk, handle) {
  const badge = document.getElementById('risk-badge');
  if (!badge) return;
  badge.classList.remove('hidden');
  document.getElementById('risk-handle').textContent  = handle || '…';
  document.getElementById('risk-score').textContent   = risk.score;
  const bar = document.getElementById('risk-bar');
  bar.style.width = `${risk.score}%`;
  bar.style.background = risk.tier === 'allow' ? '#10b981' : risk.tier === 'step_up' ? '#f59e0b' : '#ef4444';
  const tierEl = document.getElementById('risk-tier');
  tierEl.textContent = risk.tier || '…';
  tierEl.className = `text-[10px] font-bold px-2 py-0.5 rounded-full ${
    risk.tier === 'allow'   ? 'bg-green-100 text-green-700' :
    risk.tier === 'step_up' ? 'bg-amber-100 text-amber-700' :
                              'bg-red-100 text-red-700'
  }`;
  const bd = document.getElementById('risk-breakdown');
  if (risk.breakdown && Object.keys(risk.breakdown).length > 0) {
    bd.innerHTML = Object.entries(risk.breakdown)
      .map(([k,v]) => `<span class="inline-block mr-1 mb-0.5 px-1.5 py-0.5 bg-gray-100 rounded text-[10px]">${k}: +${v}</span>`)
      .join('');
  } else {
    bd.textContent = 'No signals detected.';
  }
}

// ---------- Step indicator ----------

function setPip(active) {
  document.querySelectorAll('[data-pip]').forEach(el => {
    const n = Number(el.dataset.pip);
    const span = el.querySelector('span');
    if (n === active) {
      el.classList.remove('text-gray-400');
      span.className = 'w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xs';
    } else if (n < active) {
      span.className = 'w-6 h-6 rounded-full bg-emerald-200 text-emerald-700 flex items-center justify-center text-xs';
    } else {
      el.classList.add('text-gray-400');
      span.className = 'w-6 h-6 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-xs';
    }
  });
}

function showStep(n) {
  document.querySelectorAll('[data-step]').forEach(el => {
    el.hidden = Number(el.dataset.step) !== n;
  });
  setPip(n);
  // Per-step firstEventLatencyMs and interval reset are handled internally
  // by tel.snapshot() — no manual reset needed here.
}

// ---------- Canvas: credentials ----------

function drawCredentials(canvas, username, password) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f9fafb';
  ctx.fillRect(0, 0, W, H);

  function jitterChar(ctx, char, x, y, baseSize) {
    ctx.save();
    ctx.translate(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 2);
    ctx.rotate((Math.random() - 0.5) * 0.08);
    ctx.font = `${baseSize + (Math.random() - 0.5) * 2}px monospace`;
    ctx.fillText(char, 0, 0);
    ctx.restore();
  }

  // Username row
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px sans-serif';
  ctx.fillText('Username:', 12, 28);
  ctx.fillStyle = '#111827';
  let x = 95;
  for (const c of username) {
    jitterChar(ctx, c, x, 28, 14);
    x += 9;
  }

  // Separator
  ctx.strokeStyle = '#e5e7eb';
  ctx.beginPath();
  ctx.moveTo(12, 42); ctx.lineTo(W - 12, 42);
  ctx.stroke();

  // Password row
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px sans-serif';
  ctx.fillText('Password:', 12, 70);
  ctx.fillStyle = '#111827';
  x = 95;
  for (const c of password) {
    jitterChar(ctx, c, x, 70, 14);
    x += 9;
  }

  // Subtle noise overlay
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
}

// ---------- Canvas: OTP ----------

function drawOtp(canvas, code) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Background
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#ecfdf5');
  grad.addColorStop(1, '#f0fdf4');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Noise
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }

  // Strikethrough-style lines
  ctx.strokeStyle = 'rgba(16,185,129,0.15)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 15 + Math.random() * (H - 30));
    ctx.lineTo(W, 15 + Math.random() * (H - 30));
    ctx.stroke();
  }

  // Characters
  const chars = code.split('');
  const spacing = W / (chars.length + 1);
  chars.forEach((c, i) => {
    const x = spacing * (i + 1);
    const y = H / 2 + 10;
    ctx.save();
    ctx.translate(x + (Math.random() - 0.5) * 4, y + (Math.random() - 0.5) * 4);
    ctx.rotate((Math.random() - 0.5) * 0.12);
    ctx.font = `bold ${32 + (Math.random() - 0.5) * 4}px monospace`;
    ctx.fillStyle = '#065f46';
    ctx.textAlign = 'center';
    ctx.fillText(c, 0, 0);
    ctx.restore();
  });
}

// ---------- Step-up overlay ----------

async function doStepUp(sessionId, token) {
  const overlay = document.getElementById('stepup-overlay');
  overlay.classList.remove('hidden');

  const res = await fetch('/api/login/stepup-challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, token }),
  });
  const data = await res.json();
  if (!res.ok) { overlay.classList.add('hidden'); return false; }

  // Draw math captcha
  const canvas = document.getElementById('stepup-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f9fafb';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random()*0.04})`;
    ctx.fillRect(Math.random()*W, Math.random()*H, 1, 1);
  }
  const expr = `${data.a} ${data.op} ${data.b} = ?`;
  for (let ci = 0; ci < expr.length; ci++) {
    const x = 20 + ci * 18 + (Math.random()-0.5)*3;
    const y = H/2 + 8 + (Math.random()-0.5)*4;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((Math.random()-0.5)*0.12);
    ctx.font = `bold ${22+(Math.random()-0.5)*3}px monospace`;
    ctx.fillStyle = '#1f2937';
    ctx.fillText(expr[ci], 0, 0);
    ctx.restore();
  }

  const answerEl = document.getElementById('stepup-answer');
  const submitEl = document.getElementById('stepup-submit');
  const statusEl = document.getElementById('stepup-status');
  answerEl.value = '';
  answerEl.focus();

  return new Promise(resolve => {
    let stepupKs = 0;
    const onKey = () => stepupKs++;
    answerEl.addEventListener('keydown', onKey);

    submitEl.onclick = async () => {
      answerEl.removeEventListener('keydown', onKey);
      const vRes = await fetch('/api/login/stepup-verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, token, answer: answerEl.value, telemetry: { keystrokeCount: stepupKs } }),
      });
      const vData = await vRes.json();
      overlay.classList.add('hidden');
      if (vData.ok) {
        if (vData.risk) updateBadge(vData.risk, vData.handle);
        resolve(true);
      } else {
        statusEl.textContent = 'Verification failed.';
        resolve(false);
      }
    };
  });
}

// ---------- Main flow ----------

let SESSION_ID = null, TOKEN = null;
let currentStep = 1;
let account = null;
let otpCode = null;
let handle = null;

const statusEl = document.getElementById('status');

function setStatus(msg, cls = 'text-gray-500') {
  statusEl.textContent = msg;
  statusEl.className = `text-sm text-center ${cls}`;
}

function showTerminal(outcome, agentHandle, risk, data) {
  document.querySelectorAll('[data-step]').forEach(el => { el.hidden = true; });
  document.querySelectorAll('button').forEach(b => { b.style.pointerEvents = 'none'; b.style.opacity = '0.5'; });
  setStatus('');
  const isBlock = outcome === 'block';
  const signals = data && data.reasons ? data.reasons : (data && data.reason ? [data.reason] : []);
  const signalsHtml = signals.length
    ? `<div class="flex flex-wrap justify-center gap-1 mt-1">${signals.map(s => `<span class="text-[11px] bg-red-50 text-red-600 border border-red-100 rounded px-1.5 py-0.5">${s}</span>`).join('')}</div>`
    : '';
  const card = document.createElement('div');
  card.className = `bg-white rounded-xl border ${isBlock ? 'border-red-200' : 'border-green-200'} p-8 text-center space-y-3 mb-4`;
  card.innerHTML = `
    <div class="w-14 h-14 rounded-full ${isBlock ? 'bg-red-100' : 'bg-emerald-100'} flex items-center justify-center mx-auto text-2xl">${isBlock ? '✗' : '✓'}</div>
    <h2 class="text-xl font-semibold ${isBlock ? 'text-red-700' : 'text-emerald-700'}">${isBlock ? 'Blocked' : 'Signed in'}</h2>
    <div class="inline-block bg-gray-50 border border-gray-200 rounded-xl px-5 py-3">
      <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Your agent identity</p>
      <p class="text-lg font-mono font-semibold">${agentHandle || '—'}</p>
    </div>
    <p class="text-sm text-gray-400">Risk score: ${risk?.score ?? '—'} &middot; ${risk?.tier ?? '—'}</p>
    ${signalsHtml}
    <a href="https://agentgauntlet.ai/leaderboard"
       class="inline-block mt-1 text-sm text-indigo-600 hover:underline font-medium">
      Find yourself on the leaderboard →
    </a>
  `;
  const main = document.querySelector('main') || document.body;
  main.prepend(card);
}

async function init() {
  setStatus('Starting session…');

  // Session
  const sRes = await fetch('/api/login/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!sRes.ok) { setStatus('Session blocked.', 'text-red-500'); return; }
  const sData = await sRes.json();
  SESSION_ID = sData.sessionId;
  TOKEN      = sData.token;
  account    = sData.account;

  // Render credentials canvas
  const credCanvas = document.getElementById('cred-canvas');
  drawCredentials(credCanvas, account.username, account.password);

  // Wire up SSO decoys
  document.getElementById('btn-sso').addEventListener('click', () => {
    usedSsoDecoy = true;
    setStatus('Enterprise SSO is not available for personal accounts.', 'text-amber-600');
  });
  document.getElementById('btn-google').addEventListener('click', () => {
    usedSsoDecoy = true;
    setStatus('Google sign-in is not available for this account type.', 'text-amber-600');
  });

  // Wire trap checkbox
  document.getElementById('trap-checkbox').addEventListener('change', e => {
    trapCheckboxChecked = e.target.checked;
  });

  // Password keystroke tracking
  const pwdEl = document.getElementById('login-password');
  pwdEl.addEventListener('keydown', () => {
    passwordKeystrokes++;
    passwordKeystrokeTimes.push(Date.now());
  });
  pwdEl.addEventListener('paste', () => {
    passwordPastedNotTyped = true;
  });

  // Username paste tracking
  document.getElementById('login-username').addEventListener('paste', () => {
    usernamePastedNotTyped = true;
  });

  // Fingerprint (non-blocking)
  setStatus('Initializing…');
  const fp = await window.AGDetect.collectFingerprint();
  const fpRes = await fetch('/api/login/fingerprint', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, token: TOKEN, fingerprint: fp }),
  });
  const fpData = await fpRes.json();
  if (fpData.handle) handle = fpData.handle;
  if (fpData.risk) updateBadge(fpData.risk, handle);

  if (!fpRes.ok || fpData.action === 'block') {
    showTerminal('block', handle, fpData.risk, fpData); return;
  }
  if (fpData.action === 'step_up') {
    const passed = await doStepUp(SESSION_ID, TOKEN);
    if (!passed) { setStatus('Verification failed.', 'text-red-500'); return; }
  }

  setStatus('Enter your credentials to sign in.');
  showStep(1);
  document.getElementById('btn-login-submit').addEventListener('click', submitStep1);
}

async function submitStep1() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const trapChecked = document.getElementById('trap-checkbox').checked;
  const honeypot = document.getElementById('hp-username-confirm').value;

  const res = await fetch('/api/login/step1', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: SESSION_ID, token: TOKEN,
      credentials: {
        username, password,
        trapChecked,
        honeypotUsernameConfirm: honeypot,
        panelId: document.getElementById('panel-login').id,
      },
      // snapshotTelemetry() merges generic AGDetect signals with the
      // login-specific fields (password/username paste, SSO decoy, trap
      // checkbox, password-scoped keystroke std).
      telemetry: snapshotTelemetry(),
    }),
  });
  const data = await res.json();
  if (data.risk) updateBadge(data.risk, null);

  if (!res.ok) {
    if (data.action === 'step_up') {
      const passed = await doStepUp(SESSION_ID, TOKEN);
      if (passed) await submitStep1();
      return;
    }
    showTerminal('block', handle, data.risk, data);
    return;
  }

  // Step 2: OTP
  otpCode = data.otp;
  const otpCanvas = document.getElementById('otp-canvas');
  drawOtp(otpCanvas, otpCode);

  const promptEl = document.getElementById('otp-prompt');
  promptEl.querySelector('p').textContent = data.step2?.prompt || 'Enter the code above.';

  setStatus('');
  showStep(2);
  document.getElementById('otp-input').focus();
  document.getElementById('btn-otp-submit').addEventListener('click', submitStep2);
}

async function submitStep2() {
  const code = document.getElementById('otp-input').value.trim();
  const telSnap = snapshotTelemetry();

  const res = await fetch('/api/login/step2', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, token: TOKEN, otpCode: code, telemetry: telSnap }),
  });
  const data = await res.json();
  if (data.risk) updateBadge(data.risk, data.handle);

  if (!res.ok) {
    if (data.action === 'step_up') {
      const passed = await doStepUp(SESSION_ID, TOKEN);
      if (passed) await submitStep2();
      return;
    }
    showTerminal('block', handle, data.risk, data);
    return;
  }

  if (data.handle) handle = data.handle;
  showTerminal('success', handle, data.risk, null);
  setStatus('');
}

init().catch(err => setStatus('Error: ' + err.message, 'text-red-500'));
