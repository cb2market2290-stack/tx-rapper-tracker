# Phase C — B2B Design Doc
## TX Rapper Tracker

**Status:** C.1 Design
**Estimated:** ~3 days
**Prereqs:** Phase D closed, 58/58 smokes green

---

## Scope

- CSV export per artist (Premium)
- API token generation + revocation (Premium)
- API key authentication middleware
- Separate rate limit for API key requests

---

## Files Added

migrations/015_api_tokens.js
src/services/apiTokens.js
src/routes/export.js
src/routes/apiTokens.js
src/middleware/apiKeyAuth.js
test/export.smoke.js
test/apiTokens.smoke.js

---

## Database — api_tokens table

id SERIAL PK, user_id FK users, token_hash TEXT UNIQUE,
prefix TEXT, label TEXT, created_at TIMESTAMPTZ,
last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ.
Indexes on user_id and token_hash.
One active token per user enforced at service layer.

---

## Token Format

txrt_ + 64 hex chars = 69 chars total.
Generated: crypto.randomBytes(32).toString(hex).
Stored as sha256(token). Raw token shown once, never again.

---

## CSV Format

Headers: date, platform, artist_slug, artist_name, views, rank
Last 90 days, date DESC platform ASC.
Content-Type: text/csv
Content-Disposition: attachment; filename=txrt-{slug}-{date}.csv

---

## Routes

POST   /api/tokens                  create token (Premium, revokes existing)
GET    /api/tokens                  list tokens (prefix + metadata only)
DELETE /api/tokens/:id              revoke token
GET    /api/export/artist/:id/csv   CSV export (session OR X-API-Key, Premium)

---

## Middleware: apiKeyAuth

Reads X-API-Key header, hashes it, looks up api_tokens.
If found + not revoked: attaches user to req, updates last_used_at.
If not found: passes through. Applied globally before route handlers.

---

## Rate Limits

API key requests: 120/min (2x session limit for B2B batch callers).

---

## Smoke Tests (5 new, 63/63 total)

59: token_create     POST /api/tokens -> 200, txrt_ prefix present
60: token_list       GET /api/tokens -> 200, array
61: token_revoke     DELETE /api/tokens/:id -> 200
62: csv_export_shape GET /api/export/artist/:id/csv -> 200, text/csv
63: apikey_auth      GET /api/export with X-API-Key -> 200

---

## Commit Plan

save-progress-C1.sh: design doc + migration
save-progress-C2.sh: services + routes + middleware + smokes

Obsidian backfill at end of C.2.

Generated: Phase C.1 | 2026-05-05
