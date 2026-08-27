#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1j-production-hardening-6a04981799aa'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
PARENT_FREEZE='/var/lib/stay/evidence/runtime-freezes/R110.json'
HISTORICAL_FREEZE='/var/lib/stay/evidence/runtime-freezes/R108.json'
R110_CLOSURE='/var/lib/stay/evidence/physiology-benchmark/R110F/production-hardening-closure.json'
RUNTIME_DROPIN='/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf'
ONE_SHOT_DROPIN='/etc/systemd/system/stay.service.d/p1-r113-cold-recovery-once.conf'
SOCKET='/run/stay/resident-control.sock'
SERVICE_CGROUP='/sys/fs/cgroup/system.slice/stay.service'
BWRAP='/usr/local/libexec/stay-bwrap-sandbox'
BENCHMARK_SCRIPT='/usr/local/libexec/stay-p1-physiology-benchmark-v3.js'
CONTROL_SCRIPT='/usr/local/libexec/stay-resident-control-client.js'
BENCHMARK_UNIT='/etc/systemd/system/stay-p1-physiology-benchmark.service'
BENCHMARK_ROOT='/var/lib/stay/evidence/physiology-benchmark/R114F'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
STAGE_ROOT="$(readlink -f -- "$SCRIPT_DIRECTORY/../..")"
SOURCE_MANIFEST="$SCRIPT_DIRECTORY/P1_PRODUCTION_HARDENING_R110F_TO_R111F.sha256"
WORK=''
ONE_SHOT_CREATED=0
COMPLETED=0

phase() {
  echo "===== $1 ====="
}

abort() {
  echo "P1_PRODUCTION_HARDENING_FORWARD_RECOVERY_ABORT=$1" >&2
  exit "${2:-1}"
}

json_field() {
  node -e 'const value=process.argv[2].split(".").reduce((object,key)=>object?.[key],JSON.parse(process.argv[1]));process.stdout.write(String(value??""))' "$1" "$2"
}

proc_value() {
  tr '\0' '\n' < "/proc/$1/environ" |
    awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,"");print;found=1} END{if(!found)exit 1}'
}

env_file_value() {
  awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,"");print;found=1} END{if(!found)exit 1}' "$1"
}

durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" node <<'NODE'
'use strict';
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.STAY_DATABASE, { readOnly: true });
try {
  const row = database.prepare(`
    SELECT json, sha256
    FROM metadata
    WHERE key='life:runtime-revision'
  `).get();
  if (!row) process.exit(2);
  const digest = crypto.createHash('sha256').update(row.json).digest('hex');
  if (digest !== row.sha256) process.exit(3);
  const revision = Number(JSON.parse(row.json).revision);
  if (!Number.isSafeInteger(revision) || revision < 1) process.exit(4);
  process.stdout.write(String(revision));
} finally {
  database.close();
}
NODE
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.p1-production-hardening-recovery.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
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

write_benchmark_unit() {
  local target="$1"
  cat > "$target" <<EOF
[Unit]
Description=STAY R114F BSF SNTSS I4-G1 Chronobiology contained-repair 72-hour benchmark
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
}

verify_running_benchmark_contract() {
  local benchmark_pid command
  [[ -f "$BENCHMARK_SCRIPT" && ! -L "$BENCHMARK_SCRIPT" &&
     -f "$CONTROL_SCRIPT" && ! -L "$CONTROL_SCRIPT" &&
     -f "$BENCHMARK_UNIT" && ! -L "$BENCHMARK_UNIT" ]] || return 1
  [[ "$(sha256sum "$BENCHMARK_SCRIPT" | awk '{print $1}')" == \
     "$(sha256sum "$current_release/deploy/live-physiology-transplant/p1-physiology-benchmark.js" | awk '{print $1}')" ]] || return 1
  [[ "$(sha256sum "$CONTROL_SCRIPT" | awk '{print $1}')" == \
     "$(sha256sum "$current_release/deploy/live-physiology-transplant/p1-resident-control-client.js" | awk '{print $1}')" ]] || return 1
  cmp -s "$WORK/benchmark.service.expected" "$BENCHMARK_UNIT" || return 1
  [[ "$(systemctl show stay-p1-physiology-benchmark.service -p FragmentPath --value)" == "$BENCHMARK_UNIT" &&
     "$(systemctl show stay-p1-physiology-benchmark.service -p NeedDaemonReload --value)" == no ]] || return 1
  benchmark_pid="$(systemctl show stay-p1-physiology-benchmark.service -p MainPID --value)"
  [[ "$benchmark_pid" =~ ^[0-9]+$ && "$benchmark_pid" -gt 1 && -d "/proc/$benchmark_pid" ]] || return 1
  command="$(tr '\0' ' ' < "/proc/$benchmark_pid/cmdline")"
  [[ "$command" == *"$BENCHMARK_SCRIPT run"* ]] || return 1
  [[ "$(proc_value "$benchmark_pid" STAY_DATABASE)" == "$DATABASE" &&
     "$(proc_value "$benchmark_pid" STAY_PHYSIOLOGY_BENCHMARK_ROOT)" == "$BENCHMARK_ROOT" &&
     "$(proc_value "$benchmark_pid" STAY_REQUIRE_CGROUPS)" == 1 &&
     "$(proc_value "$benchmark_pid" STAY_CGROUP_DELEGATE_SUBGROUP)" == stay-kernel &&
     "$(proc_value "$benchmark_pid" STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION)" == 0.5.0-i4g1 ]] || return 1
}

archive_work() {
  local label="$1" target
  target="$(mktemp -d "$EVIDENCE_ROOT/${label}-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
  rmdir -- "$target"
  mv -T "$WORK" "$target"
  WORK=''
  chmod -R a-w "$target"
  printf '%s\n' "$target"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$ONE_SHOT_CREATED" -eq 1 && -f "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]]; then
    rm -f -- "$ONE_SHOT_DROPIN"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if [[ "$COMPLETED" -eq 0 && -n "$WORK" && -d "$WORK" ]]; then
    local failed
    failed="$(archive_work 'FAILED-R114-RECOVERY')"
    echo "P1_PRODUCTION_HARDENING_FORWARD_RECOVERY_FAILURE_EVIDENCE=$failed" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 1201
[[ "${STAY_P1_PRODUCTION_HARDENING_RECOVERY_AUTHORIZATION:-}" == \
   'FORWARD_RECOVER_R114_AND_COMPLETE_FREEZE_BENCHMARK' ]] || abort authorization-required 1202

phase 'SOURCE AND LIVE IDENTITY'
for file in "$DATABASE" "$PARENT_FREEZE" "$HISTORICAL_FREEZE" "$RUNTIME_DROPIN" \
  "$BWRAP" "$SOURCE_MANIFEST"; do
  [[ -f "$file" && ! -L "$file" ]] || abort immutable-input-invalid 1203
done
(
  cd "$STAGE_ROOT"
  sha256sum -c deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R110F_TO_R111F.sha256
) || abort source-manifest-invalid 1204

current_release="$(readlink -f /opt/stay/current)"
[[ "$current_release" == /opt/stay/releases/0.8.11.3-p1k-r112-repair-* &&
   -d "$current_release" && ! -L "$current_release" ]] || abort current-release-not-r114-candidate 1205
release_contract="$current_release/P1_PRODUCTION_HARDENING_RELEASE.env"
[[ -f "$release_contract" && ! -L "$release_contract" ]] || abort release-contract-invalid 1206
[[ "$(env_file_value "$release_contract" P1_PRODUCTION_HARDENING_RELEASE)" == PASS &&
   "$(env_file_value "$release_contract" PARENT_RELEASE)" == "$SOURCE_RELEASE" &&
   "$(env_file_value "$release_contract" PARENT_REVISION)" == R112 &&
   "$(env_file_value "$release_contract" TARGET_REVISION)" == R114F &&
   "$(env_file_value "$release_contract" SNTSS_BIOLOGICAL_PACKAGE_CHANGED)" == NO &&
   "$(env_file_value "$release_contract" SNTSS_RESOURCE_CONTRACT_CHANGED)" == NO ]] ||
  abort release-contract-mismatch 1207
expected_i4="$(env_file_value "$release_contract" FROZEN_I4_TREE_SHA256)"
[[ "$expected_i4" == "sha256:$(tree_digest "$current_release")" ]] || abort frozen-i4-tree-changed 1208

observed_ip="$(ip -o -4 addr show scope global |
  awk '{address=$4;sub(/\/.*/,"",address);print address}' |
  sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 1209

failure_evidence="${STAY_P1_PRODUCTION_HARDENING_FAILURE_EVIDENCE:-}"
if [[ -z "$failure_evidence" ]]; then
  while IFS= read -r candidate; do
    if [[ -s "$candidate/recovery.before.json" && -s "$candidate/preflight.json" &&
         -s "$candidate/r110-closure.json" && -s "$candidate/service.before.env" &&
         -s "$candidate/p1-r113-cold-recovery-once.conf" ]]; then
      failure_evidence="$candidate"
      break
    fi
  done < <(find "$EVIDENCE_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'FAILED-R114-*' -printf '%p\n' | sort -r)
fi
[[ -n "$failure_evidence" && -d "$failure_evidence" && ! -L "$failure_evidence" &&
   "$(readlink -f "$failure_evidence")" == "$EVIDENCE_ROOT"/FAILED-R114-* ]] ||
  abort prior-failure-evidence-not-found 1210

before_proof="$failure_evidence/recovery.before.json"
preflight="$failure_evidence/preflight.json"
closure="$failure_evidence/r110-closure.json"
before_service="$failure_evidence/service.before.env"
one_shot_source="$failure_evidence/p1-r113-cold-recovery-once.conf"
for file in "$before_proof" "$preflight" "$closure" "$before_service" "$one_shot_source"; do
  [[ -f "$file" && ! -L "$file" && -s "$file" ]] || abort prior-failure-evidence-invalid 1211
done
[[ -f "$R110_CLOSURE" && ! -L "$R110_CLOSURE" &&
   "$(sha256sum "$R110_CLOSURE" | awk '{print $1}')" == "$(sha256sum "$closure" | awk '{print $1}')" ]] ||
  abort r110-closure-identity-mismatch 1212

before_nrestarts="$(env_file_value "$before_service" SYSTEMD_NRESTARTS)"
[[ "$before_nrestarts" =~ ^[0-9]+$ ]] || abort prior-restart-counter-invalid 1213
current_nrestarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$current_nrestarts" == "$before_nrestarts" ]] || abort automatic-service-restart-observed 1214

WORK="$(mktemp -d "$EVIDENCE_ROOT/.forward-recovery.XXXXXX")"
install -o root -g root -m 0400 "$before_proof" "$WORK/recovery.before.json"
install -o root -g root -m 0400 "$preflight" "$WORK/preflight.json"
install -o root -g root -m 0400 "$closure" "$WORK/r110-closure.json"
install -o root -g root -m 0400 "$before_service" "$WORK/service.before.env"
install -o root -g root -m 0400 "$one_shot_source" "$WORK/p1-r113-cold-recovery-once.conf"

target_freeze='/var/lib/stay/evidence/runtime-freezes/R114.json'
recovery_restarts=1
revision_fenced_retry='NOT_REQUIRED'

if [[ ! -e "$target_freeze" && ! -L "$target_freeze" ]]; then
  phase 'PROVE OR REVISION-FENCE THE RUNNING R114 GENERATION'
  health="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
  sntss="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node \
    "$current_release/deploy/live-physiology-transplant/p1-resident-control-client.js" \
    status resident:sntss 2>/dev/null || true)"
  chronobiology="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node \
    "$current_release/deploy/live-physiology-transplant/p1-resident-control-client.js" \
    status resident:chronobiology 2>/dev/null || true)"

  durable_revision="$(durable_runtime_revision)" || abort durable-runtime-revision-invalid 1215
  if [[ "$(systemctl show stay.service -p ActiveState --value)" == active &&
        "$(json_field "$health" ok 2>/dev/null || true)" == true &&
        "$(json_field "$health" revision 2>/dev/null || true)" == 114 &&
        "$durable_revision" == 114 ]]; then
    revision_fenced_retry='R114_RUNNING_GENERATION_PROVED_NO_RESTART'
  else
    # A retry is safe only if the failed start committed no Kernel revision.
    # Once durable state advances beyond R112, another process start would
    # create a different generation and this R114 completion must fail closed.
    [[ "$durable_revision" == 112 ]] ||
      abort r114-generation-not-live-restart-would-advance-revision 1216
    [[ ! -e "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]] ||
      abort one-shot-dropin-already-exists 1217
    recovery_restarts=2
    revision_fenced_retry='FIRST_START_COMMITTED_NO_REVISION_SAFE_R113_RETRY'
    install_atomic "$one_shot_source" "$ONE_SHOT_DROPIN" 0644
    ONE_SHOT_CREATED=1
    systemctl daemon-reload || abort daemon-reload-failed 1218
    systemd-analyze verify stay.service >/dev/null 2>"$WORK/systemd-verify.stderr" ||
      abort systemd-contract-invalid 1219
    systemctl restart stay.service || abort recovery-restart-failed 1220
    for _ in $(seq 1 300); do
      health="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
      if [[ "$(json_field "$health" ok 2>/dev/null || true)" == true &&
           "$(json_field "$health" revision 2>/dev/null || true)" == 114 && -S "$SOCKET" ]]; then
        break
      fi
      sleep 1
    done
    durable_revision="$(durable_runtime_revision)" || abort durable-runtime-revision-invalid 1220
    [[ "$(json_field "$health" ok 2>/dev/null || true)" == true &&
       "$(json_field "$health" revision 2>/dev/null || true)" == 114 &&
       "$durable_revision" == 114 ]] || abort recovered-runtime-not-r114 1220
    rm -f -- "$ONE_SHOT_DROPIN"
    ONE_SHOT_CREATED=0
    systemctl daemon-reload || abort one-shot-removal-daemon-reload-failed 1220
  fi

  main_pid="$(systemctl show stay.service -p MainPID --value)"
  current_nrestarts="$(systemctl show stay.service -p NRestarts --value)"
  [[ "$current_nrestarts" == "$before_nrestarts" ]] || abort automatic-service-restart-observed 1221
  [[ "$(readlink -f /opt/stay/current)" == "$current_release" &&
     "$(proc_value "$main_pid" STAY_TRUSTED_TIME_PULSE_INTERVAL_MS)" == 250 &&
     "$(proc_value "$main_pid" STAY_TRUSTED_ORGANISM_TIME_PULSE_INTERVAL_MS)" == 60000 &&
     "$(proc_value "$main_pid" STAY_REQUIRE_CGROUPS)" == 1 ]] || abort recovered-runtime-contract-invalid 1222
  [[ ! -e "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]] || abort one-shot-dropin-not-removed 1223
  if systemctl show stay.service -p Environment --value | tr ' ' '\n' |
    grep -q '^STAY_RECOVER_COLD_RESIDENTS_AT_REVISION='; then
    abort one-shot-recovery-still-configured 1224
  fi

  sntss=''
  chronobiology=''
  for _ in $(seq 1 300); do
    sntss="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node \
      "$current_release/deploy/live-physiology-transplant/p1-resident-control-client.js" \
      status resident:sntss 2>/dev/null || true)"
    chronobiology="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node \
      "$current_release/deploy/live-physiology-transplant/p1-resident-control-client.js" \
      status resident:chronobiology 2>/dev/null || true)"
    if [[ "$(json_field "$sntss" resident.running 2>/dev/null || true)" == true &&
         "$(json_field "$chronobiology" resident.running 2>/dev/null || true)" == true ]]; then
      break
    fi
    sleep 1
  done
  printf '%s\n' "$health" > "$WORK/health.after-recovery.json"
  printf '%s\n' "$sntss" > "$WORK/sntss.after-recovery.json"
  printf '%s\n' "$chronobiology" > "$WORK/chronobiology.after-recovery.json"
  STAY_DATABASE="$DATABASE" STAY_RECOVERY_SERVICE_RESTARTS="$recovery_restarts" node \
    "$current_release/deploy/live-physiology-transplant/p1-production-hardening-live-proof.js" \
    repair-recovery "$WORK/recovery.before.json" "$WORK/sntss.after-recovery.json" \
    "$WORK/chronobiology.after-recovery.json" > "$WORK/recovery.proof.json" ||
    abort cold-recovery-proof-invalid 1225

  phase 'BOUNDED LIVE PROGRESSION GATE (130 SECONDS)'
  STAY_REQUIRE_CGROUPS=1 STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel \
    STAY_DATABASE="$DATABASE" STAY_SERVICE_CGROUP="$SERVICE_CGROUP" \
    node "$current_release/deploy/live-physiology-transplant/p1-physiology-benchmark.js" sample > \
    "$WORK/soak.start.json" || abort soak-start-sample-failed 1226
  for step in $(seq 1 26); do
    sleep 5
    if (( step % 2 == 0 )); then
      echo "R114_FORWARD_RECOVERY_GATE_PROGRESS_SECONDS=$((step * 5))"
    fi
  done
  STAY_REQUIRE_CGROUPS=1 STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel \
    STAY_DATABASE="$DATABASE" STAY_SERVICE_CGROUP="$SERVICE_CGROUP" \
    node "$current_release/deploy/live-physiology-transplant/p1-physiology-benchmark.js" sample > \
    "$WORK/soak.end.json" || abort soak-end-sample-failed 1227
  STAY_PRODUCTION_HARDENING_TARGET_REVISION=114 node \
    "$current_release/deploy/live-physiology-transplant/p1-production-hardening-live-proof.js" \
    soak "$WORK/soak.start.json" "$WORK/soak.end.json" > "$WORK/soak.proof.json" ||
    abort bounded-live-soak-failed 1228

  phase 'DURABLE STATE AND R114 FREEZE'
  STAY_DATABASE="$DATABASE" node \
    "$current_release/deploy/live-physiology-transplant/p1-sntss-i4g-live-state.js" \
    114 "$HISTORICAL_FREEZE" > "$WORK/i4g-live-state.json" || abort durable-i4g-state-invalid 1229
  cp "$WORK/soak.end.json" "$WORK/final.sample.json"
  runtime_dropin_sha256="$(sha256sum "$RUNTIME_DROPIN" | awk '{print $1}')"
  one_shot_sha256="$(sha256sum "$one_shot_source" | awk '{print $1}')"
  overlay_sha256="$(env_file_value "$release_contract" PRODUCTION_OVERLAY_SHA256)"
  STAY_PRODUCTION_HARDENING_TARGET_REVISION=114 node \
    "$current_release/deploy/live-physiology-transplant/p1-production-hardening-freeze.js" capture \
    --sample "$WORK/final.sample.json" \
    --state "$WORK/i4g-live-state.json" \
    --parent "$PARENT_FREEZE" \
    --recovery "$WORK/recovery.proof.json" \
    --preflight "$WORK/preflight.json" \
    --closure "$WORK/r110-closure.json" \
    --soak "$WORK/soak.proof.json" \
    --release "$current_release" \
    --overlay-sha256 "$overlay_sha256" \
    --runtime-dropin-sha256 "sha256:$runtime_dropin_sha256" \
    --one-shot-dropin-sha256 "sha256:$one_shot_sha256" \
    --hostname "$(hostname)" \
    --private-ip "$observed_ip" \
    --main-pid "$main_pid" \
    --restarts "$current_nrestarts" \
    --captured-at "$(date -u +'%Y-%m-%dT%H:%M:%S.%NZ')" > "$WORK/freeze.json" ||
    abort freeze-capture-failed 1230
  STAY_PRODUCTION_HARDENING_TARGET_REVISION=114 node \
    "$current_release/deploy/live-physiology-transplant/p1-production-hardening-freeze.js" \
    verify "$WORK/freeze.json" > "$WORK/freeze-summary.env" || abort freeze-verification-failed 1231
  temporary_freeze="$(mktemp "$(dirname "$target_freeze")/.R114.XXXXXX")"
  install -o root -g staydeploy -m 0440 "$WORK/freeze.json" "$temporary_freeze"
  if ! ln "$temporary_freeze" "$target_freeze"; then
    rm -f -- "$temporary_freeze"
    abort freeze-record-raced 1232
  fi
  rm -f -- "$temporary_freeze"
  STAY_PRODUCTION_HARDENING_TARGET_REVISION=114 node \
    "$current_release/deploy/live-physiology-transplant/p1-production-hardening-freeze.js" \
    verify "$target_freeze" >/dev/null || abort installed-freeze-invalid 1233
else
  phase 'VERIFY EXISTING R114 FREEZE'
  [[ -f "$target_freeze" && ! -L "$target_freeze" ]] || abort target-freeze-invalid 1233
  STAY_PRODUCTION_HARDENING_TARGET_REVISION=114 node \
    "$current_release/deploy/live-physiology-transplant/p1-production-hardening-freeze.js" \
    verify "$target_freeze" > "$WORK/freeze-summary.env" || abort installed-freeze-invalid 1234
  recovery_restarts="$(json_field "$(<"$target_freeze")" recovery.serviceRestarts)"
  [[ "$recovery_restarts" == 1 || "$recovery_restarts" == 2 ]] ||
    abort installed-freeze-restart-count-invalid 1234
  revision_fenced_retry='EXISTING_R114_FREEZE_VERIFIED'
fi

final_meta=''
for _ in $(seq 1 30); do
  final_meta="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta 2>/dev/null || true)"
  if [[ "$(json_field "$final_meta" revisionLabel 2>/dev/null || true)" == R114F ]]; then break; fi
  sleep 1
done
[[ "$(json_field "$final_meta" revision)" == 114 &&
   "$(json_field "$final_meta" revisionFrozen)" == true &&
   "$(json_field "$final_meta" revisionLabel)" == R114F ]] || abort final-frozen-metadata-invalid 1235
printf '%s\n' "$final_meta" > "$WORK/meta.final.json"

phase 'START OR VERIFY CLEAN V3 72-HOUR BENCHMARK'
write_benchmark_unit "$WORK/benchmark.service.expected"
if [[ -e "$BENCHMARK_ROOT" || -L "$BENCHMARK_ROOT" ]]; then
  [[ -d "$BENCHMARK_ROOT" && ! -L "$BENCHMARK_ROOT" ]] || abort benchmark-root-invalid 1236
  if [[ -s "$BENCHMARK_ROOT/state.json" || -s "$BENCHMARK_ROOT/samples.jsonl" ]]; then
    [[ -s "$BENCHMARK_ROOT/state.json" && -s "$BENCHMARK_ROOT/samples.jsonl" &&
       "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value)" == active ]] &&
      verify_running_benchmark_contract ||
      abort existing-benchmark-is-not-cleanly-active 1237
  else
    archived_root="$(mktemp -d "/var/lib/stay/evidence/physiology-benchmark/FAILED-R114F-START-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
    rmdir -- "$archived_root"
    mv -T "$BENCHMARK_ROOT" "$archived_root"
    chmod -R a-w "$archived_root"
  fi
fi

if [[ ! -e "$BENCHMARK_ROOT" && ! -L "$BENCHMARK_ROOT" ]]; then
  systemctl stop stay-p1-physiology-benchmark.service >/dev/null 2>&1 || true
  install -d -o root -g root -m 0700 "$BENCHMARK_ROOT"
  install -d -o root -g root -m 0755 "$(dirname "$BENCHMARK_SCRIPT")"
  install_atomic "$current_release/deploy/live-physiology-transplant/p1-physiology-benchmark.js" \
    "$BENCHMARK_SCRIPT" 0500
  install_atomic "$current_release/deploy/live-physiology-transplant/p1-resident-control-client.js" \
    "$CONTROL_SCRIPT" 0500
  install_atomic "$WORK/benchmark.service.expected" "$BENCHMARK_UNIT" 0644
  systemctl daemon-reload || abort benchmark-daemon-reload-failed 1238
  systemd-analyze verify stay-p1-physiology-benchmark.service >/dev/null \
    2>"$WORK/benchmark-systemd-verify.stderr" || abort benchmark-unit-invalid 1239
  systemctl enable --now stay-p1-physiology-benchmark.service >/dev/null || abort benchmark-start-failed 1240
fi

for _ in $(seq 1 30); do
  [[ -s "$BENCHMARK_ROOT/state.json" && -s "$BENCHMARK_ROOT/samples.jsonl" ]] && break
  sleep 1
done
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value)" == active ]] ||
  abort benchmark-not-active 1241
node - "$BENCHMARK_ROOT/state.json" "$BENCHMARK_SCRIPT" <<'NODE'
'use strict';
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { observedFailures } = require(process.argv[3]);
if (!(
  state.format === 'stay-physiology-benchmark-state-v3' &&
  state.runtimeRevision === 114 &&
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

benchmark_started_at="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).startedAt)' "$BENCHMARK_ROOT/state.json")"
benchmark_due_15m="$(date -u -d "$benchmark_started_at +15 minutes" +'%Y-%m-%dT%H:%M:%SZ')"
benchmark_due_12h="$(date -u -d "$benchmark_started_at +12 hours" +'%Y-%m-%dT%H:%M:%SZ')"
benchmark_due_72h="$(date -u -d "$benchmark_started_at +72 hours" +'%Y-%m-%dT%H:%M:%SZ')"

cat > "$WORK/result.env" <<EOF
P1_PRODUCTION_HARDENING_FORWARD_RECOVERY_RESULT=PASS
RUNTIME_REVISION=114
REVISION_LABEL=R114F
CURRENT_RELEASE=$current_release
RECOVERY_SERVICE_RESTARTS=$recovery_restarts
REVISION_FENCED_RETRY=$revision_fenced_retry
AUTOMATIC_SERVICE_RESTARTS_DURING_TRANSITION=ZERO
SNTSS_BIOLOGICAL_PACKAGE_CHANGED=NO
SNTSS_RESOURCE_CONTRACT_CHANGED=NO
FROZEN_I4_TREE_SHA256=$expected_i4
BSF_STATUS=FUNCTIONAL
BSF_MODE=LIVE
SNTSS_STATUS=ACTIVE_SHADOW_RESIDENT
SNTSS_VERSION=0.5.0-i4g1
SNTSS_AUTHORITY=NONE
SNTSS_OUTPUT_COUNT=0
CHRONOBIOLOGY_STATUS=ACTIVE_SHADOW_RESIDENT
CHRONOBIOLOGY_AUTHORITY=NONE
BENCHMARK_SERVICE=ACTIVE
BENCHMARK_CONTRACT=V3_ZERO_FAULT_ZERO_TRANSITION
BENCHMARK_DURATION_HOURS=72
BENCHMARK_EVIDENCE_ROOT=$BENCHMARK_ROOT
BENCHMARK_15M_DUE_UTC=$benchmark_due_15m
BENCHMARK_12H_DUE_UTC=$benchmark_due_12h
BENCHMARK_72H_DUE_UTC=$benchmark_due_72h
FETUS_CONTINUITY=PASS
EOF

final_evidence="$(archive_work 'R114F-RECOVERY')"
COMPLETED=1
trap - EXIT
cat "$final_evidence/result.env"
cat "$final_evidence/freeze-summary.env"
echo "P1_PRODUCTION_HARDENING_FORWARD_RECOVERY_EVIDENCE=$final_evidence"
echo "P1_PRODUCTION_HARDENING_FORWARD_RECOVERY_EVIDENCE_SHA256=sha256:$(find "$final_evidence" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
