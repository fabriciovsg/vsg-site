#!/usr/bin/env bash
# VSG API smoke test — run against the develop branch deploy BEFORE merging.
#
#   ./tools/test-api.sh https://develop--vsgallery.netlify.app
#
# Checks each endpoint returns real data, and that the deliberately blocked
# paths stay blocked. Exits non-zero if anything fails.

set -uo pipefail
BASE="${1:-}"
if [ -z "$BASE" ]; then echo "Usage: $0 <base-url>"; exit 2; fi

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

check_status() { # url expected label
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$1")
  [ "$code" = "$2" ] && ok "$3 ($code)" || bad "$3 — expected $2, got $code"
}

echo "Testing $BASE"
echo
echo "── Config ─────────────────────────────────────────"
CFG=$(curl -s --max-time 30 "$BASE/api/config")
if echo "$CFG" | grep -q '"categories"'; then ok "config returns categories"; else bad "config missing categories"; fi
if echo "$CFG" | grep -q '"siteTheme"'; then ok "config returns siteTheme"; else bad "config missing siteTheme"; fi

echo
echo "── Stock ──────────────────────────────────────────"
HDRS=$(curl -s -D - -o /tmp/vsg-stock.xlsx --max-time 60 "$BASE/api/stock")
SIZE=$(wc -c < /tmp/vsg-stock.xlsx)
echo "$HDRS" | grep -i '^x-vsg-stock-file:' || true
if [ "$SIZE" -gt 100000 ]; then ok "stock xlsx downloaded (${SIZE} bytes)"; else bad "stock xlsx too small (${SIZE} bytes)"; fi
# xlsx files are zip archives — first two bytes must be PK
if head -c2 /tmp/vsg-stock.xlsx | grep -q 'PK'; then ok "stock file is a valid xlsx container"; else bad "stock file is not a zip/xlsx"; fi

echo
echo "── Whitelisted files ──────────────────────────────"
for f in location-map.json image-manifest.json colour-cache.json; do
  check_status "$BASE/api/file?name=$f" 200 "file: $f"
done
echo "  — blocked files —"
check_status "$BASE/api/file?name=clients.json"        403 "clients.json refused"
check_status "$BASE/api/file?name=stock-snapshot.json" 403 "stock-snapshot.json refused"
check_status "$BASE/api/file?name=vsg-site-config.json" 403 "config not reachable via /api/file"

echo
echo "── Drive listings ─────────────────────────────────"
check_status "$BASE/api/drive-list?scope=slab-folders"    200 "slab-folders"
check_status "$BASE/api/drive-list?scope=project-folders" 200 "project-folders"
check_status "$BASE/api/drive-list?scope=arriving-images" 200 "arriving-images"
check_status "$BASE/api/drive-list?scope=transit-images"  200 "transit-images"
check_status "$BASE/api/drive-list?scope=nonsense"        400 "unknown scope refused"
# Stock folder ID must not be listable even though it is a real folder
check_status "$BASE/api/drive-list?scope=project-images&folder=1BtszKasn-t-haVTX7JzUWTPhuriZsCCq" 403 "out-of-scope folder refused"

echo
echo "── Source paths blocked ───────────────────────────"
check_status "$BASE/package.json"                404 "package.json blocked"
check_status "$BASE/build-images.js"             404 "build-images.js blocked"
check_status "$BASE/netlify/functions/config.js" 404 "function source blocked"

echo
echo "── CORS (Drop sites must be able to call) ─────────"
ACAO=$(curl -s -D - -o /dev/null --max-time 30 \
  -H "Origin: https://vsgslabsigns.netlify.app" "$BASE/api/config" \
  | grep -i '^access-control-allow-origin:' | tr -d '\r')
if [ -n "$ACAO" ]; then ok "CORS allows Sign Generator ($ACAO)"; else bad "no CORS header for Sign Generator"; fi
ACAO2=$(curl -s -D - -o /dev/null --max-time 30 \
  -H "Origin: https://evil.example.com" "$BASE/api/config" \
  | grep -i '^access-control-allow-origin:' | tr -d '\r')
if [ -z "$ACAO2" ]; then ok "CORS refuses unknown origin"; else bad "CORS leaked to unknown origin: $ACAO2"; fi


# ── Write endpoints (Phase 2b) ─────────────────────────
# Pass the admin password as the 2nd argument to exercise the authenticated
# paths:  ./tools/test-api.sh <base-url> <admin-password>
echo
echo "── Write endpoints ────────────────────────────────"
check_status "$BASE/api/admin-login" 405 "admin-login rejects GET"
BADLOGIN=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
  -H 'Content-Type: application/json' -d '{"password":"definitely-wrong"}' "$BASE/api/admin-login")
[ "$BADLOGIN" = "401" ] && ok "wrong admin password refused (401)" || bad "wrong admin password gave $BADLOGIN"

NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
  -H 'Content-Type: application/json' -d '{"action":"list-clients"}' "$BASE/api/admin")
[ "$NOAUTH" = "401" ] && ok "admin write refused without token (401)" || bad "unauthenticated admin gave $NOAUTH"

BADCLIENT=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"x"}' "$BASE/api/client-login")
[ "$BADCLIENT" = "401" ] && ok "unknown client refused (401)" || bad "unknown client gave $BADCLIENT"

ADMIN_PW="${2:-}"
if [ -n "$ADMIN_PW" ]; then
  TOKEN=$(curl -s --max-time 30 -X POST -H 'Content-Type: application/json' \
    -d "{\"password\":\"$ADMIN_PW\"}" "$BASE/api/admin-login" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  if [ -n "$TOKEN" ]; then
    ok "admin login succeeded"
    CL=$(curl -s --max-time 30 -X POST -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $TOKEN" -d '{"action":"list-clients"}' "$BASE/api/admin")
    echo "$CL" | grep -q '"clients"' && ok "list-clients returned data" || bad "list-clients failed: $CL"
    echo "$CL" | grep -qi '"password"' && bad "list-clients LEAKED password field" || ok "list-clients exposes no password material"
    echo "     $(echo "$CL" | grep -o '"needsNewPassword":true' | wc -l | tr -d ' ') client(s) need a new password"
  else
    bad "admin login did not return a token"
  fi
else
  echo "  —  skipping authenticated checks (pass the admin password as arg 2)"
fi


echo
echo "── Close-up scope ─────────────────────────────────"
check_status "$BASE/api/drive-list?scope=closeup-images" 200 "closeup-images"

echo
echo "──────────────────────────────────────────────────"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
