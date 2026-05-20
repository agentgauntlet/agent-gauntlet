# Lab 2 — Read the result

**Goal**: understand exactly which signals are firing and decide what to fix first.

**Time**: 10 minutes.

**Pre-requisite**: [Lab 1](01-first-run.md) complete (you have at least one sessionId).

---

## Step 1 — Get a sessionId

From your most recent run, find the line:

```
  Result:
    Session ID:  1a35b6cc9eecaf558ed3acc40b55891d
```

Copy that ID. If you don't have one handy, run another scenario:

```bash
npm run agent -- cart-checkout
```

## Step 2 — Fetch the raw result endpoint

```bash
curl -s "https://agentgauntlet.ai/api/session/<sessionId>/result" \
  -H "x-api-key: $(grep '^AG_KEY=' .env | cut -d= -f2)" \
  | python3 -m json.tool
```

(Replace `python3 -m json.tool` with `jq` if you have it.)

Expected output (event-tier — `signal_counts` populated):

```json
{
  "session_id": "1a35b6cc9eecaf558ed3acc40b55891d",
  "scenario": "cart",
  "outcome": "block",
  "risk_score": 100,
  "risk_tier": "high",
  "elapsed_ms": 11420,
  "signal_counts": {
    "wrong_item_step1": 1,
    "navigator_webdriver": 1,
    "default_headless_viewport": 1,
    "synthetic_click_dwell": 3,
    "uniform_keystroke_timing": 1
  },
  "signal_dimensions": {
    "Fingerprint": 80,
    "Behavior": 80,
    "Instruction": 100
  },
  "handle": "your-handle"
}
```

If you see fewer fields (no `signal_counts`), you're on the free tier. Re-check your event-join from Lab 0 — the elevated tier should expose the full breakdown.

## Step 3 — Identify the highest-weight signals

Open [02-anti-detection-cookbook.md](../02-anti-detection-cookbook.md) in another tab. For each signal in your `signal_counts`, find its weight in the cookbook or [shared/risk.js source](https://github.com/agentgauntlet/agent-gauntlet/blob/main/shared/risk.js).

For the example above:

| Signal | Layer | Weight | Notes |
|---|---|---|---|
| `wrong_item_step1` | gate | 100 | Challenge gate — auto-block. Fix first. |
| `navigator_webdriver` | 3 | 80 (capped) | One of the layer-3 ceiling contributors |
| `default_headless_viewport` | 3 | (capped by layer) | Same layer cap |
| `synthetic_click_dwell` | 4 | 60 (capped) | Layer 4 main contributor |
| `uniform_keystroke_timing` | 4 | (capped by layer) | Same |

**Rule of thumb**: fix challenge gates first (100-weight kill switches), then highest-weight non-gate signals, then everything else.

## Step 4 — Write down your fix list

In a notes file or sticky note, list the signals you saw, in this order:

1. **Gates first** — `wrong_item_step1`, `clicked_decoy_step1`, `honeypot_filled`, `clicked_recommended_decoy`, `selected_sponsored_decoy`, etc.
2. **Layer 3 (fingerprint)** — usually 4–6 fixable signals; each is a one-liner
3. **Layer 4 (behavioral)** — open-ended; tune over many runs
4. **Layer 1 (headers)** — usually nothing once you're using Playwright
5. **Layer 2 (TLS)** — usually nothing once you're using a real browser

You don't have to fix everything in one pass. Pick the top 3 from layers 3 and 4, write the fixes, run again, see what's left.

## Step 5 — Look at signal_dimensions

Note `signal_dimensions` in the response. The keys are the four detection layers (with some signals also rolled into an `Instruction` bucket for task-comprehension signals). The values are the per-dimension weight totals.

If your `Behavior` is 60 and `Fingerprint` is 80, you have more headroom by fixing Behavior — Fingerprint is already at its ceiling. Pick the dimension you can move most easily.

---

## Verify

You completed this lab if:

- ✅ You can describe (out loud or in notes) which 3 signals you'd fix first and why
- ✅ You can find a signal name in the cookbook and read its recipe
- ✅ You understand the difference between a "challenge gate" (100-weight, instant block) and a regular signal (weighted by layer, summed to score)

## What you learned

- `signal_counts` from `/api/session/:id/result` is your debug ground truth
- The runner prints a subset; raw curl gives you the full data
- Challenge gates beat layer scoring — fix them first regardless of weight math
- `signal_dimensions` tells you which layer has the most headroom
