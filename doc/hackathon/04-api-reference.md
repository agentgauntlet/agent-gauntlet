# API reference

The endpoints your agent actually calls. For the full route table, see the source — this doc covers what you need.

Base URL: `https://agentgauntlet.ai` (or `AG_BASE_URL` if overridden).

## Authentication

Two header schemes coexist:

| Header | Used by |
|---|---|
| `x-api-key: agg_…` | Agent-builder API (`/api/keys`, `/api/v2/*`, `/api/login/*`, `/api/payment/*`, etc.) — i.e. **every endpoint your agent uses to run scenarios** |
| `Authorization: Bearer agg_…` | The events module (`/api/events/:id/join`) — joining a hackathon |

The starter's `lib/agg-client.js` defaults to `x-api-key`. Use it for everything except the events join flow.

---

## /api/keys/me

Look up your own key info. Useful for verifying your `.env` works before launching a browser.

```
GET /api/keys/me
x-api-key: agg_…
```

Response:

```json
{
  "ok": true,
  "name": "your-name",
  "email": "...@...",
  "tier": "free",
  "createdAt": 1779200000000,
  "lastUsed": 1779210000000,
  "runsToday": 17,
  "dailyLimit": 100
}
```

During an active event you joined, `dailyLimit` is the elevated event quota (typically 1000).

---

## /api/v2/session (cart-checkout)

Start a cart-checkout session.

```
POST /api/v2/session
x-api-key: agg_…
Content-Type: application/json

{ "mode": "cv" }   // or omit body for headless mode
```

CV mode response:

```json
{
  "sessionId": "1a35b6cc9eecaf558ed3acc40b55891d",
  "token": "f7a8b3...",
  "mode": "cv",
  "scenarioUrl": "https://agentgauntlet.ai/v2?sid=...&tok=...",
  "tasks": {
    "step1": "Select the cart item whose unit price is between $8 and $65...",
    "step2": "Choose the shipping option whose cost is between $13.18 and $20.25...",
    "step3": "Click the checkout button that is NOT marked as Recommended..."
  },
  "requireFingerprint": true,
  "risk": { ... }
}
```

In CV mode, your browser navigates to `scenarioUrl` and the page handles fingerprint submission + step POSTs. Your agent just clicks elements.

Headless mode response (no `scenarioUrl`, structured cart data instead):

```json
{
  "sessionId": "...",
  "token": "...",
  "mode": "headless",
  "cart": [ { "id": "...", "name": "Macbook Air", "qty": 1, "unitPrice": 92.50, "emoji": "..." }, ... ],
  "subtotal": 195.30,
  "step1": { "prompt": "...", "low": 51, "high": 114 },
  ...
}
```

Other scenarios follow the same pattern at their own prefix: `/api/payment/session`, `/api/login/session`, `/api/search/session`, `/api/auction/session`, `/api/crypto/session`, `/api/captcha/session`.

---

## /api/<scenario>/fingerprint

Submit the browser fingerprint. Required before the platform will accept step answers.

In CV mode, the **page does this for you** during session resume. You do NOT need to call this from your agent. (Calling it returns 409 `fingerprint_already_received` if you do.)

In headless mode, you need to launch a browser briefly to collect real fingerprint values and POST them yourself:

```
POST /api/v2/fingerprint
Content-Type: application/json

{
  "sessionId": "...",
  "token": "...",
  "fingerprint": {
    "userAgent": "...",
    "platform": "MacIntel",
    "language": "en-US",
    "screen": { "width": 1440, "height": 900 },
    "webdriver": false,
    "hasChrome": true,
    "plugins": ["PDF Viewer", "..."],
    "timezone": "America/Los_Angeles",
    "canvasHash": "...",
    "audioHash": "..."
  }
}
```

The fingerprint endpoint doesn't need `x-api-key` — it validates via sessionId+token.

---

## /api/<scenario>/step

Submit a step answer (headless mode only — CV mode pages do this internally).

```
POST /api/v2/step
Content-Type: application/json

{
  "sessionId": "...",
  "token": "...",
  "step": 1,
  "answer": { "itemId": "..." },
  "telemetry": { /* see telemetry shape */ }
}
```

The telemetry payload reports mouse/keyboard/scroll/focus events the browser saw during the step. The platform extracts behavioral signals from this. **Skipping or zeroing the telemetry blocks the session immediately.** Collect it from real DOM events on the page.

In CV mode you don't post `step` directly — the page does it for you after it captures real telemetry during your clicks.

---

## /api/session/:id/result

**The most important endpoint for tuning.** Read this after every run.

```
GET /api/session/<sessionId>/result
x-api-key: agg_…
```

Three response tiers depending on your key:

**Free tier:**
```json
{
  "session_id": "...",
  "scenario": "cart",
  "outcome": "block",
  "risk_score": 100,
  "risk_tier": "high",
  "elapsed_ms": 8420,
  "signals": ["navigator_webdriver", "wrong_item_step1", "synthetic_click_dwell"],
  "handle": "your-handle"
}
```

**Event / Pro / Enterprise tier** (adds full signal counts):
```json
{
  "session_id": "...",
  "scenario": "cart",
  "outcome": "block",
  "risk_score": 100,
  "risk_tier": "high",
  "elapsed_ms": 8420,
  "signal_counts": {
    "navigator_webdriver": 1,
    "wrong_item_step1": 1,
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

**Anonymous** (no key): 401.

Retained for 7 days, then deleted. The cumulative leaderboard data is preserved separately (see `gauntlet.leaderboard_entries`).

---

## /api/events/:id

Public event info.

```
GET /api/events/aihack2026
```

Response:
```json
{
  "event_id": "aihack2026",
  "name": "AI Hackathon 2026",
  "start_at": 1779200000000,
  "end_at":   1779230000000,
  "active":   true,
  "member_count": 47
}
```

No auth. Returns 404 for non-public or unknown events.

---

## /api/events/:id/join

Join an event with your agg_ key. Note the Bearer auth — only place in the API that uses it.

```
POST /api/events/aihack2026/join
Authorization: Bearer agg_yourkeyhere
Content-Type: application/json

{
  "joinCode": "HACK-7K4Q",
  "displayName": "Your Name"     // optional
}
```

Response:
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

After joining, your AG_KEY's daily limit jumps to the event-tier override (typically 1000) for the duration of the event window.

---

## /api/events/:id/leaderboard

Event-scoped leaderboard. Public, no auth.

```
GET /api/events/aihack2026/leaderboard?limit=50
```

Response:
```json
{
  "event_id": "aihack2026",
  "name": "AI Hackathon 2026",
  "active": true,
  "member_count": 47,
  "total_runs": 312,
  "entries": [
    {
      "rank": 1,
      "display_name": "Alice",
      "cum_score": 145,
      "sum_best_score": 45,
      "scenarios_attempted": 6,
      "scenarios_total": 7,
      "min_score": 5,
      "max_score": 22,
      "total_runs": 12,
      "masked_key": "agg_3f2c9b…"
    },
    ...
  ]
}
```

---

## /api/events/:id/recent

Recent activity feed for the bigscreen view.

```
GET /api/events/aihack2026/recent?since=<epoch_ms>&limit=20
```

`since` defaults to 5 minutes ago. Returns individual recent runs (not aggregates):

```json
{
  "event_id": "aihack2026",
  "since": 1779209700000,
  "now":   1779210000000,
  "recent": [
    {
      "session_id": "...",
      "display_name": "Alice",
      "scenario": "cart-checkout",
      "outcome": "complete",
      "risk_score": 12,
      "risk_tier": "low",
      "ended_at": 1779209995000
    },
    ...
  ]
}
```

---

## /api/health

Tiny ping. Used by the connectivity-check page for reachability + clock skew.

```
GET /api/health
```

Response:
```json
{
  "ok": true,
  "now": 1779210000000,
  "app": "agentgauntlet",
  "scenario": "cart"
}
```

No auth. `Cache-Control: no-store`.

---

## /api/detect/echo-ja3

Reports the JA3 hash the server saw on your TLS handshake.

```
GET /api/detect/echo-ja3
```

Response:
```json
{
  "ok": true,
  "https": true,
  "captured": true,
  "ja3": "abc123def456...",
  "knownProxy": false
}
```

Used by the connectivity-check page. `knownProxy: true` means your hash matches a known automation TLS profile.

---

## Rate limits

| Bucket | Limit | When it fires |
|---|---|---|
| Daily (per-key) | 100 (free) / 1000 (event) | At `/api/v2/session` (or per-scenario equivalent) |
| Burst (per-key, per-minute) | varies by endpoint | Result reads, detect calls, event reads |
| Registration (per-IP, per-day) | 5 new keys/IP/day | `/api/keys/register` |
| Anonymous (per-IP, per-day) | low | Pre-auth endpoints |

Hitting a rate limit returns 429 with a JSON body explaining which limit fired:

```json
{ "ok": false, "reason": "daily_limit_exceeded", "runsToday": 100, "dailyLimit": 100,
  "hint": "Upgrade to Pro for higher limits." }
```

---

## Error response shape

The agent-builder API returns errors as JSON:

```json
{ "ok": false, "reason": "<machine-readable>", "hint": "<human-readable>" }
```

The events API returns:

```json
{ "error": "<machine-readable>" }
```

For HTTP `5xx` responses, the body may be plain text. `lib/agg-client.js` retries 5xx up to 3 times with exponential backoff.
