#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

abort() { printf 'R123F_AUTHORIZED_FREEZE_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }

[[ "$EUID" -eq 0 ]] || abort root-required 2201
[[ "${STAY_R123F_AUTHORIZATION:-}" == \
  'AUTHORIZE_R123F_FREEZE_WITH_ONE_DISCLOSED_HISTORICAL_ABANDONMENT_NO_BENCHMARK' ]] ||
  abort authorization-required 2202
for name in STAY_R123F_SOURCE_TAG STAY_R123F_SOURCE_COMMIT STAY_R123F_SOURCE_TREE \
  STAY_R123F_HELPER_SHA256 STAY_R123F_SHELL_SHA256; do
  [[ -n "${!name:-}" ]] || abort source-identity-missing 2203
done
[[ "$STAY_R123F_SOURCE_TAG" == 'r123f-authorized-freeze-v2' \
  && "$STAY_R123F_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R123F_SOURCE_TREE" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R123F_HELPER_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R123F_SHELL_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  abort source-identity-invalid 2204

release='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173'
database='/var/lib/stay/data/continuity.sqlite3'
socket='/run/stay/resident-control.sock'
target_freeze='/var/lib/stay/evidence/runtime-freezes/R123.json'
benchmark_root='/var/lib/stay/evidence/physiology-benchmark/R123F'
evidence_parent='/var/lib/stay/evidence/production-hardening'
script_directory="$(dirname -- "$(readlink -f -- "$0")")"
helper="$script_directory/p1-r123f-authorized-freeze.js"
control="$release/deploy/live-physiology-transplant/p1-resident-control-client.js"
expected_pid='395571'
expected_controller_sha='491cb2217af45589113e3b135c4ed677e04dbc49e3f20f64aeca77095a2e0b6b'
manifest="$release/deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256"
work=''
freeze_created=0
complete=0

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$complete" -eq 0 && "$freeze_created" -eq 1 \
    && "$target_freeze" == /var/lib/stay/evidence/runtime-freezes/R123.json \
    && -f "$target_freeze" && ! -L "$target_freeze" ]]; then
    rm -f -- "$target_freeze"
  fi
  if [[ "$complete" -eq 0 && -n "$work" && "$work" == "$evidence_parent"/.R123F-* \
    && -d "$work" && ! -L "$work" ]]; then
    failed="$evidence_parent/FAILED-R123F-AUTHORIZED-FREEZE-$(date -u +'%Y%m%dT%H%M%SZ').${work##*.}"
    mv -- "$work" "$failed" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

[[ -f "$helper" && ! -L "$helper" && -f "$0" && ! -L "$0" \
  && "sha256:$(sha256sum "$helper" | awk '{print $1}')" == "$STAY_R123F_HELPER_SHA256" \
  && "sha256:$(sha256sum "$0" | awk '{print $1}')" == "$STAY_R123F_SHELL_SHA256" ]] ||
  abort source-hash-invalid 2205
[[ "$(readlink -f /opt/stay/current)" == "$release" \
  && -d "$release" && ! -L "$release" \
  && -f "$database" && ! -L "$database" \
  && -S "$socket" ]] || abort production-fence-invalid 2206
[[ -f "$manifest" && ! -L "$manifest" \
  && "$(sha256sum "$manifest" | awk '{print $1}')" == \
    '021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb' ]] ||
  abort manifest-identity-invalid 2207
[[ "$(sha256sum /usr/local/sbin/stay-p1-production-controller | awk '{print $1}')" == \
  "$expected_controller_sha" ]] || abort controller-identity-invalid 2208
[[ ! -e "$target_freeze" && ! -L "$target_freeze" ]] || abort freeze-already-exists 2209
[[ ! -e "$benchmark_root" && ! -L "$benchmark_root" ]] || abort benchmark-root-exists 2210
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value 2>/dev/null || true)" \
  == inactive ]] || abort benchmark-must-remain-inactive 2211
[[ "$(systemctl show stay.service -p MainPID --value)" == "$expected_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == 0 \
  && "$(systemctl show stay.service -p ActiveState --value)" == active \
  && "$(systemctl show stay.service -p SubState --value)" == running ]] ||
  abort service-generation-changed 2212

work="$(mktemp -d "$evidence_parent/.R123F-AUTHORIZED-FREEZE.XXXXXX")"
printf '%s\n' "$STAY_R123F_AUTHORIZATION" > "$work/authorization.txt"
(cd "$release" && sha256sum --quiet -c "$manifest") || abort installed-release-hash-invalid 2213
printf '%s  %s\n' 'b0da4fa781181f44299ae724dbc364a71a477dcceec860af7faf8d4f909a066b' \
  'STAY_P1_PRODUCTION_HARDENING_R118_TO_R119F_V4_BUNDLE_20260830.tar.gz' > \
  "$work/release-archive.sha256"
cp -- "$manifest" "$work/installed-release-manifest.sha256"

/usr/local/bin/node - "$work/identity.json" <<NODE
'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  releaseTag: 'r119f-v4',
  releaseCommit: '833cf2564ed2be040c681a627de24042f9ac1538',
  releaseTree: '97a1f8dbcf596cb98f0bda9af8faacfd709cb9ef',
  archiveSha256: 'sha256:b0da4fa781181f44299ae724dbc364a71a477dcceec860af7faf8d4f909a066b',
  manifestSha256: 'sha256:021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb',
  r120RecoveryTag: 'r120f-recovery-v2',
  r120RecoveryCommit: '92edf850231743f4c7a149f56cf5288d4cf81f5c',
  r122OperationalTag: 'r122-operational-recovery-v1',
  r122OperationalCommit: '4d87973d15640189dd9346a4a0d2b7b835c21960',
  r123FreezeTag: process.env.STAY_R123F_SOURCE_TAG,
  r123FreezeCommit: process.env.STAY_R123F_SOURCE_COMMIT,
  r123FreezeTree: process.env.STAY_R123F_SOURCE_TREE,
  helperSha256: process.env.STAY_R123F_HELPER_SHA256,
  shellSha256: process.env.STAY_R123F_SHELL_SHA256,
}));
NODE

captured=0
for _ in $(seq 1 40); do
  [[ "$(systemctl show stay.service -p MainPID --value)" == "$expected_pid" \
    && "$(systemctl show stay.service -p NRestarts --value)" == 0 ]] ||
    abort service-generation-changed-during-proof 2214
  STAY_RESIDENT_CONTROL_TIMEOUT_MS=5000 /usr/local/bin/node "$control" \
    status resident:sntss > "$work/sntss.status.json" 2> "$work/sntss.status.stderr" || continue
  STAY_RESIDENT_CONTROL_TIMEOUT_MS=5000 /usr/local/bin/node "$control" \
    status resident:chronobiology > "$work/chronobiology.status.json" \
    2> "$work/chronobiology.status.stderr" || continue
  curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > \
    "$work/meta.unfrozen.json" || continue
  /usr/local/bin/node - "$work/service.json" "$release" "$expected_pid" \
    "$expected_controller_sha" <<'NODE'
'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  release: process.argv[3], mainPid: Number(process.argv[4]), nRestarts: 0,
  activeState: 'active', subState: 'running', benchmarkActiveState: 'inactive',
  benchmarkSubState: 'dead', currentControllerSha256: `sha256:${process.argv[5]}`,
}));
NODE
  if /usr/local/bin/node "$helper" capture "$database" "$release" \
    "$work/sntss.status.json" "$work/chronobiology.status.json" \
    "$work/meta.unfrozen.json" "$work/identity.json" "$work/service.json" \
    "$helper" "$0" > "$work/freeze.json" 2> "$work/freeze.stderr"; then
    captured=1
    break
  fi
  sleep 0.25
done
[[ "$captured" -eq 1 ]] || abort exact-live-proof-not-captured 2215
/usr/local/bin/node "$helper" verify "$work/freeze.json" > "$work/freeze-summary.env" ||
  abort freeze-record-invalid 2216

install -d -o root -g staydeploy -m 0750 "$(dirname "$target_freeze")"
temporary_freeze="$(mktemp "$(dirname "$target_freeze")/.R123.XXXXXX")"
install -o root -g staydeploy -m 0440 "$work/freeze.json" "$temporary_freeze"
if ! ln "$temporary_freeze" "$target_freeze"; then
  rm -f -- "$temporary_freeze"
  abort freeze-install-raced 2217
fi
rm -f -- "$temporary_freeze"
freeze_created=1
/usr/local/bin/node "$helper" verify "$target_freeze" > /dev/null ||
  abort installed-freeze-invalid 2218

for _ in $(seq 1 20); do
  curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > \
    "$work/meta.frozen.json" 2>/dev/null || true
  if /usr/local/bin/node - "$work/meta.frozen.json" <<'NODE'
'use strict';
const fs = require('node:fs');
try {
  const meta = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const chip = id => meta.chipProjection?.lifecycle?.find(value => value.coreId === id);
  process.exit(meta.ok === true && meta.revision === 123 && meta.revisionFrozen === true
    && meta.revisionLabel === 'R123F' && chip('bsf')?.state === 'LIVE'
    && chip('sntss')?.state === 'SHADOW' && chip('chronobiology')?.state === 'SHADOW'
    ? 0 : 1);
} catch { process.exit(1); }
NODE
  then break; fi
  sleep 0.25
done
/usr/local/bin/node - "$work/meta.frozen.json" <<'NODE' || abort public-freeze-not-visible 2219
'use strict';
const fs = require('node:fs'); const meta = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const chip = id => meta.chipProjection.lifecycle.find(value => value.coreId === id);
if (!(meta.ok === true && meta.revision === 123 && meta.revisionFrozen === true
  && meta.revisionLabel === 'R123F' && chip('bsf')?.state === 'LIVE'
  && chip('sntss')?.state === 'SHADOW' && chip('chronobiology')?.state === 'SHADOW')) process.exit(1);
NODE
[[ "$(systemctl show stay.service -p MainPID --value)" == "$expected_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == 0 \
  && "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value 2>/dev/null || true)" \
    == inactive \
  && ! -e "$benchmark_root" && ! -L "$benchmark_root" ]] ||
  abort final-service-or-benchmark-fence-failed 2220

final="$evidence_parent/R123F-AUTHORIZED-FREEZE-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final" && ! -L "$final" ]] || abort final-evidence-exists 2221
mv -- "$work" "$final"
work=''
chmod -R a-w -- "$final"
complete=1
record_sha="$(/usr/local/bin/node -e \
  'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).recordSha256)' \
  "$target_freeze")"
printf 'R123F_AUTHORIZED_FREEZE_RESULT=PASS\nREVISION_LABEL=R123F\nRECORD_SHA256=%s\nFREEZE_FILE=%s\nEVIDENCE_ROOT=%s\nSERVICE_PID=%s\nSERVICE_RESTARTS_DURING_FREEZE=ZERO\nHISTORICAL_ABANDONED_DELIVERIES=1\nABANDONED_SEQUENCE=2466906\nUNRESOLVED_PENDING_DELIVERIES=0\nINVENTED_BIOLOGICAL_TIME=FALSE\nWEB_CHIP_BSF=LIVE\nWEB_CHIP_SNTSS=SHADOW\nWEB_CHIP_CHRONOBIOLOGY=SHADOW\nBENCHMARK_STARTED=NO\nBENCHMARK_SERVICE=INACTIVE\n' \
  "$record_sha" "$target_freeze" "$final" "$expected_pid"
