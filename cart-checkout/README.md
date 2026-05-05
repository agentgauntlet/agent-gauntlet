# Cart Checkout — Anti-Agent Demo

A realistic shopping cart checkout page built to **block AI agents** (web scrapers, autonomous browsing agents, vision-based agents) while letting humans through. First page in a planned suite covering cart, payment, catalog, healthcare, and banking.

## Run

```bash
cd cart-checkout
npm install
npm start
# open http://localhost:3000
```

## How it blocks agents

The page layers four kinds of defenses, scored together on the server.

### 1. Visual challenges (defeat DOM-only agents)

- **Canvas-rendered prices.** Every price (line items, subtotal, shipping, tax, total) is drawn on a `<canvas>`, not as text. Agents that read the DOM see no number — they would need real OCR. Each price has tiny rotation/jitter to defeat trivial template matching.
- **Emoji-based product visual.** Each item shows a glyph rather than an inline `alt`-tagged image.

### 2. Interaction challenges (defeat zero-interaction agents)

- **Slide-to-confirm.** A pointer-driven slider that must reach a server-randomized threshold (90–97%). Headless agents that don't fire `pointermove` events fail.
- **Visual-pick challenge.** "Tap the apple" — the target fruit is randomized per session by the server, and the four fruit cells are shuffled client-side. The agent must perceive the prompt text *and* identify the matching emoji.
- **Behavioral telemetry.** The client tracks mouse moves, computes Shannon entropy of mouse-segment angles, counts keystrokes, scrolls, and focus events. The server rejects sessions with too few moves, low entropy (straight-line cursor), or no scroll activity.
- **Coupon keystroke check.** If the coupon field has a value but no keystrokes were recorded, that means the value was set programmatically (`element.value = '...'`) — blocked.

### 3. Semantic ambiguity (defeat label-following agents)

- **Three "Place Order" buttons.** All look plausible. Only one — chosen by the server, with a randomized `data-btn-id` — is real. The real one has a small visible cue (a ✓ glyph and bolder shade) that humans notice; agents that just click "the first button labeled Place Order" pick a decoy and get blocked.
- **Inverted "I'm not a robot" checkbox.** The label explicitly tells humans to **leave it empty**. Agents trained to auto-tick "not a robot" boxes flip it on and get blocked.

### 4. Honeypots (defeat auto-form-fillers)

- Two off-screen, `aria-hidden`, `tabindex=-1` fields named `email_confirm` and `promo_secondary`. Real users never see them. Naive form-fillers populate every input and trigger a hard fail.

## Server-side scoring

`POST /api/session` issues a per-session token plus the randomized challenge config (real button id, required fruit, slide threshold). `POST /api/checkout` validates the submission against:

| Signal | Failure mode it catches |
|---|---|
| Honeypot fields filled | Auto-form-fillers |
| Wrong button id clicked | Label-following agents |
| Slide not completed | No-pointer-event agents |
| Wrong fruit | Visual reasoning failure |
| "Not a robot" box ticked | Bots that flip every checkbox |
| Page completed in <3s | Direct-API replay |
| <5 mouse moves | Headless / scripted clicks |
| Mouse entropy <0.4 bits | Straight-line cursor paths |
| Coupon filled, 0 keystrokes | Programmatic `.value =` |
| >80 focus/blur events | Tab-thrashing scripts |

Sessions are one-shot (token invalidated on first checkout) and expire after 10 minutes.

## File layout

```
cart-checkout/
├── server.js          # Express server: /api/session, /api/checkout
├── package.json
├── README.md
└── public/
    ├── index.html     # Cart UI + challenge widgets
    ├── app.js         # Client logic, telemetry, submission
    └── styles.css     # Honeypot field positioning
```

## v2 — vision-agent-targeted variant

Open `http://localhost:3000/v2` for the v2 build, which is designed specifically to challenge **modern computer-vision agents** (Claude computer use, GPT-4V/Operator, Gemini-with-screenshots). v1 stops scrapers cold; v2 attacks the failure modes vision agents still have.

### What v2 changes

**Inverted visual hierarchy.** The biggest, brightest, most CTA-looking buttons are *decoys*. The real action is a small plain button or list item. A vision agent that picks "the primary action" by visual saliency ends up clicking a trap.

**Multi-step server-side state machine.** Three steps (cart → shipping → review). The server tracks what step you're on and only accepts answers in order. Each step is one mandatory click. Agents that try to skip directly to checkout get rejected with `step_mismatch`.

**Context-dependent arithmetic prompts.** Each step's correct answer is computed from values on the page:
- Step 1: "Click the item whose unit price is between $X and $Y." X, Y are randomized per session so exactly one item qualifies. The agent must read all unit prices and do a comparison.
- Step 2: "Choose the shipping option whose cost is between A% and B% of your subtotal ($S)." The agent must (a) read the subtotal, (b) compute three percentages, (c) find the one in range. This trips agents that pattern-match on labels rather than reason about content.
- Step 3: Negation prompt — "click the button that is NOT marked Recommended." A flashy gradient button labeled "✨ Place Order (Recommended)" is the trap; a small plain "Place Order" is the real action.

**Carryover defenses.** Canvas-rendered prices, honeypot fields, mouse-entropy/scroll telemetry, one-shot tokens.

### Environment fingerprinting (v2 only)

Before any step is accepted, the client must POST `/api/v2/fingerprint` with a collected browser-environment fingerprint. The server combines this with HTTP-header analysis from the original session request and either accepts or *poisons* the session.

**HTTP-header signals (checked at `/api/v2/session`):**

- *Hard (refuse session):* missing `User-Agent`, `User-Agent` literally contains "Headless", or UA matches non-browser HTTP clients (`curl`, `python-requests`, `Go-http-client`, `node-fetch`, `axios`, `wget`, `okhttp`, `libwww-perl`).
- *Soft (carried forward):* missing `Accept-Language`, missing `Accept-Encoding`, Chrome-claiming UA without `Sec-Ch-Ua` client hints.

**Client fingerprint signals (checked at `/api/v2/fingerprint`):**

- *Hard:* `navigator.webdriver === true`; `Notification.permission === 'denied'` while `permissions.query({notifications}).state === 'prompt'` (a known headless-Chrome leak); `screen.width === 0`.
- *Soft:* WebGL renderer matching `SwiftShader|Mesa Off-Screen|llvmpipe` (software rasterizer); WebGL missing entirely; desktop-Chrome UA with zero `navigator.plugins` (Puppeteer default); desktop-Chrome UA with no `window.chrome`; default 800×600 viewport (Puppeteer/Playwright default); missing canvas/audio fingerprint hash; `requestAnimationFrame` firing in <2 ms (rAF not throttled to display refresh).

**Verdict:** any one *hard* signal poisons the session; **two or more** *soft* signals also poison. Poisoned sessions are blocked with `headless_environment_detected` plus the specific flag list at the next step submission. The client also receives a generic "environment rejected" verdict from `/api/v2/fingerprint` and locks the UI immediately.

**What this catches that the rest of v2 doesn't:**

- `curl`-based scrapers — refused at session creation, before any HTML is even sent.
- Vanilla Puppeteer / Playwright (no anti-detect plugins) — caught by `navigator.webdriver`, default viewport, software renderer, missing plugins, notif mismatch.
- Selenium with default settings — caught by `navigator.webdriver`.
- Most "vision agent in a headless browser" stacks — caught by software renderer + missing plugins + chrome object missing.

**What this does *not* catch on its own:**

- Anti-detect frameworks (puppeteer-extra-plugin-stealth, undetected-chromedriver) that specifically patch these signals.
- Real headed browsers driven by a vision agent — these have valid fingerprints and pass through. The behavioral telemetry + multi-step + inverted-hierarchy challenges are what bite them.

### Extended behavioral telemetry (v2 only)

The client now ships richer behavioral signals on every step submission. Each is computed locally and then aggregated server-side across all three steps; the final checkout call scores the cumulative profile:

- **Mouse velocity profile** — mean and stddev of cursor speed (px/ms). Bots that interpolate at constant speed produce `std/mean < 0.15`, flagged as `uniform_mouse_velocity`.
- **Mouse curvature** — sum of angular changes between consecutive segments. Straight-line cursor paths accumulate near zero across three steps; flagged as `straight_line_cursor`.
- **Click dwell time** — milliseconds between `mousedown` and `mouseup`. Real users dwell 50–200 ms; synthetic `dispatchEvent` clicks dwell <20 ms. Flagged as `synthetic_click_dwell`.
- **Scroll-delta variance** — wheel/touchpad scrolls produce variable, often fractional `deltaY`. Synthetic scrolls produce uniform integer deltas. Flagged as `synthetic_scroll_pattern`.
- **Per-step reaction time** — milliseconds from a new step rendering to the first user event. Bots that pre-parse the response click in <100 ms; flagged as `superhuman_reaction_time`.
- **Keystroke interval stddev** — script-fillers type at constant rate (low std). Flagged as `uniform_keystroke_timing`.
- **Tab visibility changes** — humans sometimes switch tabs; some bots never trigger `visibilitychange`. (Reported but not blocked on directly.)

### TLS-layer fingerprinting (v2 only, HTTPS port)

When you hit `https://localhost:3443/v2`, a custom `net.Server` front-end parses the raw TLS Client Hello bytes off the wire **before** Node's TLS layer touches them. It computes the **JA3** string and MD5 hash from `version, ciphers, extensions, curves, ec_point_formats`, with [RFC 8701 GREASE](https://datatracker.ietf.org/doc/html/rfc8701) values stripped. The captured fingerprint is keyed by the `(remoteAddress, remotePort)` pair and read by Express middleware on the next HTTP request over that connection.

The implementation is in `tls-fingerprint.js` (pure JS, no dependencies). It uses paused-mode `socket.read()` to peek the Client Hello, then `socket.unshift()` to put the bytes back so Node's `https.Server` handles the actual TLS handshake normally.

**TLS heuristics applied at `/api/v2/session`:**

- *Hard:* zero ciphers (parse failure or junk client).
- *Soft:* fewer than 10 ciphers offered (browsers offer 14–30+); missing SNI; missing ALPN; ALPN present but no `h2`/`http/1.1`; **no GREASE values present** (real browsers send GREASE; most non-browsers don't); missing `supported_versions` extension; missing `signature_algorithms`.

The captured JA3 hash for any connection can be inspected at `GET /debug/tls`.

**Reality check on TLS-only catch rates:** modern `curl` 8.x on OpenSSL 3 produces a Client Hello that's *almost* indistinguishable from a real browser — 31 ciphers, 13 extensions, valid SNI, h2 ALPN. The only signal that fires is `no_grease`. Older / simpler clients (Python `requests`, Go default `net/http`, embedded HTTP libraries, `okhttp`) light up several flags. **TLS fingerprinting alone is no longer a strong filter against modern tooling** — its real value is as one signal in a layered system, where it combines with header, fingerprint, behavioral, and reasoning checks to push borderline sessions over the poison threshold.

### Risk-scored thresholds (v2 only)

The previous "any 1 hard signal or 2+ soft signals = block" rule has been replaced by a **weighted risk score** ranging 0–100. Each signal has a tunable weight (see `risk.js`). Total weight maps to one of three tiers:

| Score | Tier | Action |
|---|---|---|
| 0–29 | low | allow |
| 30–69 | medium | **step-up challenge** (math captcha) |
| 70+ | high | block |

This catches borderline sessions that previously slipped through. A curl request with browser-like headers but no GREASE in the TLS Client Hello (a real-world case for modern OpenSSL builds) only has one weak signal and previously passed; under risk scoring it earns 15 points and combines with any other small signal to land in the step-up tier.

**Step-up challenge.** When risk lands in the medium tier, the user must solve a math captcha rendered to a `<canvas>` with per-character font/rotation/jitter and background noise. The verify endpoint requires (a) the correct numeric answer, (b) at least one keystroke recorded on the input field, and (c) a minimum dwell of ~2 seconds before submission. Failure on any pushes the session to the block tier.

**Tunable.** Edit `THRESHOLDS` in `risk.js` to make the system stricter or more permissive without touching call sites. Production deployments would typically run the system in observe-only mode first to calibrate weights against real traffic.

### Visitor history + leaderboard (v2 only)

Each visitor gets a stable identity computed from `SHA-256(JA3 + canvasHash + audioHash + UA + screen + tz)` — first 16 hex chars become the `visitorId`. A deterministic handle like *"Sneaky Salamander #7B3"* is generated from the ID using small adjective/animal word lists.

On every terminal session event (complete, block), the server records the outcome to `.data/visitors.json`:
- visitor handle, first/last seen, visit count
- outcomes: completes, blocks, step-up encounters
- accumulated risk scores (best, worst, avg)
- per-signal counts across all visits
- distinct JA3 hashes and UA strings observed

A public leaderboard at **`/leaderboard`** shows tabs for:
- **Most Stealthy** — lowest avg risk among visitors who completed at least once
- **Most Caught** — most blocks (×10) plus step-ups
- **Most Persistent** — most sessions
- **Most Adaptive** — greatest signal variety across visits (hint that an agent is iterating)
- **Recent** — sorted by last-seen

The leaderboard is intentionally visible to everyone in this build (per the demo's transparency goal); a production deployment would gate it.

**Storage interface.** `visitor-store.js` defines an abstract `VisitorStore` class; the JSON-file `JsonVisitorStore` is the prototype impl. Swapping to SQLite (`better-sqlite3`) or Postgres requires writing a sibling class with the same shape — call sites in `server.js` don't change.

### Live risk badge

The v2 page shows a small badge in the top-right corner displaying the current accumulated risk score, tier, visitor handle, and a breakdown of the top contributing signals with their weights. The badge updates after each phase (session start, fingerprint receipt, each step submission, checkout). For demo purposes this is fully visible; a production deployment would keep this server-side only.

### Updated estimated block rates (v2 with all layers)

| Adversary | v1 | v2 (no fp) | v2 + env fingerprint | v2 + behavioral + JA3 |
|---|---|---|---|---|
| `curl` / Python `requests` | ~100% | ~100% | ~100% (refused at headers) | ~100% (refused at headers) |
| Vanilla Puppeteer/Playwright (no stealth) | ~95% | ~98% | ~99% | ~99.5% |
| Headed browser + scripted automation | ~70% | ~85% | ~90% | **~96%** (behavioral kills synthetic clicks/scrolls) |
| Headed browser + vision agent (no drag) | ~50% | ~80% | ~80% | ~88% |
| Headed browser + computer-use agent | ~25% | ~55% | ~55% | ~70% |
| Anti-detect headless + vision agent | ~30% | ~60% | ~60% | ~78% (behavioral still bites) |

### Why this is harder for vision agents

| Vision-agent shortcut | What v2 does |
|---|---|
| Click the most prominent CTA | The most prominent CTA blocks you |
| OCR the page, find the answer | The answer requires arithmetic over several OCR'd values |
| Follow the label "Recommended" | "Recommended" is a trap on step 3 |
| Skip ahead to a known checkout endpoint | State machine rejects out-of-order steps |
| Standard mouse path | Telemetry accumulated across all 3 steps; low entropy still blocks |

### Estimated block rates (rough)

|  | v1 | v2 |
|---|---|---|
| `curl` / no JS | ~100% | ~100% |
| Vanilla Puppeteer/Playwright (no stealth) | ~95% | **~99%** (fingerprint catches what v1 misses) |
| Headed browser + vision agent, no drag primitive | ~50% | ~80% |
| Headed browser + full computer-use agent (drag + careful reading) | ~25% | ~55% |
| Anti-detect headless + vision agent | ~30% | ~60% (fingerprint patched, but reasoning challenges still bite) |

These are estimates, not measurements — actual rates depend on the agent. v2 is a stronger baseline but still loses against a sufficiently capable agent. The realistic frontier is combining v2-style patterns with environment fingerprinting (TLS, canvas/WebGL fingerprint), which we haven't added here.

## What's next

Same pattern, applied to the other use cases:

- Payment / card entry — bias toward keystroke timing + Luhn-aware decoys.
- Product catalog — anti-scraping focus (canvas prices, randomized DOM order).
- Healthcare portal — semantic-ambiguity heavy (consent flows).
- Bank login — credential-stuffing detection.
