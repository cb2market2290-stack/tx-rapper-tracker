#!/usr/bin/env bash
# tx-tunnel-smoke.sh
# Drop-in replacement for scripts/test-tunnel.sh that pins DNS via --resolve
# so it works inside osascript's stale-resolver shell. Reads the trycloudflare
# URL from /tmp/tx-tunnel.log, looks up its IPs out-of-band, then walks the
# full smoke (health, /me, signup+cookie, /me with cookie, search, admin login,
# /api/admin/stats).
set +e
URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/tx-tunnel.log | head -1)
HOST=${URL#https://}
echo "URL=$URL"
echo "HOST=$HOST"

IPS=$(dig +short "$HOST" | head -2 | xargs)
if [ -z "$IPS" ]; then
  IPS="104.16.231.132 104.16.230.132"
fi
echo "IPS=$IPS"

RES=""
for ip in $IPS; do RES="$RES --resolve $HOST:443:$ip"; done

ADMIN_EMAIL="cb2market2290@gmail.com"
PW='correct-horse-battery-staple-42'
RAND=$$
TEST_EMAIL="tunnel-$RAND@example.com"
hr() { printf '\n===== %s =====\n' "$*"; }

hr "1. health (public)"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}  time=%{time_total}s\n' "$URL/health"
cat /tmp/t.json; echo

hr "2. /api/auth/me unauthenticated -> expect 401"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' "$URL/api/auth/me"
cat /tmp/t.json; echo

hr "3. signup via tunnel -> expect 201"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' -c /tmp/t-jar.txt -X POST "$URL/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$PW\"}"
head -c 200 /tmp/t.json; echo

hr "4. /me with cookie -> expect 200"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' -b /tmp/t-jar.txt "$URL/api/auth/me"
head -c 200 /tmp/t.json; echo

hr "5. /api/payments/status (anon-tolerant)"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' "$URL/api/payments/status"
head -c 300 /tmp/t.json; echo

hr "6. /api/payments/tiers (Phase 2e.A)"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' "$URL/api/payments/tiers"
python3 -c "
import json
d = json.load(open('/tmp/t.json'))
ts = d.get('tiers') or []
print('tier_count:', len(ts))
for t in ts:
    print(' -', t.get('slug'), 'rank=' + str(t.get('rank')), t.get('displayName'))
" 2>/dev/null || head -c 200 /tmp/t.json
echo

hr "7. admin login + /api/admin/stats"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' -c /tmp/t-adm.txt -X POST "$URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PW\"}"
echo " login:"; head -c 150 /tmp/t.json; echo

curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' -b /tmp/t-adm.txt "$URL/api/admin/stats"
echo " stats:"; head -c 300 /tmp/t.json; echo

hr "8. admin extraction-status (Phase 2e.B)"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' -b /tmp/t-adm.txt "$URL/api/admin/extraction-status"
head -c 300 /tmp/t.json; echo

hr "9. admin extraction-jobs (Phase 2e.B)"
curl -sS $RES -o /tmp/t.json -w 'HTTP %{http_code}\n' -b /tmp/t-adm.txt "$URL/api/admin/extraction-jobs?limit=5"
python3 -c "
import json
d = json.load(open('/tmp/t.json'))
print('kind:', d.get('kind'))
print('count:', len(d.get('rows', [])))
" 2>/dev/null || head -c 200 /tmp/t.json
echo

hr "10. cleanup — logout both"
curl -sS $RES -o /dev/null -b /tmp/t-jar.txt -X POST "$URL/api/auth/logout"
curl -sS $RES -o /dev/null -b /tmp/t-adm.txt -X POST "$URL/api/auth/logout"
echo "done"
exit 0
