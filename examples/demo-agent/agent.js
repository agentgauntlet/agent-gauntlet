#!/usr/bin/env node
/**
 * AgentGauntlet demo agent — cart-checkout scenario
 *
 * Supports two modes:
 *   cv       (default) — agent screenshots the page and uses Claude vision to
 *                        extract item/price information. No structured data from API.
 *   headless           — agent receives structured JSON from the API and resolves
 *                        answers without needing to read the page visually.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY       your Anthropic API key
 *
 * Optional env vars:
 *   AGENT_MODE              "cv" (default) or "headless"
 *   AGENTGAUNTLET_API_KEY   free key from agentgauntlet.ai/keys.html (unlocks leaderboard)
 *   AGENTGAUNTLET_BASE_URL  override base URL (default: https://agentgauntlet.ai)
 *   HEADLESS                set to "false" to watch the browser (default: true)
 */

const Anthropic    = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');

const BASE_URL   = process.env.AGENTGAUNTLET_BASE_URL || 'https://agentgauntlet.ai';
const API_KEY    = process.env.AGENTGAUNTLET_API_KEY  || null;
const HEADLESS   = process.env.HEADLESS !== 'false';
const AGENT_MODE = process.env.AGENT_MODE === 'headless' ? 'headless' : 'cv';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- API helpers -----------------------------------------------------------

async function apiPost(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;
  if (token)   headers['X-Session-Token'] = token;
  const res  = await fetch(`${BASE_URL}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`API ${path} → ${res.status} (non-JSON):\n${text.slice(0, 300)}`); }
  if (!res.ok && !json.ok && json.action !== 'block' && json.action !== 'step_up') {
    throw new Error(`API ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function printResult(risk, outcome, mode) {
  console.log('\n─────────────────────────────────');
  console.log(`RESULT  [mode: ${mode}]`);
  console.log('─────────────────────────────────');
  console.log(`Outcome:    ${outcome || (risk && risk.action) || 'unknown'}`);
  if (risk) {
    console.log(`Risk score: ${risk.score}/100`);
    console.log(`Tier:       ${risk.tier}`);
    console.log(`Action:     ${risk.action}`);
    if (risk.signals && risk.signals.length)
      console.log(`Signals:    ${risk.signals.join(', ')}`);
    if (risk.breakdown && risk.breakdown.length) {
      console.log('\nBreakdown:');
      risk.breakdown.forEach(d => console.log(`  ${d.dimension}: ${d.score}`));
    }
  }
  console.log('─────────────────────────────────\n');
}

// --- Claude vision helper --------------------------------------------------

async function askClaude(screenshotBuf, task) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: 'You are a web agent. Look at the screenshot and answer the question with the minimum text required — no explanation.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBuf.toString('base64') } },
        { type: 'text', text: task },
      ],
    }],
  });
  return msg.content[0].text.trim();
}

// --- Telemetry stub (honest — no mouse data) --------------------------------

function telemetry() {
  return { mouseEvents: [], keyEvents: [], scrollEvents: [], dwellMs: Math.floor(800 + Math.random() * 1200) };
}

// --- Fingerprint — computed from real browser context ----------------------

// --- Fingerprint — computed from real browser context ----------------------

async function computeFingerprint(page) {
  return page.evaluate(async () => {
    // Canvas fingerprint
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

    // Audio fingerprint — use OfflineAudioContext which works in headless
    let audioHash = null;
    try {
      const offline = new OfflineAudioContext(1, 4096, 44100);
      const osc     = offline.createOscillator();
      const comp    = offline.createDynamicsCompressor();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      osc.connect(comp);
      comp.connect(offline.destination);
      osc.start(0);
      const rendered = await offline.startRendering();
      const buf = rendered.getChannelData(0);
      let ah = 0;
      for (let i = 0; i < Math.min(buf.length, 500); i++) {
        ah = Math.imul(31, ah) + Math.round(buf[i] * 1e8) | 0;
      }
      audioHash = (ah >>> 0).toString(16).padStart(8, '0');
    } catch (_) {}

    return {
      canvasHash,
      audioHash,
      webdriver:  navigator.webdriver,
      userAgent:  navigator.userAgent,
      screen:     { width: screen.width, height: screen.height },
      tz:         Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });
}

async function submitFingerprint(sessionId, token, page) {
  const fingerprint = await computeFingerprint(page);
  console.log(`Fingerprint: canvas=${fingerprint.canvasHash} audio=${fingerprint.audioHash || 'null'} webdriver=${fingerprint.webdriver}`);
  return apiPost('/api/v2/fingerprint', { sessionId, token, fingerprint }, token);
}

// ===========================================================================
// CV MODE — agent reads the page visually, submits answers by name
// ===========================================================================

async function runCv() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [CV mode]\n`);

  // 1. Start CV session — server returns tasks + scenarioUrl, no item data
  const session = await apiPost('/api/v2/session', { mode: 'cv' }, null);
  const { sessionId, token, tasks, scenarioUrl } = session;
  console.log(`Session: ${sessionId}`);
  console.log(`Scenario URL: ${scenarioUrl}\n`);

  // 2. Launch browser — add webdriver override before first navigation
  const browser = await chromium.launch({ headless: HEADLESS });
  const page    = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.goto(scenarioUrl, { waitUntil: 'networkidle' });
  console.log('Browser opened:', scenarioUrl);

  // 3. Compute and submit fingerprint from the real browser context
  const fpResult = await submitFingerprint(sessionId, token, page);
  if (fpResult.action === 'block') {
    await browser.close();
    console.log('Blocked at fingerprint stage.');
    printResult(fpResult.risk, 'blocked', 'cv');
    return;
  }

  // --- Step 1: identify item visually --------------------------------------
  const shot1 = await page.screenshot({ fullPage: true });
  console.log(`\nStep 1 task: ${tasks.step1}`);

  const itemAnswer = await askClaude(shot1,
    `${tasks.step1}\nLook at the cart items shown on the page. Reply with ONLY the exact product name of the matching item.`
  );
  console.log(`Claude identified: "${itemAnswer}"`);

  const step1Result = await apiPost('/api/v2/step', {
    sessionId, token, step: 1,
    answer: { cvItemName: itemAnswer },
    telemetry: telemetry(),
  }, token);
  if (step1Result.action === 'block') {
    await browser.close();
    printResult(step1Result.risk, 'blocked at step 1', 'cv');
    return;
  }
  console.log(`Step 2 task: ${step1Result.task}`);

  // --- Step 2: identify shipping visually ----------------------------------
  const shot2 = await page.screenshot({ fullPage: true });

  const shippingAnswer = await askClaude(shot2,
    `${step1Result.task}\nLook at the shipping options shown on the page. Reply with ONLY the exact name of the matching shipping option (e.g. "Standard", "Express", "Overnight").`
  );
  console.log(`Claude identified: "${shippingAnswer}"`);

  const step2Result = await apiPost('/api/v2/step', {
    sessionId, token, step: 2,
    answer: { cvShippingName: shippingAnswer },
    telemetry: telemetry(),
  }, token);
  if (step2Result.action === 'block') {
    await browser.close();
    printResult(step2Result.risk, 'blocked at step 2', 'cv');
    return;
  }
  console.log(`Step 3 task: ${step2Result.task}`);

  // --- Step 3: identify non-recommended button visually --------------------
  const shot3 = await page.screenshot({ fullPage: true });

  const btnAnswer = await askClaude(shot3,
    `${step2Result.task}\nLook at the checkout buttons on the page. Is there a button NOT marked as "Recommended"? Reply with ONLY "yes" or "no".`
  );
  const clickedNonRecommended = btnAnswer.toLowerCase().startsWith('yes');
  console.log(`Claude identified non-recommended button: ${clickedNonRecommended}`);

  const checkoutResult = await apiPost('/api/v2/checkout', {
    sessionId, token,
    cvClickedNonRecommended: clickedNonRecommended,
    telemetry: telemetry(),
  }, token);

  await browser.close();
  printResult(checkoutResult.risk, checkoutResult.outcome || 'completed', 'cv');
}

// ===========================================================================
// HEADLESS MODE — agent receives structured JSON, no vision needed
// ===========================================================================

async function runHeadless() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}  [headless mode]\n`);

  // 1. Start headless session — server returns cart items + price ranges
  const session = await apiPost('/api/v2/session', {}, null);
  const { sessionId, token, cart, subtotal, step1: step1Meta } = session;
  console.log(`Session: ${sessionId}`);
  console.log(`Cart has ${cart.length} items, subtotal $${subtotal}`);
  console.log(`Step 1 prompt: ${step1Meta.prompt}\n`);

  // 2. Launch browser briefly to compute real fingerprint values
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.goto(`${BASE_URL}/v2`, { waitUntil: 'networkidle' });
  const fpResult = await submitFingerprint(sessionId, token, page);
  await browser.close();
  if (fpResult.action === 'block') {
    console.log('Blocked at fingerprint stage.');
    printResult(fpResult.risk, 'blocked', 'headless');
    return;
  }

  // --- Step 1: find item in price range from structured data ---------------
  const targetItem = cart.find(i => i.unitPrice >= step1Meta.low && i.unitPrice <= step1Meta.high);
  if (!targetItem) throw new Error('No item found in step 1 price range');
  console.log(`Step 1 → selecting: ${targetItem.name} ($${targetItem.unitPrice})`);

  const step1Result = await apiPost('/api/v2/step', {
    sessionId, token, step: 1,
    answer: { itemId: targetItem.id, clickedDecoy: false },
    telemetry: telemetry(),
  }, token);
  if (step1Result.action === 'block') {
    printResult(step1Result.risk, 'blocked at step 1', 'headless');
    return;
  }

  // --- Step 2: find shipping in pct range from structured data -------------
  const { shipping, step2: step2Meta } = step1Result;
  console.log(`Step 2 prompt: ${step2Meta.prompt}`);

  const targetShipping = shipping.find(s => {
    const pct = (s.cost / subtotal) * 100;
    return pct >= step2Meta.lowPct && pct <= step2Meta.highPct;
  });
  if (!targetShipping) throw new Error('No shipping found in step 2 pct range');
  console.log(`Step 2 → selecting: ${targetShipping.name} ($${targetShipping.cost})`);

  const step2Result = await apiPost('/api/v2/step', {
    sessionId, token, step: 2,
    answer: { shippingId: targetShipping.id },
    telemetry: telemetry(),
  }, token);
  if (step2Result.action === 'block') {
    printResult(step2Result.risk, 'blocked at step 2', 'headless');
    return;
  }

  // --- Step 3: click real button using ID from API -------------------------
  const { step3: step3Meta, summary } = step2Result;
  console.log(`\nOrder summary: $${summary.subtotal} + ${summary.shippingName} $${summary.shippingCost} + tax $${summary.tax} = $${summary.total}`);
  console.log('Step 3 → clicking real button (non-recommended)');

  const checkoutResult = await apiPost('/api/v2/checkout', {
    sessionId, token,
    clickedBtnId: step3Meta.realBtnId,
    telemetry: telemetry(),
  }, token);

  printResult(checkoutResult.risk, checkoutResult.outcome || 'completed', 'headless');
}

// --- Entry point -----------------------------------------------------------

const runner = AGENT_MODE === 'headless' ? runHeadless : runCv;
runner().catch(err => {
  console.error('\nAgent error:', err.message);
  process.exit(1);
});
