// V2 client: 3-step checkout with vision-agent-targeted challenges.
// Each step is rendered from server-supplied config; the server holds
// the source of truth for which item / shipping / button is "correct".

(async function () {
  // ---------- Telemetry + fingerprint ----------
  // Both now live in window.AGDetect (loaded from /shared/detect-core.js
  // by v2.html). We start a per-page telemetry collector and call
  // .snapshot() at each step boundary to flush counters and produce the
  // payload the server's accumulateTelemetry() expects.
  const tel = window.AGDetect.startTelemetry();

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
            telemetry: tel.snapshot(),
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
  const _qp  = new URLSearchParams(location.search);
  const _sid = _qp.get('sid');
  const _tok = _qp.get('tok');
  try {
    let res;
    if (_sid && _tok) {
      // CV agent pre-created the session; resume it instead of creating a new one
      res = await fetch('/api/v2/session/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: _sid, token: _tok }),
      });
    } else {
      res = await fetch('/api/v2/session', { method: 'POST' });
    }
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
  // Skipped when resuming a CV-agent session (fingerprint already submitted via API)
  if (session.requireFingerprint !== false) {
    setStatus('Verifying environment…');
    const fp = await window.AGDetect.collectFingerprint();
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
      telemetry: tel.snapshot(),
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
      telemetry: tel.snapshot(),
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
      telemetry: tel.snapshot(),
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
      telemetry: tel.snapshot(),
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
