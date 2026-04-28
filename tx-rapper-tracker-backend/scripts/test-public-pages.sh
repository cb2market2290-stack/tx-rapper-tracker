#!/usr/bin/env bash
# Public-pages smoke test (Phase 3c).
#
# What this CAN do (no auth required):
#   * Verify /a/:slug returns 200 text/html for a known artist.
#   * Verify /a/:slug returns 404 for an unknown / private slug.
#   * Verify /compare/:slugs returns 200 for a known set.
#   * Verify /compare/:slugs returns 400 over the cap of 5.
#   * Verify /compare/:slugs returns 404 when zero recognized.
#   * Verify /robots.txt returns the expected Allow/Disallow rules.
#   * Verify /sitemap.xml returns valid XML with at least one entry.
#
# Prereqs:
#   * Backend running on :8787 (npm start).
#   * Postgres reachable; migration 016 applied.
#   * The artists.is_public flag for at least one row is TRUE
#     (default after migration 016) and the seed roster lives.
#
# Run: bash scripts/test-public-pages.sh

set -u

BASE="${BASE:-http://localhost:8787}"
RESP=/tmp/tx-public.body
PASS=0
FAIL=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()  { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

# --- 1. /a/:slug — known artist returns 200 + indexable HTML ----------
hr "1. /a/megan-thee-stallion"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/a/megan-thee-stallion")
code_eq 200 "$CODE" "GET /a/megan-thee-stallion"
CT=$(curl -sS -o /dev/null -D - "$BASE/a/megan-thee-stallion" | awk -F': ' 'tolower($1)=="content-type"{print $2}' | tr -d '\r' | head -1)
case "$CT" in
  text/html*) ok "Content-Type is text/html (got: $CT)" ;;
  *)          bad "Content-Type expected text/html; got '$CT'" ;;
esac
grep -q '<title>Megan Thee Stallion' "$RESP" \
  && ok "page <title> contains the artist name" \
  || bad "page <title> missing 'Megan Thee Stallion'"
grep -q '<table' "$RESP" \
  && ok "page contains a <table> (SSR snapshot data, not JS-only)" \
  || bad "page is missing a <table> — SSR snapshot row not rendered"
grep -q 'rel="canonical"' "$RESP" \
  && ok "<link rel=canonical> present" \
  || bad "missing <link rel=canonical>"
grep -q '/?signup=1' "$RESP" \
  && ok "sign-up CTA links present" \
  || bad "sign-up CTA missing — funnel break"

# --- 2. /a/:slug — unknown slug returns 404 ---------------------------
hr "2. /a/this-doesnt-exist"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/a/this-doesnt-exist")
code_eq 404 "$CODE" "unknown slug 404s"

# --- 3. /a/:slug — invalid slug shape (semicolon) returns 404 ---------
# Defense-in-depth: a slug with characters outside [a-z0-9-] should
# never reach the DB. The route's isValidSlug short-circuits.
hr "3. /a/has;semicolon"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/a/has%3Bsemicolon")
code_eq 404 "$CODE" "invalid slug shape 404s"

# --- 4. /compare/:slugs — known pair returns 200 ----------------------
hr "4. /compare/megan-thee-stallion+glorilla"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/compare/megan-thee-stallion+glorilla")
code_eq 200 "$CODE" "GET compare returns 200"
grep -q 'Megan Thee Stallion' "$RESP" && ok "first artist named in body" || bad "first artist missing"
grep -q 'GloRilla'            "$RESP" && ok "second artist named in body" || bad "second artist missing"

# --- 5. /compare/:slugs — too many slugs returns 400 ------------------
hr "5. /compare/<6 slugs> exceeds cap"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/compare/a+b+c+d+e+f")
code_eq 400 "$CODE" "compare cap enforced"
KIND=$(python3 -c "import json;print(json.load(open('$RESP')).get('kind',''))" 2>/dev/null)
[ "$KIND" = "compare.too_many" ] && ok "kind == compare.too_many" || bad "kind was '$KIND'"

# --- 6. /compare/:slugs — zero recognized slugs returns 404 -----------
hr "6. /compare/foo+bar (zero recognized)"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/compare/foo+bar")
code_eq 404 "$CODE" "zero recognized slugs 404s"

# --- 7. /robots.txt — content sanity ----------------------------------
hr "7. /robots.txt"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/robots.txt")
code_eq 200 "$CODE" "robots.txt reachable"
grep -q '^Allow: /a/'        "$RESP" && ok "allows /a/"        || bad "missing 'Allow: /a/'"
grep -q '^Allow: /compare/'  "$RESP" && ok "allows /compare/"  || bad "missing 'Allow: /compare/'"
grep -q '^Disallow: /admin'  "$RESP" && ok "disallows /admin"  || bad "missing 'Disallow: /admin'"
grep -q '^Disallow: /api/'   "$RESP" && ok "disallows /api/"   || bad "missing 'Disallow: /api/'"
grep -q '^Sitemap: '         "$RESP" && ok "advertises Sitemap" || bad "missing 'Sitemap:' line"

# --- 8. /sitemap.xml — at least one URL entry -------------------------
hr "8. /sitemap.xml"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/sitemap.xml")
code_eq 200 "$CODE" "sitemap.xml reachable"
grep -q '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' "$RESP" \
  && ok "valid sitemap urlset element" \
  || bad "sitemap urlset element missing/wrong"
grep -q '<loc>' "$RESP" && ok "at least one <loc> entry" || bad "no <loc> entries"
grep -q '<changefreq>daily</changefreq>' "$RESP" && ok "changefreq=daily present" || bad "changefreq missing"

hr "Summary"
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
