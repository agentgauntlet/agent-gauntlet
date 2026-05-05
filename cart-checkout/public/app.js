// Cart-checkout client: renders the cart UI, wires every challenge widget,
// collects behavioral telemetry, and submits everything to /api/checkout
// for server-side scoring.

(async function () {
  // ---------- Static cart data ----------
  const items = [
    { name: 'Wireless Headphones', qty: 1, price: 89.99, emoji: '🎧' },
    { name: 'USB-C Cable (3-pack)', qty: 2, price: 12.50, emoji: '🔌' },
    { name: 'Mechanical Keyboard', qty: 1, price: 129.00, emoji: '⌨️' },
  ];
  const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
  const shipping = 7.99;
  const tax = +(subtotal * 0.0875).toFixed(2);
  const total = +(subtotal + shipping + tax).toFixed(2);

  // ---------- Render cart items with canvas prices ----------
  const ul = document.getElementById('cart-items');
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'py-3 flex items-center justify-between';
    li.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-2xl">${it.emoji}</div>
        <div>
          <div class="font-medium">${it.name}</div>
          <div class="text-xs text-gray-500">Qty ${it.qty}</div>
        </div>
      </div>
      <canvas data-item-price width="80" height="20"></canvas>
    `;
    ul.appendChild(li);
    drawPrice(li.querySelector('canvas'), `$${(it.qty * it.price).toFixed(2)}`);
  }

  drawPrice(document.querySelector('[data-line=subtotal]'), `$${subtotal.toFixed(2)}`);
  drawPrice(document.querySelector('[data-line=shipping]'), `$${shipping.toFixed(2)}`);
  drawPrice(document.querySelector('[data-line=tax]'), `$${tax.toFixed(2)}`);
  drawPrice(document.querySelector('[data-line=total]'), `$${total.toFixed(2)}`, true);

  function drawPrice(c, text, big = false) {
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#111827';
    ctx.font = `${big ? '600 14px' : '13px'} system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.save();
    // Tiny jitter — defeats trivial template-OCR matching.
    ctx.translate(c.width - 2, c.height / 2 + (Math.random() - 0.5));
    ctx.rotate((Math.random() - 0.5) * 0.03);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // ---------- Get challenge config from server ----------
  let session;
  try {
    const res = await fetch('/api/session', { method: 'POST' });
    session = await res.json();
  } catch (e) {
    setStatus('Failed to start session.', 'text-red-700');
    return;
  }

  // ---------- Visual challenge ----------
  const visualMap = { apple: '🍎', banana: '🍌', orange: '🍊', grape: '🍇' };
  document.getElementById('visual-prompt').textContent = session.requiredVisual;
  const grid = document.getElementById('visual-grid');
  let visualSelected = null;
  const order = Object.keys(visualMap).sort(() => Math.random() - 0.5);
  for (const key of order) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className =
      'aspect-square text-2xl bg-white border border-amber-200 rounded-lg hover:bg-amber-100 flex items-center justify-center';
    cell.textContent = visualMap[key];
    cell.dataset.fruit = key;
    cell.addEventListener('click', () => {
      visualSelected = key;
      [...grid.children].forEach(c => c.classList.remove('ring-2', 'ring-indigo-500'));
      cell.classList.add('ring-2', 'ring-indigo-500');
    });
    grid.appendChild(cell);
  }

  // ---------- Slide-to-confirm ----------
  const track = document.getElementById('slide-track');
  const handle = document.getElementById('slide-handle');
  const fill = document.getElementById('slide-fill');
  let dragging = false;
  let pointerStartX = 0;
  let handleStartLeft = 0;
  let slideCompleted = false;
  let maxSlidePctSeen = 0;

  function trackGeometry() {
    const rect = track.getBoundingClientRect();
    const handleW = handle.offsetWidth;
    const minLeft = 4;
    const maxLeft = rect.width - handleW - 4;
    return { minLeft, maxLeft };
  }

  handle.addEventListener('pointerdown', (e) => {
    if (slideCompleted) return;
    dragging = true;
    pointerStartX = e.clientX;
    handleStartLeft = handle.offsetLeft;
    handle.style.cursor = 'grabbing';
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const { minLeft, maxLeft } = trackGeometry();
    let newLeft = handleStartLeft + (e.clientX - pointerStartX);
    newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
    handle.style.left = newLeft + 'px';
    fill.style.width = (newLeft + handle.offsetWidth) + 'px';
    const pct = ((newLeft - minLeft) / (maxLeft - minLeft)) * 100;
    maxSlidePctSeen = Math.max(maxSlidePctSeen, pct);
    if (pct >= session.minSlidePercent && !slideCompleted) {
      slideCompleted = true;
      handle.style.background = '#16a34a';
      handle.textContent = '✓';
    }
  });
  handle.addEventListener('pointerup', () => {
    dragging = false;
    handle.style.cursor = slideCompleted ? 'default' : 'grab';
    if (!slideCompleted) {
      // snap back
      handle.style.left = '4px';
      fill.style.width = '4px';
    }
  });

  // ---------- Checkout buttons (real + decoys) ----------
  const cb = document.getElementById('checkout-buttons');
  const realId = session.realButtonId;
  const decoyIds = session.decoyButtonIds || [];
  const allIds = [realId, ...decoyIds].sort(() => Math.random() - 0.5);

  for (const bid of allIds) {
    const isReal = bid === realId;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.btnId = bid;
    // Real button: solid indigo with a subtle ✓ glyph humans can perceive.
    // Decoys: same label, lighter shade — looks plausible but is a trap.
    b.className =
      'w-full py-3 rounded-lg font-medium transition ' +
      (isReal
        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
        : 'bg-indigo-200 text-indigo-900 hover:bg-indigo-300');
    if (isReal) {
      b.innerHTML = '<span class="mr-1">✓</span>Place Order';
    } else {
      b.textContent = 'Place Order';
    }
    b.addEventListener('click', () => submitCheckout(bid));
    cb.appendChild(b);
  }

  // ---------- Behavioral telemetry ----------
  const telemetry = {
    mouseMoves: 0,
    mousePoints: [],
    keystrokeCount: 0,
    scrollEvents: 0,
    focusBlurEvents: 0,
  };
  document.addEventListener('mousemove', (e) => {
    telemetry.mouseMoves++;
    if (telemetry.mousePoints.length < 600) {
      telemetry.mousePoints.push([e.clientX, e.clientY]);
    }
  });
  document.addEventListener('keydown', () => { telemetry.keystrokeCount++; });
  window.addEventListener('scroll', () => { telemetry.scrollEvents++; }, { passive: true });
  document.addEventListener('focusin', () => { telemetry.focusBlurEvents++; });
  document.addEventListener('focusout', () => { telemetry.focusBlurEvents++; });

  function computeMouseEntropy(points) {
    if (points.length < 3) return 0;
    // Shannon entropy of segment-angle histogram across 16 bins.
    const bins = new Array(16).fill(0);
    let n = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      if (dx === 0 && dy === 0) continue;
      const a = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI); // 0..1
      const idx = Math.min(15, Math.floor(a * 16));
      bins[idx]++;
      n++;
    }
    if (n === 0) return 0;
    let h = 0;
    for (const c of bins) {
      if (c === 0) continue;
      const p = c / n;
      h -= p * Math.log2(p);
    }
    return h; // 0..4
  }

  // ---------- Submit ----------
  async function submitCheckout(clickedButtonId) {
    setStatus('Verifying…');
    const payload = {
      sessionId: session.sessionId,
      token: session.token,
      telemetry: {
        mouseMoves: telemetry.mouseMoves,
        mouseEntropy: +computeMouseEntropy(telemetry.mousePoints).toFixed(3),
        keystrokeCount: telemetry.keystrokeCount,
        scrollEvents: telemetry.scrollEvents,
        focusBlurEvents: telemetry.focusBlurEvents,
      },
      challenges: {
        clickedButtonId,
        slideCompleted,
        maxSlidePercent: +maxSlidePctSeen.toFixed(1),
        visualSelected,
        couponEntered: !!document.getElementById('coupon').value.trim(),
        honeypotEmail: !!document.getElementById('hp-email').value,
        honeypotPromo: !!document.getElementById('hp-promo').value,
        robotCheckbox: document.getElementById('robot-cb').checked,
      },
    };
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        setStatus(`✅ Order placed. Confirmation: ${data.orderId}`, 'text-green-700');
      } else if (data.blocked) {
        setStatus(`🚫 Blocked. Signals: ${data.reasons.join(', ')}`, 'text-red-700');
      } else {
        setStatus(`🚫 Rejected: ${data.reason || 'unknown'}`, 'text-red-700');
      }
    } catch (e) {
      setStatus('Network error.', 'text-red-700');
    }
  }

  function setStatus(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'mt-4 text-sm text-center ' + (cls || 'text-gray-500');
  }

  setStatus('Ready.');
})();
