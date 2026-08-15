'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const expected = {
  'cores/fetus-legacy-0.6/index.js': 'ad2698402492a573aa5b28978b2b1a8e3387a6adc8ca0592d06bcfe310cdc9b1',
  'legacy/0.6.0/HIBERNATION_STATE_SHA256': 'aff6ae3773cd58f153f3ed92680cd552d9c70f4d398fbf2bc2a2905f8c101dbb',
  'legacy/0.6.0/SOURCE_ARCHIVE_SHA256': '3e6efcb80a2707bb81c313f2cf3d98c14b1d2a7a8b1645de6cca8be80031445e'
};

test('verified fetus compatibility and immutable fingerprint files are byte-identical to 0.7 baseline', () => {
  for (const [relative, hash] of Object.entries(expected)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
    assert.equal(actual, hash, relative);
  }
});
