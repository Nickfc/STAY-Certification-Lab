'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  trustedCoreHostExecArgv,
  nativeCoreExecArgv
} = require('../runtime/kernel/core-sandbox');

const root = path.resolve(__dirname, '..');

const neutral = path.join(
  root,
  'cores',
  'sntss',
  'neutral',
  'index.js'
);

const clientSource = fs.readFileSync(
  path.join(
    root,
    'runtime',
    'kernel',
    'core-host-client.js'
  ),
  'utf8'
);

test(
  'trusted OS-sandbox CoreHost supervisor may launch Bubblewrap',
  () => {
    const bwrap =
      process.env.STAY_BWRAP ||
      '/usr/bin/bwrap';

    const supervisor =
      trustedCoreHostExecArgv(neutral);

    assert.ok(
      supervisor.includes('--allow-child-process')
    );

    assert.ok(
      supervisor.includes(
        `--allow-fs-read=${bwrap}`
      )
    );
  }
);

test(
  'direct native Core execution retains no child-process authority',
  () => {
    const worker =
      nativeCoreExecArgv(neutral);

    assert.equal(
      worker.includes('--allow-child-process'),
      false
    );
  }
);

test(
  'CoreHost client selects trusted authority only when OS sandbox is required',
  () => {
    assert.match(
      clientSource,
      /STAY_REQUIRE_OS_CORE_SANDBOX === '1'/
    );

    assert.match(
      clientSource,
      /trustedCoreHostExecArgv\(this\.modulePath\)/
    );

    assert.match(
      clientSource,
      /nativeCoreExecArgv\(this\.modulePath\)/
    );
  }
);
