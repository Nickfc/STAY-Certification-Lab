'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectCoreModule } = require('../runtime/kernel/core-loader');

const neutral = path.join(
  __dirname,
  '..',
  'cores',
  'sntss',
  'neutral',
  'index.js'
);

function captureEnvironment(keys) {
  return new Map(keys.map(key => [
    key,
    Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined
  ]));
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('manifest inspection preserves a bounded Bubblewrap failure diagnostic', async t => {
  if (process.platform !== 'linux') {
    t.skip('OS sandbox diagnostic regression is Linux-only');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-fake-bwrap-'));
  const fakeBwrap = path.join(root, 'bwrap');
  const env = captureEnvironment([
    'STAY_REQUIRE_OS_CORE_SANDBOX',
    'STAY_BWRAP'
  ]);

  t.after(async () => {
    restoreEnvironment(env);
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeBwrap,
    [
      '#!/bin/sh',
      'echo "synthetic-bwrap-diagnostic: proc mount denied" >&2',
      'i=0',
      'while [ "$i" -lt 100 ]; do',
      '  printf "0123456789abcdef0123456789abcdef" >&2',
      '  i=$((i + 1))',
      'done',
      'echo >&2',
      'exit 17',
      ''
    ].join('\n'),
    { mode: 0o755 }
  );
  await fs.chmod(fakeBwrap, 0o755);

  process.env.STAY_REQUIRE_OS_CORE_SANDBOX = '1';
  process.env.STAY_BWRAP = fakeBwrap;

  await assert.rejects(
    inspectCoreModule(neutral, 5000),
    error => {
      assert.match(
        error.message,
        /synthetic-bwrap-diagnostic: proc mount denied/
      );
      assert.ok(
        error.message.length <= 1200,
        `diagnostic must remain bounded, got ${error.message.length} bytes`
      );
      assert.ok(
        error.code === 'CORE_WORKER_EXIT' ||
        error.code === 'CORE_INSPECT_EXIT'
      );
      return true;
    }
  );
});
