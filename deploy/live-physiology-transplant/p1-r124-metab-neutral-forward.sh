#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173'
SOURCE_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256'
SOURCE_MANIFEST_SHA256='021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb'
SOURCE_MANIFEST_RECORDS=221
SOURCE_FILE_COUNT=612
SOURCE_TREE_SHA256='c97d4850e4747de7a6d80231047140ef99bfabdf69e762b8b52367f1ce30d9a2'
SOURCE_RELEASE_ENV_SHA256='37d1a01ed5040ab05de89ff2b57f935df00f786b4f486af262fdf9b741bd5bde'
TARGET_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R123F_TO_R124.sha256'
TARGET_RELEASE_ENV='P1_R124_RELEASE.env'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
SOCKET='/run/stay/resident-control.sock'
BWRAP='/usr/local/libexec/stay-bwrap-sandbox'
RUNTIME_DROPIN='/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf'
BIRTH_DROPIN='/etc/systemd/system/stay.service.d/p1-r124-metab-neutral-birth-once.conf'
ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-metab-neutral-birth.json'
ACTIVE_PUBLIC_KEY='/etc/stay/metab-neutral-birth-authority.pub'
PARENT_FREEZE='/var/lib/stay/evidence/runtime-freezes/R123.json'
TARGET_FREEZE='/var/lib/stay/evidence/runtime-freezes/R124.json'
BENCHMARK_ROOT='/var/lib/stay/evidence/physiology-benchmark/R123F'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
RECOVERY_MARKER='/run/stay-r124-metab-neutral-recovery.env'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
STAGE_ROOT="$(readlink -f -- "$SCRIPT_DIRECTORY/../..")"
LIVE_PROOF="$SCRIPT_DIRECTORY/p1-r124-metab-neutral-live-proof.js"
CONTROL_CLIENT="$SCRIPT_DIRECTORY/p1-resident-control-client.js"
ADJUDICATION="$STAGE_ROOT/certification/p1-r0/r123f-benchmark-closure/adjudication-v4.json"
OUTBOX_WITNESS="$STAGE_ROOT/certification/p1-r0/r123f-benchmark-closure/outbox-witness-v1.json"

: "${STAY_R124_RELEASE_TAG:?}"
: "${STAY_R124_RELEASE_COMMIT:?}"
: "${STAY_R124_RELEASE_TREE:?}"
: "${STAY_R124_ARCHIVE_SHA256:?}"
: "${STAY_R124_MANIFEST_SHA256:?}"
: "${STAY_R124_CONTROLLER_SHA256:?}"
: "${STAY_R124_TARGET_RELEASE:?}"
: "${STAY_R124_BIRTH_CERTIFICATE_FILE:?}"
: "${STAY_R124_BIRTH_CERTIFICATE_SHA256:?}"
: "${STAY_R124_BIRTH_DOSSIER_FILE:?}"
: "${STAY_R124_BIRTH_DOSSIER_SHA256:?}"
: "${STAY_R124_BIRTH_PUBLIC_KEY_FILE:?}"
: "${STAY_R124_BIRTH_PUBLIC_KEY_SHA256:?}"

WORK=''
CANDIDATE=''
NEW_RELEASE=''
TARGET_CREATED=0
POINTER_CHANGED=0
RESTART_COMMITTED=0
BIRTH_MATERIAL_ACTIVE=0
COMPLETED=0
FAILURE_EVIDENCE=''

phase() { printf '===== %s =====\n' "$1"; }
abort() { printf 'R124_METAB_FORWARD_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }

sha256_file() { sha256sum "$1" | awk '{print $1}'; }

json_field() {
  node -e 'const value=process.argv[2].split(".").reduce((object,key)=>object?.[key],JSON.parse(process.argv[1]));process.stdout.write(String(value??""))' "$1" "$2"
}

durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" node <<'NODE'
'use strict';
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.STAY_DATABASE, { open: true, readOnly: true });
try {
  database.exec('PRAGMA query_only=ON');
  const row = database.prepare("SELECT json, sha256 FROM metadata WHERE key='life:runtime-revision'").get();
  if (!row || crypto.createHash('sha256').update(row.json).digest('hex') !== row.sha256) process.exit(2);
  const revision = Number(JSON.parse(row.json).revision);
  if (!Number.isSafeInteger(revision)) process.exit(3);
  process.stdout.write(String(revision));
} finally { database.close(); }
NODE
}

tree_digest() {
  local root="$1" relative="$2"
  (cd "$root" && find "$relative" -type f -print0 | sort -z | xargs -0 sha256sum |
    sha256sum | awk '{print $1}')
}

release_inventory_digest() {
  (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum |
    sha256sum | awk '{print $1}')
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r124-metab.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

point_current() {
  local release="$1" temporary="/opt/stay/.current-r124-metab.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  ln -s "$release" "$temporary"
  mv -Tf "$temporary" /opt/stay/current
}

manifest_paths() {
  awk '
    !/^[0-9a-f]{64}  \.\/[A-Za-z0-9._\/-]+$/ { exit 2 }
    { sub(/^\.\//, "", $2); print $2 }
  ' "$STAGE_ROOT/$TARGET_MANIFEST"
}

safe_relative_path() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9._/-]+$ \
    && "$value" != /* && "$value" != '.' && "$value" != '..' \
    && "/$value/" != *'/../'* && "/$value/" != *'/./'* \
    && "$value" != *//* ]]
}

capture_quiescent_database() {
  local output="$1" helper="$2" temporary attempt
  temporary="$output.new"
  for attempt in $(seq 1 20); do
    node "$helper" capture "$DATABASE" > "$temporary"
    if node - "$temporary" <<'NODE'
'use strict';
const value = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (!(value.quickCheck === 'ok' && value.queryOnly === true &&
  value.pendingDeliveries === 0 && value.pendingOutboxIntents === 0)) process.exit(1);
NODE
    then
      mv -fT "$temporary" "$output"
      printf '%s\n' "$attempt" > "$output.attempts"
      return 0
    fi
    sleep 0.25
  done
  mv -fT "$temporary" "$output"
  return 1
}

candidate_file_set() {
  {
    (cd "$SOURCE_RELEASE" && find . -type f -printf '%P\n')
    manifest_paths
    printf '%s\n' "$TARGET_MANIFEST" "$TARGET_RELEASE_ENV"
  } | LC_ALL=C sort -u
}

archive_failure_work() {
  if [[ -n "$WORK" && -d "$WORK" ]]; then
    local failed
    failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R124-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
    rmdir -- "$failed"
    if mv -T "$WORK" "$failed"; then
      WORK=''
      FAILURE_EVIDENCE="$failed"
      chmod -R a-w "$failed" || true
      printf 'R124_FAILURE_EVIDENCE=%s\n' "$failed" >&2
    fi
  fi
}

write_recovery_marker() {
  [[ -n "$FAILURE_EVIDENCE" ]] || return 0
  local temporary
  temporary="$(mktemp /run/.stay-r124-metab-recovery.XXXXXX)"
  cat > "$temporary" <<EOF
R124_FAILURE_EVIDENCE=$FAILURE_EVIDENCE
R124_RELEASE=$NEW_RELEASE
R124_RELEASE_TAG=$STAY_R124_RELEASE_TAG
R124_RELEASE_COMMIT=$STAY_R124_RELEASE_COMMIT
R124_RELEASE_TREE=$STAY_R124_RELEASE_TREE
R124_ARCHIVE_SHA256=$STAY_R124_ARCHIVE_SHA256
R124_MANIFEST_SHA256=$STAY_R124_MANIFEST_SHA256
R124_CONTROLLER_SHA256=$STAY_R124_CONTROLLER_SHA256
R124_BIRTH_CERTIFICATE_SHA256=$STAY_R124_BIRTH_CERTIFICATE_SHA256
R124_BIRTH_DOSSIER_SHA256=$STAY_R124_BIRTH_DOSSIER_SHA256
R124_BIRTH_PUBLIC_KEY_SHA256=$STAY_R124_BIRTH_PUBLIC_KEY_SHA256
EOF
  install -o root -g root -m 0600 "$temporary" "$RECOVERY_MARKER"
  rm -f -- "$temporary"
}

remove_active_birth_material() {
  local file
  for file in "$BIRTH_DROPIN" "$ACTIVE_CERTIFICATE" "$ACTIVE_PUBLIC_KEY"; do
    if [[ -e "$file" || -L "$file" ]]; then
      [[ -f "$file" && ! -L "$file" ]] || return 1
      rm -f -- "$file"
    fi
  done
  systemctl daemon-reload
  BIRTH_MATERIAL_ACTIVE=0
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 && "$RESTART_COMMITTED" -eq 0 ]]; then
    [[ "$BIRTH_MATERIAL_ACTIVE" -eq 1 ]] && remove_active_birth_material || true
    [[ "$POINTER_CHANGED" -eq 1 ]] && point_current "$SOURCE_RELEASE" || true
    if [[ "$TARGET_CREATED" -eq 1 && -n "$NEW_RELEASE" \
      && "$NEW_RELEASE" == /opt/stay/releases/0.8.11.3-p1m-r124-metab-neutral-* \
      && -d "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]]; then
      rm -rf --one-file-system -- "$NEW_RELEASE"
    fi
    archive_failure_work
    printf 'R124_FORWARD_ROLLBACK=PRE_RESTART_STATE_RESTORED\n' >&2
  elif [[ "$COMPLETED" -eq 0 ]]; then
    archive_failure_work
    write_recovery_marker
    printf 'R124_FORWARD_POST_RESTART=LEFT_REVISION_FENCED_FOR_FORWARD_RECOVERY\n' >&2
  fi
  if [[ -n "$CANDIDATE" && "$CANDIDATE" == /opt/stay/releases/.p1m-r124-metab-neutral.* \
    && -d "$CANDIDATE" ]]; then
    rm -rf --one-file-system -- "$CANDIDATE"
  fi
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf --one-file-system -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 2401
[[ "${STAY_R124_AUTHORIZATION:-}" == 'AUTHORIZE_R124_METAB_NEUTRAL_ZERO_AUTHORITY_BIRTH' ]] ||
  abort authorization-required 2402
[[ "$STAY_R124_RELEASE_TAG" =~ ^r124-metab-neutral-v[0-9]+$ \
  && "$STAY_R124_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R124_RELEASE_TREE" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R124_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_TARGET_RELEASE" =~ ^/opt/stay/releases/0\.8\.11\.3-p1m-r124-metab-neutral-[0-9a-f]{12}$ \
  && "$STAY_R124_BIRTH_CERTIFICATE_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_BIRTH_DOSSIER_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_BIRTH_PUBLIC_KEY_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  abort immutable-identity-invalid 2403

for file in "$DATABASE" "$RUNTIME_DROPIN" "$BWRAP" "$PARENT_FREEZE" \
  "$STAGE_ROOT/$TARGET_MANIFEST" "$LIVE_PROOF" "$CONTROL_CLIENT" \
  "$ADJUDICATION" "$OUTBOX_WITNESS" "$STAY_R124_BIRTH_CERTIFICATE_FILE" \
  "$STAY_R124_BIRTH_DOSSIER_FILE" "$STAY_R124_BIRTH_PUBLIC_KEY_FILE"; do
  [[ -f "$file" && ! -L "$file" ]] || abort immutable-input-invalid 2404
done
[[ "$(sha256_file "$STAGE_ROOT/$TARGET_MANIFEST")" == "${STAY_R124_MANIFEST_SHA256#sha256:}" \
  && "$(sha256_file "$STAY_R124_BIRTH_CERTIFICATE_FILE")" == "${STAY_R124_BIRTH_CERTIFICATE_SHA256#sha256:}" \
  && "$(sha256_file "$STAY_R124_BIRTH_DOSSIER_FILE")" == "${STAY_R124_BIRTH_DOSSIER_SHA256#sha256:}" \
  && "$(sha256_file "$STAY_R124_BIRTH_PUBLIC_KEY_FILE")" == "${STAY_R124_BIRTH_PUBLIC_KEY_SHA256#sha256:}" ]] ||
  abort immutable-input-hash-invalid 2405
[[ ! -e "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" \
  && ! -e "$BIRTH_DROPIN" && ! -L "$BIRTH_DROPIN" \
  && ! -e "$ACTIVE_CERTIFICATE" && ! -L "$ACTIVE_CERTIFICATE" \
  && ! -e "$ACTIVE_PUBLIC_KEY" && ! -L "$ACTIVE_PUBLIC_KEY" \
  && ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" ]] ||
  abort prior-attempt-or-target-evidence-present 2406

observed_ip="$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 2407
[[ -d "$SOURCE_RELEASE" && ! -L "$SOURCE_RELEASE" \
  && "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" \
  && -f "$SOURCE_RELEASE/$SOURCE_MANIFEST" \
  && ! -L "$SOURCE_RELEASE/$SOURCE_MANIFEST" \
  && "$(sha256_file "$SOURCE_RELEASE/$SOURCE_MANIFEST")" == "$SOURCE_MANIFEST_SHA256" \
  && "$(wc -l < "$SOURCE_RELEASE/$SOURCE_MANIFEST")" -eq "$SOURCE_MANIFEST_RECORDS" \
  && "$(sha256_file "$SOURCE_RELEASE/P1_R119F_RELEASE.env")" == "$SOURCE_RELEASE_ENV_SHA256" \
  && "$(find "$SOURCE_RELEASE" -type f | wc -l)" -eq "$SOURCE_FILE_COUNT" \
  && "$(release_inventory_digest "$SOURCE_RELEASE")" == "$SOURCE_TREE_SHA256" \
  && -z "$(find -P "$SOURCE_RELEASE" -xdev \
    \( -type l -o -type f -links +1 -o ! -type d ! -type f \) -print -quit)" ]] ||
  abort source-release-invalid 2408
[[ -S "$SOCKET" && ! -L "$SOCKET" ]] || abort resident-socket-invalid 2409
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value 2>/dev/null || true)" == inactive ]] ||
  abort benchmark-still-active 2410
[[ -f "$BENCHMARK_ROOT/samples.jsonl" && ! -L "$BENCHMARK_ROOT/samples.jsonl" \
  && -f "$BENCHMARK_ROOT/state.json" && ! -L "$BENCHMARK_ROOT/state.json" \
  && -f "$BENCHMARK_ROOT/collector-attempts.json" && ! -L "$BENCHMARK_ROOT/collector-attempts.json" \
  && -f "$BENCHMARK_ROOT/72h.json" && ! -L "$BENCHMARK_ROOT/72h.json" ]] ||
  abort benchmark-evidence-invalid 2411

before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
before_active="$(systemctl show stay.service -p ActiveState --value)"
before_sub="$(systemctl show stay.service -p SubState --value)"
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$before_restarts" =~ ^[0-9]+$ \
  && "$before_active" == active && "$before_sub" == running \
  && "$(durable_runtime_revision)" == 123 ]] || abort source-service-invalid 2412

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R124-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"

phase 'EXACT READ-ONLY R123F PREFLIGHT'
node - "$before_pid" "$before_restarts" > "$WORK/service.before.json" <<'NODE'
'use strict';
const [mainPid, nRestarts] = process.argv.slice(2).map(Number);
process.stdout.write(`${JSON.stringify({ mainPid, nRestarts, activeState: 'active',
  subState: 'running', benchmarkActiveState: 'inactive' })}\n`);
NODE
install -o root -g root -m 0400 "$PARENT_FREEZE" "$WORK/R123.freeze.json"
capture_quiescent_database "$WORK/database.before.json" "$LIVE_PROOF" ||
  abort database-before-not-quiescent 2413
node "$CONTROL_CLIENT" status resident:sntss > "$WORK/sntss.before.json"
node "$CONTROL_CLIENT" status resident:chronobiology > "$WORK/chronobiology.before.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.before.json"
node - "$LIVE_PROOF" "$BENCHMARK_ROOT" "$ADJUDICATION" "$OUTBOX_WITNESS" \
  > "$WORK/benchmark.proof.json" <<'NODE'
'use strict';
const path = require('node:path');
const [helper, benchmarkRoot, adjudicationFile, witnessFile] = process.argv.slice(2);
const proof = require(helper).validateBenchmark({
  samplesFile: path.join(benchmarkRoot, 'samples.jsonl'),
  stateFile: path.join(benchmarkRoot, 'state.json'),
  attemptsFile: path.join(benchmarkRoot, 'collector-attempts.json'),
  milestoneFile: path.join(benchmarkRoot, '72h.json'),
  adjudicationFile,
  witnessFile
});
process.stdout.write(`${JSON.stringify(proof)}\n`);
NODE
node - "$LIVE_PROOF" "$WORK" > "$WORK/before.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [helper, root] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const proof = require(helper).validateBefore({
  database: read('database.before.json'), freeze: read('R123.freeze.json'),
  sntssStatus: read('sntss.before.json'),
  chronobiologyStatus: read('chronobiology.before.json'),
  meta: read('meta.before.json'), service: read('service.before.json')
});
process.stdout.write(`${JSON.stringify(proof)}\n`);
NODE
[[ "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$before_restarts" \
  && "$(durable_runtime_revision)" == 123 \
  && "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" ]] ||
  abort read-only-preflight-mutated-production 2413

phase 'BUILD SOURCE-SEALED R124 CANDIDATE'
mapfile -t overlay_files < <(manifest_paths)
[[ "${#overlay_files[@]}" -gt 0 \
  && "$(printf '%s\n' "${overlay_files[@]}" | LC_ALL=C sort -u | wc -l)" -eq "${#overlay_files[@]}" \
  && "$(printf '%s\n' "${overlay_files[@]}" | LC_ALL=C sort)" == "$(printf '%s\n' "${overlay_files[@]}")" ]] ||
  abort manifest-path-set-invalid 2414
for file in "${overlay_files[@]}"; do
  safe_relative_path "$file" || abort manifest-path-unsafe 2414
  [[ "$file" != "$TARGET_MANIFEST" && "$file" != "$TARGET_RELEASE_ENV" \
    && -f "$STAGE_ROOT/$file" && ! -L "$STAGE_ROOT/$file" ]] ||
    abort manifest-input-invalid 2414
done
(cd "$STAGE_ROOT" && sha256sum -c "$TARGET_MANIFEST" >/dev/null) ||
  abort stage-manifest-verification-failed 2414

CANDIDATE="$(mktemp -d /opt/stay/releases/.p1m-r124-metab-neutral.XXXXXX)"
cp -a --reflink=auto "$SOURCE_RELEASE/." "$CANDIDATE/"
chmod --reference="$SOURCE_RELEASE" "$CANDIDATE"
chown --reference="$SOURCE_RELEASE" "$CANDIDATE"
source_sntss_digest="$(tree_digest "$SOURCE_RELEASE" cores/sntss/i4g)"
source_chrono_c3_digest="$(tree_digest "$SOURCE_RELEASE" cores/chronobiology/c3)"
source_chrono_c3r4_digest="$(tree_digest "$SOURCE_RELEASE" cores/chronobiology/c3r4)"
source_chrono_c3r5_digest="$(tree_digest "$SOURCE_RELEASE" cores/chronobiology/c3r5)"
for file in "${overlay_files[@]}"; do
  install -D -o root -g root -m 0644 "$STAGE_ROOT/$file" "$CANDIDATE/$file"
done
install -D -o root -g root -m 0644 "$STAGE_ROOT/$TARGET_MANIFEST" \
  "$CANDIDATE/$TARGET_MANIFEST"
(cd "$CANDIDATE" && sha256sum -c "$TARGET_MANIFEST" >/dev/null) ||
  abort candidate-manifest-verification-failed 2415

[[ "$(tree_digest "$CANDIDATE" cores/sntss/i4g)" == "$source_sntss_digest" \
  && "$(tree_digest "$CANDIDATE" cores/chronobiology/c3)" == "$source_chrono_c3_digest" \
  && "$(tree_digest "$CANDIDATE" cores/chronobiology/c3r4)" == "$source_chrono_c3r4_digest" \
  && "$(tree_digest "$CANDIDATE" cores/chronobiology/c3r5)" == "$source_chrono_c3r5_digest" ]] ||
  abort protected-biological-tree-changed 2416
for relative in cores/sntss/i4g cores/chronobiology/c3 cores/chronobiology/c3r4 \
  cores/chronobiology/c3r5; do
  diff -qr "$SOURCE_RELEASE/$relative" "$CANDIDATE/$relative" > "$WORK/$(basename "$relative").diff" ||
    abort protected-biological-tree-diff 2416
done

for file in "${overlay_files[@]}"; do
  [[ "$file" == *.js ]] && node --check "$CANDIDATE/$file" >/dev/null
  [[ "$file" == *.sh ]] && bash -n "$CANDIDATE/$file"
done

node - "$CANDIDATE" <<'NODE'
'use strict';
const path = require('node:path');
const root = process.argv[2];
const policy = require(path.join(root, 'runtime/kernel/package-policy.js'));
for (const relative of [
  'cores/sntss/i4g/index.js', 'cores/chronobiology/c3/index.js',
  'cores/chronobiology/c3r4/index.js', 'cores/chronobiology/c3r5/index.js',
  'cores/p1-r0/metab-neutral/index.js'
]) {
  const modulePath = path.join(root, relative);
  const manifest = require(modulePath).manifest;
  const record = policy.enforcePackagePolicy(modulePath);
  policy.verifyManifestAgainstPackagePolicy(record, manifest);
}
NODE

phase 'FOCUSED REGRESSION AND REAL ENTRY PATHS'
if ! node --test --test-concurrency=1 \
  "$CANDIDATE/test/p1-r124-metab-neutral-birth.test.js" \
  "$CANDIDATE/test/p1-r124-metab-founder-dossier.test.js" \
  "$CANDIDATE/test/p1-r124-metab-neutral-production-proof.test.js" \
  "$CANDIDATE/test/p1-resident-control-socket.test.js" \
  "$CANDIDATE/test/server.test.js" > "$WORK/focused-tests.tap" 2>&1; then
  cat "$WORK/focused-tests.tap" >&2
  abort candidate-focused-tests-failed 2417
fi
cat "$WORK/focused-tests.tap"

if ! systemd-run --wait --pipe --collect --quiet \
  --property=User=staydeploy --property=Delegate=yes \
  --property=CPUAccounting=yes --property=MemoryAccounting=yes \
  /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production STAY_REQUIRE_OS_CORE_SANDBOX=1 STAY_BWRAP="$BWRAP" \
    STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CGROUPS=1 \
    /usr/local/bin/node --disable-sigusr1 --test --test-concurrency=1 \
    --test-name-pattern='^R124-METAB-ENTRY-01' \
    "$CANDIDATE/test/p1-r124-metab-neutral-birth.test.js" \
    > "$WORK/real-metab-entry.tap" 2>&1; then
  cat "$WORK/real-metab-entry.tap" >&2
  abort real-metab-entry-failed 2418
fi
cat "$WORK/real-metab-entry.tap"

if ! systemd-run --wait --pipe --collect --quiet \
  --property=User=staydeploy --property=Delegate=yes \
  --property=CPUAccounting=yes --property=MemoryAccounting=yes \
  /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production STAY_REQUIRE_OS_CORE_SANDBOX=1 STAY_BWRAP="$BWRAP" \
    STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CGROUPS=1 \
    /usr/local/bin/node "$CANDIDATE/deploy/live-physiology-transplant/p1-r119f-entry-preflight.js" \
    > "$WORK/chronobiology-entry.proof.json"; then
  abort real-chronobiology-entry-failed 2419
fi
[[ "$(json_field "$(<"$WORK/chronobiology-entry.proof.json")" result)" == PASS \
  && "$(json_field "$(<"$WORK/chronobiology-entry.proof.json")" version)" == '1.0.0-c3rc.5' \
  && "$(json_field "$(<"$WORK/chronobiology-entry.proof.json")" hardCpuPercent)" == 20 \
  && "$(json_field "$(<"$WORK/chronobiology-entry.proof.json")" payloadSandboxed)" == true \
  && "$(json_field "$(<"$WORK/chronobiology-entry.proof.json")" payloadAttachedBeforeInit)" == true ]] ||
  abort real-chronobiology-entry-invalid 2419

[[ "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$before_restarts" \
  && "$(durable_runtime_revision)" == 123 \
  && "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" ]] ||
  abort candidate-tests-mutated-production 2420

manifest_digest="$(sha256_file "$STAGE_ROOT/$TARGET_MANIFEST")"
NEW_RELEASE="/opt/stay/releases/0.8.11.3-p1m-r124-metab-neutral-${manifest_digest:0:12}"
[[ "$NEW_RELEASE" == "$STAY_R124_TARGET_RELEASE" \
  && ! -e "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]] ||
  abort target-release-identity-invalid 2421

cat > "$CANDIDATE/$TARGET_RELEASE_ENV" <<EOF
P1_R124_RELEASE=PASS
SOURCE_RELEASE=$SOURCE_RELEASE
SOURCE_RUNTIME_REVISION=R123F
TARGET_RUNTIME_REVISION=R124F
RELEASE_TAG=$STAY_R124_RELEASE_TAG
RELEASE_COMMIT=$STAY_R124_RELEASE_COMMIT
RELEASE_TREE=$STAY_R124_RELEASE_TREE
ARCHIVE_SHA256=$STAY_R124_ARCHIVE_SHA256
MANIFEST_SHA256=$STAY_R124_MANIFEST_SHA256
SOURCE_RELEASE_TREE_SHA256=sha256:$SOURCE_TREE_SHA256
PARENT_FREEZE_RECORD_SHA256=sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc
BENCHMARK_SAMPLES=4312
BIRTH_CERTIFICATE_SHA256=$STAY_R124_BIRTH_CERTIFICATE_SHA256
BIRTH_DOSSIER_SHA256=$STAY_R124_BIRTH_DOSSIER_SHA256
BIRTH_PUBLIC_KEY_SHA256=$STAY_R124_BIRTH_PUBLIC_KEY_SHA256
METAB_VERSION=0.1.0-p1r0-neutral.1
METAB_MODE=NEUTRAL
METAB_AUTHORITY=NONE
METAB_OUTPUTS=0
EOF
chown root:root "$CANDIDATE/$TARGET_RELEASE_ENV"
chmod 0444 "$CANDIDATE/$TARGET_RELEASE_ENV"

cmp <(candidate_file_set) \
  <(cd "$CANDIDATE" && find . -type f -printf '%P\n' | LC_ALL=C sort) >/dev/null ||
  abort candidate-file-set-invalid 2422
[[ -z "$(find -P "$CANDIDATE" -xdev \
  \( -type l -o -type f -links +1 -o ! -type d ! -type f \) -print -quit)" ]] ||
  abort candidate-unsafe-tree 2422

mv -T "$CANDIDATE" "$NEW_RELEASE"
CANDIDATE=''
TARGET_CREATED=1
chmod -R a-w "$NEW_RELEASE"

phase 'STAGE ONE-SHOT BIRTH AUTHORITY AND COMMIT ONE RESTART'
install_atomic "$STAY_R124_BIRTH_PUBLIC_KEY_FILE" "$ACTIVE_PUBLIC_KEY" 0444
install_atomic "$STAY_R124_BIRTH_CERTIFICATE_FILE" "$ACTIVE_CERTIFICATE" 0444
cat > "$WORK/p1-r124-metab-neutral-birth-once.conf" <<EOF
[Service]
Environment=STAY_ALLOW_METAB_NEUTRAL_BIRTH=1
Environment=STAY_METAB_NEUTRAL_BIRTH_CERTIFICATE=$ACTIVE_CERTIFICATE
Environment=STAY_METAB_NEUTRAL_BIRTH_PUBLIC_KEY=$ACTIVE_PUBLIC_KEY
EOF
install_atomic "$WORK/p1-r124-metab-neutral-birth-once.conf" "$BIRTH_DROPIN" 0644
BIRTH_MATERIAL_ACTIVE=1
systemctl daemon-reload
point_current "$NEW_RELEASE"
POINTER_CHANGED=1
[[ "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" \
  && "$(durable_runtime_revision)" == 123 \
  && "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$before_restarts" ]] ||
  abort pre-restart-fence-failed 2423

RESTART_COMMITTED=1
systemctl restart stay.service
after_pid="$(systemctl show stay.service -p MainPID --value)"
after_restarts="$(systemctl show stay.service -p NRestarts --value)"
after_active="$(systemctl show stay.service -p ActiveState --value)"
after_sub="$(systemctl show stay.service -p SubState --value)"
[[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" \
  && "$after_restarts" == "$before_restarts" \
  && "$after_active" == active && "$after_sub" == running \
  && "$(durable_runtime_revision)" == 124 \
  && "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" ]] ||
  abort r124-restart-fence-failed 2424

phase 'ATOMIC METAB NEUTRAL BIRTH'
node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-resident-control-client.js" \
  birth resident:metab > "$WORK/metab.birth.json" || abort metab-birth-failed 2425

capture_quiescent_database "$WORK/database.after.json" \
  "$NEW_RELEASE/deploy/live-physiology-transplant/p1-r124-metab-neutral-live-proof.js" ||
  abort database-after-not-quiescent 2425
node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-resident-control-client.js" \
  status resident:sntss > "$WORK/sntss.after.json"
node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-resident-control-client.js" \
  status resident:chronobiology > "$WORK/chronobiology.after.json"
node "$NEW_RELEASE/deploy/live-physiology-transplant/p1-resident-control-client.js" \
  status resident:metab > "$WORK/metab.after.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
node - "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" \
  > "$WORK/service.after.json" <<'NODE'
'use strict';
const [beforePid, afterPid, beforeRestarts, afterRestarts] = process.argv.slice(2).map(Number);
process.stdout.write(`${JSON.stringify({ beforePid, afterPid, beforeRestarts, afterRestarts,
  restartCommands: 1 })}\n`);
NODE
node - "$NEW_RELEASE/deploy/live-physiology-transplant/p1-r124-metab-neutral-live-proof.js" \
  "$WORK" > "$WORK/after.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [helper, root] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const proof = require(helper).validateAfter({
  before: read('before.proof.json'), database: read('database.after.json'),
  sntssStatus: read('sntss.after.json'),
  chronobiologyStatus: read('chronobiology.after.json'),
  metabStatus: read('metab.after.json'), meta: read('meta.after.json'),
  service: read('service.after.json')
});
process.stdout.write(`${JSON.stringify(proof)}\n`);
NODE

install -o root -g root -m 0400 "$STAY_R124_BIRTH_CERTIFICATE_FILE" \
  "$WORK/metab-neutral-birth-certificate.json"
install -o root -g root -m 0400 "$STAY_R124_BIRTH_DOSSIER_FILE" \
  "$WORK/metab-neutral-founder-dossier.json"
install -o root -g root -m 0444 "$STAY_R124_BIRTH_PUBLIC_KEY_FILE" \
  "$WORK/metab-neutral-birth-authority.pub"
install -o root -g root -m 0444 "$NEW_RELEASE/$TARGET_RELEASE_ENV" \
  "$WORK/P1_R124_RELEASE.env"

phase 'REVOKE ONE-SHOT AUTHORITY AND FREEZE R124'
remove_active_birth_material || abort birth-authority-revocation-failed 2426
[[ ! -e "$BIRTH_DROPIN" && ! -L "$BIRTH_DROPIN" \
  && ! -e "$ACTIVE_CERTIFICATE" && ! -L "$ACTIVE_CERTIFICATE" \
  && ! -e "$ACTIVE_PUBLIC_KEY" && ! -L "$ACTIVE_PUBLIC_KEY" ]] ||
  abort birth-authority-revocation-incomplete 2426

node - "$NEW_RELEASE" "$WORK" > "$WORK/R124.freeze.json" <<'NODE'
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [releaseRoot, evidenceRoot] = process.argv.slice(2);
const { sealRevisionFreeze, validateRevisionFreeze } = require(
  path.join(releaseRoot, 'runtime/revision-freeze.js')
);
const read = name => JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), 'utf8'));
const hash = name => `sha256:${crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(evidenceRoot, name))).digest('hex')}`;
const before = read('before.proof.json');
const after = read('after.proof.json');
const service = read('service.after.json');
const release = Object.fromEntries(fs.readFileSync(path.join(evidenceRoot,
  'P1_R124_RELEASE.env'), 'utf8').trim().split('\n').map(line => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
}));
if (!(before.result === 'PASS' && after.result === 'PASS' && after.runtimeRevision === 124 &&
  after.authorityOwned === false && after.observedOutputs === 0 && after.chipState === 'NEUTRAL')) {
  process.exit(2);
}
const record = sealRevisionFreeze({
  format: 'stay-runtime-revision-freeze-v1', result: 'PASS', acceptance: 'ACCEPTED',
  freezeType: 'R124_METAB_NEUTRAL_ZERO_AUTHORITY_BIRTH',
  runtime: { revision: 124, revisionLabel: 'R124F', progression: [123, 124],
    serviceMainPid: service.afterPid, serviceNRestarts: service.afterRestarts,
    restartCommands: service.restartCommands },
  parentFreeze: { revision: 123,
    recordSha256: 'sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc' },
  benchmark: { result: 'PASS', samples: 4312,
    adjudicationSha256: 'sha256:a78cd8281d246d851e3476f8da50964bc7e9556a8760439099dd727ecadfc6e4',
    witnessSha256: 'sha256:80c383e7b9b15c3da64b29e14d2ca4800d8ad64f19b63dd44ec401afa8564cfc' },
  release: { path: releaseRoot, tag: release.RELEASE_TAG, commit: release.RELEASE_COMMIT,
    tree: release.RELEASE_TREE, archiveSha256: release.ARCHIVE_SHA256,
    manifestSha256: release.MANIFEST_SHA256 },
  metab: { residencyId: 'resident:metab', version: '0.1.0-p1r0-neutral.1',
    mode: 'NEUTRAL', founderId: after.founderId, instanceId: after.instanceId,
    checkpointGeneration: after.checkpointGeneration, authorityOwned: false,
    observedOutputs: 0, signalling: 'FORBIDDEN', productionEligible: false },
  continuity: { sntssCheckpointGenerationBefore: before.sntssCheckpointGeneration,
    chronobiologyCheckpointGenerationBefore: before.chronobiologyCheckpointGeneration,
    pendingDeliveries: 0, pendingOutboxIntents: 0, inventedBiologicalTime: false },
  birthAuthority: { active: false, certificateSha256: release.BIRTH_CERTIFICATE_SHA256,
    dossierSha256: release.BIRTH_DOSSIER_SHA256,
    publicKeySha256: release.BIRTH_PUBLIC_KEY_SHA256 },
  evidence: Object.fromEntries([
    'benchmark.proof.json', 'before.proof.json', 'after.proof.json',
    'database.before.json', 'database.after.json', 'sntss.after.json',
    'chronobiology.after.json', 'metab.after.json', 'meta.after.json',
    'service.after.json', 'metab-neutral-birth-certificate.json',
    'metab-neutral-founder-dossier.json', 'metab-neutral-birth-authority.pub'
  ].map(name => [name, hash(name)])),
  capturedAt: new Date().toISOString()
});
if (!validateRevisionFreeze(record, 124)) process.exit(3);
process.stdout.write(`${JSON.stringify(record)}\n`);
NODE
install_atomic "$WORK/R124.freeze.json" "$TARGET_FREEZE" 0444
node - "$NEW_RELEASE/runtime/revision-freeze.js" "$TARGET_FREEZE" <<'NODE'
'use strict';
const fs = require('node:fs');
const [helper, file] = process.argv.slice(2);
if (!require(helper).validateRevisionFreeze(JSON.parse(fs.readFileSync(file, 'utf8')), 124)) {
  process.exit(1);
}
NODE

curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
node - "$WORK/meta.frozen.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const meta = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const chip = id => meta.chipProjection?.lifecycle?.find(value => value.coreId === id);
if (!(meta.ok === true && meta.revision === 124 && meta.revisionFrozen === true &&
  meta.revisionLabel === 'R124F' && chip('bsf')?.state === 'LIVE' &&
  chip('sntss')?.state === 'SHADOW' && chip('chronobiology')?.state === 'SHADOW' &&
  chip('metab')?.state === 'NEUTRAL' && chip('metab')?.born === true)) process.exit(1);
NODE

[[ "$(systemctl show stay.service -p MainPID --value)" == "$after_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$after_restarts" \
  && "$(durable_runtime_revision)" == 124 \
  && "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" ]] ||
  abort final-live-fence-failed 2427

final_evidence="$EVIDENCE_ROOT/R124F-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]] || abort evidence-target-present 2428
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
COMPLETED=1

printf '%s\n' \
  'R124_METAB_NEUTRAL_FORWARD=PASS' \
  'RUNTIME_REVISION_AFTER=124' \
  'REVISION_LABEL=R124F' \
  "CURRENT_RELEASE=$NEW_RELEASE" \
  "SERVICE_PID=$after_pid" \
  "SERVICE_NRESTARTS=$after_restarts" \
  'RESTART_COMMANDS=1' \
  'BSF_MODE=LIVE' \
  'BSF_STATUS=RUNNING' \
  'SNTSS_MODE=SHADOW' \
  'SNTSS_STATUS=RUNNING' \
  'SNTSS_AUTHORITY=NONE' \
  'SNTSS_OUTPUTS=0' \
  'CHRONOBIOLOGY_MODE=SHADOW' \
  'CHRONOBIOLOGY_STATUS=RUNNING' \
  'CHRONOBIOLOGY_AUTHORITY=NONE' \
  'METAB_MODE=NEUTRAL' \
  'METAB_STATUS=RUNNING' \
  'METAB_AUTHORITY=NONE' \
  'METAB_OUTPUTS=0' \
  'METAB_SIGNALLING=FORBIDDEN' \
  'FETUS_CONTINUITY=PASS' \
  'WEB_CHIP_BSF=LIVE' \
  'WEB_CHIP_SNTSS=SHADOW' \
  'WEB_CHIP_CHRONOBIOLOGY=SHADOW' \
  'WEB_CHIP_METAB=NEUTRAL' \
  'BIRTH_AUTHORITY_ACTIVE=NO' \
  'BENCHMARK_R123F=PASS' \
  "FREEZE_FILE=$TARGET_FREEZE" \
  "EVIDENCE_ROOT=$final_evidence" \
  "R124_EVIDENCE_SHA256=sha256:$(find "$final_evidence" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
