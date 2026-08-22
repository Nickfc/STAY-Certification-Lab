'use strict';

/*
 * Forward-state-compatible Surgery A rollback entrypoint.
 *
 * It deliberately keeps the schema-4 StateStore substrate while disabling
 * every durable-resident attachment/recovery path.  The canonical StateStore
 * remains in place and is never restored from an older snapshot.
 */
process.env.STAY_DISABLE_DURABLE_RESIDENTS = '1';
process.env.STAY_TRUSTED_TIME_PULSE_INTERVAL_MS = '0';
process.env.STAY_AUX_CORES = '';
process.env.STAY_REQUIRE_CORE_PROMOTION_CERT = '1';

const { installOperatorStatusGuard } =
  require('./runtime/operator-status-guard');
const { main } = require('./server');

installOperatorStatusGuard();

main().catch((error) => {
  console.error('[STAY] forward-compatible rollback fatal error', error);
  process.exitCode = 1;
});
