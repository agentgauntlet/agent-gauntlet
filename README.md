# AgentGauntlet

**An open benchmark of realistic web scenarios with active anti-agent defenses.**

AI browsing agents are tested against environments that are trying to detect and block them. Each scenario produces a quantitative risk score. A shared leaderboard tracks agent performance over time.

**Live demo → [agentgauntlet.ai](https://agentgauntlet.ai)**

---

## Quickstart (5 minutes)

### Prerequisites

- Node.js 18+ and npm
- `openssl` on your PATH (for self-signed TLS certs — standard on macOS/Linux)

### Option A — run all scenarios

```bash
git clone https://github.com/your-org/agentgauntlet  # update with actual repo URL
cd agentgauntlet
npm install          # installs concurrently at the root
npm start            # starts all three scenarios in parallel
```

Open:
- **Cart checkout** → http://localhost:3000
- **Payment checkout** → http://localhost:3001
- **Bank login** → http://localhost:3002
- **Leaderboard** → http://localhost:3000/leaderboard

HTTPS endpoints (JA3 fingerprinting active): ports 3443 / 3444 / 3445.  
Self-signed certs are auto-generated on first run; accept the browser warning or trust them in your OS keychain.

### Option B — run a single scenario

```bash
cd cart-checkout && npm install && npm start
# or
cd payment-checkout && npm install && npm start
# or
cd bank-login && npm install && npm start
```

### Option C — Docker

```bash
docker compose up
```

All three scenarios start in parallel. Ports and volumes same as above.

---

## Scenarios

| Scenario | Port | Defense focus |
|---|---|---|
| **cart-checkout** | 3000 / 3443 | Canvas prices, semantic ambiguity, slide-to-confirm, honeypots, behavioral telemetry, TLS/JA3 |
| **payment-checkout** | 3001 / 3444 | Luhn-valid card canvas, keystroke timing on card groups, paste detection, inverted-hierarchy buttons |
| **bank-login** | 3002 / 3445 | Credential-stuffing detection, password keystroke timing, OTP canvas, trap checkbox, decoy SSO panel |

All scenarios share:
- **8-layer defense stack**: canvas rendering, interaction challenges, semantic ambiguity, honeypots, browser fingerprinting, behavioral telemetry, TLS/JA3 fingerprinting, weighted risk scoring
- **Risk scores 0–100** → `allow` (<30) / `step_up` (30–69) / `block` (70+)
- **Step-up math captcha**: triggered at `step_up` threshold; requires correct answer + keystroke + ≥2 s dwell
- **Visitor identity**: SHA-256(JA3 + canvas hash + audio hash + UA + screen + TZ) → stable 16-char ID
- **Leaderboard**: five lenses — Most Stealthy, Most Caught, Most Persistent, Most Adaptive, Recent

---

## Project layout

```
agentgauntlet/
├── shared/                  # risk.js, visitor-store.js, tls-fingerprint.js
├── cart-checkout/           # scenario 1
├── payment-checkout/        # scenario 2
├── bank-login/              # scenario 3
├── doc/product/             # strategy, roadmap, launch post
└── docker-compose.yml
```

---

## Tuning

Signal weights live in [`shared/risk.js`](shared/risk.js). Every signal has a points value (0–90); the sum maps to tier. Weights are first guesses — if you have data showing different values, open a PR.

---

## Running your agent against it

The scenarios are designed to be run by any browsing agent. There are no rate limits. Sessions expire after 15 minutes.

What to look for:
- Which step blocks your agent and with which signals
- Whether behavioral telemetry or static fingerprints catch it first
- Whether your agent reasons correctly about inverted-hierarchy button prompts

HTTPS endpoints give the most signal (TLS/JA3 checks active). HTTP endpoints skip TLS scoring but run all other layers.

---

## License

MIT
