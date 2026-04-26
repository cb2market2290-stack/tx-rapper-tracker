# Deploy verification log

A running record of "I built the bundle, then I drove a real client through
a real tunnel and it works." The live commit hash is the contract — if you
can't tell what code was tested by reading git log around that timestamp,
the entry is useless.

Quick-tunnel URLs (`*.trycloudflare.com`) rotate on every cloudflared restart
so they're worthless for follow-up; the verified-bundle commit hash is what
matters here.

## 2026-04-26 — Phase 2d + 2e.A + 2e.B verified via Cloudflare quick tunnel

**Bundle:** main @ `3279513` (Phase 2e.B: admin re-extract UI), which
sits on top of `2d79e29` (Phase 2e.A frontend) → `f24b9d9` (Phase 2e.A
backend) → `5cd7e56` (Phase 2d collapse).

**Tunnel:** `cloudflared tunnel --url http://localhost:8787` →
quick-tunnel URL captured from log; smoke ran via `--resolve` to pin
DNS (osascript shell had a stale-resolver quirk).

**Smoke (10/10 PASS):**

| § | What | Result |
|---|------|--------|
| 1 | `GET /health` (public) | 200 `{ok:true}` |
| 2 | `GET /api/auth/me` no cookie → 401 | 401 unauthenticated |
| 3 | `POST /api/auth/signup` via tunnel | 201, session cookie set |
| 4 | `GET /api/auth/me` with cookie | 200, user resolved |
| 5 | `GET /api/payments/status` (anon) | 200, enabled=false |
| 6 | `GET /api/payments/tiers` (Phase 2e.A) | 200, 3 tiers (free/pro/premium) |
| 7 | Admin login + `GET /api/admin/stats` | 200/200, 22 users |
| 8 | `GET /api/admin/extraction-status` (Phase 2e.B) | 200, all 7 counters present |
| 9 | `GET /api/admin/extraction-jobs?limit=5` (Phase 2e.B) | 200, kind=admin.extraction_jobs |
| 10 | Logout both | OK |

**Why a quick tunnel and not a named one:** the dev box doesn't have
`~/.cloudflared/cert.pem` provisioned. The Phase 2d code is verified
end-to-end through Cloudflare's edge either way — graduating to a named
tunnel is just `cloudflared tunnel login && cloudflared tunnel create`
plus a `config.yml` (see DEPLOY.md §5). No code change needed.

**Smoke harness:** `tx-tunnel-smoke.sh` at the repo root — drop-in
replacement for `scripts/test-tunnel.sh` that pins DNS via `--resolve`.
Reads the tunnel URL from `/tmp/tx-tunnel.log`, resolves IPs out-of-band
via `dig`, then walks the full smoke. Doesn't need to live in the
backend tree because it's an external-client harness.
