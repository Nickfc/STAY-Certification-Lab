'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  trustedCoreHostExecArgv,
  nativeCoreExecArgv,
  coreSupervisorEnvironment
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

    assert.match(
      clientSource,
      /env:\s*coreSupervisorEnvironment\(/
    );
  }
);

test(
  'CoreHost supervisor preserves the fail-closed sandbox selection across its fork',
  () => {
    const previousRequired = process.env.STAY_REQUIRE_OS_CORE_SANDBOX;
    const previousBwrap = process.env.STAY_BWRAP;
    try {
      process.env.STAY_REQUIRE_OS_CORE_SANDBOX = '1';
      process.env.STAY_BWRAP = '/usr/local/libexec/stay-bwrap-sandbox';
      const environment = coreSupervisorEnvironment();
      assert.equal(environment.STAY_REQUIRE_OS_CORE_SANDBOX, '1');
      assert.equal(environment.STAY_BWRAP, '/usr/local/libexec/stay-bwrap-sandbox');
      assert.equal(environment.STAY_REQUIRE_CGROUPS, undefined);
      assert.equal(environment.NODE_OPTIONS, undefined);
    } finally {
      if (previousRequired === undefined) delete process.env.STAY_REQUIRE_OS_CORE_SANDBOX;
      else process.env.STAY_REQUIRE_OS_CORE_SANDBOX = previousRequired;
      if (previousBwrap === undefined) delete process.env.STAY_BWRAP;
      else process.env.STAY_BWRAP = previousBwrap;
    }
  }
);
