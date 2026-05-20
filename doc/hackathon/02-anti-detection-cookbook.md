# Anti-detection cookbook

The single most useful document. Concrete recipes for each detection layer, in priority order.

**The honest truth before you start**: the LLM is the *least* important part of a winning agent. Four of seven scenarios don't need one at all. Of the three that benefit from vision or NL, prompt design matters more than model choice. What separates a 95th-percentile agent from a median one is **how the agent behaves in the browser** — typing rhythm, mouse motion, deliberation timing, error recovery. Spend your time there.

## How to use this doc

After every run, look at `signal_counts` from `/api/session/:id/result` (the starter's runner prints it). For each signal, search this doc for its name. The recipe makes it stop firing.

You don't need to fix every signal at once. Tackle the highest-weight one, run again, see what's left.

---

## Layer 1 — HTTP headers

Cheapest layer to fix. If you're using a real browser (Playwright + Chromium), you're already most of the way there.

### `no_user_agent` / `headless_in_ua` / `non_browser_http_client`

**What it means**: your request has no User-Agent, or one that contains "HeadlessChrome", "curl", "Python-requests", etc.

**Recipe** (in Playwright):

```js
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
             '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  viewport:  { width: 1440, height: 900 },
  locale:    'en-US',
  timezoneId: 'America/Los_Angeles',
});
```

Pick a UA string matching a real recent Chrome version. Don't pick something exotic — the platform doesn't know you, it just looks for known-bad markers.

### `chrome_ua_missing_client_hints`

**What it means**: your UA claims Chrome but you didn't send `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` headers.

**Recipe**: Playwright's default browser context handles this automatically when you launch Chromium. If you're seeing this signal, you're probably making `fetch()` calls from outside the browser — those don't send client hints by default. Make the calls from inside `page.evaluate(...)` instead, or use the browser's built-in fetch via `page.evaluate(() => fetch(...))`.

### `no_accept_language` / `no_accept_encoding`

**What it means**: standard browser headers missing.

**Recipe**: same as above. Real browser, real navigation. Don't `fetch()` from Node.

---

## Layer 2 — TLS / JA3 fingerprint

Often the simplest layer in practice: use a real browser and you're done.

### `known_bot_ja3`

**What it means**: your client's TLS handshake matches a known automation tool (curl, Python requests, Go's default http client, etc.). Worth 60.

**Recipe**: don't make API calls from Node directly during a session. Make them from inside the browser via `page.evaluate(() => fetch(...))`. The browser's TLS stack matches Chrome's, which isn't in the known-bot list.

If you're at a venue with corporate TLS inspection (most enterprise events), **every participant shares the same JA3** — the proxy's, not the browser's. Don't panic: the primary leaderboard metric is lowest score, not JA3 variety. Layer 2 contributes very little to total score in this scenario. Focus on Layers 3 and 4.

The connectivity check page (`/event/<slug>/check`) tells you what JA3 the server sees. If it matches a known proxy, the check warns rather than alerts — that's expected.

---

## Layer 3 — Browser fingerprint

Long list of fixable signals. Each is a one-liner once you know what to do.

### `navigator_webdriver`

**What it means**: `navigator.webdriver === true`. Playwright sets this. Single biggest first improvement.

**Recipe** — add this BEFORE the first `page.goto()`:

```js
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
```

`addInitScript` runs before any page JS, including the page's fingerprint collection script. `page.addInitScript(...)` works too but `context`-level scripts apply to all pages in the context.

### `default_headless_viewport`

**What it means**: your viewport is 800×600 or some other default that screams "headless test framework." Real users have 1366×768, 1440×900, 1536×864, 1920×1080.

**Recipe**:

```js
const context = await browser.newContext({
  viewport:  { width: 1440, height: 900 },
});
```

### `zero_screen`

**What it means**: `screen.width === 0 || screen.height === 0`. Some headless modes report no screen.

**Recipe**: launch chromium with a real screen via the `--window-size` flag if needed, or override `screen` properties via `addInitScript`. Setting the viewport (above) usually fixes this on Playwright 1.40+.

### `chrome_object_missing`

**What it means**: your UA claims Chrome but `window.chrome` is undefined. Headless Chrome has this; full Chrome doesn't.

**Recipe**: stub the chrome object:

```js
await context.addInitScript(() => {
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }
});
```

Doesn't need to be a complete API surface — the platform only checks the object exists.

### `headless_chrome_notif_mismatch`

**What it means**: real Chrome has a `Notification.permission === 'default'` (or 'granted'/'denied' if the user set it). Headless Chrome can have a mismatched state for the permission API.

**Recipe**:

```js
await context.addInitScript(() => {
  const originalQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);
});
```

### `zero_plugins_desktop_chrome`

**What it means**: real Chrome usually has at least 3 plugins (PDF Viewer, Native Client, etc.). Headless Chrome reports 0.

**Recipe**: spoof a plugin list:

```js
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'PDF Viewer' },
      { name: 'Chrome PDF Viewer' },
      { name: 'Chromium PDF Viewer' },
    ],
  });
});
```

### `no_canvas_hash` / `no_audio_hash` / `webgl_missing` / `software_webgl_renderer`

**What it means**: the page tried to fingerprint your canvas/audio/WebGL surface and got nothing useful back. Either the API failed entirely or returned a "SwiftShader" / software renderer signature.

**Recipe**: launch Chromium with hardware-acceleration-like flags, even in headless:

```js
const browser = await chromium.launch({
  args: [
    '--use-gl=swiftshader',          // accepts software GL as "real-ish"
    '--enable-webgl',
    '--ignore-gpu-blocklist',
  ],
});
```

You can also override the WebGL renderer string explicitly:

```js
await context.addInitScript(() => {
  const proto = WebGLRenderingContext.prototype;
  const origGetParam = proto.getParameter;
  proto.getParameter = function (param) {
    if (param === 37445) return 'Intel Inc.';                        // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return 'Intel Iris OpenGL Engine';         // UNMASKED_RENDERER_WEBGL
    return origGetParam.call(this, param);
  };
});
```

### `no_fingerprint_object`

**What it means**: the page expected the agent to POST a fingerprint object and the request never came (or had no body).

**Recipe**: in CV mode (where the agent navigates to a scenario URL), the page itself submits the fingerprint during session resume — you don't need to POST it. In headless mode, you do. Check the scenario's docs in `03-scenarios.md`.

---

## Layer 4 — Behavioral telemetry

The most open-ended layer. There's always more humanization to add. These are the major signals and the patterns that beat each one.

### `synthetic_click_dwell`

**What it means**: your `locator.click()` lands immediately. Real humans hover for 100–500ms before clicking — they're tracking the cursor, deliberating, occasionally over/undershooting.

**Recipe**:

```js
async function humanClick(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.hover();
  await sleep(120 + Math.random() * 280);  // 120-400ms dwell
  await locator.click();
}
```

Tune the dwell distribution. Some clicks should be fast (~80ms), some slow (~1s). A constant range is detectable in itself.

### `uniform_keystroke_timing`

**What it means**: you typed with constant inter-key delay (or no delay).

**Recipe**: vary per-key delay. Humans are faster on familiar letter pairs ("th", "in") and slower on punctuation:

```js
async function humanType(locator, text) {
  await locator.click();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    await locator.press(ch === ' ' ? 'Space' : ch);
    // Variable per-key delay with occasional thinking pause
    let delay = 60 + Math.random() * 120;                       // 60-180ms typical
    if (ch === ' ' || ch === '.' || ch === ',') delay += 80;    // slower on punctuation
    if (Math.random() < 0.03) delay += 500 + Math.random() * 800;  // 3% chance of thinking
    await sleep(delay);
  }
}
```

### `straight_line_cursor`

**What it means**: your mouse moved in a perfect straight line. Real human mouse motion has curvature, micro-corrections, and acceleration that follows a roughly bezier-like path.

**Recipe**:

```js
async function humanMouseTo(page, x, y) {
  const { x: x0, y: y0 } = await page.evaluate(() => ({ x: window.__lastMouseX || 0, y: window.__lastMouseY || 0 }));
  const steps = 20 + Math.floor(Math.random() * 20);
  const cx = (x0 + x) / 2 + (Math.random() - 0.5) * 80;       // control point with jitter
  const cy = (y0 + y) / 2 + (Math.random() - 0.5) * 80;
  for (let t = 0; t <= 1; t += 1 / steps) {
    // quadratic bezier
    const px = (1-t)*(1-t)*x0 + 2*(1-t)*t*cx + t*t*x;
    const py = (1-t)*(1-t)*y0 + 2*(1-t)*t*cy + t*t*y;
    await page.mouse.move(px, py);
    await sleep(8 + Math.random() * 12);
  }
}
```

### `uniform_mouse_velocity`

**What it means**: your mouse moved at constant speed. Real motion accelerates and decelerates.

**Recipe**: the bezier-with-variable-step-delay approach above naturally produces non-uniform velocity. If you're using `page.mouse.move(x, y, { steps: N })`, that's uniform — switch to manual stepping with per-step jitter.

### `low_mouse_activity` / `low_mouse_entropy`

**What it means**: your agent only moved the cursor at click time. Real users move the cursor while reading, hovering over different items, etc.

**Recipe**: between clicks, scatter a few random "wandering" moves:

```js
async function wanderMouse(page, durationMs = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < durationMs) {
    const x = 200 + Math.random() * 800;
    const y = 200 + Math.random() * 400;
    await humanMouseTo(page, x, y);
    await sleep(200 + Math.random() * 400);
  }
}
```

Call this between steps. Doesn't have to do anything useful — just generate plausible cursor activity.

### `no_scroll_low_activity` / `synthetic_scroll_pattern`

**What it means**: you didn't scroll the page (or scrolled in a single mechanical motion). Real users scroll, then read, then scroll more — with pause-and-resume rhythm and slight horizontal variation.

**Recipe**:

```js
async function humanScroll(page, totalDeltaY) {
  let scrolled = 0;
  while (scrolled < totalDeltaY) {
    const delta = 60 + Math.random() * 120;
    await page.mouse.wheel(0, Math.min(delta, totalDeltaY - scrolled));
    scrolled += delta;
    await sleep(300 + Math.random() * 700);       // pause to read
  }
}
```

### `too_fast` / `superhuman_reaction_time`

**What it means**: you completed a step in under N hundred milliseconds. Humans need time to read, decide, move.

**Recipe**: between page state changes and your next action, insert a deliberation pause that scales with step complexity:

```js
// Step 1 is choosing from a cart — needs reading time
await humanPause(1500, 0.5);   // median 1.5s, log-normal

// Step 3 is clicking one of two buttons — faster
await humanPause(700, 0.4);
```

`lib/jitter.js` in the starter has `humanPause(medianMs, spread)` using a log-normal distribution. Bad default values are intentional.

### `focus_thrashing`

**What it means**: you focused and unfocused input fields repeatedly without typing. Common bug when using `locator.click()` then `locator.fill()` on the same input.

**Recipe**: don't double-tap. Either `click` THEN type, or just `fill` (which focuses + types).

---

## The honeypot / decoy gates (instant block)

Read [01-how-scoring-works.md](01-how-scoring-works.md) for the full list. Recipe is the same for all of them:

### Before clicking ANY element, verify it's visible

```js
async function safeClick(locator) {
  const isVisible = await locator.evaluate(el => {
    if (!el || !el.offsetParent) return false;  // detached or display:none
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    return true;
  });
  if (!isVisible) throw new Error('refused to click invisible element (likely honeypot)');
  await humanClick(locator);
}
```

Use this everywhere you click. Same check applies to inputs before filling them.

### Read the task before acting

The platform's tasks are explicit. "Click the item whose unit price is between $51 and $114" — read the prices, do the math, click the right one. Don't naively click the first item, the cheapest item, or the most-expensive item. The decoy items are specifically constructed to be tempting if you skip the math.

---

## Prompt engineering (when you do use an LLM)

The starter's example prompt is deliberately bad:

```
"Look at the screenshot. Reply with ONLY the exact text of the item to click. No explanation."
```

Better:

```
"You are looking at a shopping cart page. The task is: Click the item whose
unit price is between $51 and $114. Each item shows its quantity and unit
price. Reply with ONLY the exact product name of the item whose unit
price falls in the range. If multiple items match, pick the one with the
smallest price. Do not explain. Format: just the product name on one line."
```

Three improvements:
1. **Give the model the constraint explicitly** (the price range) — don't make it re-read your task
2. **Specify the tiebreaker** if multiple options match
3. **Specify the output format** — easier to programmatically use the answer

For image-CAPTCHA prompts, include the grid coordinates you want returned (e.g., "Reply with comma-separated cell indices, e.g. `0,3,7`").

For product-search, ask the model to extract just the product name from the search instruction — don't give it the whole task and expect it to also do the search.

---

## When to stop tuning

When `signal_counts` is empty (`{}`) on a `complete`-outcome run, you've zeroed out detectable signals. That doesn't mean your score is 0 — there's always a small noise floor. But it does mean further Layer-1-through-4 work has diminishing returns.

At that point, switch to:
- **Lowering token cost** (No-LLM Hero category — drop the LLM for scenarios where you don't need it)
- **Going wide** — solve all 7 scenarios cleanly instead of perfecting one
- **Going deep** — minimize the score on one specific scenario (Single-Scenario Specialist category)

The cumulative-score leaderboard rewards solving more scenarios. The +100 penalty per unattempted scenario is bigger than the difference between a great and a mediocre run.
