#!/usr/bin/env bash
# Smoke test admin endpoints.
#   (a) anonymous -> 404 (route is not advertised)
#   (b) signed-in non-admin -> 404
#   (c) signed-in admin (Paul) -> 200 with stats / sessions / audit
set -u
BASE="${BASE:-http://localhost:8787}"
ADMIN_EMAIL="${ADMIN_EMAIL:-cb2market2290@gmail.com}"
PW='correct-horse-battery-staple-42'
RAND=$RANDOM
NON_ADMIN="nonadmin-$RAND@example.com"

hr() { printf '\n===== %s =====\n' "$*"; }

hr "(a) anonymous GET /api/admin/stats -> expect 404"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' "$BASE/api/admin/stats"
cat /tmp/r.json; echo

hr "(b) sign up non-admin, GET /api/admin/stats -> expect 404"
curl -sS -o /dev/null -c /tmp/jar-na.txt -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$NON_ADMIN\",\"password\":\"$PW\"}"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar-na.txt "$BASE/api/admin/stats"
cat /tmp/r.json; echo

hr "(c1) log in as admin ($ADMIN_EMAIL)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -c /tmp/jar-admin.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PW\"}"
ADMIN_LOGIN_CODE=$(tail -1 /tmp/r.json 2>/dev/null; echo)
cat /tmp/r.json | head -c 200; echo

hr "(c2) GET /api/admin/stats -> expect 200"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar-admin.txt "$BASE/api/admin/stats"
cat /tmp/r.json; echo

hr "(c3) GET /api/admin/sessions?limit=5"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar-admin.txt "$BASE/api/admin/sessions?limit=5"
python3 -c "import json,sys; d=json.load(open('/tmp/r.json')); print('rows:', len(d['rows'])); [print(' ', r['email'], r['ip'], (r.get('user_agent') or '')[:40]) for r in d['rows']]" 2>/dev/null || cat /tmp/r.json

hr "(c4) GET /api/admin/audit?limit=5"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar-admin.txt "$BASE/api/admin/audit?limit=5"
python3 -c "import json,sys; d=json.load(open('/tmp/r.json')); print('rows:', len(d['rows'])); [print(' ', r['created_at'][:19], r['event'], r.get('email') or '—') for r in d['rows']]" 2>/dev/null || cat /tmp/r.json

hr "(c5) GET /api/admin/audit?event=login_failed"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar-admin.txt "$BASE/api/admin/audit?event=login_failed&limit=3"
python3 -c "import json; d=json.load(open('/tmp/r.json')); print('rows:', len(d['rows'])); [print(' ', r['event'], r.get('details')) for r in d['rows']]" 2>/dev/null || cat /tmp/r.json

hr "done"
