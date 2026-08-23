'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const script = fs.readFileSync(path.join(
  __dirname,
  '..',
  'deploy',
  'live-physiology-transplant',
  'p1-finish-transplant-root.sh'
), 'utf8');

test('final transplant uses a group-restricted setuid Bubblewrap boundary', () => {
  assert.match(script, /SETUID_BWRAP='\/usr\/local\/libexec\/stay-bwrap-setuid'/);
  assert.match(script, /install -o root -g staydeploy -m 4750 "\$bwrap_source" "\$SETUID_BWRAP"/);
  assert.match(script, /install -o root -g staydeploy -m 0550 "\$WORK\/bwrap-wrapper" "\$HELPER"/);
  assert.match(script, /NoNewPrivileges=false/);
  assert.match(script, /CapPrm.*ZERO_CAP_HEX/s);
  assert.match(script, /CapEff.*ZERO_CAP_HEX/s);
  assert.match(script, /CapAmb.*ZERO_CAP_HEX/s);
});

test('payload seccomp replaces the failing nested-userns sysctl operation', () => {
  assert.match(script, /if \[\[ "\\\$arg" == --disable-userns \]\]/);
  assert.match(script, /args\+=\(--seccomp 3\)/);
  assert.match(script, /272\);\s+\/\/ unshare/);
  assert.match(script, /308\);\s+\/\/ setns/);
  assert.match(script, /435\);\s+\/\/ clone3/);
  assert.match(script, /0x10000000\);\s+\/\/ CLONE_NEWUSER/);
  assert.match(script, /payload-userns-seccomp-probe 142/);
});

test('pre-attach rollback removes every privileged sandbox artifact', () => {
  assert.match(script, /rm -f -- "\$HELPER" "\$SETUID_BWRAP" "\$USERNS_FILTER"/);
  assert.match(script, /ATTACH_STARTED=0/);
  assert.match(script, /ATTACH_STARTED=1\s+STEP='resident-sntss-attach'\s+attach=/s);
});
