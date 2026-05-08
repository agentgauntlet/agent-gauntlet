# AgentGauntlet demo agents

Baseline agents for two scenarios. Both use Claude + Playwright for fingerprinting.

## Agents

| File | Scenario | How it works |
|---|---|---|
| `agent.js` | Cart checkout (v2) | Screenshots the page, uses Claude vision to read items/prices/buttons |
| `captcha-agent.js` | Image CAPTCHA | Receives 9 PNG images via API, sends them all to Claude in one message |

## Quickstart

```bash
cd examples/demo-agent
npm install
npx playwright install chromium

export ANTHROPIC_API_KEY=sk-ant-...
export AGENTGAUNTLET_API_KEY=agg_...   # optional — free at agentgauntlet.ai/keys.html

# Cart checkout — CV mode (default)
node agent.js

# Cart checkout — headless mode (structured JSON, no vision)
AGENT_MODE=headless node agent.js

# Image CAPTCHA
node captcha-agent.js
```

## Options

| Env var | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Your Anthropic API key |
| `AGENTGAUNTLET_API_KEY` | none | Free key for leaderboard tracking |
| `AGENTGAUNTLET_BASE_URL` | `https://agentgauntlet.ai` | Override for local self-hosted runs |
| `AGENT_MODE` | `cv` | Cart agent only: `cv` or `headless` |
| `HEADLESS` | `true` | Set to `false` to watch the fingerprint browser step |

## Running against a local instance

```bash
export AGENTGAUNTLET_BASE_URL=http://localhost:8080
node agent.js
node captcha-agent.js
```

## How the CAPTCHA agent works

1. `POST /api/captcha/session` — server returns a 3×3 grid of 9 base64 PNG images + instruction (e.g. "Select all squares containing a traffic light")
2. Launches Playwright briefly to compute a real canvas/audio fingerprint
3. Sends all 9 images to Claude in one multi-image message
4. Claude returns a JSON array of matching indices, e.g. `[0, 3, 7]`
5. Waits 3–6 seconds (submitting instantly triggers `captcha_solved_too_fast`)
6. `POST /api/captcha/solve` with the selected image IDs + telemetry

## How the cart checkout agent works

### CV mode (default)
1. `POST /api/v2/session` with `{ mode: "cv" }` — returns task descriptions + scenario URL
2. Opens the page in Playwright; page resumes the existing session via URL params
3. Computes and submits fingerprint via API
4. Screenshots each step → sends to Claude → clicks the identified element
5. Page submits each step to the server; agent reads outcome from terminal card

### Headless mode
1. `POST /api/v2/session` — returns structured cart data with item IDs and price ranges
2. Finds correct item and shipping by comparing prices mathematically
3. Submits answers by ID — no browser or vision model needed for the task steps
