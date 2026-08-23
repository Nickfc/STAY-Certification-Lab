#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_ROLLBACK_A1_WRITE_AUTHORIZED:-NO}" == "YES" ]] || { echo "ROLLBACK_A1_ABORT=authorization-missing" >&2; exit 150; }

EXPECTED_SHA="7d040592ccf1f149f0f0a170f79cf76bb5f05d92"
BASE_RELEASE="/opt/stay/releases/0.8.11.3-p1a-surgery-a-candidate-${EXPECTED_SHA}"
A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
NODE_BIN="$(command -v node)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || { echo "ROLLBACK_A1_ABORT=unexpected-current-release" >&2; exit 151; }
[[ -d "$BASE_RELEASE" && ! -L "$BASE_RELEASE" ]] || { echo "ROLLBACK_A1_ABORT=base-release-missing" >&2; exit 152; }
BEFORE="$(mktemp /run/stay-a1-rollback-before.XXXXXX)"
AFTER="$(mktemp /run/stay-a1-rollback-after.XXXXXX)"
trap 'rm -f -- "$BEFORE" "$AFTER"' EXIT
$NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE" > "$BEFORE"
$NODE_BIN -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));if(s.residents.length)process.exit(1)' "$BEFORE" || {
  echo "ROLLBACK_A1_ABORT=resident-present" >&2; exit 153;
}
systemctl stop stay.service
ln -s "$BASE_RELEASE" "/opt/stay/.current-a1-rollback-$STAMP"
mv -Tf "/opt/stay/.current-a1-rollback-$STAMP" /opt/stay/current
systemctl start stay.service
for _ in $(seq 1 60); do
  curl --fail --silent --max-time 2 http://127.0.0.1:8787/healthz | grep -q '"ok":true' && break
  sleep 1
done
curl --fail --silent --max-time 5 http://127.0.0.1:8787/healthz | grep -q '"ok":true' || { echo "ROLLBACK_A1_ABORT=health-failed" >&2; exit 154; }
$NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE" > "$AFTER"
$NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" compare "$BEFORE" "$AFTER" >/dev/null || { echo "ROLLBACK_A1_ABORT=continuity-failed" >&2; exit 155; }
echo "ROLLBACK_A1_RESULT=PASS"
echo "POST_ROLLBACK_RELEASE=$(readlink -f /opt/stay/current)"
echo "CANONICAL_FORWARD_STATE_PRESERVED=YES"
echo "BIOLOGICAL_STATE_RESTORED=NO"
echo "STATESTORE_SCHEMA=4"
echo "SNTSS_RESIDENT_PRESENT=NO"
echo "CHRONOBIOLOGY_RESIDENT_PRESENT=NO"
