#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail() {
  throw Object.assign(new Error('private material cleanup boundary is invalid'), {
    code: 'C3C_PRIVATE_CLEANUP_INVALID',
  });
}

function restoreOwnerAccessNoFollow(target) {
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(target, stat.mode | 0o700);
    for (const entry of fs.readdirSync(target)) {
      restoreOwnerAccessNoFollow(path.join(target, entry));
    }
    return;
  }
  fs.chmodSync(target, stat.mode | 0o600);
}

function destroyPrivateMaterial(outputRoot, targets) {
  const root = fs.realpathSync(outputRoot);
  if (!Array.isArray(targets) || targets.length === 0) fail();
  for (const supplied of targets) {
    const target = path.resolve(supplied);
    if (path.dirname(target) !== root) fail();
    restoreOwnerAccessNoFollow(target);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

if (require.main === module) {
  destroyPrivateMaterial(process.env.PRIVATE_OUTPUT_ROOT, [
    process.env.PRIVATE_RAW_ROOT,
    process.env.PRIVATE_EPHEMERAL_ROOT,
  ]);
}

module.exports = { destroyPrivateMaterial, restoreOwnerAccessNoFollow };
