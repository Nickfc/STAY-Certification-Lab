'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const servicePath = path.join(
  __dirname,
  '..',
  'deploy',
  'systemd',
  'stay.service'
);

const service = fs.readFileSync(servicePath, 'utf8');

function directive(name) {
  const prefix = name + '=';
  const values = service
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length));

  assert.equal(
    values.length,
    1,
    `expected exactly one canonical ${name}= directive`
  );

  return values[0];
}

test('systemd hardening remains compatible with the required nested Bubblewrap Core sandbox', () => {
  assert.match(
    service,
    /^Environment=STAY_REQUIRE_OS_CORE_SANDBOX=1$/m
  );

  // The trusted CoreHost is still unprivileged and process visibility remains
  // restricted, but bubblewrap must be able to read procfs namespace controls
  // and mount a fresh /proc inside the worker PID namespace.
  assert.equal(directive('NoNewPrivileges'), 'true');
  assert.equal(directive('ProtectProc'), 'invisible');
  assert.equal(directive('ProcSubset'), 'all');
  assert.equal(directive('RestrictNamespaces'), 'false');

  // Host drill I1-D proved both of these systemd mount policies independently
  // make bubblewrap fail with "Can't mount proc ... Operation not permitted".
  assert.equal(directive('ProtectKernelTunables'), 'false');
  assert.equal(directive('ProtectKernelLogs'), 'false');

  // This protection was independently proven compatible and stays enabled.
  assert.equal(directive('ProtectKernelModules'), 'true');

  assert.equal(directive('ProtectSystem'), 'strict');
  assert.equal(
    directive('CapabilityBoundingSet'),
    'CAP_SETGID CAP_SETUID CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN'
  );
  assert.equal(directive('AmbientCapabilities'), '');

  assert.notEqual(directive('ProcSubset'), 'pid');
});