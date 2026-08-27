#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1i-i4g-deadline-3f4580ae943e'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
PARENT_FREEZE='/var/lib/stay/evidence/runtime-freezes/R110.json'
HISTORICAL_FREEZE='/var/lib/stay/evidence/runtime-freezes/R108.json'
R110_BENCHMARK_ROOT='/var/lib/stay/evidence/physiology-benchmark/R110F'
R110_12H="$R110_BENCHMARK_ROOT/12h.json"
R110_CLOSURE="$R110_BENCHMARK_ROOT/production-hardening-closure.json"
RUNTIME_DROPIN='/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf'
ONE_SHOT_DROPIN='/etc/systemd/system/stay.service.d/p1-r111-cold-recovery-once.conf'
SOCKET='/run/stay/resident-control.sock'
SERVICE_CGROUP='/sys/fs/cgroup/system.slice/stay.service'
BWRAP='/usr/local/libexec/stay-bwrap-sandbox'
BENCHMARK_SCRIPT='/usr/local/libexec/stay-p1-physiology-benchmark-v3.js'
CONTROL_SCRIPT='/usr/local/libexec/stay-resident-control-client.js'
BENCHMARK_UNIT='/etc/systemd/system/stay-p1-physiology-benchmark.service'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
STAGE_ROOT="$(readlink -f -- "$SCRIPT_DIRECTORY/../..")"
CONTROL_CLIENT="$SCRIPT_DIRECTORY/p1-resident-control-client.js"
STATE_HELPER="$SCRIPT_DIRECTORY/p1-sntss-i4g-live-state.js"
LIVE_PROOF="$SCRIPT_DIRECTORY/p1-production-hardening-live-proof.js"
PREFLIGHT="$SCRIPT_DIRECTORY/p1-production-hardening-preflight.js"
FREEZE_HELPER="$SCRIPT_DIRECTORY/p1-production-hardening-freeze.js"
BENCHMARK_HELPER="$SCRIPT_DIRECTORY/p1-physiology-benchmark.js"
SOURCE_MANIFEST="$SCRIPT_DIRECTORY/P1_PRODUCTION_HARDENING_R110F_TO_R111F.sha256"

PRODUCTION_OVERLAY_FILES=(
  'server.js'
  'runtime/core-host/host.js'
  'runtime/core-host/host-legacy.js'
  'runtime/core-host/sandbox-host.js'
  'runtime/core-host/worker.js'
  'runtime/kernel/actor-queue.js'
  'runtime/kernel/canonical-json.js'
  'runtime/kernel/cgroup-governor.js'
  'runtime/kernel/core-host-client.js'
  'runtime/kernel/core-loader.js'
  'runtime/kernel/core-sandbox.js'
  'runtime/kernel/living-kernel.js'
  'runtime/kernel/manifest.js'
  'runtime/kernel/package-policy.js'
  'runtime/kernel/protocol.js'
  'runtime/kernel/resident-control-socket.js'
  'runtime/kernel/resident-manager.js'
  'runtime/kernel/resource-governor.js'
  'runtime/kernel/state-store.js'
)

RELEASE_AUXILIARY_FILES=(
  'deploy/live-physiology-transplant/p1-physiology-benchmark.js'
  'deploy/live-physiology-transplant/p1-production-hardening-fixture.js'
  'deploy/live-physiology-transplant/p1-production-hardening-forward.sh'
  'deploy/live-physiology-transplant/p1-production-hardening-freeze.js'
  'deploy/live-physiology-transplant/p1-production-hardening-live-proof.js'
  'deploy/live-physiology-transplant/p1-production-hardening-preflight.js'
  'deploy/live-physiology-transplant/p1-resident-control-client.js'
  'deploy/live-physiology-transplant/p1-sntss-i4g-live-state.js'
  'test/fixtures/stateful-core.js'
  'test/production-hardening-entry-path.test.js'
  'test/production-hardening.test.js'
)

WORK=''
CANDIDATE=''
NEW_RELEASE=''
TARGET_CREATED=0
POINTER_CHANGED=0
RESTART_COMMITTED=0
OLD_BENCHMARK_STOPPED=0
CLOSURE_CREATED=0
ONE_SHOT_CREATED=0
FREEZE_INSTALLED=0
NEW_BENCHMARK_STARTED=0
COMPLETED=0

phase() {
  echo "===== $1 ====="
}

abort() {
  echo "P1_PRODUCTION_HARDENING_FORWARD_ABORT=$1" >&2
  exit "${2:-1}"
}

json_field() {
  node -e 'const value=process.argv[2].split(".").reduce((object,key)=>object?.[key],JSON.parse(process.argv[1]));process.stdout.write(String(value??""))' "$1" "$2"
}

proc_value() {
  tr '\0' '\n' < "/proc/$1/environ" |
    awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,"");print;found=1} END{if(!found)exit 1}'
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.p1-production-hardening.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

point_current() {
  local release="$1" temporary="/opt/stay/.current-p1-production-hardening.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  ln -s "$release" "$temporary"
  mv -Tf "$temporary" /opt/stay/current
}

tree_digest() {
  (
    cd "$1"
    find cores/sntss/i4g -type f -print0 |
      sort -z |
      xargs -0 sha256sum |
      sha256sum |
      awk '{print $1}'
  )
}

archive_failure_work() {
  if [[ -n "$WORK" && -d "$WORK" ]]; then
    local failed
    failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R111-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
    rmdir -- "$failed"
    if mv -T "$WORK" "$failed" 2>/dev/null; then
      WORK=''
      chmod -R a-w "$failed" || true
      echo "P1_PRODUCTION_HARDENING_FAILURE_EVIDENCE=$failed" >&2
    fi
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e

  if [[ "$ONE_SHOT_CREATED" -eq 1 && -f "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]]; then
    rm -f -- "$ONE_SHOT_DROPIN"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi

  if [[ "$COMPLETED" -eq 0 && "$RESTART_COMMITTED" -eq 0 ]]; then
    if [[ "$POINTER_CHANGED" -eq 1 ]]; then point_current "$SOURCE_RELEASE" || true; fi
    if [[ "$CLOSURE_CREATED" -eq 1 && -f "$R110_CLOSURE" && ! -L "$R110_CLOSURE" ]]; then
      rm -f -- "$R110_CLOSURE"
    fi
    if [[ "$OLD_BENCHMARK_STOPPED" -eq 1 ]]; then
      systemctl start stay-p1-physiology-benchmark.service >/dev/null 2>&1 || true
    fi
    if [[ "$TARGET_CREATED" -eq 1 && "$NEW_RELEASE" == /opt/stay/releases/0.8.11.3-p1j-production-hardening-* && -d "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]]; then
      rm -rf --one-file-system -- "$NEW_RELEASE"
    fi
    archive_failure_work
    echo 'P1_PRODUCTION_HARDENING_FORWARD_ROLLBACK=PRE_RESTART_STATE_RESTORED' >&2
  elif [[ "$COMPLETED" -eq 0 ]]; then
    archive_failure_work
    echo 'P1_PRODUCTION_HARDENING_FORWARD_POST_RESTART=LEFT_RUNNING_FOR_FORWARD_RECOVERY' >&2
  fi

  if [[ -n "$CANDIDATE" && "$CANDIDATE" == /opt/stay/releases/.p1j-production-hardening.* && -d "$CANDIDATE" ]]; then
    rm -rf --one-file-system -- "$CANDIDATE"
  fi
  if [[ -n "$WORK" && -d "$WORK" ]]; then
    rm -rf --one-file-system -- "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 1101
[[ "${STAY_P1_PRODUCTION_HARDENING_AUTHORIZATION:-}" == 'HARDEN_R110F_EXACTLY_ONCE_RECOVER_AND_BENCHMARK_72H' ]] ||
  abort authorization-required 1102

phase 'IMMUTABLE INPUTS'
for file in "$DATABASE" "$PARENT_FREEZE" "$HISTORICAL_FREEZE" "$R110_12H" "$RUNTIME_DROPIN" "$BWRAP" "$SOURCE_MANIFEST"; do
  [[ -f "$file" && ! -L "$file" ]] || abort immutable-input-invalid 1103
done
[[ -S "$SOCKET" && ! -L "$SOCKET" ]] || abort resident-control-socket-invalid 1104
[[ ! -e "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]] || abort one-shot-dropin-already-exists 1105
[[ ! -e "$R110_CLOSURE" && ! -L "$R110_CLOSURE" ]] || abort r110-closure-already-exists 1106
[[ "$(sha256sum "$R110_12H" | awk '{print $1}')" == '1fbf5e7b854204278a7ee7967dfc0c9016d1eeb5b281eb7a5289fd66d3b88007' ]] ||
  abort r110-12h-identity-mismatch 1107
[[ "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" ]] || abort unexpected-current-release 1108
[[ "$(systemctl show stay.service -p ActiveState --value)" == active &&
   "$(systemctl show stay.service -p SubState --value)" == running ]] || abort stay-service-not-running 1109
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value)" == active ]] ||
  abort r110-benchmark-not-active 1110

for file in "$CONTROL_CLIENT" "$STATE_HELPER" "$LIVE_PROOF" "$PREFLIGHT" "$FREEZE_HELPER" "$BENCHMARK_HELPER"; do
  [[ -f "$file" && ! -L "$file" ]] || abort helper-invalid 1111
  node --check "$file" >/dev/null
done
(
  cd "$STAGE_ROOT"
  sha256sum -c deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R110F_TO_R111F.sha256
) || abort source-manifest-invalid 1112

for file in "${PRODUCTION_OVERLAY_FILES[@]}" "${RELEASE_AUXILIARY_FILES[@]}"; do
  [[ -f "$STAGE_ROOT/$file" && ! -L "$STAGE_ROOT/$file" ]] || abort release-overlay-input-invalid 1113
  [[ "$file" == *.js ]] && node --check "$STAGE_ROOT/$file" >/dev/null
done

observed_overlay="$({
  for file in "${PRODUCTION_OVERLAY_FILES[@]}" "${RELEASE_AUXILIARY_FILES[@]}"; do
    printf '%s  %s\n' "$(sha256sum "$STAGE_ROOT/$file" | awk '{print $1}')" "$file"
  done
} | sha256sum | awk '{print $1}')"
NEW_RELEASE="/opt/stay/releases/0.8.11.3-p1j-production-hardening-${observed_overlay:0:12}"
[[ ! -e "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]] || abort target-release-already-exists 1114

observed_ip="$(ip -o -4 addr show scope global |
  awk '{address=$4;sub(/\/.*/,"",address);print address}' |
  sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 1115

before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
before_health="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz)" ||
  abort health-unavailable 1116
before_meta="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/__stay/meta)" ||
  abort metadata-unavailable 1117
[[ "$(json_field "$before_health" ok)" == true && "$(json_field "$before_health" revision)" == 110 ]] ||
  abort health-not-r110 1118
[[ "$(json_field "$before_meta" revision)" == 110 &&
   "$(json_field "$before_meta" revisionFrozen)" == true &&
   "$(json_field "$before_meta" revisionLabel)" == R110F ]] || abort metadata-not-r110f 1119
[[ "$(proc_value "$before_pid" STAY_TRUSTED_TIME_PULSE_INTERVAL_MS)" == 250 &&
   "$(proc_value "$before_pid" STAY_TRUSTED_ORGANISM_TIME_PULSE_INTERVAL_MS)" == 60000 &&
   "$(proc_value "$before_pid" STAY_REQUIRE_CGROUPS)" == 1 &&
   "$(proc_value "$before_pid" STAY_CGROUP_DELEGATE_SUBGROUP)" == stay-kernel &&
   "$(proc_value "$before_pid" STAY_REQUIRE_OS_CORE_SANDBOX)" == 1 &&
   "$(proc_value "$before_pid" STAY_REQUIRE_CORE_PACKAGE_POLICY)" == 1 ]] ||
  abort runtime-configuration-invalid 1120

node - "$STAGE_ROOT/runtime/revision-freeze.js" "$PARENT_FREEZE" "$HISTORICAL_FREEZE" <<'NODE'
'use strict';
const fs = require('node:fs');
const { validateRevisionFreeze } = require(process.argv[2]);
const parent = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const historical = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
if (
  !validateRevisionFreeze(parent, 110) ||
  parent.recordSha256 !== 'sha256:da7ad05dd0044754b81d599617d03a86d4cc31e208e39710d167f15c8c163989' ||
  !validateRevisionFreeze(historical, 108)
) process.exit(1);
NODE

install -d -o root -g root -m 0700 "$EVIDENCE_ROOT"
WORK="$(mktemp -d "$EVIDENCE_ROOT/.forward.XXXXXX")"
printf '%s\n' "$before_health" > "$WORK/health.before.json"
printf '%s\n' "$before_meta" > "$WORK/meta.before.json"
cat > "$WORK/service.before.env" <<EOF
MAIN_PID=$before_pid
SYSTEMD_NRESTARTS=$before_restarts
CURRENT_RELEASE=$SOURCE_RELEASE
RUNTIME_REVISION=110
EOF
STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$CONTROL_CLIENT" status resident:sntss > \
  "$WORK/sntss.before.json" || abort sntss-before-status-unavailable 1121
STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$CONTROL_CLIENT" status resident:chronobiology > \
  "$WORK/chronobiology.before.json" || abort chronobiology-before-status-unavailable 1122
STAY_DATABASE="$DATABASE" node "$LIVE_PROOF" before \
  "$WORK/sntss.before.json" "$WORK/chronobiology.before.json" > \
  "$WORK/recovery.before.json" || abort r110-recovery-baseline-invalid 1123
node "$LIVE_PROOF" closure "$R110_12H" > "$WORK/r110-closure.json" ||
  abort r110-closure-invalid 1124
install -o root -g root -m 0400 "$RUNTIME_DROPIN" "$WORK/runtime-dropin.before"
install -o root -g root -m 0400 "$R110_12H" "$WORK/r110-12h.json"

phase 'BUILD IMMUTABLE R111 CANDIDATE'
CANDIDATE="$(mktemp -d /opt/stay/releases/.p1j-production-hardening.XXXXXX)"
cp -a --reflink=auto "$SOURCE_RELEASE/." "$CANDIDATE/"
chmod --reference="$SOURCE_RELEASE" "$CANDIDATE"
chown --reference="$SOURCE_RELEASE" "$CANDIDATE"
source_i4_digest="$(tree_digest "$SOURCE_RELEASE")"

for file in "${PRODUCTION_OVERLAY_FILES[@]}" "${RELEASE_AUXILIARY_FILES[@]}"; do
  install -D -o root -g root -m 0644 "$STAGE_ROOT/$file" "$CANDIDATE/$file"
  [[ "$(sha256sum "$CANDIDATE/$file" | awk '{print $1}')" == \
     "$(sha256sum "$STAGE_ROOT/$file" | awk '{print $1}')" ]] ||
    abort candidate-overlay-mismatch 1126
done
candidate_i4_digest="$(tree_digest "$CANDIDATE")"
[[ "$candidate_i4_digest" == "$source_i4_digest" ]] || abort frozen-i4-tree-changed 1127
diff -qr "$SOURCE_RELEASE/cores/sntss/i4g" "$CANDIDATE/cores/sntss/i4g" > \
  "$WORK/i4-tree.diff" || abort frozen-i4-tree-differs 1128

for file in "${PRODUCTION_OVERLAY_FILES[@]}" "${RELEASE_AUXILIARY_FILES[@]}"; do
  [[ "$file" == *.js ]] && node --check "$CANDIDATE/$file" >/dev/null
done
node - "$CANDIDATE" <<'NODE'
'use strict';
const path = require('node:path');
const root = process.argv[2];
const policy = require(path.join(root, 'runtime/kernel/package-policy.js'));
for (const relative of ['cores/sntss/i4g/index.js', 'cores/chronobiology/c3/index.js']) {
  const modulePath = path.join(root, relative);
  const manifest = require(modulePath).manifest;
  const record = policy.enforcePackagePolicy(modulePath);
  policy.verifyManifestAgainstPackagePolicy(record, manifest);
}
NODE

if ! STAY_BWRAP="$BWRAP" node --test \
  "$CANDIDATE/test/production-hardening-entry-path.test.js" \
  "$CANDIDATE/test/production-hardening.test.js" > \
  "$WORK/production-hardening-tests.tap" 2>&1; then
  cat "$WORK/production-hardening-tests.tap" >&2
  abort candidate-hardening-tests-failed 1129
fi

phase 'REAL ENTRY-PATH CANDIDATE INSPECTION'
runuser -u staydeploy -- env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  NODE_ENV=production \
  STAY_REQUIRE_OS_CORE_SANDBOX=1 \
  STAY_BWRAP="$BWRAP" \
  STAY_REQUIRE_CORE_PACKAGE_POLICY=1 \
  STAY_REQUIRE_CGROUPS=0 \
  /usr/local/bin/node \
  "$CANDIDATE/deploy/live-physiology-transplant/p1-production-hardening-preflight.js" \
  --candidate-inspection-only > "$WORK/entry-path-preflight.json" ||
  abort entry-path-preflight-failed 1155
[[ "$(json_field "$(<"$WORK/entry-path-preflight.json")" result)" == PASS ]] ||
  abort entry-path-preflight-invalid 1156

phase 'REAL OS-SANDBOX PREFLIGHT'
runuser -u staydeploy -- env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  NODE_ENV=production \
  STAY_DATABASE="$DATABASE" \
  STAY_REQUIRE_OS_CORE_SANDBOX=1 \
  STAY_BWRAP="$BWRAP" \
  STAY_REQUIRE_CORE_PACKAGE_POLICY=1 \
  STAY_REQUIRE_CGROUPS=0 \
  /usr/local/bin/node \
  "$CANDIDATE/deploy/live-physiology-transplant/p1-production-hardening-preflight.js" > \
  "$WORK/preflight.json" || abort os-sandbox-preflight-failed 1130
[[ "$(json_field "$(<"$WORK/preflight.json")" result)" == PASS ]] ||
  abort os-sandbox-preflight-invalid 1131

cat > "$CANDIDATE/P1_PRODUCTION_HARDENING_RELEASE.env" <<EOF
P1_PRODUCTION_HARDENING_RELEASE=PASS
PARENT_RELEASE=$SOURCE_RELEASE
PARENT_REVISION=R110F
TARGET_REVISION=R111F
PRODUCTION_OVERLAY_SHA256=sha256:$observed_overlay
FROZEN_I4_TREE_SHA256=sha256:$source_i4_digest
SNTSS_VERSION=0.5.0-i4g1
SNTSS_BIOLOGICAL_PACKAGE_CHANGED=NO
SNTSS_RESOURCE_CONTRACT_CHANGED=NO
EVENT_CHECKPOINT_COMMIT_FENCE=COMBINED
SPECULATIVE_OUTPUT_FENCE=ENABLED
INACTIVE_CHRONOLOGY_GAP_BACKFILL=ATOMIC
POST_COMMIT_OUTBOX_RETRY=HEALTH_VISIBLE
PAYLOAD_QUIESCENCE_BEFORE_SPAWN=REQUIRED
PAYLOAD_CGROUP_MEMORY_HIGH_BYTES=67108864
PAYLOAD_CGROUP_MEMORY_MAX_BYTES=100663296
SUPERVISOR_KERNEL_ACCOUNTING=ENABLED
BENCHMARK_CONTRACT=V3_72H_ZERO_FAULT
TERMINAL_STATE_CONSUMER_DEACTIVATION_EVIDENCE=ONE_SQLITE_TRANSACTION
PERSISTENCE_WRITE_FAILURE_HISTORY=STICKY_FOR_PROCESS_LIFETIME
PUBLIC_RUNNING_REQUIRES_LIVE_HEALTHY_UNIT=YES
BENCHMARK_EXACT_PAYLOAD_PID_CONTRACT=YES
BENCHMARK_RECOVERY_RETENTION_WATERMARKS=YES
BENCHMARK_EVIDENCE_FSYNC=YES
EOF
chown root:root "$CANDIDATE/P1_PRODUCTION_HARDENING_RELEASE.env"
chmod 0444 "$CANDIDATE/P1_PRODUCTION_HARDENING_RELEASE.env"
mv -T "$CANDIDATE" "$NEW_RELEASE"
CANDIDATE=''
TARGET_CREATED=1
chmod -R a-w "$NEW_RELEASE"

phase 'CLOSE FAILED R110F BENCHMARK'
systemctl stop stay-p1-physiology-benchmark.service || abort r110-benchmark-stop-failed 1125
OLD_BENCHMARK_STOPPED=1
install -o root -g root -m 0400 "$WORK/r110-closure.json" "$R110_CLOSURE"
CLOSURE_CREATED=1

phase 'ONE-SHOT COLD RECOVERY AND SINGLE SERVICE RESTART'
cat > "$WORK/p1-r111-cold-recovery-once.conf" <<'EOF'
[Service]
Environment=STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=111
EOF
install_atomic "$WORK/p1-r111-cold-recovery-once.conf" "$ONE_SHOT_DROPIN" 0644
ONE_SHOT_CREATED=1
one_shot_sha256="$(sha256sum "$ONE_SHOT_DROPIN" | awk '{print $1}')"

point_current "$NEW_RELEASE"
POINTER_CHANGED=1
systemctl daemon-reload || abort daemon-reload-failed 1132
systemd-analyze verify stay.service >/dev/null 2>"$WORK/systemd-verify.stderr" ||
  abort systemd-contract-invalid 1133
RESTART_COMMITTED=1
if ! systemctl restart stay.service; then
  abort restart-failed-forward-recovery-required 1134
fi

after_health=''
for _ in $(seq 1 240); do
  after_health="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
  if [[ "$(json_field "$after_health" ok 2>/dev/null || true)" == true && -S "$SOCKET" ]]; then break; fi
  sleep 1
done
after_pid="$(systemctl show stay.service -p MainPID --value)"
after_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$(json_field "$after_health" ok 2>/dev/null || true)" == true &&
   "$(json_field "$after_health" revision 2>/dev/null || true)" == 111 &&
   "$after_pid" != "$before_pid" &&
   "$after_restarts" == "$before_restarts" &&
   "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" ]] ||
  abort restarted-r111-runtime-invalid 1135
[[ "$(proc_value "$after_pid" STAY_RECOVER_COLD_RESIDENTS_AT_REVISION)" == 111 ]] ||
  abort one-shot-recovery-contract-not-consumed 1136

rm -f -- "$ONE_SHOT_DROPIN"
ONE_SHOT_CREATED=0
systemctl daemon-reload || abort one-shot-removal-daemon-reload-failed 1137
[[ ! -e "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]] ||
  abort one-shot-recovery-dropin-not-removed 1138
if systemctl show stay.service -p Environment --value |
  tr ' ' '\n' |
  grep -q '^STAY_RECOVER_COLD_RESIDENTS_AT_REVISION='; then
  abort one-shot-recovery-contract-still-configured 1138
fi

after_sntss=''
after_chronobiology=''
for _ in $(seq 1 300); do
  after_sntss="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$CONTROL_CLIENT" status resident:sntss 2>/dev/null || true)"
  after_chronobiology="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$CONTROL_CLIENT" status resident:chronobiology 2>/dev/null || true)"
  if [[ "$(json_field "$after_sntss" resident.running 2>/dev/null || true)" == true &&
       "$(json_field "$after_chronobiology" resident.running 2>/dev/null || true)" == true ]]; then
    break
  fi
  sleep 1
done
printf '%s\n' "$after_sntss" > "$WORK/sntss.after-recovery.json"
printf '%s\n' "$after_chronobiology" > "$WORK/chronobiology.after-recovery.json"
printf '%s\n' "$after_health" > "$WORK/health.after-recovery.json"
STAY_DATABASE="$DATABASE" STAY_RECOVERY_SERVICE_RESTARTS=1 node "$LIVE_PROOF" recovery \
  "$WORK/recovery.before.json" \
  "$WORK/sntss.after-recovery.json" \
  "$WORK/chronobiology.after-recovery.json" > \
  "$WORK/recovery.proof.json" || abort cold-recovery-proof-invalid 1139

phase 'BOUNDED LIVE PROGRESSION GATE (130 SECONDS)'
STAY_REQUIRE_CGROUPS=1 STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel \
  STAY_DATABASE="$DATABASE" STAY_SERVICE_CGROUP="$SERVICE_CGROUP" \
  node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-physiology-benchmark.js" sample > \
  "$WORK/soak.start.json" || abort soak-start-sample-failed 1140
for step in $(seq 1 26); do
  sleep 5
  if (( step % 2 == 0 )); then
    echo "R111_LIVE_GATE_PROGRESS_SECONDS=$((step * 5))"
  fi
done
STAY_REQUIRE_CGROUPS=1 STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel \
  STAY_DATABASE="$DATABASE" STAY_SERVICE_CGROUP="$SERVICE_CGROUP" \
  node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-physiology-benchmark.js" sample > \
  "$WORK/soak.end.json" || abort soak-end-sample-failed 1141
node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-production-hardening-live-proof.js" \
  soak "$WORK/soak.start.json" "$WORK/soak.end.json" > \
  "$WORK/soak.proof.json" || abort bounded-live-soak-failed 1142

phase 'DURABLE STATE AND R111 FREEZE'
STAY_DATABASE="$DATABASE" node \
  "$NEW_RELEASE/deploy/live-physiology-transplant/p1-sntss-i4g-live-state.js" \
  111 "$HISTORICAL_FREEZE" > "$WORK/i4g-live-state.json" ||
  abort durable-i4g-state-invalid 1143
cp "$WORK/soak.end.json" "$WORK/final.sample.json"
runtime_dropin_sha256="$(sha256sum "$RUNTIME_DROPIN" | awk '{print $1}')"
target_freeze='/var/lib/stay/evidence/runtime-freezes/R111.json'
[[ ! -e "$target_freeze" && ! -L "$target_freeze" ]] || abort target-freeze-already-exists 1144
node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-production-hardening-freeze.js" capture \
  --sample "$WORK/final.sample.json" \
  --state "$WORK/i4g-live-state.json" \
  --parent "$PARENT_FREEZE" \
  --recovery "$WORK/recovery.proof.json" \
  --preflight "$WORK/preflight.json" \
  --closure "$WORK/r110-closure.json" \
  --soak "$WORK/soak.proof.json" \
  --release "$NEW_RELEASE" \
  --overlay-sha256 "sha256:$observed_overlay" \
  --runtime-dropin-sha256 "sha256:$runtime_dropin_sha256" \
  --one-shot-dropin-sha256 "sha256:$one_shot_sha256" \
  --hostname "$(hostname)" \
  --private-ip "$observed_ip" \
  --main-pid "$after_pid" \
  --restarts "$after_restarts" \
  --captured-at "$(date -u +'%Y-%m-%dT%H:%M:%S.%NZ')" > \
  "$WORK/freeze.json" || abort freeze-capture-failed 1145
node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-production-hardening-freeze.js" \
  verify "$WORK/freeze.json" > "$WORK/freeze-summary.env" ||
  abort freeze-verification-failed 1146
temporary_freeze="$(mktemp "$(dirname "$target_freeze")/.R111.XXXXXX")"
install -o root -g staydeploy -m 0440 "$WORK/freeze.json" "$temporary_freeze"
if ! ln "$temporary_freeze" "$target_freeze"; then
  rm -f -- "$temporary_freeze"
  abort freeze-record-raced 1147
fi
rm -f -- "$temporary_freeze"
FREEZE_INSTALLED=1
node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-production-hardening-freeze.js" \
  verify "$target_freeze" >/dev/null || abort installed-freeze-invalid 1148

final_meta=''
for _ in $(seq 1 30); do
  final_meta="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta 2>/dev/null || true)"
  if [[ "$(json_field "$final_meta" revisionLabel 2>/dev/null || true)" == R111F ]]; then break; fi
  sleep 1
done
[[ "$(json_field "$final_meta" revision)" == 111 &&
   "$(json_field "$final_meta" revisionFrozen)" == true &&
   "$(json_field "$final_meta" revisionLabel)" == R111F ]] ||
  abort final-frozen-metadata-invalid 1149
printf '%s\n' "$final_meta" > "$WORK/meta.final.json"

phase 'START CLEAN V3 72-HOUR BENCHMARK'
benchmark_root='/var/lib/stay/evidence/physiology-benchmark/R111F'
[[ ! -e "$benchmark_root" && ! -L "$benchmark_root" ]] || abort benchmark-target-already-exists 1150
install -d -o root -g root -m 0700 "$benchmark_root"
install -d -o root -g root -m 0755 "$(dirname "$BENCHMARK_SCRIPT")"
install_atomic "$NEW_RELEASE/deploy/live-physiology-transplant/p1-physiology-benchmark.js" \
  "$BENCHMARK_SCRIPT" 0500
install_atomic "$NEW_RELEASE/deploy/live-physiology-transplant/p1-resident-control-client.js" \
  "$CONTROL_SCRIPT" 0500
cat > "$WORK/benchmark.service" <<EOF
[Unit]
Description=STAY R111F BSF SNTSS I4-G1 Chronobiology production-hardening 72-hour benchmark
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
ReadWritePaths=$benchmark_root
Environment=STAY_DATABASE=$DATABASE
Environment=STAY_RESIDENT_CONTROL_SOCKET=$SOCKET
Environment=STAY_SERVICE_CGROUP=$SERVICE_CGROUP
Environment=STAY_REQUIRE_CGROUPS=1
Environment=STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel
Environment=STAY_PHYSIOLOGY_BENCHMARK_ROOT=$benchmark_root
Environment=STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION=0.5.0-i4g1

[Install]
WantedBy=multi-user.target
EOF
install_atomic "$WORK/benchmark.service" "$BENCHMARK_UNIT" 0644
systemctl daemon-reload || abort benchmark-daemon-reload-failed 1151
systemd-analyze verify stay-p1-physiology-benchmark.service >/dev/null \
  2>"$WORK/benchmark-systemd-verify.stderr" || abort benchmark-unit-invalid 1152
systemctl enable --now stay-p1-physiology-benchmark.service >/dev/null ||
  abort benchmark-start-failed 1153
NEW_BENCHMARK_STARTED=1
for _ in $(seq 1 30); do
  [[ -s "$benchmark_root/state.json" && -s "$benchmark_root/samples.jsonl" ]] && break
  sleep 1
done
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value)" == active ]] ||
  abort benchmark-not-active 1154
node - "$benchmark_root/state.json" "$BENCHMARK_SCRIPT" <<'NODE'
'use strict';
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { observedFailures } = require(process.argv[3]);
if (!(
  state.format === 'stay-physiology-benchmark-state-v3' &&
  state.runtimeRevision === 111 &&
  state.collectorStarts === 1 &&
  state.collectorRestarts === 0 &&
  state.failures === 0 &&
  state.sntssCoreHostFaults === 0 &&
  state.sntssProcessTransitions === 0 &&
  state.chronobiologyCoreHostFaults === 0 &&
  state.chronobiologyProcessTransitions === 0 &&
  state.mainPidTransitions === 0 &&
  state.maintenanceFailureRows === 0 &&
  state.startupTeardownFailureRows === 0 &&
  state.detachTeardownFailureRows === 0 &&
  state.terminalTeardownFailureRows === 0 &&
  state.shutdownCheckpointFailureRows === 0 &&
  state.shutdownStopFailureRows === 0 &&
  state.outboxPendingRows === 0 &&
  state.maxPendingOutboxIntents === 0 &&
  observedFailures(state) === 0
)) process.exit(1);
NODE

benchmark_started_at="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).startedAt)' "$benchmark_root/state.json")"
benchmark_due_15m="$(date -u -d "$benchmark_started_at +15 minutes" +'%Y-%m-%dT%H:%M:%SZ')"
benchmark_due_12h="$(date -u -d "$benchmark_started_at +12 hours" +'%Y-%m-%dT%H:%M:%SZ')"
benchmark_due_72h="$(date -u -d "$benchmark_started_at +72 hours" +'%Y-%m-%dT%H:%M:%SZ')"
sntss_generation="$(json_field "$after_sntss" resident.checkpointGeneration)"
chronobiology_generation="$(json_field "$after_chronobiology" resident.checkpointGeneration)"

cat > "$WORK/result.env" <<EOF
P1_PRODUCTION_HARDENING_FORWARD_RESULT=PASS
RUNTIME_REVISION_BEFORE=110
RUNTIME_REVISION_AFTER=111
REVISION_LABEL=R111F
CURRENT_RELEASE=$NEW_RELEASE
SERVICE_RESTARTS_THIS_FORWARD=ONE
R110F_BENCHMARK=CLOSED_AS_FAILED_DIAGNOSTIC_EVIDENCE_RETAINED
R110F_12H_EVIDENCE_SHA256=sha256:1fbf5e7b854204278a7ee7967dfc0c9016d1eeb5b281eb7a5289fd66d3b88007
SNTSS_BIOLOGICAL_PACKAGE_CHANGED=NO
SNTSS_RESOURCE_CONTRACT_CHANGED=NO
FROZEN_I4_TREE_SHA256=sha256:$source_i4_digest
SNTSS_STATUS=ACTIVE_SHADOW_RESIDENT
SNTSS_VERSION=0.5.0-i4g1
SNTSS_STATE_SCHEMA=5
SNTSS_AUTHORITY=NONE
SNTSS_OUTPUT_COUNT=0
SNTSS_CHECKPOINT_GENERATION=$sntss_generation
EVENT_CHECKPOINT_COMMIT_FENCE=PASS
SPECULATIVE_OUTPUT_FENCE=PASS
GENERATION_FENCED_RECOVERY=PASS
INACTIVE_CHRONOLOGY_GAP_BACKFILL=PASS
POST_COMMIT_OUTBOX_RETRY=PASS
PAYLOAD_QUIESCENCE_BEFORE_SPAWN=PASS
PAYLOAD_CGROUP_MEMORY_HIGH_BYTES=67108864
PAYLOAD_CGROUP_MEMORY_MAX_BYTES=100663296
SUPERVISOR_KERNEL_ACCOUNTING=PASS
CHRONOBIOLOGY_STATUS=ACTIVE_SHADOW_RESIDENT
CHRONOBIOLOGY_AUTHORITY=NONE
CHRONOBIOLOGY_CHECKPOINT_GENERATION=$chronobiology_generation
BSF_STATUS=FUNCTIONAL
BSF_MODE=LIVE
BOUNDED_LIVE_SOAK_SECONDS=130
BENCHMARK_SERVICE=ACTIVE
BENCHMARK_CONTRACT=V3_ZERO_FAULT_ZERO_TRANSITION
BENCHMARK_DURATION_HOURS=72
BENCHMARK_EVIDENCE_ROOT=$benchmark_root
BENCHMARK_15M_DUE_UTC=$benchmark_due_15m
BENCHMARK_12H_DUE_UTC=$benchmark_due_12h
BENCHMARK_72H_DUE_UTC=$benchmark_due_72h
FETUS_CONTINUITY=PASS
EOF

final_evidence="$EVIDENCE_ROOT/R111F-$(date -u +'%Y%m%dT%H%M%SZ')"
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
COMPLETED=1
trap - EXIT
cat "$final_evidence/result.env"
cat "$final_evidence/freeze-summary.env"
echo "P1_PRODUCTION_HARDENING_EVIDENCE=$final_evidence"
echo "P1_PRODUCTION_HARDENING_EVIDENCE_SHA256=sha256:$(find "$final_evidence" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
