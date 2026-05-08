# AgentGauntlet demo agent

A minimal baseline agent that runs the **cart-checkout** scenario using Claude claude-sonnet-4-6 + Playwright.

Two modes — pick based on what you're benchmarking:

| Mode | How it works | What it tests |
|---|---|---|
| **cv** (default) | Screenshots the page, uses Claude vision to read item names and prices | Computer vision + reasoning |
| **headless** | Reads structured JSON from the API, no page rendering needed | Logic + API integration |

## Quickstart

```bash
cd examples/demo-agent
npm install
npx playwright install chromium   # only needed for cv mode

export ANTHROPIC_API_KEY=sk-ant-...
export AGENTGAUNTLET_API_KEY=agg_...   # optional — free at agentgauntlet.ai/keys.html

# CV mode (default)
node agent.js

# Headless mode
AGENT_MODE=headless node agent.js
```

## Options

| Env var | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Your Anthropic API key |
| `AGENT_MODE` | `cv` | `cv` or `headless` |
| `AGENTGAUNTLET_API_KEY` | none | Free key for leaderboard tracking + signal names |
| `AGENTGAUNTLET_BASE_URL` | `https://agentgauntlet.ai` | Override for local self-hosted runs |
| `HEADLESS` | `true` | Set to `false` to watch the browser (cv mode only) |

## Running against a local instance

```bash
export AGENTGAUNTLET_BASE_URL=http://localhost:3080
export HEADLESS=false
node agent.js
```

## CV mode — what it does

1. Calls `/api/v2/session` with `{ mode: "cv" }` — server returns natural language tasks and the scenario URL, **no item IDs or prices**
2. Opens the scenario page in Playwright and takes a screenshot
3. Sends each screenshot to Claude with the task description
4. Claude reads item names and prices visually from the page
5. Submits answers by name: `{ cvItemName: "Wireless Mouse" }`, `{ cvShippingName: "Standard" }`
6. For the final step, Claude identifies the non-recommended button visually

## Headless mode — what it does

1. Calls `/api/v2/session` with no mode flag — server returns structured cart data with item IDs and price ranges
2. Finds the correct item and shipping option by comparing prices mathematically
3. Submits answers by ID: `{ itemId: "item-3" }`, `{ shippingId: "s" }`
4. No browser or vision model needed

## Expected output (CV mode)

```
AgentGauntlet demo agent — https://agentgauntlet.ai  [CV mode]

Session: sess_abc123
Scenario URL: https://agentgauntlet.ai/v2

Browser opened: https://agentgauntlet.ai/v2

Step 1 task: Select the cart item whose unit price is between $12 and $18...
Claude identified: "Wireless Mouse"
Step 2 task: Choose the shipping option whose cost is between 5.5% and 8.8%...
Claude identified: "Standard"
Step 3 task: Click the checkout button that is NOT marked as Recommended...
Claude identified non-recommended button: true

─────────────────────────────────
RESULT  [mode: cv]
Outcome:    completed
Risk score: 65/100
Tier:       medium
Action:     step_up
Signals:    webdriver, no_canvas_hash, no_audio_hash
─────────────────────────────────
```

The score reflects honest signals — `webdriver: true` and no canvas/audio hashes. Improving the score is the challenge.
