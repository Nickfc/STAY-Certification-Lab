'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('R10.5-17 trusted-boundary bootstrap requires out-of-band verification before repository code receives root', () => {
  const installer = fs.readFileSync(path.join(root, 'deploy/install-trusted-boundary.sh'), 'utf8');
  const ceremony = fs.readFileSync(path.join(root, 'docs/sntss/R10_5_TRUST_BOOTSTRAP_CEREMONY.md'), 'utf8');

  assert.match(installer, /SECOND-STAGE INSTALLER ONLY/);
  assert.match(installer, /STAY_BOOTSTRAP_PREVERIFIED/);
  assert.match(installer, /--public-key-sha256/);
  assert.match(installer, /bootstrap manifest must contain exactly/);
  assert.doesNotMatch(installer, /Usage: sudo \.\/deploy\/install-trusted-boundary\.sh \/path\/to\/release-authority-public\.pem/);

  const verifyPosition = ceremony.indexOf('/usr/bin/openssl pkeyutl -verify');
  const sudoPosition = ceremony.indexOf('sudo env STAY_BOOTSTRAP_PREVERIFIED=1');
  assert.ok(verifyPosition >= 0 && sudoPosition > verifyPosition, 'external signature verification must occur before sudoing repository code');
  assert.match(ceremony, /No repository script or Node executable has been trusted or executed to reach this point/);
  assert.match(ceremony, /public-key fingerprint.*independent/i);
  assert.match(ceremony, /\/usr\/bin\/sha256sum -c/);
});
