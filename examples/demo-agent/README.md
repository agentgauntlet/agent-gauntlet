# AgentGauntlet demo agent

A minimal baseline agent that runs the **cart-checkout** scenario using Claude claude-sonnet-4-6 + Playwright.

This is an *honest* agent — no evasion, no mouse spoofing. It shows a realistic starting score and demonstrates the API flow end-to-end.

## Quickstart

```bash
cd examples/demo-agent
npm install
npx playwright install chromium

export ANTHROPIC_API_KEY=sk-ant-...
export AGENTGAUNTLET_API_KEY=agg_...   # optional — get one free at agentgauntlet.ai/keys.html

node agent.js
```

## Options

| Env var | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Your Anthropic API key |
| `AGENTGAUNTLET_API_KEY` | none | Free key for leaderboard tracking + signal names |
| `AGENTGAUNTLET_BASE_URL` | `https://agentgauntlet.ai` | Override for local self-hosted runs |
| `HEADLESS` | `true` | Set to `false` to watch the browser |

## Running against a local instance

```bash
export AGENTGAUNTLET_BASE_URL=http://localhost:3080
export HEADLESS=false
node agent.js
```

## What it does

1. Creates a session via the cart-checkout API
2. Submits an honest browser fingerprint (no spoofing)
3. Opens the scenario page in Playwright
4. Takes a screenshot at each step and asks Claude to identify the correct item / shipping option
5. Submits answers via the step API
6. Prints the final risk score, tier, and signal breakdown

## Expected output

```
Session: sess_abc123
Cart has 5 items, subtotal $47.50
Step 1 prompt: Click the item whose unit price is between $12 and $18.

Step 1 → selecting item: Wireless Mouse ($14.99)
Step 2 → selecting shipping: Standard ($4.75)

Order summary: subtotal $47.50 + Standard $4.75 + tax $4.16 = $56.41
Step 3 → clicking real button (not the recommended decoy)

─────────────────────────────────
RESULT
Outcome:    completed
Risk score: 62/100
Tier:       step_up
Action:     step_up
Signals:    webdriver, no_canvas_hash, no_audio_hash
─────────────────────────────────
```

The score will be high because we submit `webdriver: true` and no canvas/audio hashes — those are honest signals that the benchmark correctly flags. Improving the score is the challenge.
