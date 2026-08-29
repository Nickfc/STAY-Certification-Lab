#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

: "${STAY_R118F_WORK:?}"
: "${STAY_R118F_BEFORE_DATABASE:?}"
: "${STAY_R118F_SERVICE_PROOF:?}"
: "${STAY_R118F_ENTRY_PROOF:?}"
: "${STAY_R118F_PREFLIGHT_PROOF:?}"
: "${STAY_R118F_RELEASE:?}"
: "${STAY_R118F_RELEASE_TAG:?}"
: "${STAY_R118F_RELEASE_COMMIT:?}"
: "${STAY_R118F_RELEASE_TREE:?}"
: "${STAY_R118F_ARCHIVE_SHA256:?}"
: "${STAY_R118F_MANIFEST_SHA256:?}"
: "${STAY_R118F_CONTROLLER_SHA256:?}"
: "${STAY_R118F_PRIVATE_IPV4:?}"

WORK="$(readlink -f -- "$STAY_R118F_WORK")"
BEFORE_DATABASE="$(readlink -f -- "$STAY_R118F_BEFORE_DATABASE")"
SERVICE_PROOF="$(readlink -f -- "$STAY_R118F_SERVICE_PROOF")"
ENTRY_PROOF="$(readlink -f -- "$STAY_R118F_ENTRY_PROOF")"
PREFLIGHT_PROOF="$(readlink -f -- "$STAY_R118F_PREFLIGHT_PROOF")"
NEW_RELEASE="$(readlink -f -- "$STAY_R118F_RELEASE")"
DATABASE='/var/lib/stay/data/continuity.sqlite3'
SOCKET='/run/stay/resident-control.sock'
SERVICE_CGROUP='/sys/fs/cgroup/system.slice/stay.service'
BENCHMARK_SCRIPT='/usr/local/libexec/stay-p1-physiology-benchmark-v3.js'
CONTROL_SCRIPT='/usr/local/libexec/stay-resident-control-client.js'
BENCHMARK_UNIT='/etc/systemd/system/stay-p1-physiology-benchmark.service'
BENCHMARK_ROOT='/var/lib/stay/evidence/physiology-benchmark/R118F'
TARGET_FREEZE='/var/lib/stay/evidence/runtime-freezes/R118.json'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
LIVE_PROOF="$SCRIPT_DIRECTORY/p1-r118f-live-proof.js"
FREEZE_HELPER="$SCRIPT_DIRECTORY/p1-r118f-freeze.js"
CONTROL_CLIENT="$SCRIPT_DIRECTORY/p1-resident-control-client.js"
BENCHMARK_HELPER="$SCRIPT_DIRECTORY/p1-physiology-benchmark.js"
FREEZE_CREATED=0
BENCHMARK_ROOT_CREATED=0
BENCHMARK_UNIT_INSTALLED=0
COMPLETED=0

abort() {
  echo "R118F_FINALIZE_ABORT=$1" >&2
  exit "${2:-1}"
}

json_field() {
  node -e 'const value=process.argv[2].split(".").reduce((object,key)=>object?.[key],JSON.parse(process.argv[1]));process.stdout.write(String(value??""))' "$1" "$2"
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r118f-finalize.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 ]]; then
    if [[ "$BENCHMARK_UNIT_INSTALLED" -eq 1 ]]; then
      systemctl disable --now stay-p1-physiology-benchmark.service >/dev/null 2>&1 || true
      rm -f -- "$BENCHMARK_UNIT"
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if [[ "$BENCHMARK_ROOT_CREATED" -eq 1 && "$BENCHMARK_ROOT" == /var/lib/stay/evidence/physiology-benchmark/R118F && -d "$BENCHMARK_ROOT" && ! -L "$BENCHMARK_ROOT" ]]; then
      rm -rf --one-file-system -- "$BENCHMARK_ROOT"
    fi
    if [[ "$FREEZE_CREATED" -eq 1 && "$TARGET_FREEZE" == /var/lib/stay/evidence/runtime-freezes/R118.json && -f "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" ]]; then
      rm -f -- "$TARGET_FREEZE"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 1801
[[ "$WORK" == /var/lib/stay/evidence/production-hardening/.R118F-* && -d "$WORK" && ! -L "$WORK" ]] ||
  abort work-root-invalid 1802
for file in "$BEFORE_DATABASE" "$SERVICE_PROOF" "$ENTRY_PROOF" "$PREFLIGHT_PROOF" \
  "$LIVE_PROOF" "$FREEZE_HELPER" "$CONTROL_CLIENT" "$BENCHMARK_HELPER"; do
  [[ -f "$file" && ! -L "$file" ]] || abort evidence-input-invalid 1803
done
[[ "$NEW_RELEASE" == /opt/stay/releases/0.8.11.3-p1m-r118f-chrono-repair-* \
  && -d "$NEW_RELEASE" && ! -L "$NEW_RELEASE" \
  && "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" ]] || abort release-pointer-invalid 1804
[[ ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" ]] || abort target-freeze-already-exists 1805
[[ ! -e "$BENCHMARK_ROOT" && ! -L "$BENCHMARK_ROOT" ]] || abort benchmark-root-already-exists 1806
expected_pid="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).afterPid))' "$SERVICE_PROOF")"
expected_restarts="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).afterRestarts))' "$SERVICE_PROOF")"
[[ "$(systemctl show stay.service -p MainPID --value)" == "$expected_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$expected_restarts" ]] ||
  abort service-generation-changed-before-finalize 1822

health=''
for _ in $(seq 1 60); do
  health="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
  if [[ "$(json_field "$health" ok 2>/dev/null || true)" == true \
    && "$(json_field "$health" revision 2>/dev/null || true)" == 118 \
    && -S "$SOCKET" ]]; then break; fi
  sleep 1
done
[[ "$(json_field "$health" ok 2>/dev/null || true)" == true \
  && "$(json_field "$health" revision 2>/dev/null || true)" == 118 ]] ||
  abort runtime-not-r118 1807

STAY_DATABASE="$DATABASE" node "$LIVE_PROOF" capture > "$WORK/after.start.database.json" ||
  abort after-start-database-capture-failed 1808
STAY_REQUIRE_CGROUPS=1 STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel \
  STAY_DATABASE="$DATABASE" STAY_SERVICE_CGROUP="$SERVICE_CGROUP" \
  node "$BENCHMARK_HELPER" sample > "$WORK/soak.start.json" ||
  abort soak-start-failed 1809

for step in $(seq 1 26); do
  sleep 5
  if (( step % 2 == 0 )); then
    echo "R118F_LIVE_GATE_PROGRESS_SECONDS=$((step * 5))"
  fi
done

sntss=''
chronobiology=''
meta=''
for _ in $(seq 1 60); do
  sntss="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$CONTROL_CLIENT" status resident:sntss 2>/dev/null || true)"
  chronobiology="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$CONTROL_CLIENT" status resident:chronobiology 2>/dev/null || true)"
  meta="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta 2>/dev/null || true)"
  if [[ "$(json_field "$sntss" resident.running 2>/dev/null || true)" == true \
    && "$(json_field "$chronobiology" resident.running 2>/dev/null || true)" == true \
    && "$(json_field "$meta" revision 2>/dev/null || true)" == 118 ]]; then break; fi
  sleep 1
done
printf '%s\n' "$sntss" > "$WORK/sntss.final.json"
printf '%s\n' "$chronobiology" > "$WORK/chronobiology.final.json"
printf '%s\n' "$meta" > "$WORK/meta.unfrozen.json"
STAY_DATABASE="$DATABASE" node "$LIVE_PROOF" capture > "$WORK/after.final.database.json" ||
  abort after-final-database-capture-failed 1810
[[ "$(systemctl show stay.service -p MainPID --value)" == "$expected_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$expected_restarts" ]] ||
  abort service-generation-changed-during-soak 1823
STAY_REQUIRE_CGROUPS=1 STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel \
  STAY_DATABASE="$DATABASE" STAY_SERVICE_CGROUP="$SERVICE_CGROUP" \
  node "$BENCHMARK_HELPER" sample > "$WORK/soak.end.json" ||
  abort soak-end-failed 1811

node "$LIVE_PROOF" verify \
  "$BEFORE_DATABASE" "$WORK/after.final.database.json" \
  "$WORK/sntss.final.json" "$WORK/chronobiology.final.json" \
  "$WORK/meta.unfrozen.json" "$SERVICE_PROOF" > "$WORK/live.proof.json" ||
  abort live-proof-invalid 1812

node "$FREEZE_HELPER" capture \
  --proof "$WORK/live.proof.json" \
  --preflight "$PREFLIGHT_PROOF" \
  --entry-proof "$ENTRY_PROOF" \
  --service-proof "$SERVICE_PROOF" \
  --release "$NEW_RELEASE" \
  --release-tag "$STAY_R118F_RELEASE_TAG" \
  --release-commit "$STAY_R118F_RELEASE_COMMIT" \
  --release-tree "$STAY_R118F_RELEASE_TREE" \
  --archive-sha256 "$STAY_R118F_ARCHIVE_SHA256" \
  --manifest-sha256 "$STAY_R118F_MANIFEST_SHA256" \
  --controller-sha256 "$STAY_R118F_CONTROLLER_SHA256" \
  --hostname "$(hostname)" \
  --private-ip "$STAY_R118F_PRIVATE_IPV4" > "$WORK/freeze.json" ||
  abort freeze-capture-failed 1813
node "$FREEZE_HELPER" verify "$WORK/freeze.json" > "$WORK/freeze-summary.env" ||
  abort freeze-verification-failed 1814
temporary_freeze="$(mktemp "$(dirname "$TARGET_FREEZE")/.R118.XXXXXX")"
install -o root -g staydeploy -m 0440 "$WORK/freeze.json" "$temporary_freeze"
if ! ln "$temporary_freeze" "$TARGET_FREEZE"; then
  rm -f -- "$temporary_freeze"
  abort freeze-install-raced 1815
fi
rm -f -- "$temporary_freeze"
FREEZE_CREATED=1
node "$FREEZE_HELPER" verify "$TARGET_FREEZE" >/dev/null || abort installed-freeze-invalid 1816

final_meta=''
for _ in $(seq 1 30); do
  final_meta="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta 2>/dev/null || true)"
  if [[ "$(json_field "$final_meta" revisionLabel 2>/dev/null || true)" == R118F ]]; then break; fi
  sleep 1
done
[[ "$(json_field "$final_meta" revision 2>/dev/null || true)" == 118 \
  && "$(json_field "$final_meta" revisionFrozen 2>/dev/null || true)" == true \
  && "$(json_field "$final_meta" revisionLabel 2>/dev/null || true)" == R118F ]] ||
  abort public-freeze-not-visible 1817
printf '%s\n' "$final_meta" > "$WORK/meta.frozen.json"

install -d -o root -g root -m 0700 "$BENCHMARK_ROOT"
BENCHMARK_ROOT_CREATED=1
install -d -o root -g root -m 0755 "$(dirname "$BENCHMARK_SCRIPT")"
install_atomic "$BENCHMARK_HELPER" "$BENCHMARK_SCRIPT" 0500
install_atomic "$CONTROL_CLIENT" "$CONTROL_SCRIPT" 0500
cat > "$WORK/benchmark.service" <<EOF
[Unit]
Description=STAY R118F BSF SNTSS Chronobiology performance-repair 72-hour benchmark
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
BENCHMARK_UNIT_INSTALLED=1
systemctl daemon-reload || abort benchmark-daemon-reload-failed 1818
systemd-analyze verify stay-p1-physiology-benchmark.service >/dev/null \
  2>"$WORK/benchmark-systemd-verify.stderr" || abort benchmark-unit-invalid 1819
systemctl enable --now stay-p1-physiology-benchmark.service >/dev/null ||
  abort benchmark-start-failed 1820
for _ in $(seq 1 30); do
  [[ -s "$BENCHMARK_ROOT/state.json" && -s "$BENCHMARK_ROOT/samples.jsonl" ]] && break
  sleep 1
done
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value)" == active ]] ||
  abort benchmark-not-active 1821
node - "$BENCHMARK_ROOT/state.json" "$BENCHMARK_SCRIPT" <<'NODE'
'use strict';
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { observedFailures } = require(process.argv[3]);
if (!(state.format === 'stay-physiology-benchmark-state-v3'
  && state.runtimeRevision === 118
  && state.collectorStarts === 1
  && state.collectorRestarts === 0
  && state.failures === 0
  && state.sntssCoreHostFaults === 0
  && state.chronobiologyCoreHostFaults === 0
  && state.sntssProcessTransitions === 0
  && state.chronobiologyProcessTransitions === 0
  && state.mainPidTransitions === 0
  && state.maintenanceFailureRows === 0
  && state.maxPendingOutboxIntents === 0
  && observedFailures(state) === 0)) process.exit(1);
NODE

benchmark_started_at="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).startedAt)' "$BENCHMARK_ROOT/state.json")"
benchmark_due_12h="$(date -u -d "$benchmark_started_at +12 hours" +'%Y-%m-%dT%H:%M:%SZ')"
benchmark_due_72h="$(date -u -d "$benchmark_started_at +72 hours" +'%Y-%m-%dT%H:%M:%SZ')"
cat > "$WORK/result.env" <<EOF
R118F_FINALIZE_RESULT=PASS
RUNTIME_REVISION_BEFORE=116
COLD_RECOVERY_REVISION=117
RUNTIME_REVISION_AFTER=118
REVISION_LABEL=R118F
CURRENT_RELEASE=$NEW_RELEASE
SERVICE_RESTARTS_THIS_DEPLOYMENT=ONE
CHRONOBIOLOGY_VERSION=1.0.0-c3rc.4
CHRONOBIOLOGY_INSTANCE_ID=f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a
CHRONOBIOLOGY_STATUS=ACTIVE_SHADOW_RESIDENT
CHRONOBIOLOGY_ABANDONED_COUNT=0
CHRONOBIOLOGY_INVENTED_BIOLOGICAL_TIME=NO
CHRONOBIOLOGY_AUTHORITY=NONE
SNTSS_VERSION=0.5.0-i4g1
SNTSS_INSTANCE_ID=8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f
SNTSS_STATUS=ACTIVE_SHADOW_RESIDENT
SNTSS_AUTHORITY=NONE
SNTSS_OUTPUT_COUNT=0
BSF_STATUS=FUNCTIONAL
BSF_MODE=LIVE
FETUS_CONTINUITY=PASS
WEB_CHIP_BSF=LIVE
WEB_CHIP_SNTSS=SHADOW
WEB_CHIP_CHRONOBIOLOGY=SHADOW
BENCHMARK_SERVICE=ACTIVE
BENCHMARK_CONTRACT=V3_ZERO_FAULT_ZERO_TRANSITION
BENCHMARK_STARTED_AT_UTC=$benchmark_started_at
BENCHMARK_12H_DUE_UTC=$benchmark_due_12h
BENCHMARK_72H_DUE_UTC=$benchmark_due_72h
EOF

COMPLETED=1
trap - EXIT
cat "$WORK/result.env"
cat "$WORK/freeze-summary.env"
