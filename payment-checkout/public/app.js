// Payment-checkout client: 2-step card entry + authorization.
// Defense focus: keystroke timing on card number groups, paste detection,
// inverted-hierarchy decoy button, canvas-rendered card + auth code.

(async function () {

  // ---------- Telemetry ----------
  const tel = {
    mouseMoves: 0, mousePoints: [],
    keystrokeCount: 0, keystrokeTimes: [],
    scrollEvents: 0, scrollDeltas: [],
    focusBlurEvents: 0, clickDwells: [],
    visibilityChanges: 0,
    stepShownAt: performance.now(), firstEventLatencyMs: null,
    // Payment-specific
    cardKeystrokes: 0, cvvKeystrokes: 0,
    cardGroupPauses: [],   // ms between groups of 4 digits
    cardLastGroupTime: null,
    cardDigitCount: 0,
    cardPastedNotTyped: false, cvvPastedNotTyped: false,
  };

  function noteFirst() {
    if (tel.firstEventLatencyMs === null)
      tel.firstEventLatencyMs = +(performance.now() - tel.stepShownAt).toFixed(1);
  }

  document.addEventListener('mousemove', e => { tel.mouseMoves++; if (tel.mousePoints.length < 800) tel.mousePoints.push([e.clientX, e.clientY, performance.now()]); noteFirst(); });
  document.addEventListener('keydown', () => { tel.keystrokeCount++; tel.keystrokeTimes.push(performance.now()); noteFirst(); });
  window.addEventListener('scroll', () => { tel.scrollEvents++; noteFirst(); }, { passive: true });
  window.addEventListener('wheel', e => { tel.scrollDeltas.push(+e.deltaY.toFixed(3)); }, { passive: true });
  document.addEventListener('focusin', () => tel.focusBlurEvents++);
  document.addEventListener('focusout', () => tel.focusBlurEvents++);
  document.addEventListener('visibilitychange', () => tel.visibilityChanges++);
  let downAt = null;
  document.addEventListener('mousedown', () => { downAt = performance.now(); noteFirst(); });
  document.addEventListener('mouseup', () => { if (downAt !== null) { tel.clickDwells.push(+(performance.now() - downAt).toFixed(1)); downAt = null; } });

  // Card number keystroke tracking — detect group pauses (4-4-4-4 rhythm).
  const cardInput = document.getElementById('card-number');
  cardInput.addEventListener('keydown', () => {
    tel.cardKeystrokes++;
    const now = performance.now();
    const rawLen = cardInput.value.replace(/\D/g, '').length;
    // Every 4th digit, record the pause since the last group.
    if (rawLen > 0 && rawLen % 4 === 0) {
      if (tel.cardLastGroupTime !== null) {
        tel.cardGroupPauses.push(+(now - tel.cardLastGroupTime).toFixed(1));
      }
      tel.cardLastGroupTime = now;
    }
  });
  cardInput.addEventListener('paste', () => { tel.cardPastedNotTyped = true; });
  cardInput.addEventListener('input', () => {
    // Format as groups of 4.
    let raw = cardInput.value.replace(/\D/g, '').slice(0, 16);
    cardInput.value = raw.match(/.{1,4}/g)?.join(' ') || raw;
  });

  const cvvInput = document.getElementById('card-cvv');
  cvvInput.addEventListener('keydown', () => tel.cvvKeystrokes++);
  cvvInput.addEventListener('paste', () => { tel.cvvPastedNotTyped = true; });

  function entropy(pts) {
    if (pts.length < 3) return 0;
    const bins = new Array(16).fill(0); let n = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i-1][0], dy = pts[i][1] - pts[i-1][1];
      if (!dx && !dy) continue;
      bins[Math.min(15, Math.floor((Math.atan2(dy, dx) + Math.PI) / (2*Math.PI) * 16))]++; n++;
    }
    if (!n) return 0;
    return bins.reduce((h, c) => c ? h - (c/n)*Math.log2(c/n) : h, 0);
  }
  function meanStd(arr) {
    if (!arr || !arr.length) return { mean: 0, std: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return { mean: +mean.toFixed(3), std: +Math.sqrt(arr.reduce((s,x) => s+(x-mean)**2, 0)/arr.length).toFixed(3) };
  }
  function median(arr) {
    if (!arr || !arr.length) return 0;
    const s = arr.slice().sort((a,b) => a-b), m = Math.floor(s.length/2);
    return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
  }
  function velStats(pts) {
    if (pts.length < 3) return { mean: 0, std: 0, curvature: 0 };
    const v = []; let curv = 0, lastA = null;
    for (let i = 1; i < pts.length; i++) {
      const [x1,y1,t1] = pts[i-1], [x2,y2,t2] = pts[i];
      const dt = Math.max(1, t2-t1), dx = x2-x1, dy = y2-y1;
      v.push(Math.sqrt(dx*dx+dy*dy)/dt);
      if (dx||dy) { const a = Math.atan2(dy,dx); if (lastA!==null) { let d=Math.abs(a-lastA); if(d>Math.PI) d=2*Math.PI-d; curv+=d; } lastA=a; }
    }
    const ms = meanStd(v);
    return { mean: ms.mean, std: ms.std, curvature: +curv.toFixed(3) };
  }

  function snap() {
    const vel = velStats(tel.mousePoints);
    const ks  = [];
    for (let i = 1; i < tel.keystrokeTimes.length; i++) ks.push(tel.keystrokeTimes[i] - tel.keystrokeTimes[i-1]);
    const ksStats = meanStd(ks);
    const sdUniform = tel.scrollDeltas.length > 1 && tel.scrollDeltas.every(d => Number.isInteger(d)) && new Set(tel.scrollDeltas).size <= 2;
    const t = {
      mouseMoves: tel.mouseMoves, mouseEntropy: +entropy(tel.mousePoints).toFixed(3),
      keystrokeCount: tel.keystrokeCount, scrollEvents: tel.scrollEvents, focusBlurEvents: tel.focusBlurEvents,
      mouseVelocityMean: vel.mean, mouseVelocityStd: vel.std, mouseCurvature: vel.curvature,
      clickDwellMedian: +median(tel.clickDwells).toFixed(1), clickCount: tel.clickDwells.length,
      scrollDeltaUniform: sdUniform, keystrokeIntervalStd: ksStats.std,
      visibilityChanges: tel.visibilityChanges, firstEventLatencyMs: tel.firstEventLatencyMs,
      cardKeystrokes: tel.cardKeystrokes, cvvKeystrokes: tel.cvvKeystrokes,
      cardGroupPauses: tel.cardGroupPauses.slice(),
      cardPastedNotTyped: tel.cardPastedNotTyped, cvvPastedNotTyped: tel.cvvPastedNotTyped,
    };
    tel.mouseMoves=0; tel.mousePoints=[]; tel.keystrokeCount=0; tel.keystrokeTimes=[];
    tel.scrollEvents=0; tel.scrollDeltas=[]; tel.focusBlurEvents=0; tel.clickDwells=[];
    tel.firstEventLatencyMs=null; tel.stepShownAt=performance.now();
    return t;
  }

  function setStatus(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'text-sm text-center ' + (cls || 'text-gray-500');
  }

  function updateBadge(risk, handle) {
    if (!risk) return;
    document.getElementById('risk-badge').classList.remove('hidden');
    if (handle) document.getElementById('risk-handle').textContent = handle;
    document.getElementById('risk-score').textContent = risk.score;
    const tierEl = document.getElementById('risk-tier');
    tierEl.textContent = risk.tier.toUpperCase();
    const styles = { low: ['#dcfce7','#166534','#10b981'], medium: ['#fef3c7','#92400e','#f59e0b'], high: ['#fee2e2','#991b1b','#ef4444'] }[risk.tier] || ['#f3f4f6','#374151','#9ca3af'];
    tierEl.style.backgroundColor = styles[0]; tierEl.style.color = styles[1];
    const bar = document.getElementById('risk-bar'); bar.style.width = Math.min(100,risk.score)+'%'; bar.style.background = styles[2];
    const bd = document.getElementById('risk-breakdown');
    bd.innerHTML = (risk.breakdown || []).sort((a,b)=>b.weight-a.weight).slice(0,8).map(b=>`<div class="flex justify-between"><span>${b.signal}</span><span class="text-gray-400">+${b.weight}</span></div>`).join('') || 'No signals.';
  }

  function showStep(n) {
    document.querySelectorAll('section[data-step]').forEach(s => { s.hidden = Number(s.dataset.step) !== n; });
    document.querySelectorAll('[data-pip]').forEach(p => {
      const num = Number(p.dataset.pip), dot = p.querySelector('span.w-6');
      if (num <= n) { p.classList.remove('text-gray-400'); dot.className='w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs'; }
      else { p.classList.add('text-gray-400'); dot.className='w-6 h-6 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-xs'; }
    });
  }

  async function postJSON(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      return await r.json();
    } catch { return { ok: false, reason: 'network_error' }; }
  }

  function showTerminal(outcome, handle, risk, data) {
    document.querySelectorAll('section[data-step]').forEach(s => { s.hidden = true; });
    document.querySelectorAll('button').forEach(b => { b.style.pointerEvents='none'; b.style.opacity='0.5'; });
    setStatus('');
    const isBlock = outcome === 'block';
    const signals = data && data.reasons ? data.reasons : (data && data.reason ? [data.reason] : []);
    const signalsHtml = signals.length
      ? `<div class="flex flex-wrap justify-center gap-1 mt-1">${signals.map(s => `<span class="text-[11px] bg-red-50 text-red-600 border border-red-100 rounded px-1.5 py-0.5">${s}</span>`).join('')}</div>`
      : '';
    const card = document.createElement('div');
    card.className = `bg-white rounded-xl border ${isBlock ? 'border-red-200' : 'border-green-200'} p-8 text-center space-y-3 mb-4`;
    card.innerHTML = `
      <div class="w-14 h-14 rounded-full ${isBlock ? 'bg-red-100' : 'bg-green-100'} flex items-center justify-center mx-auto text-2xl">${isBlock ? '✗' : '✓'}</div>
      <h2 class="text-xl font-semibold ${isBlock ? 'text-red-700' : 'text-green-700'}">${isBlock ? 'Blocked' : 'Payment authorized'}</h2>
      <div class="inline-block bg-gray-50 border border-gray-200 rounded-xl px-5 py-3">
        <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Your agent identity</p>
        <p class="text-lg font-mono font-semibold">${handle || '—'}</p>
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

  function blockedUI(data) {
    showTerminal('block', session && session.handle, data && data.risk, data);
  }

  // ---------- Fingerprint ----------
  async function sha256Hex(s) {
    try { const buf=new TextEncoder().encode(s), h=await crypto.subtle.digest('SHA-256',buf); return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32); } catch { return null; }
  }

  async function collectFingerprint() {
    const fp = {};
    try { const c=document.createElement('canvas'); c.width=280; c.height=60; const ctx=c.getContext('2d'); ctx.textBaseline='top'; ctx.font="14px 'Arial'"; ctx.fillStyle='#069'; ctx.fillText('Cwm fjordbank glyphs vext quiz, 🦊🍔',2,2); ctx.strokeStyle='rgba(102,204,0,0.7)'; ctx.beginPath(); ctx.arc(50,30,18,0,Math.PI*2); ctx.stroke(); fp.canvasHash=await sha256Hex(c.toDataURL()); } catch(e) { fp.canvasError=String(e); }
    try { const gl=document.createElement('canvas').getContext('webgl'); if(gl){const d=gl.getExtension('WEBGL_debug_renderer_info'); if(d){fp.webglVendor=gl.getParameter(d.UNMASKED_VENDOR_WEBGL); fp.webglRenderer=gl.getParameter(d.UNMASKED_RENDERER_WEBGL);} fp.webglVersion=gl.getParameter(gl.VERSION);}else{fp.webglMissing=true;} } catch(e) { fp.webglError=String(e); }
    try { const C=window.OfflineAudioContext||window.webkitOfflineAudioContext; if(C){const ctx=new C(1,5000,44100),osc=ctx.createOscillator(),comp=ctx.createDynamicsCompressor(); osc.type='triangle'; osc.frequency.value=1000; comp.threshold.value=-50; comp.knee.value=40; comp.ratio.value=12; comp.attack.value=0; comp.release.value=0.2; osc.connect(comp); comp.connect(ctx.destination); osc.start(0); const buf=await ctx.startRendering(),ch=buf.getChannelData(0); let sum=0; for(let i=4500;i<5000;i++) sum+=Math.abs(ch[i]); fp.audioHash=sum.toFixed(8);} } catch {}
    fp.userAgent=navigator.userAgent; fp.platform=navigator.platform; fp.webdriver=navigator.webdriver===true;
    fp.pluginsLength=navigator.plugins?navigator.plugins.length:0; fp.chrome=!!window.chrome;
    fp.screen={width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,colorDepth:screen.colorDepth};
    fp.devicePixelRatio=window.devicePixelRatio;
    try { fp.tzOffset=new Date().getTimezoneOffset(); fp.tz=Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    try { if(navigator.permissions&&typeof Notification!=='undefined'){const n=await navigator.permissions.query({name:'notifications'}); fp.notifPerm=n.state; fp.notifAPI=Notification.permission; fp.notifMismatch=fp.notifAPI==='denied'&&fp.notifPerm==='prompt';} } catch {}
    fp.rafFrame = await new Promise(r=>{const t=performance.now(); requestAnimationFrame(()=>r(+(performance.now()-t).toFixed(2)));});
    return fp;
  }

  // ---------- Canvas rendering helpers ----------

  function drawCard(canvas, card) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    // Background gradient.
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#1e3a5f');
    grad.addColorStop(1, '#0f2340');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 16);
    ctx.fill();

    // Chip.
    ctx.fillStyle = '#c8a84b';
    ctx.beginPath(); ctx.roundRect(24, 60, 40, 30, 5); ctx.fill();
    ctx.strokeStyle = '#a0832a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(44, 60); ctx.lineTo(44, 90); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(24, 75); ctx.lineTo(64, 75); ctx.stroke();

    // Card number with per-character jitter (same anti-OCR technique as prices).
    const groups = card.number.match(/.{1,4}/g) || [];
    let x = 24;
    ctx.textBaseline = 'middle';
    for (let g = 0; g < groups.length; g++) {
      for (const ch of groups[g]) {
        ctx.save();
        ctx.translate(x, 130 + (Math.random() - 0.5) * 2);
        ctx.rotate((Math.random() - 0.5) * 0.04);
        ctx.font = `bold ${20 + (Math.random() * 2 - 1)}px 'Courier New', monospace`;
        ctx.fillStyle = `rgba(255,255,255,${0.90 + Math.random() * 0.10})`;
        ctx.fillText(ch, 0, 0);
        ctx.restore();
        x += 13;
      }
      x += 10; // group gap
    }

    // Expiry.
    const mm = String(card.expMonth).padStart(2, '0');
    const yy = String(card.expYear).padStart(2, '0');
    ctx.font = '11px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('VALID THRU', 24, 158);
    ctx.font = 'bold 14px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(`${mm}/${yy}`, 24, 174);

    // CVV label.
    ctx.font = '11px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('CVV', w - 80, 158);
    ctx.font = 'bold 14px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(card.cvv, w - 80, 174);

    // Network logo placeholder.
    ctx.font = 'bold italic 18px serif'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'right';
    ctx.fillText('VISA', w - 20, 30);
    ctx.textAlign = 'left';
  }

  function drawAuthCode(canvas, code) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Background noise.
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(${Math.random()*150|0},${Math.random()*150|0},${Math.random()*150|0},0.2)`;
      ctx.fillRect(Math.random()*canvas.width, Math.random()*canvas.height, 1, 1);
    }
    let x = 30;
    for (const c of String(code)) {
      ctx.save();
      ctx.translate(x, 35 + (Math.random()-0.5)*6);
      ctx.rotate((Math.random()-0.5)*0.3);
      ctx.font = `${26+(Math.random()*4)}px ${Math.random()<0.5?'serif':'sans-serif'}`;
      ctx.fillStyle = '#1f2937';
      ctx.fillText(c, 0, 0);
      ctx.restore();
      x += 32;
    }
    ctx.strokeStyle = 'rgba(99,102,241,0.35)';
    ctx.beginPath(); ctx.moveTo(0, 35+(Math.random()-0.5)*12); ctx.lineTo(canvas.width, 35+(Math.random()-0.5)*12); ctx.stroke();
  }

  // ---------- Step-up ----------
  async function doStepUp(sessionId, token) {
    const overlay = document.getElementById('stepup-overlay');
    const cvs = document.getElementById('stepup-canvas');
    const input = document.getElementById('stepup-answer');
    const btn = document.getElementById('stepup-submit');
    const status = document.getElementById('stepup-status');
    overlay.classList.remove('hidden'); overlay.classList.add('flex');
    input.value = ''; status.textContent = 'Loading…';

    const ch = await postJSON('/api/payment/stepup-challenge', { sessionId, token });
    if (!ch.a) { status.textContent = 'Failed.'; return false; }

    const ctx = cvs.getContext('2d'); ctx.clearRect(0,0,cvs.width,cvs.height);
    for (let i=0;i<80;i++){ctx.fillStyle=`rgba(${Math.random()*150|0},${Math.random()*150|0},${Math.random()*150|0},0.25)`;ctx.fillRect(Math.random()*cvs.width,Math.random()*cvs.height,1,1);}
    let x=18;
    for (const c of `${ch.a} ${ch.op} ${ch.b} = ?`) { ctx.save();ctx.translate(x,30+(Math.random()-0.5)*6);ctx.rotate((Math.random()-0.5)*0.35);ctx.font=`${22+Math.random()*4}px ${Math.random()<0.5?'serif':'sans-serif'}`;ctx.fillStyle='#1f2937';ctx.fillText(c,0,0);ctx.restore();x+=22; }
    ctx.strokeStyle='rgba(99,102,241,0.4)';ctx.beginPath();ctx.moveTo(0,30+(Math.random()-0.5)*14);ctx.lineTo(cvs.width,30+(Math.random()-0.5)*14);ctx.stroke();
    status.textContent='Take your time — minimum 2 seconds.';

    return new Promise(resolve => {
      const submit = async () => {
        btn.disabled = true;
        const d = await postJSON('/api/payment/stepup-verify', { sessionId, token, answer: input.value.trim(), telemetry: snap() });
        if (d.ok) { updateBadge(d.risk, d.handle); overlay.classList.add('hidden'); overlay.classList.remove('flex'); btn.disabled=false; resolve(true); }
        else { status.textContent = `🚫 ${(d.reasons||[]).join(', ')||'Blocked.'}`; status.className='text-xs text-center text-red-600 mt-2'; updateBadge(d.risk); btn.disabled=true; input.disabled=true; resolve(false); }
      };
      btn.onclick = submit;
      input.onkeydown = e => { if(e.key==='Enter') submit(); };
    });
  }

  // ---------- Main flow ----------
  let session;
  setStatus('Starting session…');

  try {
    const r = await fetch('/api/payment/session', { method: 'POST' });
    session = await r.json();
    if (!r.ok || session.action === 'block') {
      updateBadge(session.risk, '(rejected)');
      setStatus(`🚫 Blocked at session start.`, 'text-red-700');
      return;
    }
    if (session.risk) updateBadge(session.risk, '');
  } catch { setStatus('Failed to start session.', 'text-red-700'); return; }

  // Render card to canvas.
  drawCard(document.getElementById('card-canvas'), session.card);

  // Collect + submit fingerprint.
  setStatus('Verifying environment…');
  const fp = await collectFingerprint();
  try {
    const fpData = await postJSON('/api/payment/fingerprint', { sessionId: session.sessionId, token: session.token, fingerprint: fp });
    session.handle = fpData.handle; session.visitorId = fpData.visitorId;
    if (fpData.risk) updateBadge(fpData.risk, fpData.handle);
    if (fpData.action === 'block') {
      setStatus('🚫 Environment rejected.', 'text-red-700');
      document.querySelectorAll('button').forEach(b => { b.style.pointerEvents='none'; b.style.opacity='0.5'; });
      return;
    }
    if (fpData.action === 'step_up') {
      const passed = await doStepUp(session.sessionId, session.token);
      if (!passed) { setStatus('🚫 Step-up failed.', 'text-red-700'); return; }
    }
  } catch { setStatus('Environment check failed.', 'text-red-700'); return; }

  setStatus('Step 1 — enter your card details.');

  // Decoy button.
  document.getElementById('btn-instant-pay').addEventListener('click', async () => {
    setStatus('Processing…');
    const d = await postJSON('/api/payment/step1', {
      sessionId: session.sessionId, token: session.token,
      card: { number: document.getElementById('card-number').value, expMonth: null, expYear: null, cvv: null, honeypotCardBackup: document.getElementById('hp-card-backup').value || false, clickedDecoy: true },
      telemetry: snap(),
    });
    blockedUI(d);
  });

  // Real submit.
  document.getElementById('btn-card-submit').addEventListener('click', () => submitStep1());

  async function submitStep1() {
    setStatus('Verifying card…');
    const rawNum = document.getElementById('card-number').value.replace(/\D/g,'');
    const expRaw = document.getElementById('card-expiry').value.replace(/\D/g,'');
    const expM = parseInt(expRaw.slice(0,2), 10);
    const expY = parseInt(expRaw.slice(2,4), 10);
    const cvv  = document.getElementById('card-cvv').value.replace(/\D/g,'');

    const d = await postJSON('/api/payment/step1', {
      sessionId: session.sessionId, token: session.token,
      card: { number: rawNum, expMonth: expM, expYear: expY, cvv, honeypotCardBackup: !!document.getElementById('hp-card-backup').value },
      telemetry: snap(),
    });
    if (d.risk) updateBadge(d.risk, session.handle);
    if (d.ok) {
      renderStep2(d);
    } else if (d.action === 'step_up') {
      const passed = await doStepUp(session.sessionId, session.token);
      if (passed) submitStep1(); else blockedUI({ reasons: ['stepup_failed'] });
    } else {
      blockedUI(d);
    }
  }

  function renderStep2(data) {
    showStep(2);
    drawAuthCode(document.getElementById('auth-canvas'), data.authCode);
    document.getElementById('step2-prompt').textContent = data.step2.prompt;

    document.getElementById('order-summary').innerHTML = `
      <div class="flex justify-between"><span class="text-gray-500">Card</span><span>•••• •••• •••• ${session.card.number.slice(-4)}</span></div>
      <div class="flex justify-between"><span class="text-gray-500">Auth code</span><span>shown above ↑</span></div>
    `;

    const wrap = document.getElementById('step2-buttons');
    wrap.innerHTML = '';

    // DECOY: loud gradient "Express Checkout" button.
    const decoy = document.createElement('button');
    decoy.type = 'button'; decoy.dataset.btnId = data.decoyBtnId;
    decoy.className = 'py-5 rounded-xl font-bold text-white text-lg shadow-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 hover:opacity-90 flex items-center justify-center gap-2';
    decoy.innerHTML = '✨ Express Checkout <span class="text-xs bg-white/20 px-2 py-0.5 rounded">Recommended</span>';
    decoy.addEventListener('click', () => submitAuthorize(data.decoyBtnId));

    // REAL: quiet plain "Confirm Payment".
    const real = document.createElement('button');
    real.type = 'button'; real.dataset.btnId = data.realBtnId;
    real.className = 'py-3 rounded-lg font-medium text-gray-700 border border-gray-300 bg-white hover:bg-gray-50 text-sm';
    real.textContent = 'Confirm Payment';
    real.addEventListener('click', () => submitAuthorize(data.realBtnId));

    const order = Math.random() < 0.5 ? [decoy, real] : [real, decoy];
    order.forEach(b => wrap.appendChild(b));

    setStatus('Step 2 — authorize your payment.');
  }

  async function submitAuthorize(btnId) {
    setStatus('Authorizing…');
    const d = await postJSON('/api/payment/authorize', {
      sessionId: session.sessionId, token: session.token,
      clickedBtnId: btnId, telemetry: snap(),
    });
    if (d.risk) updateBadge(d.risk, session.handle);
    if (d.ok) {
      showTerminal('success', d.handle || session.handle, d.risk, null);
    } else if (d.action === 'step_up') {
      const passed = await doStepUp(session.sessionId, session.token);
      if (passed) submitAuthorize(btnId); else blockedUI({ reasons: ['stepup_failed'] });
    } else {
      blockedUI(d);
    }
  }

})();
