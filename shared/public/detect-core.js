// Browser-side signal collection — the single source of truth used by every
// scenario page in this repo and (via the detect.js bundle in the private
// repo) by enterprise customers embedding our SDK on their own sites.
//
// Load as a classic script:  <script src="/shared/detect-core.js"></script>
// Public API attached at:    window.AGDetect = { collectFingerprint,
//                                                startTelemetry, /* helpers */ }
//
// Classic-script (not ES module) on purpose — the existing build pipeline
// (terser + javascript-obfuscator) is brittle around import/export and the
// scenario clients are open-source anyway, so module syntax buys us little.
// The Phase 2b enterprise wrapper bundles detect-core's source directly
// into its own minified+obfuscated output, so the wrapper doesn't depend
// on the global either.
//
// API surface
// ───────────
//   AGDetect.collectFingerprint()       → Promise<FingerprintObject>
//   AGDetect.startTelemetry({ opts })    → { snapshot(), detach() }
//   AGDetect.meanStd, .median,
//            .entropy, .velocityStats   pure helpers exposed for tests
//
// This module is intentionally transport-free: collectFingerprint() returns
// a plain object, telemetry.snapshot() returns a plain object. Callers
// decide what to do with them — scenario clients POST the result to
// /api/{scenario}/fingerprint; the enterprise wrapper HMAC-signs and sends
// to /api/detect/score. detect-core itself never speaks the network.
//
// All signal field names match what shared/risk.js's scoreFingerprint() and
// the per-scenario telemetry scorers expect, so this module is a drop-in
// replacement for the inline implementations that previously lived inside
// each scenario's app.js / v2.js.

(function () {
  'use strict';

// ===================================================================
// Internal helpers
// ===================================================================

async function sha256Hex(s) {
  try {
    const buf = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
  } catch (_e) {
    return null;
  }
}

// ===================================================================
// Pure statistical helpers — exported for reuse
// ===================================================================

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

// Angular entropy of a mouse-point path. Real cursors have varied direction
// vectors (high entropy ≈ 3–4); synthesised straight-line paths collapse
// onto one bin (low entropy ≈ 0–1).
function entropy(points) {
  if (!points || points.length < 3) return 0;
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

// Velocity (px/ms) mean + std + cumulative angular curvature over a
// mouse-point trail. Uniform velocity and zero curvature both indicate
// scripted motion.
function velocityStats(points) {
  if (!points || points.length < 3) return { mean: 0, std: 0, curvature: 0 };
  const v = [];
  let curvSum = 0;
  let lastAngle = null;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1, t1] = points[i - 1];
    const [x2, y2, t2] = points[i];
    const dt = Math.max(1, t2 - t1);
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    v.push(dist / dt);
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

// ===================================================================
// Fingerprint
// ===================================================================
//
// Returns a Promise<Fingerprint>. Each section is best-effort wrapped in
// try/catch — a single failing API (e.g. canvas blocked by extension) only
// removes that field, never throws. Server-side scoreFingerprint() handles
// missing fields by emitting the corresponding "missing" signal.
//
// Fields produced (used by shared/scenario.js → scoreFingerprint):
//   webdriver, notifMismatch, screen{width,height,...}, webglRenderer,
//   webglMissing, userAgent, pluginsLength, chrome, canvasHash, audioHash,
//   rafFrame.
// Plus contextual fields (languages, platform, hardwareConcurrency,
// deviceMemory, devicePixelRatio, windowInner, tz, tzOffset) for visitor
// identity hashing.

async function collectFingerprint() {
  const fp = {};

  // ----- Canvas hash -----
  // Distinct GPUs and OS font renderers produce different pixel output for
  // the same drawing instructions. SHA-256 over the dataURL gives a stable
  // per-environment hash.
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
    fp.canvasLen  = url.length;
  } catch (e) {
    fp.canvasError = String(e);
  }

  // ----- WebGL renderer / vendor -----
  // Headless and VM environments expose distinctive renderer strings
  // (SwiftShader, Mesa Off-Screen, llvmpipe, ANGLE SwiftShader).
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        fp.webglVendor   = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        fp.webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      }
      fp.webglVersion = gl.getParameter(gl.VERSION);
    } else {
      fp.webglMissing = true;
    }
  } catch (e) {
    fp.webglError = String(e);
  }

  // ----- Audio hash via OfflineAudioContext -----
  // Subtle DSP differences across browser/OS audio stacks give a stable
  // hash. The DynamicsCompressor amplifies cross-implementation differences.
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (Ctx) {
      const ctx = new Ctx(1, 5000, 44100);
      const osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = 1000;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50;
      comp.knee.value      = 40;
      comp.ratio.value     = 12;
      comp.attack.value    = 0;
      comp.release.value   = 0.2;
      osc.connect(comp); comp.connect(ctx.destination);
      osc.start(0);
      const buf = await ctx.startRendering();
      const ch = buf.getChannelData(0);
      let sum = 0;
      for (let i = 4500; i < 5000; i++) sum += Math.abs(ch[i]);
      fp.audioHash = sum.toFixed(8);
    }
  } catch (e) {
    fp.audioError = String(e);
  }

  // ----- Navigator + window + screen -----
  fp.userAgent           = navigator.userAgent;
  fp.languages           = Array.isArray(navigator.languages)
    ? navigator.languages.slice(0, 5)
    : null;
  fp.platform            = navigator.platform;
  fp.hardwareConcurrency = navigator.hardwareConcurrency || null;
  fp.deviceMemory        = navigator.deviceMemory || null;
  fp.webdriver           = navigator.webdriver === true;
  fp.pluginsLength       = navigator.plugins ? navigator.plugins.length : 0;
  fp.chrome              = !!window.chrome;
  fp.chromeRuntime       = !!(window.chrome && window.chrome.runtime);
  fp.screen = {
    width:        screen.width,
    height:       screen.height,
    availWidth:   screen.availWidth,
    availHeight:  screen.availHeight,
    colorDepth:   screen.colorDepth,
  };
  fp.devicePixelRatio = window.devicePixelRatio;
  fp.windowInner      = { width: window.innerWidth, height: window.innerHeight };

  // ----- Timezone -----
  try {
    fp.tzOffset = new Date().getTimezoneOffset();
    fp.tz       = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (_e) {}

  // ----- Notification API mismatch -----
  // Real Chrome: Notification.permission and permissions.query({name:'notifications'})
  // agree. Headless Chrome ships with Notification.permission === 'denied'
  // while permissions.query returns 'prompt' — a contradiction no real
  // browser produces.
  try {
    if (navigator.permissions && navigator.permissions.query &&
        typeof Notification !== 'undefined') {
      const notif        = await navigator.permissions.query({ name: 'notifications' });
      fp.notifPerm       = notif.state;
      fp.notifAPI        = Notification.permission;
      fp.notifMismatch   = (fp.notifAPI === 'denied' && fp.notifPerm === 'prompt');
    }
  } catch (_e) {}

  // ----- requestAnimationFrame timing -----
  // Headless environments often fire rAF immediately (~0ms) rather than at
  // the next display refresh (~16ms on a 60Hz display).
  fp.rafFrame = await new Promise(resolve => {
    const t0 = performance.now();
    requestAnimationFrame(() => resolve(+(performance.now() - t0).toFixed(2)));
  });

  return fp;
}

// ===================================================================
// Behavioral telemetry collector
// ===================================================================
//
// Attaches passive listeners to document + window and accumulates counts +
// sample buffers. Call .snapshot() to compute derived signals and reset
// the accumulators for the next interval. Call .detach() when done (e.g.
// on page unload) to remove all listeners.
//
// Snapshot fields match what shared/scenario.js's telemetry scorers expect:
//   mouseMoves, mouseEntropy, keystrokeCount, scrollEvents, focusBlurEvents,
//   mouseVelocityMean, mouseVelocityStd, mouseCurvature,
//   clickDwellMedian, clickDwellStd, clickCount,
//   scrollDeltaStd, scrollDeltaUniform,
//   keystrokeIntervalStd, visibilityChanges, firstEventLatencyMs.
//
// Caps to keep memory bounded over long-lived sessions:
//   maxMousePoints     (default 800)  — most-recent mouse trail
//   maxKeystrokeTimes  (default 200)  — most-recent keystroke timestamps

const DEFAULT_MAX_MOUSE_POINTS    = 800;
const DEFAULT_MAX_KEYSTROKE_TIMES = 200;

function startTelemetry(opts = {}) {
  const maxMouse = opts.maxMousePoints    || DEFAULT_MAX_MOUSE_POINTS;
  const maxKeys  = opts.maxKeystrokeTimes || DEFAULT_MAX_KEYSTROKE_TIMES;

  let mouseMoves          = 0;
  let mousePoints         = [];
  let keystrokeCount      = 0;
  let keystrokeTimes      = [];
  let scrollEvents        = 0;
  let scrollDeltas        = [];
  let focusBlurEvents     = 0;
  let clickDwells         = [];
  let visibilityChanges   = 0;
  let intervalStartedAt   = performance.now();
  let firstEventLatencyMs = null;
  let downAt              = null;

  function noteFirstEvent() {
    if (firstEventLatencyMs === null) {
      firstEventLatencyMs = +(performance.now() - intervalStartedAt).toFixed(1);
    }
  }

  function onMouseMove(e) {
    mouseMoves++;
    if (mousePoints.length < maxMouse) {
      mousePoints.push([e.clientX, e.clientY, performance.now()]);
    }
    noteFirstEvent();
  }
  function onMouseDown() {
    downAt = performance.now();
    noteFirstEvent();
  }
  function onMouseUp() {
    if (downAt !== null) {
      clickDwells.push(+(performance.now() - downAt).toFixed(1));
      downAt = null;
    }
  }
  function onKeyDown() {
    keystrokeCount++;
    if (keystrokeTimes.length < maxKeys) keystrokeTimes.push(performance.now());
    noteFirstEvent();
  }
  function onScroll()    { scrollEvents++; noteFirstEvent(); }
  function onWheel(e)    { scrollDeltas.push(+e.deltaY.toFixed(3)); }
  function onFocusIn()   { focusBlurEvents++; }
  function onFocusOut()  { focusBlurEvents++; }
  function onVisibility(){ visibilityChanges++; }

  document.addEventListener('mousemove',  onMouseMove,  { passive: true });
  document.addEventListener('mousedown',  onMouseDown,  { passive: true });
  document.addEventListener('mouseup',    onMouseUp,    { passive: true });
  document.addEventListener('keydown',    onKeyDown,    { passive: true });
  window  .addEventListener('scroll',     onScroll,     { passive: true });
  window  .addEventListener('wheel',      onWheel,      { passive: true });
  document.addEventListener('focusin',    onFocusIn,    { passive: true });
  document.addEventListener('focusout',   onFocusOut,   { passive: true });
  document.addEventListener('visibilitychange', onVisibility, { passive: true });

  function snapshot() {
    const vel  = velocityStats(mousePoints);
    const dwell = meanStd(clickDwells);
    const sds  = meanStd(scrollDeltas);
    // Synthetic scrolls usually emit identical integer deltas every step.
    const scrollDeltaUniform = scrollDeltas.length > 1
      ? scrollDeltas.every(d => Number.isInteger(d)) && new Set(scrollDeltas).size <= 2
      : false;
    // Std-dev of inter-keystroke intervals — humans vary, bots type at a
    // constant rate.
    const ksIntervals = [];
    for (let i = 1; i < keystrokeTimes.length; i++) {
      ksIntervals.push(keystrokeTimes[i] - keystrokeTimes[i - 1]);
    }
    const ksStats = meanStd(ksIntervals);

    const snap = {
      mouseMoves,
      mouseEntropy:         +entropy(mousePoints).toFixed(3),
      keystrokeCount,
      scrollEvents,
      focusBlurEvents,
      mouseVelocityMean:    vel.mean,
      mouseVelocityStd:     vel.std,
      mouseCurvature:       vel.curvature,
      clickDwellMedian:     +median(clickDwells).toFixed(1),
      clickDwellStd:        dwell.std,
      clickCount:           clickDwells.length,
      scrollDeltaStd:       sds.std,
      scrollDeltaUniform,
      keystrokeIntervalStd: ksStats.std,
      visibilityChanges,
      firstEventLatencyMs,
    };

    // Reset accumulators for the next interval.
    mouseMoves        = 0;
    mousePoints       = [];
    keystrokeCount    = 0;
    keystrokeTimes    = [];
    scrollEvents      = 0;
    scrollDeltas      = [];
    focusBlurEvents   = 0;
    clickDwells       = [];
    visibilityChanges = 0;
    firstEventLatencyMs = null;
    intervalStartedAt = performance.now();

    return snap;
  }

  function detach() {
    document.removeEventListener('mousemove',  onMouseMove);
    document.removeEventListener('mousedown',  onMouseDown);
    document.removeEventListener('mouseup',    onMouseUp);
    document.removeEventListener('keydown',    onKeyDown);
    window  .removeEventListener('scroll',     onScroll);
    window  .removeEventListener('wheel',      onWheel);
    document.removeEventListener('focusin',    onFocusIn);
    document.removeEventListener('focusout',   onFocusOut);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  return { snapshot, detach };
}

// ===================================================================
// Register on the global
// ===================================================================
//
// AGDetect = AgentGauntlet Detect. Scenarios reference window.AGDetect.*
// from their classic-script app.js / v2.js files. The Phase 2b enterprise
// wrapper bundles this module's source directly and consumes the functions
// inside its own closure — it does not read window.AGDetect.

window.AGDetect = {
  collectFingerprint,
  startTelemetry,
  // Pure helpers — exposed so tests and advanced consumers can compute
  // derived signals from raw arrays without going through the collector.
  meanStd,
  median,
  entropy,
  velocityStats,
};

})();
