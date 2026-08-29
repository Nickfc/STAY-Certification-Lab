#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
RECOVERY_MARKER='/run/stay-r118f-forward-recovery.env'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'

: "${STAY_R118F_RELEASE_TAG:?}"
: "${STAY_R118F_RELEASE_COMMIT:?}"
: "${STAY_R118F_RELEASE_TREE:?}"
: "${STAY_R118F_ARCHIVE_SHA256:?}"
: "${STAY_R118F_MANIFEST_SHA256:?}"
: "${STAY_R118F_CONTROLLER_SHA256:?}"

WORK=''
COMPLETED=0

abort() {
  echo "R118F_FORWARD_RECOVERY_ABORT=$1" >&2
  exit "${2:-1}"
}

json_field() {
  node -e 'const value=process.argv[2].split(".").reduce((object,key)=>object?.[key],JSON.parse(process.argv[1]));process.stdout.write(String(value??""))' "$1" "$2"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf --one-file-system -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 1901
[[ "${STAY_R118F_RECOVERY_AUTHORIZATION:-}" == 'COMPLETE_REVISION_FENCED_R118F_WITHOUT_RESTART' ]] ||
  abort authorization-required 1902
[[ -f "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" \
  && "$(stat -Lc '%U:%G:%a' "$RECOVERY_MARKER")" == root:root:600 ]] ||
  abort recovery-marker-invalid 1903
# shellcheck disable=SC1090
source "$RECOVERY_MARKER"
[[ "$R118F_FAILURE_EVIDENCE" == /var/lib/stay/evidence/production-hardening/FAILED-R118F-* \
  && -d "$R118F_FAILURE_EVIDENCE" && ! -L "$R118F_FAILURE_EVIDENCE" \
  && "$R118F_RELEASE" == /opt/stay/releases/0.8.11.3-p1m-r118f-chrono-repair-* \
  && -d "$R118F_RELEASE" && ! -L "$R118F_RELEASE" \
  && "$(readlink -f /opt/stay/current)" == "$R118F_RELEASE" ]] ||
  abort recovery-identity-invalid 1904
[[ "$R118F_RELEASE_TAG" == "$STAY_R118F_RELEASE_TAG" \
  && "$R118F_RELEASE_COMMIT" == "$STAY_R118F_RELEASE_COMMIT" \
  && "$R118F_RELEASE_TREE" == "$STAY_R118F_RELEASE_TREE" \
  && "$R118F_ARCHIVE_SHA256" == "$STAY_R118F_ARCHIVE_SHA256" \
  && "$R118F_MANIFEST_SHA256" == "$STAY_R118F_MANIFEST_SHA256" \
  && "$R118F_CONTROLLER_SHA256" == "$STAY_R118F_CONTROLLER_SHA256" ]] ||
  abort recovery-release-binding-invalid 1905
for file in before.database.json service.proof.json entry-quota.proof.json repair.preflight.json; do
  [[ -f "$R118F_FAILURE_EVIDENCE/$file" && ! -L "$R118F_FAILURE_EVIDENCE/$file" ]] ||
    abort recovery-evidence-missing 1906
done
observed_ip="$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 1907
health="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/healthz)"
[[ "$(json_field "$health" ok)" == true && "$(json_field "$health" revision)" == 118 ]] ||
  abort running-r118-required 1908
expected_pid="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).afterPid))' "$R118F_FAILURE_EVIDENCE/service.proof.json")"
expected_restarts="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).afterRestarts))' "$R118F_FAILURE_EVIDENCE/service.proof.json")"
[[ "$(systemctl show stay.service -p MainPID --value)" == "$expected_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$expected_restarts" ]] ||
  abort service-generation-changed 1909

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R118F-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
for file in before.database.json service.proof.json entry-quota.proof.json repair.preflight.json; do
  cp --reflink=auto --preserve=mode,timestamps "$R118F_FAILURE_EVIDENCE/$file" "$WORK/$file"
done

STAY_R118F_WORK="$WORK" \
STAY_R118F_BEFORE_DATABASE="$WORK/before.database.json" \
STAY_R118F_SERVICE_PROOF="$WORK/service.proof.json" \
STAY_R118F_ENTRY_PROOF="$WORK/entry-quota.proof.json" \
STAY_R118F_PREFLIGHT_PROOF="$WORK/repair.preflight.json" \
STAY_R118F_RELEASE="$R118F_RELEASE" \
STAY_R118F_RELEASE_TAG="$STAY_R118F_RELEASE_TAG" \
STAY_R118F_RELEASE_COMMIT="$STAY_R118F_RELEASE_COMMIT" \
STAY_R118F_RELEASE_TREE="$STAY_R118F_RELEASE_TREE" \
STAY_R118F_ARCHIVE_SHA256="$STAY_R118F_ARCHIVE_SHA256" \
STAY_R118F_MANIFEST_SHA256="$STAY_R118F_MANIFEST_SHA256" \
STAY_R118F_CONTROLLER_SHA256="$STAY_R118F_CONTROLLER_SHA256" \
STAY_R118F_PRIVATE_IPV4="$observed_ip" \
bash "$R118F_RELEASE/deploy/live-physiology-transplant/p1-r118f-finalize.sh" > "$WORK/finalize.output" ||
  abort finalization-failed 1910

final_evidence="$EVIDENCE_ROOT/R118F-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ')"
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
rm -f -- "$RECOVERY_MARKER"
COMPLETED=1
trap - EXIT
cat "$final_evidence/finalize.output"
echo 'R118F_FORWARD_RECOVERY_RESULT=PASS'
echo 'REVISION_LABEL=R118F'
echo "CURRENT_RELEASE=$R118F_RELEASE"
echo "R118F_EVIDENCE=$final_evidence"
