'use strict';

const { installOperatorStatusGuard } = require('./runtime/operator-status-guard');
const { installResidentControlSocket } = require('./runtime/kernel/resident-control-socket');
const { main } = require('./server');

installOperatorStatusGuard();
installResidentControlSocket();

main().catch((error) => {
  console.error('[STAY] fatal kernel error', error);
  process.exitCode = 1;
});
