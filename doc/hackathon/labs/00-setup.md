# Lab 0 — Setup

**Goal**: a laptop that can run the starter agent and join your event.

**Time**: 10 minutes (most of it is `npm install`).

---

## Pre-requisites

- Node.js 20 or newer (`node --version`)
- A GitHub account
- ~500 MB free disk space (Playwright + Chromium)

If `node --version` says < 20, install from https://nodejs.org or via your package manager.

## Step 1 — Get an AgentGauntlet API key

1. Open https://agentgauntlet.ai/keys.html
2. Click "Sign in with GitHub" (or LinkedIn)
3. Copy the `agg_…` key shown after signin

Keep this somewhere temporary — you'll paste it into `.env` in the next step.

## Step 2 — Clone the starter

```bash
git clone https://github.com/agentgauntlet/agent-gauntlet-starter.git
cd agent-gauntlet-starter
npm install
```

The `npm install` step downloads Chromium for Playwright (~150 MB). One-time. If you see "Chromium downloaded" near the end, you're set.

## Step 3 — Configure `.env`

```bash
cp .env.example .env
```

Open `.env` in your editor and set:

```
AG_KEY=agg_yourkeyhere
LLM_PROVIDER=none
```

Don't worry about the LLM key yet — we'll use the no-LLM fallback for the first run.

## Step 4 — Verify connectivity

Open your event's connectivity check page:

```
https://agentgauntlet.ai/event/<event-slug>/check
```

If you don't know the event slug yet, use `https://agentgauntlet.ai/event/preflight/check` — works identically.

Wait for the 8 checks to complete. You want **mostly green**. Yellow is OK on the LLM provider rows if you're not using one. Red on AgentGauntlet platform reachable = you can't proceed; ask the organizer about network access.

## Step 5 — Join the event

Get the join code from your event organizer (typically shown on a slide at the opening). It looks like `HACK-7K4Q`.

Then:

```bash
curl -X POST https://agentgauntlet.ai/api/events/<event-slug>/join \
  -H "Authorization: Bearer $(grep '^AG_KEY=' .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"joinCode":"HACK-7K4Q","displayName":"Your Name"}'
```

Replace `<event-slug>` with the slug your organizer shared (e.g., `aihack2026`).

Expected response (something like):

```json
{
  "event_id": "aihack2026",
  "name": "AI Hackathon 2026",
  "joined_at": 1779210000000,
  "display_name": "Your Name",
  "daily_limit_override": 1000,
  "start_at": 1779200000000,
  "end_at":   1779230000000
}
```

If you get `invalid_join_code`, double-check the code with the organizer.

---

## Verify

Run:

```bash
curl https://agentgauntlet.ai/api/keys/me \
  -H "x-api-key: $(grep '^AG_KEY=' .env | cut -d= -f2)"
```

Expected:

```json
{
  "ok": true,
  "name": "your-name",
  "tier": "free",
  "dailyLimit": 1000,
  "runsToday": 0
}
```

The `dailyLimit: 1000` confirms event-tier override is active. If you see `100`, the event window hasn't started yet (or you joined the wrong event slug).

## What you learned

- API keys are `agg_…` and live in `.env` as `AG_KEY`
- Joining an event boosts your daily quota — without this, you'll exhaust 100 runs fast
- `/api/keys/me` is the verify-my-key command — useful when things break
- The connectivity check page (`/event/<slug>/check`) is your friend whenever something feels off
