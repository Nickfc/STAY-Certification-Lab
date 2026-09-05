'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');

const FORMAT = 'stay-resident-control-v1';
const DEFAULT_SOCKET_PATH = '/run/stay/resident-control.sock';
const MAX_REQUEST_BYTES = 4096;
const PATCH_MARKER = Symbol.for('stay.resident-control-socket.v1');

const RESIDENT_MODULES = Object.freeze({
  'resident:sntss': 'cores/sntss/i3d/index.js',
  'resident:chronobiology': 'cores/chronobiology/c3/index.js',
  'resident:metab': 'cores/p1-r0/metab-neutral/index.js'
});

const OPERATIONS = new Set([
  'status', 'attach', 'birth', 'detach', 'promote', 'resynchronize'
]);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('resident-control request must be an object', 'RESIDENT_CONTROL_REQUEST');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'format' || keys[1] !== 'operation' || keys[2] !== 'residencyId') {
    fail('resident-control request shape is not fixed', 'RESIDENT_CONTROL_REQUEST');
  }
  if (value.format !== FORMAT || !OPERATIONS.has(value.operation)) {
    fail('resident-control operation is invalid', 'RESIDENT_CONTROL_OPERATION');
  }
  const homeosStatusOnly = value.operation === 'status' &&
    value.residencyId === 'resident:homeos';
  if (!Object.prototype.hasOwnProperty.call(RESIDENT_MODULES, value.residencyId) &&
      !homeosStatusOnly) {
    fail('resident-control residency is not allowlisted', 'RESIDENT_CONTROL_RESIDENCY');
  }
  if (value.operation === 'birth' && value.residencyId !== 'resident:metab') {
    fail('resident-control birth residency is not allowlisted', 'RESIDENT_CONTROL_RESIDENCY');
  }
  if (
    value.residencyId === 'resident:metab' &&
    ['attach', 'promote'].includes(value.operation)
  ) {
    fail('METAB requires the exact neutral-birth operation', 'RESIDENT_CONTROL_OPERATION');
  }
  return Object.freeze({ operation: value.operation, residencyId: value.residencyId });
}

function resolveContract(kernel, residencyId) {
  const manager = kernel.ensureResidentManager();
  const contract = manager.contractRegistry.byResidencyId.get(residencyId);
  if (!contract || contract.residencyId !== residencyId) {
    fail('resident contract is unavailable', 'RESIDENT_CONTRACT_UNKNOWN');
  }
  const record = kernel.stateStore.getResident(residencyId);
  return {
    manager,
    contract,
    moduleRelativePath: record?.moduleRelativePath || RESIDENT_MODULES[residencyId]
  };
}

async function statusFor(kernel, residencyId) {
  const { manager, contract, moduleRelativePath } = resolveContract(kernel, residencyId);
  const record = kernel.stateStore.getResident(residencyId);
  const unit = manager.units.get(residencyId) || null;
  const runtimeStatus = record ? await manager.status(residencyId) : null;
  return Object.freeze({
    residencyId,
    coreId: contract.coreId,
    moduleRelativePath,
    version: contract.version,
    stateSchema: contract.stateSchema,
    priority: contract.priority,
    productionEligible: contract.productionEligible,
    signalling: contract.signalling,
    declaredOutputs: contract.outputs.length,
    observedOutputs: Number(runtimeStatus?.observedOutputs || 0),
    present: Boolean(record),
    status: record?.status || 'ABSENT',
    running: runtimeStatus?.running === true,
    checkpointHash: record?.checkpointHash || null,
    checkpointGeneration: Number(record?.checkpointGeneration || 0),
    authorityOwned: Boolean(runtimeStatus?.authorityOwned),
    handledEvents: Number(runtimeStatus?.handledEvents || 0),
    health: runtimeStatus?.health || null,
    lastError: runtimeStatus?.lastError || null,
    lastSlowTransition: runtimeStatus?.lastSlowTransition || null,
    resyncRequired: runtimeStatus?.resyncRequired === true,
    terminalPersistenceError: runtimeStatus?.terminalPersistenceError || null,
    teardownError: runtimeStatus?.teardownError || null,
    queue: runtimeStatus?.queue || null,
    host: runtimeStatus?.host || null,
    durabilityContract: runtimeStatus?.durabilityContract || null,
    activationBackfilled: Number(runtimeStatus?.activationBackfilled || 0)
  });
}

function createResidentControlDispatcher(kernel) {
  let operationInFlight = false;
  return async function dispatch(raw) {
    const request = validateRequest(raw);
    const resolved = resolveContract(kernel, request.residencyId);

    if (request.operation === 'status') {
      return { ok: true, operation: 'status', resident: await statusFor(kernel, request.residencyId) };
    }
    if (operationInFlight) fail('resident-control mutation already in flight', 'RESIDENT_CONTROL_BUSY');

    operationInFlight = true;
    try {
      if (request.operation === 'birth') {
        if (typeof kernel.birthMetabNeutral !== 'function') {
          fail('METAB neutral birth is unavailable', 'RESIDENT_CONTROL_BIRTH');
        }
        await kernel.birthMetabNeutral();
      } else if (request.operation === 'attach') {
        if (kernel.stateStore.getResident(request.residencyId)) {
          fail('resident already exists', 'RESIDENT_ALREADY_EXISTS');
        }
        await kernel.attachResident(resolved.moduleRelativePath);
      } else if (request.operation === 'detach') {
        await kernel.detachResident(request.residencyId);
      } else if (request.operation === 'resynchronize') {
        if (typeof kernel.resynchronizeResident !== 'function') {
          fail('resident resynchronization is unavailable', 'RESIDENT_CONTROL_RESYNCHRONIZE');
        }
        await kernel.resynchronizeResident(request.residencyId);
      } else {
        if (request.residencyId !== 'resident:sntss') {
          fail('only SNTSS has a bounded generation-promotion operation', 'RESIDENT_CONTROL_PROMOTION');
        }
        if (typeof kernel.promoteSntssContinuityGenesis !== 'function') {
          fail('SNTSS generation promotion is unavailable', 'RESIDENT_CONTROL_PROMOTION');
        }
        await kernel.promoteSntssContinuityGenesis();
      }
      return {
        ok: true,
        operation: request.operation,
        statePreserved: ['detach', 'resynchronize'].includes(request.operation),
        resident: await statusFor(kernel, request.residencyId)
      };
    } finally {
      operationInFlight = false;
    }
  };
}

function sanitizedError(error) {
  return {
    ok: false,
    code: String(error?.code || 'RESIDENT_CONTROL_FAILED')
  };
}

function createResidentControlServer({ kernel, socketPath = DEFAULT_SOCKET_PATH, logger = console }) {
  if (!kernel || typeof kernel.attachResident !== 'function' || typeof kernel.detachResident !== 'function') {
    fail('resident-control kernel is invalid', 'RESIDENT_CONTROL_KERNEL');
  }
  const dispatch = createResidentControlDispatcher(kernel);
  let server = null;
  let started = false;

  async function start() {
    if (started) return;
    await fs.mkdir(require('node:path').dirname(socketPath), { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(socketPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat) {
      if (!stat.isSocket()) fail('resident-control path is not a socket', 'RESIDENT_CONTROL_PATH');
      await fs.unlink(socketPath);
    }

    server = net.createServer(socket => {
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy());
      let body = '';
      let handled = false;
      socket.on('data', chunk => {
        if (handled) return;
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
          handled = true;
          socket.end(JSON.stringify(sanitizedError({ code: 'RESIDENT_CONTROL_REQUEST_TOO_LARGE' })) + '\n');
          return;
        }
        const newline = body.indexOf('\n');
        if (newline === -1) return;
        handled = true;
        const trailing = body.slice(newline + 1);
        if (trailing.trim()) {
          socket.end(JSON.stringify(sanitizedError({ code: 'RESIDENT_CONTROL_REQUEST_TRAILING_DATA' })) + '\n');
          return;
        }
        Promise.resolve().then(() => dispatch(JSON.parse(body.slice(0, newline))))
          .then(result => socket.end(JSON.stringify(result) + '\n'))
          .catch(error => socket.end(JSON.stringify(sanitizedError(error)) + '\n'));
      });
      socket.on('error', error => logger.warn?.(`[STAY] resident-control client error: ${error.code || 'IO'}`));
    });
    server.on('error', error => logger.error?.(`[STAY] resident-control socket error: ${error.code || 'IO'}`));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await fs.chmod(socketPath, 0o600);
    started = true;
  }

  async function stop() {
    if (!server) {
      await fs.unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return;
    }
    await new Promise(resolve => server.close(() => resolve()));
    server = null;
    started = false;
    await fs.unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  return Object.freeze({ start, stop, socketPath, get started() { return started; } });
}

function installResidentControlSocket({ socketPath = DEFAULT_SOCKET_PATH, logger = console } = {}) {
  const { LivingKernel } = require('../index');
  if (LivingKernel.prototype[PATCH_MARKER]) return LivingKernel.prototype[PATCH_MARKER];
  const originalStart = LivingKernel.prototype.start;
  const originalStop = LivingKernel.prototype.stop;

  LivingKernel.prototype.start = async function residentControlStart(...args) {
    const result = await originalStart.apply(this, args);
    const control = createResidentControlServer({ kernel: this, socketPath, logger: this.logger || logger });
    this.residentControlSocket = control;
    try {
      await control.start();
    } catch (error) {
      this.recordMaintenanceError?.('resident-control-socket', error);
      this.logger?.error?.(`[STAY] resident-control unavailable: ${error.code || 'START_FAILED'}`);
    }
    return result;
  };

  LivingKernel.prototype.stop = async function residentControlStop(...args) {
    try {
      await this.residentControlSocket?.stop();
    } catch (error) {
      this.logger?.warn?.(`[STAY] resident-control shutdown error: ${error.code || 'STOP_FAILED'}`);
    }
    return originalStop.apply(this, args);
  };

  const marker = Object.freeze({ installed: true, socketPath });
  Object.defineProperty(LivingKernel.prototype, PATCH_MARKER, {
    value: marker,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return marker;
}

module.exports = {
  FORMAT,
  DEFAULT_SOCKET_PATH,
  RESIDENT_MODULES,
  validateRequest,
  resolveContract,
  statusFor,
  createResidentControlDispatcher,
  createResidentControlServer,
  installResidentControlSocket
};
