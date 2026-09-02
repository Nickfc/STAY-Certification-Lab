#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
RELEASE='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
SOCKET='/run/stay/resident-control.sock'
FAILURE_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R119F-20260830T084129Z.3e12om'
RECOVERY_MARKER='/run/stay-r119f-forward-recovery.env'
FREEZE='/var/lib/stay/evidence/runtime-freezes/R120.json'
BENCHMARK_ROOT='/var/lib/stay/evidence/physiology-benchmark/R120F'
BENCHMARK_SCRIPT='/usr/local/libexec/stay-p1-physiology-benchmark-v3.js'
CONTROL_SCRIPT='/usr/local/libexec/stay-resident-control-client.js'
BENCHMARK_UNIT='/etc/systemd/system/stay-p1-physiology-benchmark.service'
SERVICE_CGROUP='/sys/fs/cgroup/system.slice/stay.service'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
HELPER="$SCRIPT_DIRECTORY/p1-r120f-contained-recovery.js"
CONTROL_CLIENT="$RELEASE/deploy/live-physiology-transplant/p1-resident-control-client.js"
BENCHMARK_HELPER="$RELEASE/deploy/live-physiology-transplant/p1-physiology-benchmark.js"
WORK=''
BENCHMARK_CREATED=0
FREEZE_CREATED=0
COMPLETED=0

abort() { echo "R120F_CONTAINED_RECOVERY_ABORT=$1" >&2; exit "${2:-1}"; }
json_field() {
  node -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"
}
install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r120f-recovery.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 ]]; then
    if [[ "$BENCHMARK_CREATED" -eq 1 ]]; then
      systemctl disable --now stay-p1-physiology-benchmark.service >/dev/null 2>&1 || true
      [[ "$BENCHMARK_ROOT" == /var/lib/stay/evidence/physiology-benchmark/R120F ]] &&
        rm -rf --one-file-system -- "$BENCHMARK_ROOT"
    fi
    if [[ "$FREEZE_CREATED" -eq 1 && "$FREEZE" == /var/lib/stay/evidence/runtime-freezes/R120.json ]]; then
      rm -f -- "$FREEZE"
    fi
  fi
  [[ -z "$WORK" || ! -d "$WORK" ]] || rm -rf --one-file-system -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 2001
[[ "${STAY_R120F_RECOVERY_AUTHORIZATION:-}" == 'COMPLETE_FENCED_R120F_WITHOUT_ANOTHER_RESTART' ]] ||
  abort authorization-required 2002
[[ "$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]}' | sort -u)" == "$EXPECTED_PRIVATE_IPV4" ]] ||
  abort host-identity-mismatch 2003
[[ -f "$HELPER" && ! -L "$HELPER" && -f "$CONTROL_CLIENT" && ! -L "$CONTROL_CLIENT" \
  && -f "$BENCHMARK_HELPER" && ! -L "$BENCHMARK_HELPER" ]] || abort artifact-identity-invalid 2004
[[ "$(readlink -f /opt/stay/current)" == "$RELEASE" && -d "$RELEASE" && ! -L "$RELEASE" ]] ||
  abort release-pointer-invalid 2005
[[ "$(sha256sum "$RELEASE/deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256" | awk '{print $1}')" == \
  '021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb' ]] || abort release-manifest-invalid 2006
[[ -f "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" && -d "$FAILURE_EVIDENCE" && ! -L "$FAILURE_EVIDENCE" ]] ||
  abort failure-evidence-invalid 2007
grep -Fx "R119F_FAILURE_EVIDENCE=$FAILURE_EVIDENCE" "$RECOVERY_MARKER" >/dev/null || abort recovery-marker-mismatch 2008
grep -Fx "R119F_RELEASE=$RELEASE" "$RECOVERY_MARKER" >/dev/null || abort recovery-marker-mismatch 2008
[[ ! -e "$FREEZE" && ! -L "$FREEZE" && ! -e "$BENCHMARK_ROOT" && ! -L "$BENCHMARK_ROOT" ]] ||
  abort acceptance-target-already-exists 2009
[[ "$(systemctl show stay.service -p ActiveState --value)" == active \
  && "$(systemctl show stay.service -p SubState --value)" == running \
  && "$(systemctl show stay.service -p MainPID --value)" == 386158 \
  && "$(systemctl show stay.service -p NRestarts --value)" == 0 ]] || abort service-generation-changed 2010
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value 2>/dev/null || true)" != active ]] ||
  abort benchmark-already-active 2011

WORK="$(mktemp -d /var/lib/stay/evidence/production-hardening/.R120F-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX)"
node "$HELPER" preflight "$DATABASE" "$RELEASE" > "$WORK/preflight.json" || abort exact-preflight-failed 2012
[[ "$(json_field "$(<"$WORK/preflight.json")" result)" == PASS ]] || abort exact-preflight-invalid 2013
node "$HELPER" apply "$DATABASE" "$RELEASE" > "$WORK/apply.json" || abort output-head-cas-failed 2014

set +e
STAY_RESIDENT_CONTROL_TIMEOUT_MS=120000 node "$CONTROL_CLIENT" resynchronize resident:chronobiology \
  > "$WORK/resynchronize.json" 2> "$WORK/resynchronize.stderr"
resync_status=$?
set -e
if [[ "$resync_status" -ne 0 ]]; then
  node "$HELPER" rollback "$DATABASE" "$RELEASE" > "$WORK/rollback.json" 2> "$WORK/rollback.stderr" || true
  abort resident-resynchronization-failed 2015
fi
[[ "$(json_field "$(<"$WORK/resynchronize.json")" ok)" == true ]] || abort resident-resynchronization-invalid 2016

sntss=''
chronobiology=''
meta=''
for _ in $(seq 1 120); do
  sntss="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$CONTROL_CLIENT" status resident:sntss 2>/dev/null || true)"
  chronobiology="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$CONTROL_CLIENT" status resident:chronobiology 2>/dev/null || true)"
  meta="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta 2>/dev/null || true)"
  if [[ "$(json_field "$sntss" resident.running 2>/dev/null || true)" == true \
    && "$(json_field "$chronobiology" resident.running 2>/dev/null || true)" == true \
    && "$(json_field "$meta" ok 2>/dev/null || true)" == true \
    && "$(json_field "$meta" revision 2>/dev/null || true)" == 120 ]]; then break; fi
  sleep 1
done
printf '%s\n' "$sntss" > "$WORK/sntss.json"
printf '%s\n' "$chronobiology" > "$WORK/chronobiology.json"
printf '%s\n' "$meta" > "$WORK/meta.unfrozen.json"
node "$HELPER" live-proof "$DATABASE" "$RELEASE" "$WORK/sntss.json" "$WORK/chronobiology.json" \
  "$WORK/meta.unfrozen.json" > "$WORK/live-proof.json" || abort live-proof-failed 2017
[[ "$(systemctl show stay.service -p MainPID --value)" == 386158 \
  && "$(systemctl show stay.service -p NRestarts --value)" == 0 ]] || abort service-generation-changed 2018

cat > "$WORK/release-identity.json" <<EOF
{"releaseTag":"r119f-v4","releaseCommit":"833cf2564ed2be040c681a627de24042f9ac1538","releaseTree":"97a1f8dbcf596cb98f0bda9af8faacfd709cb9ef","archiveSha256":"sha256:b0da4fa781181f44299ae724dbc364a71a477dcceec860af7faf8d4f909a066b","manifestSha256":"sha256:021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb","controllerSha256":"${STAY_R120F_CONTROLLER_SHA256}"}
EOF
recovery_evidence_sha="sha256:$(find "$WORK" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
node "$HELPER" freeze "$DATABASE" "$RELEASE" "$WORK/sntss.json" "$WORK/chronobiology.json" \
  "$WORK/meta.unfrozen.json" "$WORK/release-identity.json" 386158 "$recovery_evidence_sha" > "$WORK/freeze.json" ||
  abort freeze-generation-failed 2019
temporary_freeze="$(mktemp /var/lib/stay/evidence/runtime-freezes/.R120.XXXXXX)"
install -o root -g staydeploy -m 0440 "$WORK/freeze.json" "$temporary_freeze"
if ! ln "$temporary_freeze" "$FREEZE"; then rm -f -- "$temporary_freeze"; abort freeze-install-raced 2020; fi
rm -f -- "$temporary_freeze"
FREEZE_CREATED=1

final_meta=''
for _ in $(seq 1 30); do
  final_meta="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta 2>/dev/null || true)"
  [[ "$(json_field "$final_meta" revisionLabel 2>/dev/null || true)" == R120F ]] && break
  sleep 1
done
[[ "$(json_field "$final_meta" revision)" == 120 \
  && "$(json_field "$final_meta" revisionFrozen)" == true \
  && "$(json_field "$final_meta" revisionLabel)" == R120F ]] || abort public-freeze-not-visible 2021
printf '%s\n' "$final_meta" > "$WORK/meta.frozen.json"

install -d -o root -g root -m 0700 "$BENCHMARK_ROOT"
BENCHMARK_CREATED=1
install -d -o root -g root -m 0755 "$(dirname "$BENCHMARK_SCRIPT")"
install_atomic "$BENCHMARK_HELPER" "$BENCHMARK_SCRIPT" 0500
install_atomic "$CONTROL_CLIENT" "$CONTROL_SCRIPT" 0500
cat > "$WORK/benchmark.service" <<EOF
[Unit]
Description=STAY R120F BSF SNTSS Chronobiology 72-hour benchmark
After=stay.service
Requires=stay.service
StartLimitIntervalSec=3600
StartLimitBurst=6

[Service]
Type=simple
ExecStart=/usr/local/bin/node $BENCHMARK_SCRIPT run
Restart=on-failure
RestartSec=10
Nice=10
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET
ReadWritePaths=$BENCHMARK_ROOT
Environment=STAY_DATABASE=$DATABASE
Environment=STAY_RESIDENT_CONTROL_SOCKET=$SOCKET
Environment=STAY_SERVICE_CGROUP=$SERVICE_CGROUP
Environment=STAY_REQUIRE_CGROUPS=1
Environment=STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel
Environment=STAY_PHYSIOLOGY_BENCHMARK_ROOT=$BENCHMARK_ROOT
Environment=STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION=0.5.0-i4g1

[Install]
WantedBy=multi-user.target
EOF
install_atomic "$WORK/benchmark.service" "$BENCHMARK_UNIT" 0644
systemctl daemon-reload || abort benchmark-daemon-reload-failed 2022
systemd-analyze verify stay-p1-physiology-benchmark.service >/dev/null || abort benchmark-unit-invalid 2023
systemctl enable --now stay-p1-physiology-benchmark.service >/dev/null || abort benchmark-start-failed 2024
for _ in $(seq 1 30); do
  [[ -s "$BENCHMARK_ROOT/state.json" && -s "$BENCHMARK_ROOT/samples.jsonl" ]] && break
  sleep 1
done
node - "$BENCHMARK_ROOT/state.json" "$BENCHMARK_SCRIPT" <<'NODE' || abort benchmark-start-proof-failed 2025
'use strict';
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { observedFailures } = require(process.argv[3]);
if (!(state.format === 'stay-physiology-benchmark-state-v3'
  && state.runtimeRevision === 120 && state.collectorStarts === 1
  && state.collectorRestarts === 0 && state.failures === 0
  && state.sntssCoreHostFaults === 0 && state.chronobiologyCoreHostFaults === 0
  && state.sntssProcessTransitions === 0 && state.chronobiologyProcessTransitions === 0
  && state.mainPidTransitions === 0 && state.maintenanceFailureRows === 0
  && state.maxPendingOutboxIntents === 0 && observedFailures(state) === 0)) process.exit(1);
NODE

benchmark_started_at="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).startedAt)' "$BENCHMARK_ROOT/state.json")"
benchmark_due_12h="$(date -u -d "$benchmark_started_at +12 hours" +'%Y-%m-%dT%H:%M:%SZ')"
benchmark_due_72h="$(date -u -d "$benchmark_started_at +72 hours" +'%Y-%m-%dT%H:%M:%SZ')"
final_evidence="/var/lib/stay/evidence/production-hardening/R120F-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ')"
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
rm -f -- "$RECOVERY_MARKER"
COMPLETED=1
trap - EXIT
echo 'R120F_CONTAINED_RECOVERY_RESULT=PASS'
echo 'RUNTIME_REVISION_BEFORE=118'
echo 'COLD_RECOVERY_REVISION=119'
echo 'RUNTIME_REVISION_AFTER=120'
echo 'REVISION_LABEL=R120F'
echo "CURRENT_RELEASE=$RELEASE"
echo 'SERVICE_RESTARTS_THIS_DEPLOYMENT=ONE'
echo 'SERVICE_RESTARTS_THIS_RECOVERY=ZERO'
echo 'BSF_STATUS=FUNCTIONAL'
echo 'BSF_MODE=LIVE'
echo 'SNTSS_STATUS=ACTIVE_SHADOW_RESIDENT'
echo 'SNTSS_AUTHORITY=NONE'
echo 'SNTSS_OUTPUT_COUNT=0'
echo 'CHRONOBIOLOGY_STATUS=ACTIVE_SHADOW_RESIDENT'
echo 'CHRONOBIOLOGY_AUTHORITY=NONE'
echo 'CHRONOBIOLOGY_ABANDONED_COUNT=0'
echo 'CHRONOBIOLOGY_INVENTED_BIOLOGICAL_TIME=NO'
echo 'FETUS_CONTINUITY=PASS'
echo 'WEB_CHIP_BSF=LIVE'
echo 'WEB_CHIP_SNTSS=SHADOW'
echo 'WEB_CHIP_CHRONOBIOLOGY=SHADOW'
echo 'BENCHMARK_SERVICE=ACTIVE'
echo "BENCHMARK_STARTED_AT_UTC=$benchmark_started_at"
echo "BENCHMARK_12H_DUE_UTC=$benchmark_due_12h"
echo "BENCHMARK_72H_DUE_UTC=$benchmark_due_72h"
echo "R120F_EVIDENCE=$final_evidence"
