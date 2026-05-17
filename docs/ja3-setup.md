# JA3 fingerprint capture — operator setup

`/api/detect/score` looks at three request headers (in priority order) to find the real client's JA3 hash:

| Header           | Source                                         |
|------------------|------------------------------------------------|
| `Cf-Ja3-Hash`    | Cloudflare Bot Management (paid plan)          |
| `X-Ja3`          | Caddy `tls-fingerprint` plugin, custom proxies |
| `X-Ja3-Hash`     | Legacy variant some proxies emit               |

If any of these arrives with a hash matching the curated list in [`shared/ja3-known.js`](../shared/ja3-known.js) (curl, Python requests, Go HTTP client, node-fetch, axios, Playwright/Puppeteer headless Chromium), the `known_bot_ja3` signal fires (weight 70 → tier `high` → action `block`).

On free-tier setups where no JA3 header is present, the signal simply doesn't fire — fingerprint + behavioral signals still drive scoring. JA3 is purely additive.

## Cloudflare Bot Management

Available on Enterprise + the Bot Management add-on (~$200/mo on Pro plans, included on Enterprise).

1. Enable Bot Management for the zone (`agentgauntlet.ai`).
2. Configure a Transform Rule to copy the bot management fields to a header:
   ```
   Name:  Set ja3 hash header
   When:  All incoming requests
   Then:  Set static header
          - Header name:  Cf-Ja3-Hash
          - Header value: cf.bot_management.ja3_hash
   ```
3. Confirm on origin by `tail`ing logs — every request from a real Chrome should carry `Cf-Ja3-Hash`; the value should match across consecutive requests from the same client.

## Caddy with the `tls-fingerprint` plugin

For self-hosted setups without Cloudflare Bot Management:

1. Build Caddy with the [`caddy-l4`](https://github.com/mholt/caddy-l4) + a JA3 module. (As of 2026, several community modules exist; pick the most maintained at deploy time. The `caddy-mathiasvr/tls-fingerprint` fork is a reasonable starting point.)
   ```bash
   xcaddy build --with github.com/mholt/caddy-l4 \
                --with github.com/mathiasvr/caddy-tls-fingerprint
   ```
2. Update the `Caddyfile` to forward the JA3 hash as a header:
   ```caddy
   :443 {
       tls_fingerprint  # registers the JA3 hash on req context

       header_up X-Ja3 {tls.fingerprint.ja3.hash}

       handle /api/detect/* {
           reverse_proxy localhost:3000
       }
       # ... other routes
   }
   ```
3. Redeploy. Verify via `curl -k https://localhost/api/detect/token …` from a known-bad client — `known_bot_ja3` should fire in the score.

## Verifying

The fastest way to confirm the pipeline:

```bash
# From any machine, hit /api/detect/score with a fake "curl JA3" header.
# The server treats Cf-Ja3-Hash as authoritative — only real proxies should
# inject it, but a request-level test bypasses that for verification.
curl -X POST https://agentgauntlet.ai/api/detect/score \
  -H 'Content-Type: application/json' \
  -H 'Cf-Ja3-Hash: 6fa3244afc6bb6f9fad207b6b52af26b' \
  -d '{"token":"<valid_token>","bundle":{"fingerprint":{},"telemetry":{}}}'
```

A clean fingerprint+telemetry bundle alone scores 0. Add the JA3 header → score 70+, action `block`.

In production, this header MUST come from the trusted upstream (Cloudflare or your Caddy build). Strip any client-supplied `Cf-Ja3-Hash` at the edge to prevent attackers from spoofing themselves out of detection (they can't — the value being a known-bad hash would only hurt them — but stripping is best practice anyway).

## Why not parse the full TLS handshake at our Node process?

The existing `shared/tls-fingerprint.js` already does this for direct HTTPS connections (each scenario's `:3443+` ports). In production, however, traffic reaches Node via Cloudflare → Caddy → upstream, so the TLS handshake we see is from Cloudflare, not the client. The proxy plugin is the only way to capture the *real* client's JA3.

## Extending the known-bad list

`shared/ja3-known.js` is a Set of hex MD5 strings. Adding a new entry:

1. Capture the candidate hash from a real session (Wireshark + the `ja3` tshark filter, or any JA3 logger on your proxy).
2. Verify it's a stable hash across at least three independent sessions of the same tool — drifting hashes (e.g. Chrome rolling out a new cipher order) belong in a different list, not here.
3. Add to `KNOWN_BOT_JA3`, commit, redeploy.

Keep the list tight — false positives on real browsers cost us customers. When in doubt, use behavioral signals instead.
