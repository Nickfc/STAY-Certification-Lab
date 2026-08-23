#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const evidence = require('./split-evidence');

const values = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--compute', '--live', '--output'].includes(flag) || !value) {
    throw new Error('Usage: VERIFY_SPLIT_EVIDENCE.js --compute <json> --live <json> --output <json>');
  }
  values[flag.slice(2)] = value;
}
if (!values.compute || !values.live || !values.output) {
  throw new Error('Usage: VERIFY_SPLIT_EVIDENCE.js --compute <json> --live <json> --output <json>');
}

const compute = JSON.parse(fs.readFileSync(path.resolve(values.compute), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.resolve(values.live), 'utf8'));
const binding = evidence.bindSplitEvidence(compute, live);
evidence.writePrivateJson(path.resolve(values.output), binding);
process.stdout.write(`${JSON.stringify(binding, null, 2)}\n`);
