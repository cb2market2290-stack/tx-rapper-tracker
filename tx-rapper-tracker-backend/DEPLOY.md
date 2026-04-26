# Deploy Guide — TX Female Rapper Tracker Backend

Targeted at a small-scale deploy behind Cloudflare Tunnel. The backend is a
single Node process plus Postgres. No Redis, no workers, no Nginx — the goal
is "runs on one box for months without touching it."

## 1. Host requirements

- Linux box (tested on Ubuntu 22/24) or macOS. Intel or Apple Silicon.
- Node 20 or newer (`node --version`).
- Postgres 14+ (16 used in dev). Any managed provider (Neon, Supabase,
  RDS) works; local install works too.
- Outbound HTTPS to `api.pwnedpasswords.com` and `googleapis.com`.
  If your firewall blocks outbound, set `HIBP_REJECT_THRESHOLD=0`
  to disable the breach check.

## 2. First-time setup

```bash
git clone <repo-url> tx-rapper-tracker-backend
cd tx-rapper-tracker-backend
npm ci --omit=dev
cp .env.production.example .env
# Fill in the .env values — see section 3.
npm run migrate           # creates users, sessions, audit_log, reset tokens
node scripts/check-prod-ready.js
```

If `check-prod-ready.js` prints all green, you're good.

## 3. Required secrets

The three things you MUST change from the example file, in this order:

1. **`SESSION_SECRET`** — 48 random bytes, hex-encoded. Generate it with:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   Losing this invalidates every session cookie. Rotating it logs everyone
   out. Never commit it, never log it.

2. **`DATABASE_URL`** — include `?sslmode=require` on any managed DB. The
   readiness script refuses to start if this looks like localhost while
   `NODE_ENV=production`.

3. **`YOUTUBE_API_KEY`** — restrict the key in Google Cloud Console. Server
   apps should set "API restrictions = YouTube Data API v3" and leave
   referrer restrictions empty. A key restricted to a referrer WILL NOT work
   from a backend.

## 4. Cookies and CORS

The session cookie is HttpOnly, SameSite=Strict, Secure. For the cookie to
actually arrive at the browser you need all three:

- `SESSION_COOKIE_SECURE=true` (the default in prod — the cookie is dropped
  over plain HTTP)
- Site served over HTTPS (Cloudflare Tunnel terminates TLS for you)
- The frontend origin is in `CORS_ORIGINS` and calls `fetch(..., { credentials: 'include' })`

If login succeeds (HTTP 200) but `/api/auth/me` returns 401 right after,
the cookie isn't being stored. Check in order: (a) browser devtools
Application → Cookies for the domain, (b) `SESSION_COOKIE_DOMAIN` matches
the site's apex, (c) the browser isn't blocking third-party cookies.

## 5. Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create tx-rapper-tracker
cloudflared tunnel route dns tx-rapper-tracker tx-rapper-tracker.example.com
```

`~/.cloudflared/config.yml`:
```yaml
tunnel: <tunnel-uuid>
credentials-file: /home/you/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: tx-rapper-tracker.example.com
    service: http://localhost:8787
  - service: http_status:404
```

Run as a service: `sudo cloudflared service install`. Then Cloudflare's edge
sends X-Forwarded-For, and `app.set('trust proxy', 1)` in `src/index.js`
picks up the real client IP so rate limiting works.

## 6. Running the node process

Under systemd on Linux:

```ini
# /etc/systemd/system/tx-rapper-tracker.service
[Unit]
Description=TX Rapper Tracker API
After=network-online.target

[Service]
WorkingDirectory=/opt/tx-rapper-tracker-backend
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/tx-rapper-tracker-backend/.env
StandardOutput=journal
StandardError=journal
User=tx
Group=tx

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now tx-rapper-tracker` and `journalctl -fu
tx-rapper-tracker` for logs. Pino writes JSON; pipe through `pino-pretty`
locally if you want it human-readable.

On macOS dev, the `scripts/restart-server.sh` wrapper is fine — don't
bother with launchd for a dev box.

## 7. Database migrations

`npm run migrate` is forward-only and idempotent — it re-reads
`schema_migrations` and applies only new files. Run it as part of every
deploy before flipping traffic. Migrations live in `migrations/` and are
applied in lexical order, so always name new files `NNN_description.sql`.

Rollback strategy: there isn't one at the code level. If a migration is
destructive and you need to roll it back, write `NNN+1_revert_X.sql` with
the inverse ops and deploy that. Never edit a committed migration file.

## 8. Monitoring

- `/health` returns `{ ok: true }` and doesn't hit Postgres. Good for
  liveness probes.
- Every auth event writes to `audit_log`. To see failed logins:
  ```sql
  SELECT created_at, event, ip, details FROM audit_log
    WHERE event LIKE 'login_%' AND created_at > now() - interval '24 hours'
    ORDER BY created_at DESC;
  ```
- zxcvbn / HIBP rejections also land in `audit_log`
  (`signup_weak_password`, `change_password_weak`).

## 9. What's NOT deployed yet

- Password reset via email — the migration exists
  (`password_reset_tokens`) but no route generates or consumes those
  tokens yet. Waiting on an SMTP provider choice.
- 2FA (TOTP or WebAuthn).
- Admin UI. Everything admin-ish is still raw SQL for now.
