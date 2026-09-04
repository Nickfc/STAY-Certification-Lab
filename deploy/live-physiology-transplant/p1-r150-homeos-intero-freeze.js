#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sealRevisionFreeze, validateRevisionFreeze } = require('../../runtime/revision-freeze');

const STAGES = Object.freeze({
  homeos: Object.freeze({
    revision: 146, label: 'R146F', parentRevision: 141,
    freezeType: 'R146_METAB_Q48_REPAIRED_HOMEOS_OUTPUT_FIREWALLED_SHADOW',
    progression: [141, 142, 143, 144, 145, 146]
  }),
  'homeos-r147': Object.freeze({
    revision: 147, label: 'R147F', parentRevision: 141,
    freezeType: 'R147_RECOVERED_HOMEOS_OUTPUT_FIREWALLED_SHADOW',
    progression: [141, 142, 143, 144, 145, 146, 147],
    certificateName: 'homeos', coreId: 'HOMEOS'
  }),
  intero: Object.freeze({
    revision: 150, label: 'R150F', parentRevision: 145,
    freezeType: 'R150_INTERO_PERCEPTION_ONLY_SHADOW',
    progression: [145, 146, 147, 148, 149, 150]
  })
});

function fail(message) {
  throw Object.assign(new Error(message), { code: 'R150_FREEZE' });
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function fileHash(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}
function readReleaseIdentity(file) {
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
    const at = line.indexOf('=');
    if (at < 1) fail('release identity is malformed');
    return [line.slice(0, at), line.slice(at + 1)];
  });
  return Object.fromEntries(entries);
}
function evidenceHashes(root) {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== 'target.freeze.json')
    .map(entry => [entry.name, fileHash(path.join(root, entry.name))])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function buildFreeze(stageName, root) {
  const stage = STAGES[stageName];
  if (!stage) fail('stage must be homeos, homeos-r147, or intero');
  const parent = readJson(path.join(root, 'parent.freeze.json'));
  const before = readJson(path.join(root, 'before.proof.json'));
  const after = readJson(path.join(root, 'after.proof.json'));
  const service = readJson(path.join(root, 'service.after.json'));
  const release = readReleaseIdentity(path.join(root, 'P1_R150_RELEASE.env'));
  const certificateName = stage.certificateName || stageName;
  const certificate = readJson(path.join(root, `${certificateName}.birth-certificate.json`));
  if (!validateRevisionFreeze(parent, stage.parentRevision) || before?.result !== 'PASS' ||
    after?.result !== 'PASS' || after.revision !== stage.revision ||
    ![1, 2].includes(service.restartCommands) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(certificate?.body?.founderDossierSha256 || ''))) {
    fail('acceptance evidence does not prove the exact freeze boundary');
  }
  const record = sealRevisionFreeze({
    format: 'stay-runtime-revision-freeze-v1', result: 'PASS', acceptance: 'ACCEPTED',
    freezeType: stage.freezeType,
    runtime: {
      revision: stage.revision, revisionLabel: stage.label,
      progression: stage.progression, serviceMainPid: service.afterPid,
      serviceNRestarts: service.afterRestarts, restartCommands: service.restartCommands,
      recoveryRestartCommands: Number(service.recoveryRestartCommands || 0)
    },
    parentFreeze: { revision: stage.parentRevision, recordSha256: parent.recordSha256 },
    release: {
      path: release.RELEASE_PATH, tag: release.RELEASE_TAG, commit: release.RELEASE_COMMIT,
      tree: release.RELEASE_TREE, archiveSha256: release.ARCHIVE_SHA256,
      manifestSha256: release.MANIFEST_SHA256,
      controllerSha256: release.CONTROLLER_SHA256
    },
    birth: {
      coreId: stage.coreId || stageName.toUpperCase(), certificateId: certificate.body.certificateId,
      certificateSha256: fileHash(path.join(root, `${certificateName}.birth-certificate.json`)),
      founderDossierSha256: certificate.body.founderDossierSha256,
      privateKeyPresent: false, entropyPresent: false
    },
    physiology: {
      bsf: 'LIVE', sntss: 'SHADOW', chronobiology: 'SHADOW', metab: 'SHADOW',
      homeos: 'SHADOW', intero: stageName === 'intero' ? 'SHADOW' : 'ABSENT',
      authorityOwned: false, pendingDeliveries: 0, pendingOutboxIntents: 0,
      abandonedDeliveries: after.abandonedDeliveries, inventedBiologicalTime: false,
      fetusContinuity: true
    },
    recovery: { revisionFenced: true, pointerRewound: false, repeatedPromotion: false },
    promotionAuthority: {
      startupOnly: true, unitDropinRevoked: true, activeCertificateRemoved: true,
      privateSigningKeyOnHost: false
    },
    benchmark: { started: false },
    evidence: evidenceHashes(root), capturedAt: new Date().toISOString()
  });
  if (!validateRevisionFreeze(record, stage.revision)) fail('sealed freeze failed self-validation');
  return record;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) fail('usage: p1-r150-homeos-intero-freeze.js <homeos|homeos-r147|intero> <evidence-root>');
  process.stdout.write(`${JSON.stringify(buildFreeze(argv[0], path.resolve(argv[1])))}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`${error.code || 'R150_FREEZE'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ STAGES, buildFreeze });
