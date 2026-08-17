'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  sandboxNodeBinding,
  sandboxWorkerPlan
} = require('../runtime/kernel/core-sandbox');

const root = path.resolve(__dirname, '..');
const neutral = path.join(
  root,
  'cores',
  'sntss',
  'neutral',
  'index.js'
);

test('Bubblewrap explicitly creates user namespace before disabling nested user namespaces', () => {
  const plan = sandboxWorkerPlan(neutral);

  const all = plan.args.indexOf('--unshare-all');
  const user = plan.args.indexOf('--unshare-user');
  const disable = plan.args.indexOf('--disable-userns');

  assert.ok(all >= 0);
  assert.ok(user > all);
  assert.ok(disable > user);
});

test('/usr Node uses the existing read-only /usr mount', () => {
  const binding = sandboxNodeBinding('/usr/bin/node');

  assert.equal(binding.hostNodePath, '/usr/bin/node');
  assert.equal(binding.nodePath, '/usr/bin/node');
  assert.deepEqual([...binding.args], []);
});

test('external Node gets a narrow read-only sandbox mount', () => {
  const binding = sandboxNodeBinding(
    '/opt/node-v24.19.0/bin/node'
  );

  assert.equal(
    binding.hostNodePath,
    '/opt/node-v24.19.0/bin/node'
  );

  assert.equal(
    binding.nodePath,
    '/stay-node/bin/node'
  );

  assert.deepEqual([...binding.args], [
    '--dir',
    '/stay-node',
    '--ro-bind',
    '/opt/node-v24.19.0/bin',
    '/stay-node/bin'
  ]);

  assert.notEqual(binding.nodePath, '/usr/bin/node');
});

test('real plan maps the current Node executable correctly', () => {
  const plan = sandboxWorkerPlan(neutral);
  const actualNode = fs.realpathSync.native(process.execPath);

  assert.ok(plan.args.includes('--unshare-user'));

  const workerIndex =
    plan.args.lastIndexOf(plan.sandboxWorkerPath);

  assert.ok(workerIndex > 0);

  let nodeIndex = -1;

  for (let i = workerIndex - 1; i >= 0; i -= 1) {
    if (/\/node$/.test(plan.args[i])) {
      nodeIndex = i;
      break;
    }
  }

  assert.ok(nodeIndex >= 0);

  if (actualNode.startsWith('/usr/')) {
    assert.equal(plan.args[nodeIndex], actualNode);
  } else {
    assert.equal(
      plan.args[nodeIndex],
      '/stay-node/bin/' + path.basename(actualNode)
    );

    assert.ok(
      plan.args.includes(path.dirname(actualNode))
    );

    assert.ok(
      plan.args.includes('/stay-node/bin')
    );
  }
});
