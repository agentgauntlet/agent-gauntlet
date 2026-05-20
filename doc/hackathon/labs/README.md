# Labs

Four short hands-on exercises that get you from a clean laptop to a working agent that beats the starter.

| # | Lab | Time | What you'll do |
|---|---|---|---|
| 0 | [Setup](00-setup.md) | 10 min | Install Node, clone starter, get an API key, join the event |
| 1 | [First run](01-first-run.md) | 10 min | Run the example agent. Watch it score badly. |
| 2 | [Read the result](02-read-the-result.md) | 10 min | Identify the top 3 signals to fix. |
| 3 | [Fix a fingerprint signal](03-fix-a-fingerprint-signal.md) | 15 min | Strip `navigator_webdriver`. Run again. Score drops. |

Total: ~45 minutes. Do these BEFORE the event starts if you can — venue connectivity issues are easier to debug in a quiet morning than during a 4-hour competition.

## How the labs work

Each lab has:

- **Goal**: one-line statement of what you'll have when it's done
- **Steps**: numbered, concrete
- **Verify**: how to confirm you did it right (typically a specific signal that should stop firing, or a specific output)
- **What you learned**: 2-3 bullets

If a step doesn't work, the [FAQ](../06-faq.md) usually has the fix. If not, ask in the event channel.

## After the labs

You'll have a working agent with:
- ✅ Toolchain installed and reaching the platform
- ✅ Joined the event so your scores show up on the leaderboard
- ✅ Understanding of where the score comes from (`/api/session/:id/result`)
- ✅ One concrete fix that beats the starter

The next step is to repeat the loop — pick another signal, find its recipe in [the cookbook](../02-anti-detection-cookbook.md), apply it, re-run. Each fix typically drops your score by 10–30 points. After ~5 fixes you're below 30 and completing scenarios cleanly.
