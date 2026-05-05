// V2 client: 3-step checkout with vision-agent-targeted challenges.
// Each step is rendered from server-supplied config; the server holds
// the source of truth for which item / shipping / button is "correct".

(async function () {
  // ---------- Telemetry: collected globally, flushed per step ----------
  // Tracks not just counts, but distributions: velocity profile, click dwell,
  // scroll-delta variance, per-step reaction time. These distinguish real
  // human input from scripted/teleported cursor activity.
  const tel = {
    mouseMoves: 0,
    mousePoints: [],     // [x, y, t]
    keystrokeCount: 0,
    keystrokeTimes: [],
    scrollEvents: 0,
    scrollDeltas: [],
    focusBlurEvents: 0,
    clickDwells: [],     // ms between mousedown and mouseup per click
    visibilityChanges: 0,
    stepShownAt: performance.now(),
    firstEventLatencyMs: null,
  };

  function noteFirstEvent() {
    if (tel.firstEventLatencyMs === null) {
      tel.firstEventLatencyMs = +(performance.now() - tel.stepShownAt).toFixed(1);
    }
  }

  document.addEventListener('mousemove', (e) => {
    tel.mouseMoves++;
    if (tel.mousePoints.length < 800) {
      tel.mousePoints.push([e.clientX, e.clientY, performance.now()]);
    }
    noteFirstEvent();
  });
  document.addEventListener('keydown', () => {
    tel.keystrokeCount++;
    tel.keystrokeTimes.push(performance.now());
    noteFirstEvent();
  });
  window.addEventListener('scroll', () => {
    tel.scrollEvents++;
    noteFirstEvent();
  }, { passive: true });
  window.addEventListener('wheel', (e) => {
    tel.scrollDeltas.push(+e.deltaY.toFixed(3));
  }, { passive: true });
  document.addEventListener('focusin', () => { tel.focusBlurEvents++; });
  document.addEventListener('focusout', () => { tel.focusBlurEvents++; });
  document.addEventListener('visibilitychange', () => { tel.visibilityChanges++; });

  // Click-dwell tracking on any button/clickable.
  let downAt = null, downTarget = null;
  document.addEventListener('mousedown', (e) => {
    downAt = performance.now();
    downTarget = e.target;
    noteFirstEvent();
  });
  document.addEventListener('mouseup', (e) => {
    if (downAt !== null) {
      tel.clickDwells.push(+(performance.now() - downAt).toFixed(1));
      downAt = null; downTarget = null;
    }
  });

  function entropy(points) {
    if (points.length < 3) return 0;
    const bins = new Array(16).fill(0);
    let n = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      if (dx === 0 && dy === 0) continue;
      const a = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
      bins[Math.min(15, Math.floor(a * 16))]++;
      n++;
    }
    if (n === 0) return 0;
    let h = 0;
    for (const c of bins) {
      if (c === 0) continue;
      const p = c / n;
      h -= p * Math.log2(p);
    }
    return h;
  }

  function meanStd(arr) {
    if (!arr || arr.length === 0) return { mean: 0, std: 0, n: 0 };
    const n = arr.length;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    return { mean: +mean.toFixed(3), std: +Math.sqrt(variance).toFixed(3), n };
  }
  function median(arr) {
    if (!arr || arr.length === 0) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function velocityStats(points) {
    if (points.length < 3) return { mean: 0, std: 0, curvature: 0 };
    const v = [];
    let curvSum = 0;
    let lastAngle = null;
    for (let i = 1; i < points.length; i++) {
      const [x1, y1, t1] = points[i - 1];
      const [x2, y2, t2] = points[i];
      const dt = Math.max(1, t2 - t1);
      const dx = x2 - x1, dy = y2 - y1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      v.push(dist / dt);                            // px/ms
      if (dx !== 0 || dy !== 0) {
        const ang = Math.atan2(dy, dx);
        if (lastAngle !== null) {
          let d = Math.abs(ang - lastAngle);
          if (d > Math.PI) d = 2 * Math.PI - d;
          curvSum += d;
        }
        lastAngle = ang;
      }
    }
    const ms = meanStd(v);
    return { mean: ms.mean, std: ms.std, curvature: +curvSum.toFixed(3) };
  }

  function snapshotTelemetry() {
    const vel = velocityStats(tel.mousePoints);
    const dwell = meanStd(tel.clickDwells);
    const scrollDeltaStats = meanStd(tel.scrollDeltas);
    // Are scroll deltas all integers and uniform? Synthetic scrolls usually are.
    const scrollDeltaUniform = tel.scrollDeltas.length > 1
      ? tel.scrollDeltas.every(d => Number.isInteger(d)) && new Set(tel.scrollDeltas).size <= 2
      : false;
    // Inter-keystroke interval stddev — humans vary, bots type at constant rate.
    const ksIntervals = [];
    for (let i = 1; i < tel.keystrokeTimes.length; i++) {
      ksIntervals.push(tel.keystrokeTimes[i] - tel.keystrokeTimes[i - 1]);
    }
    const ksStats = meanStd(ksIntervals);

    const snap = {
      // Originals (kept for backwards compatibility with existing scoring)
      mouseMoves: tel.mouseMoves,
      mouseEntropy: +entropy(tel.mousePoints).toFixed(3),
      keystrokeCount: tel.keystrokeCount,
      scrollEvents: tel.scrollEvents,
      focusBlurEvents: tel.focusBlurEvents,
      // New behavioral signals
      mouseVelocityMean: vel.mean,
      mouseVelocityStd:  vel.std,
      mouseCurvature:    vel.curvature,
      clickDwellMedian:  +median(tel.clickDwells).toFixed(1),
      clickDwellStd:     dwell.std,
      clickCount:        tel.clickDwells.length,
      scrollDeltaStd:    scrollDeltaStats.std,
      scrollDeltaUniform,
      keystrokeIntervalStd: ksStats.std,
      visibilityChanges: tel.visibilityChanges,
      firstEventLatencyMs: tel.firstEventLatencyMs,
    };
    // Reset deltas so the next step reports its own activity.
    tel.mouseMoves = 0;
    tel.mousePoints = [];
    tel.keystrokeCount = 0;
    tel.keystrokeTimes = [];
    tel.scrollEvents = 0;
    tel.scrollDeltas = [];
    tel.focusBlurEvents = 0;
    tel.clickDwells = [];
    tel.visibilityChanges = 0;
    tel.firstEventLatencyMs = null;
    tel.stepShownAt = performance.now();
    return snap;
  }

  // ---------- Helpers ----------
  function setStatus(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'mt-6 text-sm text-center ' + (cls || 'text-gray-500');
  }

  // ---------- Risk badge ----------
  function updateRiskBadge(risk, handle) {
    if (!risk) return;
    const badge = document.getElementById('risk-badge');
    badge.classList.remove('hidden');
    document.getElementById('risk-handle').textContent = handle || '';
    document.getElementById('risk-score').textContent = risk.score;
    const tierEl = document.getElementById('risk-tier');
    tierEl.textContent = risk.tier.toUpperCase();
    const tierStyles = {
      low:    { bg: '#dcfce7', fg: '#166534', bar: '#10b981' },
      medium: { bg: '#fef3c7', fg: '#92400e', bar: '#f59e0b' },
      high:   { bg: '#fee2e2', fg: '#991b1b', bar: '#ef4444' },
    }[risk.tier] || { bg: '#f3f4f6', fg: '#374151', bar: '#9ca3af' };
    tierEl.style.backgroundColor = tierStyles.bg;
    tierEl.style.color = tierStyles.fg;
    const bar = document.getElementById('risk-bar');
    bar.style.width = Math.min(100, risk.score) + '%';
    bar.style.background = tierStyles.bar;
    const breakdown = document.getElementById('risk-breakdown');
    if (risk.breakdown && risk.breakdown.length > 0) {
      breakdown.innerHTML = risk.breakdown
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8)
        .map(b => `<div class="flex justify-between"><span>${b.signal}</span><span class="text-gray-400">+${b.weight}</span></div>`)
        .join('');
    } else {
      breakdown.textContent = 'No risk signals.';
    }
  }

  // ---------- Step-up flow ----------
  async function doStepUp() {
    const overlay = document.getElementById('stepup-overlay');
    const canvas  = document.getElementById('stepup-canvas');
    const input   = document.getElementById('stepup-answer');
    const button  = document.getElementById('stepup-submit');
    const status  = document.getElementById('stepup-status');

    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    input.value = '';
    status.textContent = 'Loading…';
    status.className = 'text-xs text-center text-gray-500 mt-2';

    const res = await fetch('/api/v2/stepup-challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, token: session.token }),
    });
    const ch = await res.json();
    if (!ch.a) { status.textContent = 'Failed to load challenge.'; return; }

    // Render math problem with mild distortion to defeat trivial OCR.
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Background noise dots
    for (let i = 0; i < 80; i++) {
      ctx.fillStyle = `rgba(${Math.random()*150|0},${Math.random()*150|0},${Math.random()*150|0},0.25)`;
      ctx.fillRect(Math.random()*canvas.width, Math.random()*canvas.height, 1, 1);
    }
    // Question text, character by character with jitter
    const text = `${ch.a} ${ch.op} ${ch.b} = ?`;
    let x = 18;
    for (const c of text) {
      ctx.save();
      ctx.translate(x, 30 + (Math.random() - 0.5) * 6);
      ctx.rotate((Math.random() - 0.5) * 0.35);
      ctx.font = `${22 + (Math.random() * 4)}px ${Math.random() < 0.5 ? 'serif' : 'sans-serif'}`;
      ctx.fillStyle = '#1f2937';
      ctx.fillText(c, 0, 0);
      ctx.restore();
      x += 22;
    }
    // Strike-through line
    ctx.strokeStyle = 'rgba(99,102,241,0.4)';
    ctx.beginPath();
    ctx.moveTo(0, 30 + (Math.random() - 0.5) * 14);
    ctx.lineTo(canvas.width, 30 + (Math.random() - 0.5) * 14);
    ctx.stroke();

    status.textContent = 'Take your time — minimum 2 seconds.';

    return new Promise((resolve) => {
      const submit = async () => {
        button.disabled = true;
        const verify = await fetch('/api/v2/stepup-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            token: session.token,
            answer: input.value.trim(),
            telemetry: snapshotTelemetry(),
          }),
        });
        const data = await verify.json();
        if (data.ok) {
          updateRiskBadge(data.risk, data.handle);
          overlay.classList.add('hidden');
          overlay.classList.remove('flex');
          status.textContent = '';
          button.disabled = false;
          resolve(true);
        } else {
          status.textContent = `🚫 ${(data.reasons || []).join(', ') || 'Blocked.'}`;
          status.className = 'text-xs text-center text-red-600 mt-2';
          updateRiskBadge(data.risk, session.handle);
          // Hard block — leave overlay up but disabled
          button.disabled = true;
          input.disabled = true;
          resolve(false);
        }
      };
      button.onclick = submit;
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    });
  }
  function showStep(n) {
    document.querySelectorAll('section[data-step]').forEach(s => {
      s.hidden = (Number(s.dataset.step) !== n);
    });
    document.querySelectorAll('[data-pip]').forEach(p => {
      const num = Number(p.dataset.pip);
      const dot = p.querySelector('span.w-6');
      if (num <= n) {
        p.classList.remove('text-gray-400');
        dot.className = 'w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs';
      } else {
        p.classList.add('text-gray-400');
        dot.className = 'w-6 h-6 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-xs';
      }
    });
  }
  // ---------- Fingerprint collection ----------
  async function sha256Hex(s) {
    try {
      const buf = new TextEncoder().encode(s);
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    } catch (e) { return null; }
  }

  async function collectFingerprint() {
    const fp = {};

    // Canvas hash — different GPUs / OS font renderers produce different pixels.
    try {
      const c = document.createElement('canvas');
      c.width = 280; c.height = 60;
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#069';
      ctx.fillText('Cwm fjordbank glyphs vext quiz, 🦊🍔', 2, 2);
      ctx.strokeStyle = 'rgba(102,204,0,0.7)';
      ctx.beginPath(); ctx.arc(50, 30, 18, 0, Math.PI * 2); ctx.stroke();
      const url = c.toDataURL();
      fp.canvasHash = await sha256Hex(url);
      fp.canvasLen = url.length;
    } catch (e) { fp.canvasError = String(e); }

    // WebGL renderer / vendor — headless / VM environments leak here.
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          fp.webglVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
          fp.webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
        }
        fp.webglVersion = gl.getParameter(gl.VERSION);
      } else {
        fp.webglMissing = true;
      }
    } catch (e) { fp.webglError = String(e); }

    // Audio fingerprint via OfflineAudioContext — subtle DSP differences across stacks.
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (Ctx) {
        const ctx = new Ctx(1, 5000, 44100);
        const osc = ctx.createOscillator();
        osc.type = 'triangle'; osc.frequency.value = 1000;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12;
        comp.attack.value = 0; comp.release.value = 0.2;
        osc.connect(comp); comp.connect(ctx.destination);
        osc.start(0);
        const buf = await ctx.startRendering();
        const ch = buf.getChannelData(0);
        let sum = 0;
        for (let i = 4500; i < 5000; i++) sum += Math.abs(ch[i]);
        fp.audioHash = sum.toFixed(8);
      }
    } catch (e) { fp.audioError = String(e); }

    // Navigator
    fp.userAgent = navigator.userAgent;
    fp.languages = Array.isArray(navigator.languages) ? navigator.languages.slice(0, 5) : null;
    fp.platform = navigator.platform;
    fp.hardwareConcurrency = navigator.hardwareConcurrency || null;
    fp.deviceMemory = navigator.deviceMemory || null;
    fp.webdriver = navigator.webdriver === true;
    fp.pluginsLength = navigator.plugins ? navigator.plugins.length : 0;
    fp.chrome = !!window.chrome;
    fp.chromeRuntime = !!(window.chrome && window.chrome.runtime);

    // Screen + window
    fp.screen = {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
    };
    fp.devicePixelRatio = window.devicePixelRatio;
    fp.windowInner = { width: window.innerWidth, height: window.innerHeight };

    // Timezone
    try {
      fp.tzOffset = new Date().getTimezoneOffset();
      fp.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {}

    // Headless Chrome bug: Notification.permission === 'denied' while
    // permissions.query says 'prompt'.
    try {
      if (navigator.permissions && navigator.permissions.query && typeof Notification !== 'undefined') {
        const notif = await navigator.permissions.query({ name: 'notifications' });
        fp.notifPerm = notif.state;
        fp.notifAPI = Notification.permission;
        fp.notifMismatch = (fp.notifAPI === 'denied' && fp.notifPerm === 'prompt');
      }
    } catch (e) {}

    // requestAnimationFrame timing — headless environments often fire rAF
    // immediately rather than at the next display refresh (~16ms).
    fp.rafFrame = await new Promise(resolve => {
      const t0 = performance.now();
      requestAnimationFrame(() => resolve(+(performance.now() - t0).toFixed(2)));
    });

    return fp;
  }

  function drawPrice(c, text, big = false) {
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#111827';
    ctx.font = `${big ? '600 14px' : '13px'} system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.save();
    ctx.translate(c.width - 2, c.height / 2 + (Math.random() - 0.5));
    ctx.rotate((Math.random() - 0.5) * 0.03);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // ---------- Start ----------
  let session;
  setStatus('Starting session…');
  try {
    const res = await fetch('/api/v2/session', { method: 'POST' });
    session = await res.json();
    if (!res.ok || session.action === 'block') {
      updateRiskBadge(session.risk, '(rejected)');
      setStatus(`🚫 Blocked at session start. Risk ${session.risk?.score ?? '?'}.`, 'text-red-700');
      return;
    }
    if (session.risk) updateRiskBadge(session.risk, '');
  } catch (e) {
    setStatus('Failed to start session.', 'text-red-700');
    return;
  }

  // ---------- Fingerprint: collect + submit before any interaction ----------
  setStatus('Verifying environment…');
  const fp = await collectFingerprint();
  try {
    const fpRes = await fetch('/api/v2/fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, token: session.token, fingerprint: fp }),
    });
    const fpData = await fpRes.json();
    session.handle = fpData.handle;
    session.visitorId = fpData.visitorId;
    if (fpData.risk) updateRiskBadge(fpData.risk, fpData.handle);

    if (fpData.action === 'block') {
      setStatus('🚫 Environment rejected. This session cannot continue.', 'text-red-700');
      document.querySelectorAll('button, [data-item-id]').forEach(el => {
        el.style.pointerEvents = 'none'; el.style.opacity = '0.5';
      });
      return;
    }
    if (fpData.action === 'step_up') {
      const passed = await doStepUp();
      if (!passed) {
        setStatus('🚫 Step-up failed.', 'text-red-700');
        document.querySelectorAll('button, [data-item-id]').forEach(el => {
          el.style.pointerEvents = 'none'; el.style.opacity = '0.5';
        });
        return;
      }
    }
  } catch (e) {
    setStatus('Environment check failed.', 'text-red-700');
    return;
  }

  // ---------- Render Step 1 ----------
  const ul = document.getElementById('cart-items');
  const subtotal = session.subtotal;
  for (const it of session.cart) {
    const li = document.createElement('li');
    li.className = 'py-3 flex items-center justify-between cursor-pointer rounded-lg hover:bg-amber-50 px-2';
    li.dataset.itemId = it.id;
    li.innerHTML = `
      <div class="flex items-center gap-3 pointer-events-none">
        <div class="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-2xl">${it.emoji}</div>
        <div>
          <div class="font-medium">${it.name}</div>
          <div class="text-xs text-gray-500">Qty ${it.qty} · unit <span data-unit></span></div>
        </div>
      </div>
      <canvas data-line-price width="80" height="20"></canvas>
    `;
    li.querySelector('[data-unit]').textContent = `$${it.unitPrice.toFixed(2)}`;
    drawPrice(li.querySelector('canvas'), `$${(it.qty * it.unitPrice).toFixed(2)}`);
    li.addEventListener('click', () => submitStep1Item(it.id));
    ul.appendChild(li);
  }
  drawPrice(document.querySelector('[data-line=subtotal]'), `$${subtotal.toFixed(2)}`, true);
  document.getElementById('step1-prompt').textContent = session.step1.prompt;

  // Decoy buttons
  document.querySelectorAll('button[data-decoy]').forEach(btn => {
    btn.addEventListener('click', () => submitStep1Decoy(btn.dataset.decoy));
  });

  setStatus('Step 1 — review your cart.');

  // ---------- Step 1 submit ----------
  async function submitStep1Item(itemId) {
    setStatus('Verifying…');
    const payload = {
      sessionId: session.sessionId,
      token: session.token,
      step: 1,
      telemetry: snapshotTelemetry(),
      answer: {
        itemId,
        clickedDecoy: false,
        honeypotEmail: !!document.getElementById('hp-email').value,
        honeypotPromo: !!document.getElementById('hp-promo').value,
      },
    };
    const data = await postJSON('/api/v2/step', payload);
    if (data.risk) updateRiskBadge(data.risk, session.handle);
    if (data.ok) {
      renderStep2(data);
    } else if (data.action === 'step_up') {
      const passed = await doStepUp();
      if (passed) submitStep1Item(itemId);
      else blockedUI({ reasons: ['stepup_failed'] });
    } else {
      blockedUI(data);
    }
  }
  async function submitStep1Decoy(which) {
    const payload = {
      sessionId: session.sessionId,
      token: session.token,
      step: 1,
      telemetry: snapshotTelemetry(),
      answer: { itemId: null, clickedDecoy: which },
    };
    const data = await postJSON('/api/v2/step', payload);
    blockedUI(data); // decoys always block
  }

  // ---------- Render Step 2 ----------
  function renderStep2(data) {
    showStep(2);
    document.getElementById('step2-prompt').textContent = data.step2.prompt;
    const wrap = document.getElementById('shipping-options');
    wrap.innerHTML = '';
    for (const opt of data.shipping) {
      const card = document.createElement('button');
      card.type = 'button';
      card.dataset.shipId = opt.id;
      const isLoud = !!opt.badge;
      card.className =
        'text-left p-4 rounded-xl border-2 transition relative ' +
        (isLoud
          ? 'border-purple-300 bg-gradient-to-br from-purple-50 to-pink-50 hover:from-purple-100 hover:to-pink-100 shadow-md'
          : 'border-gray-200 bg-white hover:border-indigo-400');
      const badgeHTML = opt.badge
        ? `<span class="absolute -top-2 right-3 text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-600 text-white">${opt.badge}</span>`
        : '';
      card.innerHTML = `
        ${badgeHTML}
        <div class="font-semibold ${isLoud ? 'text-purple-900' : ''}">${opt.name}</div>
        <div class="text-xs text-gray-500 mt-1">${opt.eta}</div>
        <div class="mt-3 font-medium">$${opt.cost.toFixed(2)}</div>
      `;
      card.addEventListener('click', () => submitStep2(opt.id));
      wrap.appendChild(card);
    }
    setStatus('Step 2 — choose shipping.');
  }
  async function submitStep2(shipId) {
    setStatus('Verifying…');
    const payload = {
      sessionId: session.sessionId,
      token: session.token,
      step: 2,
      telemetry: snapshotTelemetry(),
      answer: { shippingId: shipId },
    };
    const data = await postJSON('/api/v2/step', payload);
    if (data.risk) updateRiskBadge(data.risk, session.handle);
    if (data.ok) {
      renderStep3(data);
    } else if (data.action === 'step_up') {
      const passed = await doStepUp();
      if (passed) submitStep2(shipId);
      else blockedUI({ reasons: ['stepup_failed'] });
    } else {
      blockedUI(data);
    }
  }

  // ---------- Render Step 3 ----------
  function renderStep3(data) {
    showStep(3);
    const sum = data.summary;
    document.getElementById('order-summary').innerHTML = `
      <div class="flex justify-between"><span>Subtotal</span><span>$${sum.subtotal.toFixed(2)}</span></div>
      <div class="flex justify-between"><span>Shipping (${sum.shippingName})</span><span>$${sum.shippingCost.toFixed(2)}</span></div>
      <div class="flex justify-between"><span>Tax</span><span>$${sum.tax.toFixed(2)}</span></div>
      <div class="flex justify-between font-semibold border-t border-gray-200 pt-1 mt-1"><span>Total</span><span>$${sum.total.toFixed(2)}</span></div>
    `;
    document.getElementById('step3-prompt').textContent = data.step3.prompt;

    const wrap = document.getElementById('step3-buttons');
    wrap.innerHTML = '';

    // DECOY: visually loud, labeled "Recommended". This is the trap.
    const decoy = document.createElement('button');
    decoy.type = 'button';
    decoy.dataset.btnId = data.step3.decoyBtnId;
    decoy.className =
      'py-5 rounded-xl font-bold text-white text-lg shadow-xl ' +
      'bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 hover:opacity-90 ' +
      'flex items-center justify-center gap-2';
    decoy.innerHTML = '✨ Place Order <span class="text-xs bg-white/20 px-2 py-0.5 rounded">Recommended</span>';
    decoy.addEventListener('click', () => submitCheckout(data.step3.decoyBtnId));

    // REAL: visually quiet, no "recommended" label. Reading the prompt
    // ("click the button NOT marked as recommended") leads here.
    const real = document.createElement('button');
    real.type = 'button';
    real.dataset.btnId = data.step3.realBtnId;
    real.className =
      'py-3 rounded-lg font-medium text-gray-700 border border-gray-300 bg-white hover:bg-gray-50 text-sm';
    real.textContent = 'Place Order';
    real.addEventListener('click', () => submitCheckout(data.step3.realBtnId));

    // Randomize order so position isn't a tell.
    const order = Math.random() < 0.5 ? [decoy, real] : [real, decoy];
    order.forEach(b => wrap.appendChild(b));

    setStatus('Step 3 — review and place your order.');
  }
  async function submitCheckout(btnId) {
    setStatus('Placing order…');
    const payload = {
      sessionId: session.sessionId,
      token: session.token,
      clickedBtnId: btnId,
      telemetry: snapshotTelemetry(),
    };
    const data = await postJSON('/api/v2/checkout', payload);
    if (data.risk) updateRiskBadge(data.risk, session.handle);
    if (data.ok) {
      showTerminal('success', data.handle || session.handle, data.risk, null);
    } else if (data.action === 'step_up') {
      const passed = await doStepUp();
      if (passed) submitCheckout(btnId);
      else blockedUI({ reasons: ['stepup_failed'] });
    } else {
      blockedUI(data);
    }
  }

  // ---------- Helpers ----------
  function showTerminal(outcome, handle, risk, data) {
    document.querySelectorAll('section[data-step]').forEach(s => { s.hidden = true; });
    document.querySelectorAll('button, [data-item-id]').forEach(el => {
      el.style.pointerEvents = 'none'; el.style.opacity = '0.5';
    });
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
      <h2 class="text-xl font-semibold ${isBlock ? 'text-red-700' : 'text-green-700'}">${isBlock ? 'Blocked' : 'Order placed'}</h2>
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
  async function postJSON(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, reason: 'network_error' };
    }
  }
})();
