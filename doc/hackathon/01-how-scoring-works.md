# How scoring works

Read this before tuning anything.

## The number that matters

Every session that reaches a terminal state (completed or blocked) has a **risk score** from 0 to 100. **Lower is better.** Thresholds:

| Score | Action | What participants see |
|---|---|---|
| 0–29 | allow | Session completes normally |
| 30–69 | step-up | Mid-flow challenge (TOTP, CAPTCHA-like) |
| 70–100 | block | Session terminated, no further steps allowed |

Your score is the **sum of signal weights** that fired during the run, capped at 100.

## The four detection layers

Each layer contributes signals independently. A single layer can max out the score on its own.

| # | Layer | Weight ceiling | What it inspects |
|---|---|---|---|
| 1 | HTTP headers | 90 | User-Agent, client headers, request shape |
| 2 | TLS / JA3 fingerprint | 80 | The TLS handshake your client sends |
| 3 | Browser fingerprint | 80 | `navigator.webdriver`, plugins, viewport, canvas hash, audio hash, WebGL renderer, etc. |
| 4 | Behavioral telemetry | 60 | Mouse movement, click dwell time, keystroke rhythm, scroll patterns, deliberation pauses |

Signals within a layer are deduplicated to that layer's ceiling. So if you trip three Layer 4 signals worth 30 each (90 total), your Layer 4 contribution caps at 60.

## Where most wins come from

**Layer 4 (behavioral) is where the interesting work is.** The first three layers have a finite list of things to fix — strip `navigator.webdriver`, send realistic headers, use a real browser instead of an HTTP client. Once you've done those, your Layer 1–3 signals are pretty much zero.

Layer 4 is open-ended. There's always more humanization to add: jittered typing rhythm, mouse motion curves, deliberation pauses that vary by step difficulty, scroll-then-read patterns, occasional misclicks-and-corrections. Two well-tuned agents can differ by 20 points purely on Layer 4.

## Challenge gates — the 100-weight kill switches

Some signals are worth **100 weight each**, which means **any single one trips a block regardless of your other layers**. These are:

| Signal | What you did |
|---|---|
| `honeypot_filled` | Filled a hidden/invisible input field |
| `clicked_decoy_step1` | Clicked a visually hidden decoy button |
| `clicked_recommended_decoy` | Clicked the "Recommended" button when the task said to avoid it |
| `wrong_item_step1` | Selected the wrong product / option |
| `address_substitution_accepted` | Submitted a substituted shipping address without noticing |

Plus per-scenario semantic-correctness gates (`wrong_search_terms`, `selected_sponsored_decoy`, `captcha_selected_all`, etc.).

**These are not subtle.** The platform doesn't reward stealth in lieu of solving the task correctly. You can have a 0-score-from-layers-1-3 agent and still get blocked instantly for clicking the wrong checkout button.

Read the task carefully. Verify your target element is visible (`element.offsetParent !== null`, `getBoundingClientRect()` has nonzero size, `getComputedStyle()` doesn't hide it) before clicking.

## Step-up (the 30–69 zone)

Scores in the middle band trigger a mid-flow challenge — typically a small TOTP-style verification. Pass it and the session continues; fail it and you're blocked.

Step-up is designed to be solvable by a careful agent but expensive (in time + LLM calls if you use vision). Avoid the score band entirely if you can — drive your score below 30.

The signal `stepup_failed` is worth 90 weight, so getting a step-up and failing it almost always blocks you.

## What "completion" actually requires

A session "completes" (`outcome: complete`) iff:
1. Final score is `< 70` (below the block threshold)
2. No challenge gate fired
3. The task is actually solved (right item, right button, correct shipping, etc.)
4. Step-up (if triggered) was passed

The leaderboard shows your **cumulative score** across the seven scenarios. Best per-scenario is summed; unattempted scenarios get a +100 penalty each. The math is in [03-scenarios.md](03-scenarios.md).

## What you can NOT do

The platform deliberately does not reward:

- **Faking signals**: there's no way to tell the server "pretend I'm human." The signals are computed from the network + page state you actually produce.
- **Reusing a previous session**: each session gets a fresh randomization. You can't memorize answers.
- **Direct API answers without a browser**: the scoring layers REQUIRE a real TLS handshake, real browser fingerprint, and behavioral telemetry posted from the page. Pure `fetch()` from Node trips Layers 1, 2, 3 immediately.

## Why weights are public

You'll find the open weights in `shared/risk.js` and `shared/scoring.js` of the public repo. They're public because:

- Knowing a signal exists doesn't tell you how to humanize the underlying behavior. `synthetic_click_dwell` is worth 60 weight — you still have to figure out what dwell time is "human."
- Passing all four layers cleanly requires genuine human-like behavior, not signal-targeting. A bot that fakes one signal's surface trips three others.
- Open weights make the leaderboard auditable. You can recompute any score from the result endpoint's `signal_counts`.

The hosted scoring service may use additional un-disclosed weights for edge cases the open weights miss, but the bulk of the score is computable from the public table.

## The debug loop

Every run ends with a sessionId. Hit `/api/session/:id/result` (the starter's runner does this automatically) and look at `signal_counts`. That's your work list. Pick the highest-weight signal and use [the cookbook](02-anti-detection-cookbook.md) to make it stop.

Run again. Score drops. Repeat.
