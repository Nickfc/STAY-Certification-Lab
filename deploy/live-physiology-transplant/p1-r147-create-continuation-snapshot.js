#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { StateStore } = require('../../runtime/kernel/state-store');

const REASON = 'r147-homeos-continuation-preflight-v1';

function fail(message) {
  throw Object.assign(new Error(message), {
    code: 'P1_R147_CONTINUATION_SNAPSHOT_CREATE'
  });
}

async function main() {
  const [dataRoot, expectedDatabase] = process.argv.slice(2);
  if (!dataRoot || !expectedDatabase || !path.isAbsolute(dataRoot) ||
      !path.isAbsolute(expectedDatabase) ||
      path.resolve(expectedDatabase) !== path.join(path.resolve(dataRoot), 'continuity.sqlite3')) {
    fail('exact data root and database path are required');
  }
  const databaseStat = await fs.lstat(expectedDatabase);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    fail('continuity database trust fence failed');
  }

  const store = new StateStore(dataRoot);
  try {
    await store.init();
    const snapshot = await store.createSnapshot({ reason: REASON, retention: 24 });
    const manifest = await store.verifySnapshot(snapshot.path);
    const manifestPath = path.join(snapshot.path, 'SNAPSHOT_MANIFEST.json');
    const manifestBody = await fs.readFile(manifestPath);
    if (manifest.format !== 'stay-runtime-snapshot-v2' || manifest.reason !== REASON) {
      fail('created snapshot identity is invalid');
    }
    process.stdout.write(JSON.stringify({
      format: 'stay-r147-continuation-preflight-snapshot-v1',
      result: 'PASS',
      name: snapshot.name,
      path: snapshot.path,
      manifestSha256:
        `sha256:${crypto.createHash('sha256').update(manifestBody).digest('hex')}`,
      fileCount: Object.keys(manifest.files || {}).length,
      authority: manifest.authority,
      residents: manifest.residents
    }) + '\n');
  } finally {
    store.close();
  }
}

main().catch(error => {
  console.error(`${error.code || 'P1_R147_CONTINUATION_SNAPSHOT_CREATE'}: ${error.message}`);
  process.exitCode = 1;
});
