#!/usr/bin/env bash
# Smoke test for admin WRITE endpoints.
#   1.  Non-admin POSTs a write -> 404 (route stays hidden from non-admins)
#   2.  Admin logs in
#   3.  Throwaway user signs up (gets its own cookie jar)
#   4.  Throwaway /api/auth/me -> 200  (baseline: session works)
#   5.  Admin lists sessions, finds throwaway's session row
#   6.  Admin POST /sessions/:id/revoke -> 200
#   7.  Throwaway /api/auth/me with same cookie -> 401 (session is dead)
#   8.  Throwaway signs in again, gets a fresh session
#   9.  Admin POST /users/:id/disable -> 200 with sessionsRevoked >= 1
#  10.  Throwaway tries to login -> 403 account_disabled (distinct from 401 "wrong pw")
#  11.  Admin POST /users/:admin_id/disable -> 400 (self-protection)
#  12.  Admin POST /users/:id/disable twice -> second = 409 already_disabled
#  13.  Admin POST /users/:id/enable -> 200
#  14.  Admin POST /users/:id/enable again -> 409 already_enabled
#  15.  Throwaway logs in again after enable -> 200
#  16.  Admin GET /audit — admin_revoke_session + admin_disable_user + admin_enable_user present
set -u
BASE="${BASE:-http://localhost:8787}"
ADMIN_EMAIL="${ADMIN_EMAIL:-cb2market2290@gmail.com}"
ADMIN_PW='correct-horse-battery-staple-42'
RAND=$RANDOM
TH_EMAIL="admwrite-$RAND@example.com"
TH_PW='throwaway-strong-passphrase-55'
PASS=0
FAIL=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()   { printf '\n===== %s =====\n' "$*"; }
code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

hr "0. signup admin (noop if already exists) + login admin"
curl -sS -o /dev/null -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" >/dev/null 2>&1 || true
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -c /tmp/jar-admin.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}")
code_eq 200 "$CODE" "admin login"
ADMIN_ID=$(python3 -c "import json;print(json.load(open('/tmp/r.json'))['user']['id'])" 2>/dev/null)
if [ -n "$ADMIN_ID" ]; then ok "admin id = $ADMIN_ID"; else bad "could not extract admin id"; fi

hr "1. throwaway signup $TH_EMAIL + baseline /me"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -c /tmp/jar-th.txt -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$TH_EMAIL\",\"password\":\"$TH_PW\"}")
code_eq 201 "$CODE" "throwaway signup"
TH_ID=$(python3 -c "import json;print(json.load(open('/tmp/r.json'))['user']['id'])" 2>/dev/null)
if [ -n "$TH_ID" ]; then ok "throwaway id = $TH_ID"; else bad "could not extract throwaway id"; fi

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-th.txt "$BASE/api/auth/me")
code_eq 200 "$CODE" "throwaway /me works before revoke"

hr "2. non-admin hits write endpoint -> expect 404"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-th.txt -X POST "$BASE/api/admin/users/$TH_ID/disable")
code_eq 404 "$CODE" "non-admin disable -> 404 (route hidden)"

hr "3. admin finds throwaway's session id"
curl -sS -o /tmp/r.json -b /tmp/jar-admin.txt "$BASE/api/admin/sessions?limit=500" >/dev/null
TH_SESSION_ID=$(python3 -c "
import json
rows=json.load(open('/tmp/r.json'))['rows']
for r in rows:
  if r['email']=='$TH_EMAIL':
    print(r['id']); break
")
if [ -n "$TH_SESSION_ID" ]; then ok "found throwaway session $TH_SESSION_ID"; else bad "could not find throwaway session"; fi

hr "4. admin revokes that session"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/sessions/$TH_SESSION_ID/revoke")
code_eq 200 "$CODE" "admin revoke session"

hr "5. throwaway /me with dead cookie -> 401"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-th.txt "$BASE/api/auth/me")
code_eq 401 "$CODE" "throwaway session invalidated"

hr "6. throwaway logs in again for the disable test"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -c /tmp/jar-th.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$TH_EMAIL\",\"password\":\"$TH_PW\"}")
code_eq 200 "$CODE" "throwaway re-login"

hr "7. admin disables the throwaway"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/users/$TH_ID/disable")
code_eq 200 "$CODE" "admin disable user"
SR=$(python3 -c "import json;print(json.load(open('/tmp/r.json'))['sessionsRevoked'])" 2>/dev/null)
if [ "$SR" -ge 1 ] 2>/dev/null; then ok "disable revoked $SR session(s)"; else bad "disable did not report sessionsRevoked ($SR)"; fi

hr "8. disabled user tries to login -> 403 account_disabled"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$TH_EMAIL\",\"password\":\"$TH_PW\"}")
code_eq 403 "$CODE" "login blocked for disabled user (account_disabled, not 401)"

hr "9. admin tries to disable THEMSELVES -> 400"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/users/$ADMIN_ID/disable")
code_eq 400 "$CODE" "self-disable rejected"

hr "10. disable already-disabled user -> 409"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/users/$TH_ID/disable")
code_eq 409 "$CODE" "re-disable returns 409"

hr "11. admin enables throwaway"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/users/$TH_ID/enable")
code_eq 200 "$CODE" "admin enable user"

hr "12. enable already-enabled -> 409"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/users/$TH_ID/enable")
code_eq 409 "$CODE" "re-enable returns 409"

hr "13. enabled user can login again"
# -c refreshes the cookie jar so later tests that need a live throwaway session
# (e.g. /api/artists read) can use it.
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -c /tmp/jar-th.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$TH_EMAIL\",\"password\":\"$TH_PW\"}")
code_eq 200 "$CODE" "login works after enable"

hr "14. audit trail has three admin events for target=$TH_ID"
curl -sS -o /tmp/r.json -b /tmp/jar-admin.txt "$BASE/api/admin/audit?limit=200"
for EV in admin_revoke_session admin_disable_user admin_enable_user; do
  N=$(python3 -c "
import json
rows=json.load(open('/tmp/r.json'))['rows']
n=0
for r in rows:
  if r['event']=='$EV':
    d=r.get('details') or {}
    if d.get('targetUserId')=='$TH_ID' or d.get('sessionId')=='$TH_SESSION_ID' or (d.get('targetUserId') is None and '$EV'=='admin_revoke_session'):
      n+=1
print(n)
")
  if [ "$N" -ge 1 ] 2>/dev/null; then ok "audit $EV present ($N)"; else bad "audit $EV missing"; fi
done

hr "15. artist roster CRUD (add, duplicate-409, archive, unarchive, archived-409)"
TH_ARTIST="Smoke Test Artist $RAND"

# 15a. non-admin hits admin artist list -> 404 (route stays hidden)
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-th.txt "$BASE/api/admin/artists")
code_eq 404 "$CODE" "non-admin /api/admin/artists -> 404 (route hidden)"

# 15b. admin adds a new artist -> 200
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/artists" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TH_ARTIST\"}")
code_eq 200 "$CODE" "admin add artist"
TH_ARTIST_ID=$(python3 -c "import json;print(json.load(open('/tmp/r.json'))['artist']['id'])" 2>/dev/null)
if [ -n "$TH_ARTIST_ID" ]; then ok "new artist id = $TH_ARTIST_ID"; else bad "could not extract artist id"; fi

# 15c. duplicate add -> 409 already_exists
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/artists" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TH_ARTIST\"}")
code_eq 409 "$CODE" "duplicate add -> 409"

# 15d. appears in the signed-in user's roster view
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-th.txt "$BASE/api/artists")
code_eq 200 "$CODE" "throwaway can GET /api/artists"
HAS=$(python3 -c "
import json
rows=json.load(open('/tmp/r.json'))['rows']
print('1' if any(r['name']=='$TH_ARTIST' for r in rows) else '0')
")
if [ "$HAS" = "1" ]; then ok "new artist appears in /api/artists"; else bad "new artist missing from /api/artists"; fi

# 15e. admin archives
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/artists/$TH_ARTIST_ID/archive")
code_eq 200 "$CODE" "admin archive artist"

# 15f. re-archive -> 409 already_archived
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/artists/$TH_ARTIST_ID/archive")
code_eq 409 "$CODE" "re-archive -> 409"

# 15g. archived artist no longer in public roster
curl -sS -o /tmp/r.json -b /tmp/jar-th.txt "$BASE/api/artists" >/dev/null
HAS=$(python3 -c "
import json
rows=json.load(open('/tmp/r.json'))['rows']
print('1' if any(r['name']=='$TH_ARTIST' for r in rows) else '0')
")
if [ "$HAS" = "0" ]; then ok "archived artist removed from /api/artists"; else bad "archived artist still visible"; fi

# 15h. re-add same name while archived -> 409 archived_exists
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/artists" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TH_ARTIST\"}")
code_eq 409 "$CODE" "re-add archived name -> 409"
# errorHandler serializes HttpError.code into the `error` field of the body.
CODE_KIND=$(python3 -c "import json;print(json.load(open('/tmp/r.json')).get('error',''))" 2>/dev/null)
if [ "$CODE_KIND" = "archived_exists" ]; then ok "409 distinguishes archived_exists"; else bad "expected error=archived_exists, got '$CODE_KIND'"; fi

# 15i. unarchive
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/artists/$TH_ARTIST_ID/unarchive")
code_eq 200 "$CODE" "admin unarchive artist"

# 15j. cleanup: archive again so the table doesn't accumulate test rows
curl -sS -o /dev/null -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/artists/$TH_ARTIST_ID/archive" >/dev/null

# 15k. bad body -> 400
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt -X POST \
  "$BASE/api/admin/artists" \
  -H 'Content-Type: application/json' \
  -d '{"name":""}')
code_eq 400 "$CODE" "empty name -> 400"

hr "16. audit trail has admin_add_artist + admin_archive_artist + admin_unarchive_artist"
curl -sS -o /tmp/r.json -b /tmp/jar-admin.txt "$BASE/api/admin/audit?limit=200"
for EV in admin_add_artist admin_archive_artist admin_unarchive_artist; do
  N=$(python3 -c "
import json
rows=json.load(open('/tmp/r.json'))['rows']
n=0
for r in rows:
  if r['event']=='$EV':
    d=r.get('details') or {}
    if d.get('artistId')=='$TH_ARTIST_ID' or d.get('name')=='$TH_ARTIST':
      n+=1
print(n)
")
  if [ "$N" -ge 1 ] 2>/dev/null; then ok "audit $EV present ($N)"; else bad "audit $EV missing"; fi
done

# ============================================================================
# Phase 2e.B — extraction-jobs admin endpoints
# ============================================================================
# Coverage: hidden-from-non-admin, list+filter, retry-not-found, bad body on
# reextract, and the happy path for /artists/:id/reextract using the temp
# artist created back in section 14. The smoke can run with no actual
# extraction jobs in the table (the worker may not have done anything yet)
# — so we don't depend on rows being present, just on the contract.

hr "17. extraction endpoints hidden from non-admin"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-th.txt "$BASE/api/admin/extraction-jobs")
code_eq 404 "$CODE" "throwaway extraction-jobs -> 404"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-th.txt "$BASE/api/admin/extraction-status")
code_eq 404 "$CODE" "throwaway extraction-status -> 404"

hr "18. admin lists extraction jobs"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-admin.txt "$BASE/api/admin/extraction-jobs?limit=10")
code_eq 200 "$CODE" "extraction-jobs reachable"
KIND=$(python3 -c "import json;print(json.load(open('/tmp/r.json'))['kind'])" 2>/dev/null)
[ "$KIND" = "admin.extraction_jobs" ] && ok "kind == admin.extraction_jobs" || bad "kind was '$KIND'"

hr "19. status enum is enforced"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt \
  "$BASE/api/admin/extraction-jobs?status=bogus")
code_eq 400 "$CODE" "unknown status -> 400"
# Filtering by a real status should 200 even if zero rows match.
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-admin.txt \
  "$BASE/api/admin/extraction-jobs?status=failed&limit=5")
code_eq 200 "$CODE" "status=failed reachable"

hr "20. extraction-status surface"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-admin.txt "$BASE/api/admin/extraction-status")
code_eq 200 "$CODE" "extraction-status reachable"
for f in pending running done failed skipped failed_24h features_total; do
  V=$(python3 -c "import json;print(json.load(open('/tmp/r.json'))['stats'].get('$f'))" 2>/dev/null)
  if [ -n "$V" ] && [ "$V" != "None" ]; then ok "stats.$f present (= $V)"; else bad "stats.$f missing"; fi
done

hr "21. retry of a non-existent job -> 404"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt \
  -X POST "$BASE/api/admin/extraction-jobs/999999999/retry")
code_eq 404 "$CODE" "retry missing job -> 404"

# /retry expects a positive integer in the URL, not a uuid.
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt \
  -X POST "$BASE/api/admin/extraction-jobs/not-a-number/retry")
code_eq 400 "$CODE" "retry non-numeric id -> 400"

hr "22. /artists/:id/reextract — happy path on the temp artist"
# We re-create + re-archive the same throwaway artist from section 14 if
# it's gone (test-admin-write.sh archives it but doesn't unarchive at the
# end). For safety, ask /admin/artists for the row first. If it's archived
# we unarchive briefly so reextract is allowed.
curl -sS -o /tmp/r.json -b /tmp/jar-admin.txt "$BASE/api/admin/artists" >/dev/null
TH_ART_ROW=$(python3 -c "
import json
rows=json.load(open('/tmp/r.json'))['rows']
for r in rows:
  if r['name']=='${TH_ARTIST:-__none__}':
    print(r['id'], '1' if r['is_archived'] else '0'); break
" 2>/dev/null)
TH_ART_REID=$(echo "$TH_ART_ROW" | awk '{print $1}')
TH_ART_ARCH=$(echo "$TH_ART_ROW" | awk '{print $2}')
if [ -z "$TH_ART_REID" ]; then
  ok "throwaway artist already cleaned up — skipping reextract happy path"
else
  if [ "$TH_ART_ARCH" = "1" ]; then
    curl -sS -o /dev/null -X POST -b /tmp/jar-admin.txt \
      "$BASE/api/admin/artists/$TH_ART_REID/unarchive" >/dev/null
  fi
  CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/jar-admin.txt \
    -X POST -H 'Content-Type: application/json' -d '{}' \
    "$BASE/api/admin/artists/$TH_ART_REID/reextract")
  code_eq 200 "$CODE" "reextract reachable"
  KIND=$(python3 -c "import json;print(json.load(open('/tmp/r.json'))['kind'])" 2>/dev/null)
  [ "$KIND" = "admin.artists.reextract" ] && ok "kind == admin.artists.reextract" || bad "kind was '$KIND'"
  # Re-archive to leave the DB how we found it.
  curl -sS -o /dev/null -X POST -b /tmp/jar-admin.txt \
    "$BASE/api/admin/artists/$TH_ART_REID/archive" >/dev/null
fi

hr "23. reextract on a fake uuid -> 404"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  "$BASE/api/admin/artists/00000000-0000-4000-8000-000000000000/reextract")
code_eq 404 "$CODE" "reextract bogus uuid -> 404"

hr "24. reextract with bad body -> 400"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/jar-admin.txt \
  -X POST -H 'Content-Type: application/json' -d '{"dropFeatures":"yes"}' \
  "$BASE/api/admin/artists/00000000-0000-4000-8000-000000000000/reextract")
code_eq 400 "$CODE" "non-boolean dropFeatures -> 400"

hr "summary"
echo "passed: $PASS"
echo "failed: $FAIL"
[ "$FAIL" = 0 ] && exit 0 || exit 1
