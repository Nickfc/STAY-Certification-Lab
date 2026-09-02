#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

abort() { printf 'R123F_BENCHMARK_START_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }

[[ "$EUID" -eq 0 ]] || abort root-required 2301
[[ "${STAY_R123F_BENCHMARK_AUTHORIZATION:-}" == \
  'AUTHORIZE_R123F_15M_12H_72H_BENCHMARK_WITH_ISOLATED_LAB_PARALLEL' ]] ||
  abort authorization-required 2302
for name in STAY_R123F_BENCHMARK_SOURCE_TAG STAY_R123F_BENCHMARK_SOURCE_COMMIT \
  STAY_R123F_BENCHMARK_SOURCE_TREE STAY_R123F_BENCHMARK_SCRIPT_SHA256; do
  [[ -n "${!name:-}" ]] || abort source-identity-missing 2303
done
[[ "$STAY_R123F_BENCHMARK_SOURCE_TAG" == 'r123f-benchmark-start-v1' \
  && "$STAY_R123F_BENCHMARK_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R123F_BENCHMARK_SOURCE_TREE" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R123F_BENCHMARK_SCRIPT_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  abort source-identity-invalid 2304

release='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173'
database='/var/lib/stay/data/continuity.sqlite3'
socket='/run/stay/resident-control.sock'
service_cgroup='/sys/fs/cgroup/system.slice/stay.service'
freeze='/var/lib/stay/evidence/runtime-freezes/R123.json'
freeze_sha='sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc'
benchmark_helper="$release/deploy/live-physiology-transplant/p1-physiology-benchmark.js"
benchmark_helper_sha='76af26cda4199411b6df636c86402c62d8daa8201b4d6bb212e92719051122ed'
benchmark_root='/var/lib/stay/evidence/physiology-benchmark/R123F'
benchmark_unit='/etc/systemd/system/stay-p1-physiology-benchmark.service'
evidence_parent='/var/lib/stay/evidence/production-hardening'
script="$(readlink -f -- "$0")"
expected_pid='395571'
work=''
root_created=0
unit_replaced=0
complete=0

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$complete" -eq 0 ]]; then
    if [[ "$unit_replaced" -eq 1 ]]; then
      systemctl disable --now stay-p1-physiology-benchmark.service >/dev/null 2>&1 || true
      if [[ -f "$work/benchmark.service.before" && ! -L "$work/benchmark.service.before" ]]; then
        install -o root -g root -m 0644 "$work/benchmark.service.before" "$benchmark_unit"
      else
        rm -f -- "$benchmark_unit"
      fi
      systemctl daemon-reload >/dev/null 2>&1 || true
      if [[ "$(cat "$work/unit-file-state.before" 2>/dev/null)" == enabled ]]; then
        systemctl enable stay-p1-physiology-benchmark.service >/dev/null 2>&1 || true
      fi
    fi
    if [[ "$root_created" -eq 1 && "$benchmark_root" == \
      /var/lib/stay/evidence/physiology-benchmark/R123F \
      && -d "$benchmark_root" && ! -L "$benchmark_root" ]]; then
      failed_benchmark="/var/lib/stay/evidence/physiology-benchmark/FAILED-R123F-START-$(date -u +'%Y%m%dT%H%M%SZ')"
      [[ ! -e "$failed_benchmark" && ! -L "$failed_benchmark" ]] &&
        mv -- "$benchmark_root" "$failed_benchmark"
    fi
    if [[ -n "$work" && "$work" == "$evidence_parent"/.R123F-BENCHMARK-START.* \
      && -d "$work" && ! -L "$work" ]]; then
      failed_work="$evidence_parent/FAILED-R123F-BENCHMARK-START-$(date -u +'%Y%m%dT%H%M%SZ').${work##*.}"
      mv -- "$work" "$failed_work" 2>/dev/null || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

[[ -f "$script" && ! -L "$script" \
  && "sha256:$(sha256sum "$script" | awk '{print $1}')" == \
    "$STAY_R123F_BENCHMARK_SCRIPT_SHA256" ]] || abort source-hash-invalid 2305
[[ "$(readlink -f /opt/stay/current)" == "$release" \
  && -d "$release" && ! -L "$release" \
  && -f "$database" && ! -L "$database" \
  && -S "$socket" \
  && -f "$benchmark_helper" && ! -L "$benchmark_helper" \
  && "$(sha256sum "$benchmark_helper" | awk '{print $1}')" == "$benchmark_helper_sha" ]] ||
  abort immutable-release-fence-invalid 2306
[[ -f "$freeze" && ! -L "$freeze" \
  && "$(stat -c '%a' "$freeze")" == 440 ]] || abort freeze-file-invalid 2307
[[ "$(systemctl show stay.service -p MainPID --value)" == "$expected_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == 0 \
  && "$(systemctl show stay.service -p ActiveState --value)" == active \
  && "$(systemctl show stay.service -p SubState --value)" == running ]] ||
  abort production-service-fence-changed 2308
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value 2>/dev/null || true)" \
  == inactive ]] || abort benchmark-already-active 2309
[[ ! -e "$benchmark_root" && ! -L "$benchmark_root" ]] || abort benchmark-root-exists 2310

/usr/local/bin/node - "$freeze" "$release" "$freeze_sha" <<'NODE'
'use strict';
const fs = require('node:fs'); const path = require('node:path');
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { validateRevisionFreeze } = require(path.join(process.argv[3], 'runtime/revision-freeze'));
if (!(validateRevisionFreeze(record, 123)
  && record.recordSha256 === process.argv[4]
  && record.runtime?.serviceMainPid === 395571
  && record.runtime?.restartCommandsForFreeze === 0
  && record.exception?.historicalAbandonedDeliveries === 1
  && record.exception?.unresolvedPendingDeliveries === 0
  && record.exception?.inventedBiologicalTime === false
  && record.residents?.sntss?.outputs === 0
  && record.residents?.sntss?.authority === 'NONE'
  && record.residents?.chronobiology?.authority === 'NONE')) process.exit(1);
NODE

meta="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta)"
/usr/local/bin/node -e '
const meta=JSON.parse(process.argv[1]);
const chip=id=>meta.chipProjection?.lifecycle?.find(value=>value.coreId===id);
const fetus=meta.cores?.find(value=>value.id==="fetus-legacy");
if (!(meta.ok===true && meta.revision===123 && meta.revisionFrozen===true
  && meta.revisionLabel==="R123F" && chip("bsf")?.state==="LIVE"
  && chip("sntss")?.state==="SHADOW" && chip("chronobiology")?.state==="SHADOW"
  && fetus?.memoryGuardian?.status==="healthy")) process.exit(1);
' "$meta" || abort public-r123f-fence-invalid 2311

work="$(mktemp -d "$evidence_parent/.R123F-BENCHMARK-START.XXXXXX")"
if [[ -f "$benchmark_unit" && ! -L "$benchmark_unit" ]]; then
  cp -- "$benchmark_unit" "$work/benchmark.service.before"
fi
systemctl show stay-p1-physiology-benchmark.service -p UnitFileState --value > \
  "$work/unit-file-state.before"

install -d -o root -g root -m 0700 "$benchmark_root"
root_created=1
/usr/local/bin/node - "$benchmark_root/start-authorization.json" <<'NODE'
'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  format: 'stay-r123f-benchmark-start-authorization-v1',
  authorization: process.env.STAY_R123F_BENCHMARK_AUTHORIZATION,
  runtimeRevision: 123,
  revisionLabel: 'R123F',
  freezeRecordSha256: 'sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc',
  sourceTag: process.env.STAY_R123F_BENCHMARK_SOURCE_TAG,
  sourceCommit: process.env.STAY_R123F_BENCHMARK_SOURCE_COMMIT,
  sourceTree: process.env.STAY_R123F_BENCHMARK_SOURCE_TREE,
  sourceScriptSha256: process.env.STAY_R123F_BENCHMARK_SCRIPT_SHA256,
  milestones: ['15m', '12h', '72h'],
  isolatedLaboratoryWorkAuthorizedInParallel: true,
  productionAttachmentAuthorized: false,
  productionRestartAuthorized: false,
  historicalAbandonedDeliveriesAtBaseline: 1,
  unresolvedPendingDeliveriesAtBaseline: 0,
  createdAt: new Date().toISOString(),
}));
NODE
chmod 0400 "$benchmark_root/start-authorization.json"

cat > "$work/benchmark.service" <<EOF
[Unit]
Description=STAY R123F 15-minute, 12-hour and 72-hour physiology benchmark
After=stay.service
Requires=stay.service
StartLimitIntervalSec=3600
StartLimitBurst=6

[Service]
Type=simple
ExecStart=/usr/local/bin/node $benchmark_helper run
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
Environment=STAY_DATABASE=$database
Environment=STAY_RESIDENT_CONTROL_SOCKET=$socket
Environment=STAY_SERVICE_CGROUP=$service_cgroup
Environment=STAY_REQUIRE_CGROUPS=1
Environment=STAY_CGROUP_DELEGATE_SUBGROUP=stay-kernel
Environment=STAY_PHYSIOLOGY_BENCHMARK_ROOT=$benchmark_root
Environment=STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION=0.5.0-i4g1

[Install]
WantedBy=multi-user.target
EOF
temporary_unit="$(mktemp "$(dirname "$benchmark_unit")/.stay-r123f-benchmark.XXXXXX")"
install -o root -g root -m 0644 "$work/benchmark.service" "$temporary_unit"
mv -fT "$temporary_unit" "$benchmark_unit"
unit_replaced=1
systemctl daemon-reload || abort benchmark-daemon-reload-failed 2312
systemd-analyze verify stay-p1-physiology-benchmark.service > \
  "$work/systemd-verify.stdout" 2> "$work/systemd-verify.stderr" ||
  abort benchmark-unit-invalid 2313
systemctl enable --now stay-p1-physiology-benchmark.service > \
  "$work/systemctl-start.stdout" 2> "$work/systemctl-start.stderr" ||
  abort benchmark-start-failed 2314

for _ in $(seq 1 30); do
  [[ -s "$benchmark_root/state.json" && -s "$benchmark_root/samples.jsonl" ]] && break
  sleep 1
done
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value)" == active \
  && "$(systemctl show stay-p1-physiology-benchmark.service -p SubState --value)" == running \
  && -s "$benchmark_root/state.json" && -s "$benchmark_root/samples.jsonl" ]] ||
  abort benchmark-not-active 2315

/usr/local/bin/node - "$benchmark_root/state.json" "$benchmark_helper" <<'NODE'
'use strict';
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { observedFailures } = require(process.argv[3]);
if (!(state.format === 'stay-physiology-benchmark-state-v3'
  && state.runtimeRevision === 123
  && state.samples >= 1
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
[[ "$(systemctl show stay.service -p MainPID --value)" == "$expected_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == 0 ]] ||
  abort production-service-changed-during-start 2316

cp -- "$benchmark_root/state.json" "$work/state.start.json"
head -n 1 "$benchmark_root/samples.jsonl" > "$work/sample.start.json"
cp -- "$benchmark_root/start-authorization.json" "$work/start-authorization.json"
sha256sum "$benchmark_helper" "$freeze" "$benchmark_root/state.json" \
  "$benchmark_root/samples.jsonl" > "$work/start.sha256"
started_at="$(/usr/local/bin/node -e \
  'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).startedAt)' \
  "$benchmark_root/state.json")"
due_15m="$(date -u -d "$started_at +15 minutes" +'%Y-%m-%dT%H:%M:%SZ')"
due_12h="$(date -u -d "$started_at +12 hours" +'%Y-%m-%dT%H:%M:%SZ')"
due_72h="$(date -u -d "$started_at +72 hours" +'%Y-%m-%dT%H:%M:%SZ')"
cat > "$work/result.env" <<EOF
R123F_BENCHMARK_START_RESULT=PASS
REVISION_LABEL=R123F
FREEZE_RECORD_SHA256=$freeze_sha
SERVICE_PID=$expected_pid
SERVICE_RESTARTS_DURING_START=ZERO
COLLECTOR_STARTS=ONE
COLLECTOR_RESTARTS=ZERO
BENCHMARK_STARTED_AT=$started_at
BENCHMARK_15M_DUE=$due_15m
BENCHMARK_12H_DUE=$due_12h
BENCHMARK_72H_DUE=$due_72h
LAB_PARALLEL=ISOLATED_ONLY
PRODUCTION_ATTACHMENT=NOT_AUTHORIZED
EOF

final="$evidence_parent/R123F-BENCHMARK-START-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final" && ! -L "$final" ]] || abort final-evidence-exists 2317
mv -- "$work" "$final"
work=''
chmod -R a-w -- "$final"
complete=1
printf 'R123F_BENCHMARK_START_RESULT=PASS\nREVISION_LABEL=R123F\nFREEZE_RECORD_SHA256=%s\nSERVICE_PID=%s\nSERVICE_RESTARTS_DURING_START=ZERO\nCOLLECTOR_STARTS=ONE\nCOLLECTOR_RESTARTS=ZERO\nBENCHMARK_ROOT=%s\nSTART_EVIDENCE=%s\nBENCHMARK_STARTED_AT=%s\nBENCHMARK_15M_DUE=%s\nBENCHMARK_12H_DUE=%s\nBENCHMARK_72H_DUE=%s\nLAB_PARALLEL=ISOLATED_ONLY\nPRODUCTION_ATTACHMENT=NOT_AUTHORIZED\n' \
  "$freeze_sha" "$expected_pid" "$benchmark_root" "$final" "$started_at" \
  "$due_15m" "$due_12h" "$due_72h"
