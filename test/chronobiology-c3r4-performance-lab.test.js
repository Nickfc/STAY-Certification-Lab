'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  GAP_US,
  GOLDEN_DIGEST,
  parseArguments,
} = require('../scripts/chronobiology-c3r4-performance-lab');

test('C3R4-LAB-01 performance laboratory has bounded, fail-closed arguments', () => {
  assert.deepEqual(parseArguments([]), { mode: 'direct', samples: 3 });
  assert.deepEqual(parseArguments(['--corehost', '--samples=12']), {
    mode: 'corehost',
    samples: 12,
  });
  assert.throws(() => parseArguments(['--samples=13']), {
    code: 'C3R4_PERFORMANCE_LAB_INVALID',
  });
  assert.throws(() => parseArguments(['--unknown']), {
    code: 'C3R4_PERFORMANCE_LAB_INVALID',
  });
});

test('C3R4-LAB-02 direct laboratory preserves the exact 36-hour biology', () => {
  const script = path.resolve(__dirname, '../scripts/chronobiology-c3r4-performance-lab.js');
  const child = spawnSync(process.execPath, [
    '--jitless', script, '--direct', '--samples=1',
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const result = JSON.parse(child.stdout);
  assert.equal(result.mode, 'direct-jitless');
  assert.equal(result.samples, 1);
  assert.equal(result.gapUs, GAP_US);
  assert.equal(result.stateDigest, GOLDEN_DIGEST);
  assert.equal(result.stateDigestMatchesGolden, true);
  assert.equal(result.elapsedMs.length, 1);
});
