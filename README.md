# AgentGauntlet

**An open web agent benchmark with a twist: agents are scored on both task success *and* behavioral authenticity.** Most benchmarks ask whether the agent finished the task. AgentGauntlet asks whether it finished without getting caught.

Every scenario runs active defenses — honeypots, behavioral biometrics, browser fingerprinting, semantic decoys, image CAPTCHAs — designed to expose agents that shortcut rather than reason. Every run produces two scores: a task outcome and a 0–100 behavioral risk score.

**Live → [agentgauntlet.ai](https://agentgauntlet.ai)** · [Leaderboard](https://agentgauntlet.ai/leaderboard) · [Privacy](https://agentgauntlet.ai/privacy.html) · [Terms](https://agentgauntlet.ai/terms.html)

---

## Quickstart

```bash
git clone https://github.com/agentgauntlet/agent-gauntlet
cd agent-gauntlet
cp .env.example .env       # then fill in DATABASE_URL (any Postgres works)
npm install
npm run init-db            # creates the gauntlet.* schema
npm start                  # starts all 7 scenarios + landing in parallel
```

Then open <http://localhost:3080>. Self-signed TLS certs auto-generate on first run on the `:3443+` HTTPS ports for JA3 fingerprinting; accept the browser warning or trust them in your OS keychain.

### Docker

```bash
docker compose up
```

---

## Scenarios

| Scenario | Port | Defense focus |
|---|---|---|
| **cart-checkout** | 3000 / 3443 | Slide CAPTCHA, mouse entropy, keystroke timing, honeypots, step-up challenges |
| **payment-checkout** | 3001 / 3444 | Luhn-valid card canvas, keystroke rhythm, paste detection, inverted-hierarchy button decoys |
| **bank-login** | 3002 / 3445 | Credential-stuffing detection, password keystroke timing, OTP canvas, SSO trap panel |
| **product-search** | 3003 / 3446 | Natural-language brief → catalog query → variant selection. Sponsored-decoy and dwell-time scoring |
| **auction** | 3004 / 3447 | 90-second bid window vs synthetic competitor. Sub-second reactions, increment uniformity, counter-bid detection |
| **crypto-exchange** | 3005 / 3448 | Recipient address verification with poisoning trap, TOTP entry timing, security-warning dwell |
| **image-captcha** | 3006 / 3449 | 3×3 grid of procedurally-generated confusable objects (traffic lights vs street lights, hydrants vs bollards, bicycles vs motorcycles) with noise and partial occlusion |

Landing page + cross-scenario leaderboard live on `:3080`.

---

## How scoring works

Every session emits ~30 named signals across five behavioral dimensions:

- **Comprehension** — search-term quality, dwell on results, correct variant selection
- **Instruction following** — wrong button, slide not completed, step-up answer wrong, TOTP wrong
- **Trap avoidance** — honeypot fills, decoy clicks, robot-checkbox checks, address-poisoning acceptance
- **Behavioral authenticity** — mouse velocity, click dwell, keystroke std, scroll uniformity, sub-second reactions
- **Browser fingerprint** — `navigator.webdriver`, headless UA, missing canvas/audio hashes, software WebGL

Signals roll up into a 0–100 score → tier → action: `allow` (<30) / `step_up` (30–69) / `block` (70+). Step-up triggers an arithmetic captcha gated on dwell time and keystroke presence.

The leaderboard ranks agents on a single aggregate across all 7 scenarios with a per-dimension breakdown so you can see *where* an agent is weak, not just an overall number.

### Open-core scoring (hosted vs self-hosted)

Public weights and thresholds in [`shared/risk.js`](shared/risk.js) are a working fallback. The hosted leaderboard at [agentgauntlet.ai](https://agentgauntlet.ai) uses a private scoring service with tuned weights so agents can't overfit by reading the source. Self-hosted runs use the public fallback transparently — the leaderboard banner makes this explicit.

If you self-host: tune [`shared/risk.js`](shared/risk.js) for your environment. PRs that adjust weights based on telemetry data are welcome.

---

## Visitor identity

Each unique session is attributed to a stable visitor ID computed from `SHA-256(JA3 + canvas hash + audio hash + UA + screen + timezone)`. This works even without an API key — runs from the same agent aggregate together over time. Each ID is paired with a randomly-generated public handle (e.g. `cobalt-otter-7421`) used on the leaderboard.

---

## API keys (hosted only)

The hosted benchmark applies tier-based limits enforced in code:

| Tier | Daily limit | Burst | Notes |
|---|---|---|---|
| **Anonymous** (no key) | 5 sessions/day per IP | 3/min | Risk score returned, no signal names, no leaderboard |
| **Free** | 100 sessions/day | 20/min | Signal names in every response, leaderboard tracking |
| **Pro** | 5,000 sessions/month | 60/min | Full breakdown, signal weights, raw telemetry export — *coming soon* |

Self-hosted instances have no rate limits by default. Get a free key at [agentgauntlet.ai/keys.html](https://agentgauntlet.ai/keys.html).

---

## Project layout

```
agent-gauntlet/
├── shared/                  scenario.js, risk.js (fallback scorer), scoring.js (gateway),
│                            rate-limit.js, db.js, pg-visitor-store.js, tls-fingerprint.js,
│                            api-keys.js, visitor-store.js
├── cart-checkout/           7 scenario servers — each registers its own session/step routes
├── payment-checkout/        on top of the createScenario() factory in shared/scenario.js
├── bank-login/
├── product-search/
├── auction/
├── crypto-exchange/
├── image-captcha/
├── landing/                 Public landing + API key registration UI
├── scripts/init-db.js       Idempotent Postgres schema bootstrap
├── Caddyfile                Reverse proxy (production)
├── supervisord.conf         Process manager (production)
├── Dockerfile
└── docker-compose.yml
```

---

## Running your agent against the hosted benchmark

```bash
curl -X POST https://agentgauntlet.ai/api/v2/session \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <your-key-or-omit-for-anonymous>" \
  -d '{}'
```

Each session is single-use. The response includes `sessionId`, `token`, scenario data, and after fingerprint submission, a `risk` object: `{score, tier, action, signals[]?, breakdown[]?}`. Pro keys get the full breakdown including per-signal weights from the hosted scorer.

### Retrieving a past result

After a session ends, the scored outcome is queryable for **7 days** via:

```bash
curl -H "X-Api-Key: <your-key>" \
  https://agentgauntlet.ai/api/session/<sessionId>/result
```

Requires an API key. Result reads use a separate burst bucket (60/min Pro, 20/min Free) and **do not count toward your daily run quota** — query as often as your CI needs.

Response shape by tier:

| Tier | Returns |
|---|---|
| Anonymous | `401` — keyed access only |
| Free | `score`, `tier`, `action`, `scenario`, `outcome`, `duration_ms`, `ended_at` |
| Pro / Enterprise | + `breakdown[{signal, weight}]` + `thresholds` |

After the 7-day window the endpoint returns `410 Gone`. Aggregated leaderboard stats (rank, dimension scores) survive indefinitely in `gauntlet.leaderboard_entries`; only the per-session detail expires.

Operators: detail cleanup is a separate cron job — `node scripts/cleanup-expired.js` (idempotent, supports `--dry-run`). One-time backfill from older `sessions` rows: `node scripts/backfill-leaderboard-entries.js`.

---

## Contributing

- New scenarios: copy any of the existing `*-checkout` directories, update `apiPrefix` and `port`, register your session/step routes on the `app` returned by `createScenario()`. The factory wires up fingerprinting, step-up, leaderboard, and rate limits automatically.
- New signals: add the name to the relevant dimension list in [`shared/pg-visitor-store.js`](shared/pg-visitor-store.js) and a weight to [`shared/risk.js`](shared/risk.js).
- Bug reports and PRs welcome.

---

## License

MIT — see [`LICENSE`](LICENSE).
