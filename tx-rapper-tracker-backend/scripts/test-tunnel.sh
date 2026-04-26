#!/usr/bin/env bash
# Smoke test through a Cloudflare quick tunnel.
# Usage: BASE=https://xxx.trycloudflare.com ./scripts/test-tunnel.sh
set -u
BASE="${BASE:?set BASE to the tunnel URL}"
ADMIN_EMAIL="${ADMIN_EMAIL:-cb2market2290@gmail.com}"
PW='correct-horse-battery-staple-42'
RAND=$RANDOM
TEST_EMAIL="tunnel-$RAND@example.com"
hr() { printf '\n===== %s =====\n' "$*"; }

hr "1. health (public)"
curl -sS -o /tmp/t.json -w 'HTTP %{http_code}  time=%{time_total}s\n' "$BASE/health"
cat /tmp/t.json; echo

hr "2. /api/auth/me unauthenticated -> expect 401"
curl -sS -o /tmp/t.json -w 'HTTP %{http_code}\n' "$BASE/api/auth/me"
cat /tmp/t.json; echo

hr "3. signup via tunnel -> expect 201"
curl -sS -o /tmp/t.json -w 'HTTP %{http_code}\n' -c /tmp/t-jar.txt -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$PW\"}"
head -c 200 /tmp/t.json; echo

hr "4. /me with cookie -> expect 200"
curl -sS -o /tmp/t.json -w 'HTTP %{http_code}\n' -b /tmp/t-jar.txt "$BASE/api/auth/me"
head -c 200 /tmp/t.json; echo

hr "5. /api/youtube/search?q=Megan (auth-gated, real upstream)"
curl -sS -o /tmp/t.json -w 'HTTP %{http_code}  time=%{time_total}s\n' -b /tmp/t-jar.txt \
  "$BASE/api/youtube/search?q=Megan+Thee+Stallion&max=1"
python3 -c "
import json
d = json.load(open('/tmp/t.json'))
items = d.get('items') or d.get('videos') or d.get('results') or []
print('items:', len(items) if isinstance(items, list) else 'n/a')
if isinstance(items, list) and items:
    i = items[0]
    print(' title:', (i.get('title') or i.get('snippet', {}).get('title') or '')[:80])
else:
    print(json.dumps(d)[:200])
" 2>/dev/null || head -c 200 /tmp/t.json

hr "6. admin flow (login as admin, fetch /api/admin/stats)"
curl -sS -o /tmp/t.json -w 'HTTP %{http_code}\n' -c /tmp/t-adm.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PW\"}"
echo " login:"; head -c 150 /tmp/t.json; echo

curl -sS -o /tmp/t.json -w 'HTTP %{http_code}\n' -b /tmp/t-adm.txt "$BASE/api/admin/stats"
echo " stats:"; head -c 300 /tmp/t.json; echo

hr "7. cleanup — logout both"
curl -sS -o /dev/null -b /tmp/t-jar.txt -X POST "$BASE/api/auth/logout"
curl -sS -o /dev/null -b /tmp/t-adm.txt -X POST "$BASE/api/auth/logout"
echo "done"
