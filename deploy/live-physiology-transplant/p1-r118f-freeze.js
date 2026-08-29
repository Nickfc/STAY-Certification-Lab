#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  sealRevisionFreeze,
  validateRevisionFreeze,
} = require('../../runtime/revision-freeze');

function fail(message, code = 'R118F_FREEZE') {
  throw Object.assign(new Error(message), { code });
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is invalid: ${error.message}`, 'R118F_FREEZE_INPUT'); }
}

function argumentsObject(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z][a-z0-9-]*$/.test(name || '') || value == null) {
      fail('freeze arguments are invalid', 'R118F_FREEZE_ARGUMENTS');
    }
    values[name.slice(2)] = value;
  }
  return values;
}

function capture(values) {
  const required = [
    'proof', 'preflight', 'entry-proof', 'service-proof', 'release',
    'release-tag', 'release-commit', 'release-tree', 'archive-sha256',
    'manifest-sha256', 'controller-sha256', 'hostname', 'private-ip',
  ];
  if (required.some(name => !values[name])) {
    fail('freeze is missing a required evidence identity', 'R118F_FREEZE_ARGUMENTS');
  }
  const proof = readJson(values.proof, 'live proof');
  const preflight = readJson(values.preflight, 'repair preflight');
  const entryProof = readJson(values['entry-proof'], 'entry proof');
  const serviceProof = readJson(values['service-proof'], 'service proof');
  const release = path.resolve(values.release);
  const releaseStat = fs.lstatSync(release);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) {
    fail('release directory identity is invalid', 'R118F_FREEZE_RELEASE');
  }
  if (proof.result !== 'PASS'
    || proof.runtime?.fromRevision !== 116
    || proof.runtime?.recoveryRevision !== 117
    || proof.runtime?.toRevision !== 118
    || proof.continuity?.coldReplayEvents !== 4096
    || proof.continuity?.abandonedCount !== 0
    || proof.continuity?.inventedBiologicalTime !== false
    || proof.authority?.sntss !== 'NONE'
    || proof.authority?.chronobiology !== 'NONE'
    || proof.outputs?.sntss !== 0
    || proof.resources?.changed !== false
    || proof.fetus?.status !== 'healthy'
    || proof.chips?.bsf !== 'LIVE'
    || proof.chips?.sntss !== 'SHADOW'
    || proof.chips?.chronobiology !== 'SHADOW'
    || preflight.result !== 'PASS'
    || entryProof.result !== 'PASS'
    || entryProof.hardCpuPercent !== 20
    || entryProof.hardRamMiB !== 96
    || serviceProof.restartCommands !== 1) {
    fail('R118F acceptance evidence is incomplete', 'R118F_FREEZE_ACCEPTANCE');
  }
  for (const name of [
    'release-commit', 'release-tree', 'archive-sha256', 'manifest-sha256',
    'controller-sha256',
  ]) {
    const pattern = name.endsWith('commit') || name.endsWith('tree')
      ? /^[0-9a-f]{40}$/
      : /^sha256:[0-9a-f]{64}$/;
    if (!pattern.test(values[name])) fail(`${name} identity is invalid`, 'R118F_FREEZE_IDENTITY');
  }
  const body = {
    format: 'stay-runtime-revision-freeze-v1',
    result: 'PASS',
    acceptance: 'ACCEPTED',
    freezeType: 'R118F_CHRONOBIOLOGY_GAP_PERFORMANCE_REPAIR',
    runtime: {
      revision: 118,
      revisionLabel: 'R118F',
      progression: [116, 117, 118],
      serviceMainPid: Number(serviceProof.afterPid),
      serviceRestarts: 1,
    },
    release: {
      path: release,
      tag: values['release-tag'],
      commit: values['release-commit'],
      tree: values['release-tree'],
      archiveSha256: values['archive-sha256'],
      manifestSha256: values['manifest-sha256'],
      controllerSha256: values['controller-sha256'],
    },
    host: {
      hostname: values.hostname,
      privateIpv4: values['private-ip'],
    },
    continuity: proof.continuity,
    residents: proof.release,
    authority: proof.authority,
    outputs: proof.outputs,
    resources: proof.resources,
    bsf: proof.bsf,
    fetus: proof.fetus,
    chips: proof.chips,
    evidence: {
      liveProofSha256: sha256File(values.proof),
      preflightSha256: sha256File(values.preflight),
      entryProofSha256: sha256File(values['entry-proof']),
      serviceProofSha256: sha256File(values['service-proof']),
    },
    capturedAt: new Date().toISOString(),
  };
  return sealRevisionFreeze(body);
}

function verify(record) {
  if (!validateRevisionFreeze(record, 118)
    || record.freezeType !== 'R118F_CHRONOBIOLOGY_GAP_PERFORMANCE_REPAIR'
    || record.runtime?.serviceRestarts !== 1
    || record.continuity?.coldReplayEvents !== 4096
    || record.continuity?.abandonedCount !== 0
    || record.continuity?.inventedBiologicalTime !== false
    || record.authority?.sntss !== 'NONE'
    || record.authority?.chronobiology !== 'NONE'
    || record.outputs?.sntss !== 0
    || record.resources?.changed !== false
    || record.fetus?.status !== 'healthy'
    || record.chips?.chronobiology !== 'SHADOW') {
    fail('R118F freeze record failed verification', 'R118F_FREEZE_VERIFY');
  }
  return {
    R118F_FREEZE: 'PASS',
    REVISION_LABEL: 'R118F',
    RECORD_SHA256: record.recordSha256,
    RELEASE_TAG: record.release.tag,
    RELEASE_COMMIT: record.release.commit,
    ARCHIVE_SHA256: record.release.archiveSha256,
  };
}

function main(argv = process.argv.slice(2)) {
  const operation = argv.shift();
  if (operation === 'capture') {
    process.stdout.write(`${JSON.stringify(capture(argumentsObject(argv)))}\n`);
    return;
  }
  if (operation === 'verify' && argv.length === 1) {
    const result = verify(readJson(argv[0], 'freeze record'));
    for (const [name, value] of Object.entries(result)) {
      process.stdout.write(`${name}=${value}\n`);
    }
    return;
  }
  fail('capture or verify required', 'R118F_FREEZE_USAGE');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`R118F_FREEZE_ABORT=${error.code || 'FAILED'}:${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { capture, verify };
