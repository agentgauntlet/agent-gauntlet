#!/usr/bin/env node
/**
 * AgentGauntlet demo agent — cart-checkout scenario
 *
 * Uses Claude claude-sonnet-4-6 + Playwright to complete the 3-step cart checkout.
 * No evasion techniques — this is an honest baseline to show how an agent scores.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY       your Anthropic API key
 *
 * Optional env vars:
 *   AGENTGAUNTLET_API_KEY   free key from agentgauntlet.ai/keys.html (unlocks leaderboard)
 *   AGENTGAUNTLET_BASE_URL  override base URL (default: https://agentgauntlet.ai)
 *   HEADLESS                set to "false" to watch the browser (default: true)
 */

const Anthropic  = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');

const BASE_URL    = process.env.AGENTGAUNTLET_BASE_URL || 'https://agentgauntlet.ai';
const API_KEY     = process.env.AGENTGAUNTLET_API_KEY  || null;
const HEADLESS    = process.env.HEADLESS !== 'false';
const SCENARIO    = 'cart';
const SCENARIO_PORT = 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- API helpers -----------------------------------------------------------

async function apiPost(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY)  headers['X-Api-Key'] = API_KEY;
  if (token)    headers['X-Session-Token'] = token;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok && !json.ok) throw new Error(`API ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// --- Claude vision helper --------------------------------------------------

async function askClaude(screenshotBuf, systemPrompt, userPrompt) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: screenshotBuf.toString('base64') },
        },
        { type: 'text', text: userPrompt },
      ],
    }],
  });
  return msg.content[0].text.trim();
}

// --- Telemetry stub (honest — no mouse data) --------------------------------

function telemetry() {
  return {
    mouseEvents: [],
    keyEvents:   [],
    scrollEvents: [],
    dwellMs: Math.floor(800 + Math.random() * 1200),
  };
}

// --- Main agent loop --------------------------------------------------------

async function run() {
  console.log(`\nAgentGauntlet demo agent — ${BASE_URL}\n`);

  // 1. Start session
  const session = await apiPost('/api/v2/session', {}, null);
  const { sessionId, token, cart, subtotal, step1: step1Meta } = session;
  console.log(`Session: ${sessionId}`);
  console.log(`Cart has ${cart.length} items, subtotal $${subtotal}`);
  console.log(`Step 1 prompt: ${step1Meta.prompt}\n`);

  // 2. Submit fingerprint (honest values — no canvas/audio spoofing)
  await apiPost('/api/v2/fingerprint', {
    sessionId, token,
    fingerprint: {
      userAgent:  'Mozilla/5.0 (compatible; AgentGauntlet-Demo/1.0)',
      canvasHash: null,
      audioHash:  null,
      webdriver:  true,
      screen:     { width: 1280, height: 800 },
      tz:         Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  }, token);

  // 3. Launch browser and navigate to scenario
  const browser = await chromium.launch({ headless: HEADLESS });
  const page    = await browser.newPage();

  const scenarioUrl = BASE_URL.includes('localhost')
    ? `http://localhost:${SCENARIO_PORT}/v2`
    : `${BASE_URL.replace(':3080', `:${SCENARIO_PORT}`)}/v2`;

  await page.goto(scenarioUrl, { waitUntil: 'networkidle' });
  console.log('Browser opened:', scenarioUrl);

  // --- Step 1: pick the right cart item ------------------------------------
  const screenshot1 = await page.screenshot({ fullPage: true });

  const systemPrompt = `You are a web agent completing a shopping task.
Respond with ONLY the exact text label or item name you would click — no explanation.`;

  const step1Answer = await askClaude(
    screenshot1,
    systemPrompt,
    `Task: ${step1Meta.prompt}
The cart items and their prices are: ${JSON.stringify(cart.map(i => ({ id: i.id, name: i.name, unitPrice: i.unitPrice })))}
Reply with ONLY the item id (e.g. "item-3") whose unit price is between $${step1Meta.low} and $${step1Meta.high}.`,
  );

  const targetItem = cart.find(i =>
    i.unitPrice >= step1Meta.low && i.unitPrice <= step1Meta.high
  ) || cart.find(i => step1Answer.includes(i.id));

  if (!targetItem) throw new Error(`Could not resolve step 1 item from Claude answer: ${step1Answer}`);
  console.log(`Step 1 → selecting item: ${targetItem.name} ($${targetItem.unitPrice})`);

  const step1Result = await apiPost('/api/v2/step', {
    sessionId, token, step: 1,
    answer: { itemId: targetItem.id, clickedDecoy: false },
    telemetry: telemetry(),
  }, token);

  const { shipping, step2: step2Meta } = step1Result;
  console.log(`Step 2 prompt: ${step2Meta.prompt}\n`);

  // --- Step 2: pick the right shipping option ------------------------------
  const screenshot2 = await page.screenshot({ fullPage: true });

  const step2Answer = await askClaude(
    screenshot2,
    systemPrompt,
    `Task: ${step2Meta.prompt}
Shipping options: ${JSON.stringify(shipping.map(s => ({ id: s.id, name: s.name, cost: s.cost, pct: +((s.cost / subtotal) * 100).toFixed(1) })))}
Reply with ONLY the shipping id (e.g. "ship-2") whose cost is between ${step2Meta.lowPct}% and ${step2Meta.highPct}% of the $${subtotal} subtotal.`,
  );

  const targetShipping = shipping.find(s => {
    const pct = (s.cost / subtotal) * 100;
    return pct >= step2Meta.lowPct && pct <= step2Meta.highPct;
  }) || shipping.find(s => step2Answer.includes(s.id));

  if (!targetShipping) throw new Error(`Could not resolve step 2 shipping from Claude answer: ${step2Answer}`);
  console.log(`Step 2 → selecting shipping: ${targetShipping.name} ($${targetShipping.cost})`);

  const step2Result = await apiPost('/api/v2/step', {
    sessionId, token, step: 2,
    answer: { shippingId: targetShipping.id },
    telemetry: telemetry(),
  }, token);

  const { step3: step3Meta, summary } = step2Result;
  console.log(`\nOrder summary: subtotal $${summary.subtotal} + ${summary.shippingName} $${summary.shippingCost} + tax $${summary.tax} = $${summary.total}`);
  console.log(`Step 3 prompt: ${step3Meta.prompt}\n`);

  // --- Step 3: click the non-recommended button ----------------------------
  // The API gives us both button IDs — click the real (non-decoy) one
  console.log(`Step 3 → clicking real button (not the recommended decoy)`);

  const checkoutResult = await apiPost('/api/v2/checkout', {
    sessionId, token,
    clickedBtnId: step3Meta.realBtnId,
    telemetry: telemetry(),
  }, token);

  await browser.close();

  // --- Results -------------------------------------------------------------
  const { risk, outcome } = checkoutResult;
  console.log('\n─────────────────────────────────');
  console.log('RESULT');
  console.log('─────────────────────────────────');
  console.log(`Outcome:    ${outcome || 'completed'}`);
  if (risk) {
    console.log(`Risk score: ${risk.score}/100`);
    console.log(`Tier:       ${risk.tier}`);
    console.log(`Action:     ${risk.action}`);
    if (risk.signals && risk.signals.length) {
      console.log(`Signals:    ${risk.signals.join(', ')}`);
    }
    if (risk.breakdown && risk.breakdown.length) {
      console.log('\nBreakdown:');
      risk.breakdown.forEach(d => console.log(`  ${d.dimension}: ${d.score}`));
    }
  }
  console.log('─────────────────────────────────\n');
}

run().catch(err => {
  console.error('\nAgent error:', err.message);
  process.exit(1);
});
