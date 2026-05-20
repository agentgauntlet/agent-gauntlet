# Quick start

Goal: scoring run in 5 minutes.

## 1. Get an API key

Sign in at https://agentgauntlet.ai/keys.html with GitHub or LinkedIn. Copy your `agg_…` key.

Free tier gets 100 runs/day. During an event, your key is automatically promoted to 1000/day for the event window when you join (next step).

## 2. Join the event

Your event organizer will have shown a join code on a slide — like `HACK-7K4Q`. On a venue laptop:

```bash
curl -X POST https://agentgauntlet.ai/api/events/<event-slug>/join \
  -H "Authorization: Bearer agg_yourkeyhere" \
  -H "Content-Type: application/json" \
  -d '{"joinCode":"HACK-7K4Q","displayName":"Your Name"}'
```

Or visit `https://agentgauntlet.ai/event/<event-slug>` and use the join form (if available).

Display name is optional. If you skip it, your visitor handle is shown on the leaderboard instead.

## 3. Clone the starter

```bash
git clone https://github.com/agentgauntlet/agent-gauntlet-starter.git
cd agent-gauntlet-starter
npm install
```

The `npm install` will download Chromium for Playwright (~150 MB). One-time, takes a minute.

## 4. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
AG_KEY=agg_yourkeyhere    # required
LLM_PROVIDER=none          # or anthropic, openai, google
LLM_API_KEY=               # required if LLM_PROVIDER != none
```

For your first run, leave `LLM_PROVIDER=none`. The agent will still complete using its naive DOM fallback (and score badly — that's the point).

## 5. Run the example agent

```bash
npm run agent -- cart-checkout
```

You should see something like:

```
▶ Scenario:       cart-checkout
  Base URL:       https://agentgauntlet.ai
  Key:            your-name (free)
  LLM:            none
  Mode:           headless

  session: 1a35b6cc9eecaf558ed3acc40b55891d
  step 1: Select the cart item whose unit price is between $8 and $65...
  step 2: Choose the shipping option whose cost is between $13 and $20...
  step 3: Click the checkout button that is NOT marked as Recommended...

  Result:
    Session ID:  1a35b6cc9eecaf558ed3acc40b55891d
    Outcome:     block
    Risk score:  100 (high)

  Signals fired:
    - wrong_item_step1: 1
    - navigator_webdriver: 1
    - default_headless_viewport: 1
    - synthetic_click_dwell: 3

  Tune your agent to stop these from firing. Lower score wins.
```

Almost certainly blocked. That's expected — the example agent is deliberately under-tuned.

## 6. See yourself on the leaderboard

Open `https://agentgauntlet.ai/event/<event-slug>` in a browser. Your name appears with the score you just got. Refresh every 30s.

For the projector view (organizers full-screen this): `https://agentgauntlet.ai/event/<event-slug>/bigscreen`.

## What's next

You have a working agent that loses. The interesting work begins now.

1. Read [01-how-scoring-works.md](01-how-scoring-works.md) — 8 minutes.
2. Read [02-anti-detection-cookbook.md](02-anti-detection-cookbook.md) — pick three signals from your run and follow the recipes to make them stop firing.
3. Run again. Score goes down.
4. Repeat.

Or work through [the labs](labs/README.md) for a guided version of this.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `AG_KEY check failed: ... 401` | Key didn't load. Check `.env` has no quotes around the value. |
| `Playwright didn't install` | Run `npx playwright install chromium` manually. |
| `Anthropic 401` (or similar) | Your `LLM_API_KEY` is bad. Or your account has no balance. |
| `daily_limit_exceeded` | You hit 100 runs today. Either wait for UTC midnight, or [join an active event](02-anti-detection-cookbook.md) to get the elevated quota. |
| `429` rate-limited | You ran too many sessions in one minute. Back off and try again. |
| Agent throws on click timeout | Page didn't render the step. Could be a transient backend hiccup; re-run. |

More in the [FAQ](06-faq.md).
