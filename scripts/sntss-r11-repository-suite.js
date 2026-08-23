'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const attackMap = JSON.parse(fs.readFileSync(path.join(root, 'docs/sntss/R11_REPOSITORY_ATTACK_MAP.json'), 'utf8'));
const files = new Set();
for (const domain of attackMap.domains || []) {
  for (const regression of domain.regressions || []) files.add(regression.file);
}
files.add('test/r11-repository-evidence.test.js');
files.add('test/r11-certification-contract.test.js');
files.add('test/r11-certification-status.test.js');

const args = ['--test', '--test-concurrency=1', ...Array.from(files).sort()];
const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, STAY_R11_REPOSITORY_PRECERTIFICATION: '1' }
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
