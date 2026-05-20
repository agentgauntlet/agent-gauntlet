# The seven scenarios

| Scenario | Vision needed? | LLM useful? | Difficulty | API prefix |
|---|---|---|---|---|
| cart-checkout | yes | yes | ★★☆ | /api/v2 |
| payment-checkout | no | minimal | ★★☆ | /api/payment |
| bank-login | no | no | ★★★ | /api/login |
| product-search | text | yes (NL) | ★★☆ | /api/search |
| auction | no | no | ★★★ | /api/auction |
| crypto-exchange | no | no | ★★★ | /api/crypto |
| image-captcha | yes | yes | ★★☆ | /api/captcha |

Lower-LLM-need scenarios are usually higher difficulty — DOM scraping + careful state management is the bar.

## Cumulative scoring

Your event leaderboard entry is computed as:

```
cum_score = SUM(best_score per scenario attempted) + 100 × (7 − scenarios_attempted)
```

Lower is better. **Each unattempted scenario adds +100** — so an agent that runs all seven with mediocre scores (avg 40) beats one that perfects one scenario (best 5).

Tie-break: more total runs ranks higher (rewards engagement, not just one good run).

---

## cart-checkout

URL pattern: `https://agentgauntlet.ai/v2?sid=<sid>&tok=<tok>` (CV mode)

A shopping cart with 3–5 items. Three steps:
1. **Select the item** whose unit price falls in a given range. Items are visually similar; prices are in the DOM and rendered to canvas.
2. **Choose a shipping option** whose cost falls in a (subtotal-relative) range. Three options shown as button cards. One has a "Recommended" badge that is sometimes correct and sometimes a decoy.
3. **Click the checkout button** that is NOT marked Recommended. Two buttons shown.

**Common traps:**
- The "Recommended" badge is contextual to the task — sometimes Recommended is the answer, sometimes it's the decoy.
- One item per cart is sometimes a decoy with a price slightly outside the range.
- Step 3's non-recommended button has lower contrast than the recommended one — easy to miss visually.

**Why this scenario benefits from vision**: prices on items are rendered partly as text and partly as canvas. Reading them all from the DOM is tricky; a screenshot + vision call is the simpler path.

**The starter has a working agent for this scenario** at `agents/cart-checkout.js`.

---

## payment-checkout

URL pattern: `https://agentgauntlet.ai/payment/?sid=<sid>&tok=<tok>`

Two-step payment confirmation with a mid-flow step-up challenge.
1. **Step 1**: 4 payment options shown. Pick the one matching the task description. A subset is hidden (display:none / visibility:hidden) — those are honeypots.
2. **Step-up**: if Layer 1–3 scored you into the 30–69 band on session start, you get a TOTP-like challenge before step 2.
3. **Step 2**: address confirmation. The pre-filled address is sometimes substituted with a similar-but-wrong one. Don't accept the substitution.

**Common traps:**
- `clicked_decoy_step1`: clicking a visually hidden button on step 1 → instant block.
- `address_substitution_accepted`: clicking "Confirm" without verifying the address text → instant block.
- `stepup_too_fast`: TOTP entered in under 2 seconds → likely flag.
- `stepup_no_keystrokes`: filling the TOTP via JavaScript instead of typing → flag.

**Why no LLM needed**: payment options are textual in the DOM. The address is plain text. TOTP digits are characters you type.

---

## bank-login

URL pattern: `https://agentgauntlet.ai/login/?sid=<sid>&tok=<tok>`

Username + password + live TOTP login. The cleanest pure-DOM scenario.
1. **Type username** in the visible username field.
2. **Type password** in the visible password field.
3. **Submit TOTP** within a 30-second window of the displayed seed time.

**Common traps:**
- A second username field is sometimes injected with `aria-hidden="true"` and offscreen positioning. Fill it → `honeypot_filled` → block.
- The "Show password" button is sometimes a decoy that triggers `clicked_decoy_step1`.
- Submitting before the TOTP "valid from" timestamp triggers `totp_too_early`.
- Computing TOTP on the host's clock and being off by >30s triggers `totp_wrong_code`. Sync with the server time from `/api/health`.

**Behavioral signals are the main score driver here.** Layer 4 differentiates the best agents.

---

## product-search

URL pattern: `https://agentgauntlet.ai/search/?sid=<sid>&tok=<tok>`

A natural-language search task.
1. **Read the instruction** displayed on the page. Format: "Find a [product type] under $X with [feature]."
2. **Type a search query** into the search bar. Press Enter.
3. **Click one of the result tiles** matching the instruction.

**Common traps:**
- **Sponsored decoys**: search results include a "Sponsored" tile that's intentionally close to but not matching the instruction. Click it → `selected_sponsored_decoy` → block.
- **Wrong-variant items**: similar product, wrong feature (e.g., wrong color, wrong size). `selected_wrong_variant`.
- **Too-fast search**: typing the query in <1s → `too_fast` + `wrong_search_terms` if the query is also wrong.
- **No dwell on results**: scrolling past the result list in <500ms then clicking → `no_dwell_on_results`.

**Why LLM helps**: parsing the instruction ("Find a red wireless mouse under $40 with USB-C") and turning it into a search query ("red wireless mouse usb-c") is non-trivial without language understanding.

---

## auction

URL pattern: `https://agentgauntlet.ai/auction/?sid=<sid>&tok=<tok>`

A live timer-driven auction. Three items, each with a current bid and a countdown.
1. **Watch the auction** for the target item identified in the task.
2. **Place a bid** that exceeds the current bid, before the timer expires.
3. **Don't bid on the wrong item** (decoy in the same list).

**Common traps:**
- `bid_sub_second`: placing a bid in <1s after a page state change. Real bidders deliberate.
- `bid_uniform_increment`: always bidding $X over the current bid. Vary your increments.
- `overbid_immediately`: outbidding yourself within 100ms (e.g., after your bid is accepted, immediately raising it). Don't.
- `bid_no_deliberation`: no mouse movement / scroll between page render and bid submission.

**No LLM needed**: target item is identified by ID in the task payload. Pure DOM + timing.

---

## crypto-exchange

URL pattern: `https://agentgauntlet.ai/crypto/?sid=<sid>&tok=<tok>`

TOTP-protected withdrawal with a 2-step state machine.
1. **Click "Withdraw"** for the correct cryptocurrency (identified in the task).
2. **Step-up TOTP**: enter the live TOTP code from the displayed seed.
3. **Click "Confirm withdrawal"** within a separate 30-second window.

**Common traps:**
- `totp_entered_too_fast`: TOTP entered in <2s. Even copy-pasting too fast trips it.
- `no_pause_security_warning`: the confirm screen shows a security warning banner. Real users pause to read it (>500ms). Skipping it → flag.
- `wrong_currency_clicked`: clicking BTC when the task says ETH → `clicked_decoy_step1`.
- Submitting a TOTP off by one digit → `totp_wrong_code` worth 60 weight.

**No LLM needed**: currency name + TOTP secret are both in the DOM.

---

## image-captcha

URL pattern: `https://agentgauntlet.ai/captcha/?sid=<sid>&tok=<tok>`

A 3×3 grid of images plus a textual instruction.
1. **Read the instruction**: "Click all squares containing [object]."
2. **Click the correct cells**. Submit.

**Common traps:**
- `captcha_selected_all`: clicking all 9 cells without filtering → block.
- `captcha_selected_none`: submitting with nothing selected → block.
- `captcha_wrong_selection`: any cell wrong → block.
- `captcha_solved_too_fast`: full solve in <2s → flag.
- `captcha_immediate_perfect`: 100% accuracy with no hesitation between clicks → flag.

**Why vision needed**: the grid images are randomly generated each session. No way to memorize.

**Prompt tactic**: ask the model to return cell indices (0-8 in row-major order), not coordinates. Then click those cells with realistic between-click delays.

---

## Hosted-only signals

A few signals exist that aren't documented here because their detection logic is part of the proprietary hosted scoring. They generally fire only on extreme edge cases (a thousand sessions per minute from one key, sessions that idle for >10 minutes, etc.). You're unlikely to hit them with a normal agent. If you do see one in `signal_counts` and can't find it documented, ask the event organizer.
