'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let sessionId, token, endsAt, minIncrement;
let pollInterval, timerInterval;
let closed = false;
let lastPollAt = null;

// Telemetry + fingerprint live in window.AGDetect (loaded by index.html
// from /shared/detect-core.js). buildTelemetry() preserves existing call
// sites while delegating to the shared collector.
const tel = window.AGDetect.startTelemetry();
function buildTelemetry(extra = {}) {
  return { ...tel.snapshot(), ...extra };
}

// ── Timer ──────────────────────────────────────────────────────────────────

function updateTimer() {
  const ms  = Math.max(0, endsAt - Date.now());
  const sec = Math.floor(ms / 1000);
  const m   = Math.floor(sec / 60);
  const s   = sec % 60;
  const el  = document.getElementById('timer');
  el.textContent = `${m}:${String(s).padStart(2,'0')}`;

  if (ms < 15000) {
    el.classList.add('text-red-500');
    el.classList.remove('text-orange-500');
  }

  if (ms <= 0 && !closed) {
    closed = true;
    clearInterval(pollInterval);
    clearInterval(timerInterval);
    closeAuction();
  }
}

// ── Status polling ─────────────────────────────────────────────────────────

async function pollStatus() {
  if (closed) return;
  try {
    const res  = await fetch(`/api/auction/status?sessionId=${sessionId}&token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!data.ok) return;
    lastPollAt = Date.now();
    renderStatus(data);
  } catch(_) {}
}

function renderStatus(data) {
  document.getElementById('current-bid').textContent = `$${data.currentBid}`;

  const isYou     = data.currentBidder === 'you';
  const isNone    = data.currentBidder === 'none';
  const bidderEl  = document.getElementById('current-bidder');
  const badgeEl   = document.getElementById('bid-status').querySelector ? document.getElementById('status-badge') : null;

  bidderEl.textContent = isNone ? '' : `by ${data.currentBidder}`;

  if (badgeEl) {
    if (isNone) {
      badgeEl.textContent = 'No bids yet';
      badgeEl.className = 'text-xs font-semibold px-3 py-1 rounded-full bg-gray-100 text-gray-400';
    } else if (isYou) {
      badgeEl.textContent = "You're winning!";
      badgeEl.className = 'text-xs font-semibold px-3 py-1 rounded-full bg-green-100 text-green-700';
    } else {
      badgeEl.textContent = "You've been outbid";
      badgeEl.className = 'text-xs font-semibold px-3 py-1 rounded-full bg-red-100 text-red-600';
    }
  }

  // Bid feed
  const feed = document.getElementById('bid-feed');
  feed.innerHTML = '';
  if (data.recentBids && data.recentBids.length) {
    [...data.recentBids].reverse().forEach(b => {
      const row = document.createElement('div');
      const isYouBid = b.bidder === 'you';
      row.className = `text-xs flex justify-between px-3 py-1.5 rounded-lg ${isYouBid ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-500'}`;
      row.innerHTML = `<span class="font-medium">${b.bidder === 'you' ? 'You' : 'Competitor'}</span><span class="font-mono font-semibold">$${b.amount}</span>`;
      feed.appendChild(row);
    });
  } else {
    feed.innerHTML = '<div class="text-xs text-gray-400 italic px-1">No bids placed yet</div>';
  }

  // Update quick-bid buttons with varied increments over new minimum
  updateQuickBids(data.minNextBid);
}

function updateQuickBids(minNextBid) {
  const container = document.getElementById('quick-bids');
  const increments = [0, minIncrement, minIncrement * 3]; // varied: exact min, +1 step, +3 steps
  container.innerHTML = '';
  increments.forEach(extra => {
    const amount = minNextBid + extra;
    const btn = document.createElement('button');
    btn.textContent = `$${amount}`;
    btn.className = 'flex-1 py-2 rounded-xl border border-orange-300 text-orange-700 text-sm font-semibold hover:bg-orange-50 transition-colors';
    btn.onclick = () => placeBid(amount);
    container.appendChild(btn);
  });
  // Keep custom amount input in sync
  document.getElementById('custom-amount').min = minNextBid;
  document.getElementById('custom-amount').placeholder = `Min $${minNextBid}`;
}

// ── Place bid ──────────────────────────────────────────────────────────────

async function placeBid(amount) {
  if (closed || !amount || isNaN(amount)) return;

  hideBidMsg();
  const btn = document.getElementById('custom-btn');
  btn.disabled = true;

  try {
    const res  = await fetch('/api/auction/bid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ sessionId, token, amount, telemetry: buildTelemetry() }),
    });
    const data = await res.json();

    if (data.action === 'block') {
      showFinalResult(data);
      return;
    }
    if (!data.ok) {
      showBidMsg(data.reason === 'bid_too_low'
        ? `Bid too low — minimum is $${data.minNextBid}`
        : (data.reason || 'Bid rejected'));
      return;
    }

    lastPollAt = Date.now();
    renderStatus({
      currentBid:    data.currentBid,
      currentBidder: data.currentBidder,
      recentBids:    [],
      minNextBid:    data.minNextBid,
    });
    // Refresh full status immediately after bid
    await pollStatus();
  } catch(e) {
    showBidMsg('Network error — try again');
  } finally {
    btn.disabled = false;
  }
}

function showBidMsg(msg) {
  const el = document.getElementById('bid-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideBidMsg() {
  document.getElementById('bid-msg').classList.add('hidden');
}

// ── Close auction ──────────────────────────────────────────────────────────

async function closeAuction() {
  document.getElementById('bid-controls').innerHTML =
    '<p class="text-sm text-gray-400 text-center py-2">Auction ended — calculating result…</p>';

  try {
    const res  = await fetch('/api/auction/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ sessionId, token, telemetry: buildTelemetry() }),
    });
    const data = await res.json();
    showFinalResult(data);
  } catch(e) {
    document.getElementById('bid-controls').innerHTML =
      '<p class="text-sm text-red-500 text-center">Error closing auction.</p>';
  }
}

// ── Result display ─────────────────────────────────────────────────────────

function showFinalResult(data) {
  document.getElementById('auction').classList.add('hidden');
  const el = document.getElementById('result');
  el.classList.remove('hidden');

  const won = data.ok && data.result === 'won';
  const outbid = data.result === 'outbid';

  document.getElementById('result-icon').textContent  = won ? '🏆' : (outbid ? '😔' : '🔒');
  document.getElementById('result-title').textContent =
    won ? 'You won!' : (outbid ? 'Outbid' : (data.result === 'reserve_not_met' ? 'Reserve not met' : 'Blocked'));
  document.getElementById('result-subtitle').textContent =
    won ? `Winning bid: $${data.winningBid} — ${data.item}`
        : (data.action === 'block' ? 'Bot signals detected' : 'Better luck next time');

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
  if (data.confirmationId) {
    const row = document.getElementById('res-conf-row');
    row.classList.remove('hidden'); row.classList.add('flex');
    document.getElementById('res-conf').textContent = data.confirmationId;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Start session
    const sessRes = await fetch('/api/auction/session', {
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
    endsAt       = sess.endsAt;
    minIncrement = sess.minIncrement;

    // 2. Render item
    document.getElementById('item-name').textContent     = sess.item.name;
    document.getElementById('item-category').textContent = sess.item.category;
    document.getElementById('item-desc').textContent     = sess.item.desc;

    // 3. Fingerprint
    const fp = await window.AGDetect.collectFingerprint();
    await fetch('/api/auction/fingerprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ sessionId, token, fingerprint: fp }),
    });

    // 4. Initial status + show UI
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('auction').classList.remove('hidden');
    updateQuickBids(sess.currentBid + minIncrement);
    await pollStatus();

    // 5. Start intervals
    timerInterval = setInterval(updateTimer, 500);
    pollInterval  = setInterval(pollStatus, 3500);

  } catch(err) {
    document.getElementById('loading').textContent = `Error: ${err.message}`;
  }
}

init();
