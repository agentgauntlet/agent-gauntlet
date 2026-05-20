# Lab 3 — Fix a fingerprint signal

**Goal**: strip `navigator_webdriver` from your runs. Single biggest first improvement.

**Time**: 15 minutes (includes verification runs).

**Pre-requisite**: [Lab 2](02-read-the-result.md) — you've seen `navigator_webdriver` in your `signal_counts`.

---

## Background

Playwright sets `navigator.webdriver = true` on every page by default. This is a single property that the platform's Layer 3 fingerprint check looks for. Removing it is a one-liner.

This is the cheapest, highest-impact first change you can make. Worth ~30 score points (it's one of several layer-3 signals that hit the layer's 80 ceiling, so removing it doesn't drop your score by exactly 80 — but the layer total falls).

## Step 1 — Look at where the browser launches

In the starter, the browser is created in `bin/agent.js` around line 100:

```js
const browser = await chromium.launch({ headless: !args.headful });
const context = await browser.newContext({
  viewport:  { width: 1280, height: 800 },
  locale:    'en-US',
  timezoneId: 'America/Los_Angeles',
});
const page = await context.newPage();
```

This launches a stock Chromium with no stealth measures. `navigator.webdriver` is `true` on every page in this context.

## Step 2 — Add the override

Edit `bin/agent.js`. Right after the `newContext` call and before `newPage`, add:

```js
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
```

The full block should now look like:

```js
const context = await browser.newContext({
  viewport:  { width: 1280, height: 800 },
  locale:    'en-US',
  timezoneId: 'America/Los_Angeles',
});

// Strip navigator.webdriver before any page JS runs
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = await context.newPage();
```

**Why `addInitScript` and not a `page.evaluate` later?** The platform's fingerprint script runs IMMEDIATELY when the page loads. `addInitScript` registers your code to run before any other JS in the page (including the platform's). `page.evaluate` runs too late.

**Why `context.addInitScript` and not `page.addInitScript`?** Context-level init scripts apply to every page in the context, including any pop-ups or new tabs. Page-level only applies to that one page.

## Step 3 — Run

```bash
npm run agent -- cart-checkout
```

## Step 4 — Verify the signal is gone

In the runner output, look at the `signals fired:` list. `navigator_webdriver` should be absent.

Alternatively, curl the result endpoint directly (from Lab 2) and check `signal_counts` — no `navigator_webdriver` key.

If it's still firing, common causes:
- The override is INSIDE a try/catch and you're typoing the `Object.defineProperty` call. Make sure you copied it exactly.
- You added it to `page.addInitScript` AFTER `newPage`, but `newPage` already loaded a blank page. Use `context.addInitScript` BEFORE `newPage`.
- You're running an old build (npm cache). Restart your shell session.

## Step 5 — Check your score moved

Compare the `Risk score` line between this run and a previous run. You should see a drop of 10–30 points (the exact amount depends on what other layer-3 signals were firing — when one signal stops, others may still keep the layer at its 80 cap, so the visible drop depends on how saturated layer 3 was).

If your score didn't drop at all, look at `signal_dimensions`:
- Layer 3 should be lower than before (could still be at 80 if other signals fill in)
- Other layers unchanged

If layer 3 is still at 80, fix the next layer-3 signal — likely `default_headless_viewport` (recipe: set `viewport: { width: 1440, height: 900 }` and re-run) or `chrome_object_missing`.

---

## Verify

You completed this lab if:

- ✅ `navigator_webdriver` no longer appears in `signal_counts` from the result endpoint
- ✅ You can explain why `addInitScript` (not `page.evaluate`) is the right hook
- ✅ Your score dropped, OR you can articulate why it didn't (other layer-3 signals saturating the cap)

## What you learned

- `addInitScript` is the Playwright hook for "run before any page JS"
- Context-level scripts apply to all pages; page-level only to that page
- Stripping one fingerprint signal often reveals that other layer signals were also hitting the cap — fix them in sequence and watch the layer total drop
- This pattern (find signal → look up recipe → apply → re-run → verify gone) is the inner loop of agent improvement. Repeat for every signal.

## Next

Pick another signal from your latest result. Follow its recipe in [the cookbook](../02-anti-detection-cookbook.md). Run. Repeat. After ~5 fixes you'll be below the block threshold.

For more ambitious territory: the LLM call in the example agent uses a deliberately weak prompt (`"Look at the screenshot. Reply with ONLY the exact text..."`). Rewriting the prompt to include the task's explicit constraints typically improves task-correctness (i.e. stops `wrong_item_step1` from firing). Try setting `LLM_PROVIDER=anthropic` (or openai/google) in `.env` and writing a better prompt in `agents/cart-checkout.js`.
