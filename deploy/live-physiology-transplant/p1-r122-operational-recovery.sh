#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

[[ "$EUID" -eq 0 ]] || { echo 'R122_OPERATIONAL_RECOVERY_ABORT=root-required' >&2; exit 2101; }
[[ "${STAY_R122_AUTHORIZATION:-}" == 'RESTART_ONCE_TO_CLEAR_R121_IN_MEMORY_FAILURE_WITHOUT_FREEZE' ]] ||
  { echo 'R122_OPERATIONAL_RECOVERY_ABORT=authorization-required' >&2; exit 2102; }
release='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173'
database='/var/lib/stay/data/continuity.sqlite3'
before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$before_pid" == 386158 && "$before_restarts" == 0 \
  && "$(readlink -f /opt/stay/current)" == "$release" ]] ||
  { echo 'R122_OPERATIONAL_RECOVERY_ABORT=service-fence-changed' >&2; exit 2103; }

STAY_DATABASE="$database" /usr/local/bin/node - <<'NODE'
'use strict';
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.STAY_DATABASE, { readOnly: true });
database.exec('PRAGMA query_only=ON');
const value = (sql, ...args) => Number(database.prepare(sql).get(...args)?.value || 0);
const row = database.prepare("SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
if (!row || crypto.createHash('sha256').update(row.json).digest('hex') !== row.sha256) process.exit(2);
const revision = JSON.parse(row.json);
const chrono = database.prepare("SELECT * FROM resident_instances WHERE residency_id='resident:chronobiology'").get();
const sntss = database.prepare("SELECT * FROM resident_instances WHERE residency_id='resident:sntss'").get();
const recovery = JSON.parse(database.prepare('SELECT detail_json FROM recovery_records WHERE id=106').get()?.detail_json || 'null');
if (!(database.prepare('PRAGMA quick_check').get()?.quick_check === 'ok'
  && revision.revision === 121 && revision.reason === 'resident.resynchronize'
  && chrono?.status === 'RUNNING' && chrono.version === '1.0.0-c3rc.5'
  && sntss?.status === 'RUNNING' && sntss.version === '0.5.0-i4g1'
  && value("SELECT COUNT(*) value FROM biological_deliveries WHERE status='PENDING'") === 0
  && value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE status='PENDING'") === 0
  && value("SELECT COUNT(*) value FROM authority WHERE core_id IN ('chronobiology','sntss')") === 0
  && value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='sntss'") === 0
  && recovery.abandonedCount === 1 && recovery.inventedBiologicalTime === false)) process.exit(3);
database.close();
NODE

meta="$(curl --fail --silent --max-time 4 http://127.0.0.1:8787/__stay/meta)"
/usr/local/bin/node -e '
const meta=JSON.parse(process.argv[1]);
const chip=id=>meta.chipProjection.lifecycle.find(value=>value.coreId===id);
if (!(meta.revision===121 && chip("bsf")?.state==="DEGRADED"
  && chip("sntss")?.state==="SHADOW" && chip("chronobiology")?.state==="SHADOW")) process.exit(1);
' "$meta"

systemctl restart stay.service
after_health=''
after_meta=''
for _ in $(seq 1 120); do
  after_health="$(curl --silent --max-time 3 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
  after_meta="$(curl --silent --max-time 3 http://127.0.0.1:8787/__stay/meta 2>/dev/null || true)"
  if /usr/local/bin/node -e '
    try {
      const health=JSON.parse(process.argv[1]); const meta=JSON.parse(process.argv[2]);
      const chip=id=>meta.chipProjection.lifecycle.find(value=>value.coreId===id);
      process.exit(health.ok===true && health.revision===122 && meta.ok===true
        && chip("bsf")?.state==="LIVE" && chip("sntss")?.state==="SHADOW"
        && chip("chronobiology")?.state==="SHADOW" ? 0 : 1);
    } catch { process.exit(1); }
  ' "$after_health" "$after_meta"; then break; fi
  sleep 1
done

after_pid="$(systemctl show stay.service -p MainPID --value)"
after_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" \
  && "$after_restarts" == "$before_restarts" && "$(readlink -f /opt/stay/current)" == "$release" ]] ||
  { echo 'R122_OPERATIONAL_RECOVERY_ABORT=post-restart-service-fence-failed' >&2; exit 2104; }
/usr/local/bin/node -e '
const health=JSON.parse(process.argv[1]); const meta=JSON.parse(process.argv[2]);
const chip=id=>meta.chipProjection.lifecycle.find(value=>value.coreId===id);
if (!(health.ok===true && health.revision===122 && meta.ok===true && meta.revision===122
  && chip("bsf")?.state==="LIVE" && chip("sntss")?.state==="SHADOW"
  && chip("chronobiology")?.state==="SHADOW")) process.exit(1);
' "$after_health" "$after_meta"

printf 'R122_OPERATIONAL_RECOVERY=PASS\nRUNTIME_REVISION=122\nSERVICE_PID_BEFORE=%s\nSERVICE_PID_AFTER=%s\nSERVICE_RESTARTS_THIS_RECOVERY=ONE\nCURRENT_RELEASE=%s\nWEB_CHIP_BSF=LIVE\nWEB_CHIP_SNTSS=SHADOW\nWEB_CHIP_CHRONOBIOLOGY=SHADOW\nHISTORICAL_ABANDONED_DELIVERIES=1\nFREEZE_CREATED=NO\nBENCHMARK_STARTED=NO\n' \
  "$before_pid" "$after_pid" "$release"
