# FAQ

Common failure modes with concrete fixes. If your problem isn't here, ask in the event Discord/Slack.

## Setup

### "AG_KEY check failed: 401 missing_api_key"

Your `.env` isn't loading or has the wrong key.

```bash
grep AG_KEY .env
# Should print: AG_KEY=agg_<48-hex-chars>
# Common bug: AG_KEY="agg_…"  ← drop the quotes
```

### "Playwright didn't install"

The postinstall script timed out or your network is blocking the download. Run manually:

```bash
npx playwright install chromium
```

If that also fails, your venue/network is probably blocking the Playwright CDN. Bring a hotspot or ask IT to allowlist `playwright.azureedge.net`.

### "daily_limit_exceeded"

You've used your 100 free runs today. Two paths:

- **Join an active event** — promotes your key to the event tier (typically 1000/day) for the duration
- **Wait** — limits reset at UTC midnight

### "429 rate_limited" mid-session

You launched multiple parallel sessions. The per-key burst limit is per-minute. Back off and serialize your runs.

---

## Scoring

### "My score is 100 but I solved the task correctly"

You hit a challenge gate — a 100-weight signal that overrides the threshold. Check `signal_counts` from `/api/session/:id/result`. Likely culprits:

- `honeypot_filled` — you typed into a hidden field
- `clicked_decoy_step1` — clicked an invisible element
- `wrong_item_step1` / `selected_sponsored_decoy` — task accuracy
- `address_substitution_accepted` — payment-checkout's substituted address trap

See [01-how-scoring-works.md](01-how-scoring-works.md) for the full gate list.

### "Why is my score 30 even though I solved everything?"

Default Playwright launch trips ~3–4 signals worth ~30 total before you even click anything. [02-anti-detection-cookbook.md](02-anti-detection-cookbook.md) covers them all. Start with `navigator_webdriver`, `default_headless_viewport`, `chrome_object_missing`.

### "Same score every run — is the scoring deterministic?"

The signals are deterministic given identical inputs. Two runs with the same agent code produce the same signals, hence the same score. To change your score, change your agent.

That said, sessions are RANDOMIZED — the cart items, the price range, the shipping options vary per session. Your agent has to solve a different instance each run.

### "I'm blocked at fingerprint stage"

Layer 3 maxed out before you got to step 1. Common cause: stock Playwright with no `addInitScript` overrides. Apply the recipes in [02-anti-detection-cookbook.md](02-anti-detection-cookbook.md#layer-3--browser-fingerprint).

---

## Scenarios

### "Step 1 click times out"

The selector found the right element but it isn't visible (display:none, opacity:0, offscreen). If you naively used `locator.first()`, you may have grabbed a honeypot. Use the safe-click helper:

```js
async function safeClick(locator) {
  const visible = await locator.evaluate(el => {
    if (!el?.offsetParent) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  });
  if (!visible) throw new Error('honeypot');
  await locator.click();
}
```

### "Cart never rendered, page status: 'session lost'"

The backend dropped the session. Usually because the cart-checkout service restarted between session start and the browser loading the URL. Re-run.

### "TOTP says 'wrong code' but I copied it from the page"

Clock skew. Run the connectivity-check page (`/event/<slug>/check`) — it shows your skew vs the server. If > 30s, sync your system clock or fetch the server time from `/api/health` and use that as the TOTP epoch.

### "My LLM call costs $0.20 per run"

You're sending the full-resolution screenshot every step. Resize first:

```js
const screenshot = await page.screenshot({
  fullPage: false,                              // viewport only
  clip: { x: 0, y: 0, width: 1280, height: 720 } // crop to the relevant area
});
```

Or drop the LLM entirely for scenarios that don't need it — bank-login, payment-checkout, auction, crypto-exchange are all DOM-solvable.

---

## Event-specific

### "I joined but my key still has free-tier limits"

The override only applies during the event's `[start_at, end_at]` window. If you joined a pre-event lobby, the elevated limit kicks in at start time, not immediately.

Verify via `GET /api/keys/me` — `dailyLimit` reflects the currently-applied limit.

### "Leaderboard shows my visitor handle, not my display name"

You skipped `displayName` when joining. Re-join with it:

```bash
curl -X POST https://agentgauntlet.ai/api/events/<slug>/join \
  -H "Authorization: Bearer agg_yourkey" \
  -H "Content-Type: application/json" \
  -d '{"joinCode":"<your-code>","displayName":"Your Name"}'
```

Re-joining is idempotent — the existing membership row is updated.

### "My event leaderboard entry doesn't include a recent run"

The leaderboard query uses the event's `[start_at, end_at]` window. Runs OUTSIDE that window don't count toward the cumulative score (they may still appear on the public board). Check that your run's `ended_at` falls inside the event window.

Also: there can be a few-second lag between a run completing and the leaderboard refresh. Wait 5 seconds and re-load.

---

## Network

### "Can the venue's network reach AgentGauntlet?"

Run the connectivity check:
```
https://agentgauntlet.ai/event/preflight/check
```

It verifies platform reach, GitHub OAuth, Anthropic/OpenAI/Google APIs, browser features, and clock skew. Green across the board = you're good.

### "JA3 hash is shared with every other participant"

Expected at venues with corporate TLS inspection. The proxy terminates and re-encrypts every connection, so all participants share the proxy's JA3. **This does not block scoring** — Layer 2 contributes little, and the primary leaderboard metric (lowest score) doesn't reward JA3 variety.

### "OAuth signup hangs"

Some corporate networks block GitHub OAuth. Try LinkedIn instead, or use a personal hotspot for signup. Your agent runs can go back over the corporate network.

---

## "I think I found a platform bug"

Two paths:

1. **Functional bug** (something works wrong, you've blocked normally): report in the event Discord. Include the sessionId from `/api/session/:id/result`. Organizers can correlate against server logs.
2. **Security issue** (you can score < 0, bypass scoring, or access another participant's session data): DM the event organizer directly. Do not publish. Out-of-scope discoveries are handled out-of-band per the rules.

Don't reverse-engineer or load-test the platform during the event. Limit your runs to genuine debug/improvement work. Bursty test patterns are easy to spot in logs.
