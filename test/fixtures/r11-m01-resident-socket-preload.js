'use strict';

const residentControl = require('../../runtime/kernel/resident-control-socket');
const installResidentControlSocket = residentControl.installResidentControlSocket;

residentControl.installResidentControlSocket = function installTestResidentControlSocket(options = {}) {
  const socketPath = String(process.env.STAY_TEST_RESIDENT_CONTROL_SOCKET || '');
  if (!socketPath) return Object.freeze({ installed: false, socketPath: null });
  return installResidentControlSocket({ ...options, socketPath });
};
