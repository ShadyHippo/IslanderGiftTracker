#!/usr/bin/env bash
# Full-stack API smoke test. Builds the Go server fresh, runs it on a temp port
# with temp data, and asserts every endpoint behaves. Exit 0 on pass.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA=$(mktemp -d)
PORT=18099
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  rm -rf "$DATA"
}
trap cleanup EXIT

echo "building server..."
(cd server && go build -o "$DATA/server" .)

ACNH_INIT_USERS="wife:test123" DATA_DIR="$DATA/data" PORT=$PORT "$DATA/server" > "$DATA/server.log" 2>&1 &
SRV_PID=$!
sleep 1.2

B="http://localhost:$PORT"
FAIL=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected $2, got $3)"; FAIL=1; fi
}
JAR="$DATA/jar"
login() { curl -s -b "$JAR" -c "$JAR" -o /dev/null -w '%{http_code}' -X POST "$B/api/login" -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}"; }

check "GET / (static)"              200 "$(curl -s -o /dev/null -w '%{http_code}' $B/)"
check "GET /api/me (no auth)"       401 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/me)"
check "login wrong password"        401 "$(login wife nope)"
check "login correct"               200 "$(login wife test123)"
check "GET /api/me (authed)"        200 "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' $B/api/me)"
check "GET /api/progress (authed)"  200 "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' $B/api/progress)"

printf 'definitely not a database' > "$DATA/garbage.bin"
check "PUT garbage -> 400"          400 "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PUT --data-binary @"$DATA/garbage.bin" $B/api/progress)"

python3 - "$DATA/good.db" <<'EOF'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE gifts (id INTEGER PRIMARY KEY, villager TEXT, item TEXT, date TEXT, note TEXT, created_at TEXT)")
db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
db.commit()
EOF
check "PUT valid db -> 200"         200 "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PUT --data-binary @"$DATA/good.db" $B/api/progress)"
check "PUT valid db again -> 200"   200 "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PUT --data-binary @"$DATA/good.db" $B/api/progress)"
if curl -s -b "$JAR" $B/api/progress/versions | grep -q '"versions":\['; then
  echo "PASS  progress versions listed (backup created)"
else
  echo "FAIL  progress versions"; FAIL=1
fi

check "GET /db/manifest.json"       200 "$(curl -s -o /dev/null -w '%{http_code}' $B/db/manifest.json)"
check "GET /db/reference.v9.db.gz"  404 "$(curl -s -o /dev/null -w '%{http_code}' $B/db/reference.v9.db.gz)"
check "GET /db/evil (bad name)"     404 "$(curl -s -o /dev/null -w '%{http_code}' $B/db/evil)"

if [ "$FAIL" = 1 ]; then echo "SMOKE FAILED"; exit 1; fi
echo "SMOKE OK"
