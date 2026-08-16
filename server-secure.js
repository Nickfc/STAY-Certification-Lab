'use strict';

const { installOperatorStatusGuard } = require('./runtime/operator-status-guard');
const { main } = require('./server');

installOperatorStatusGuard();

main().catch((error) => {
  console.error('[STAY] fatal kernel error', error);
  process.exitCode = 1;
});
