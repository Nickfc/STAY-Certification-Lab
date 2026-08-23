'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  ResidentManager,
  L0_SNTSS_CONTRACT,
  RESIDENT_SIGNALLING,
  createResidentContractRegistry,
} = require('../runtime/kernel/resident-manager');

const ROOT = path.resolve(__dirname, '..');
const SNTSS_MODULE = 'cores/sntss/i3d/index.js';
const CHRONOBIOLOGY_FIXTURE_MODULE = 'test/fixtures/cores/chronobiology-resident.js';

const CHRONOBIOLOGY_TEST_CONTRACT = Object.freeze({
  residencyId: 'resident:chronobiology-fixture',
  coreId: 'chronobiology-fixture',
  role: 'chronobiology',
  version: '0.0.0-test',
  stage: 'laboratory-resident-fixture',
  priority: 'optional',
  productionEligible: false,
  stateSchema: 1,
  inputs: Object.freeze([
    'runtime.organism.binding',
    'runtime.trusted-organism-time.pulse',
    'environment.photic.exposure',
  ]),
  outputs: Object.freeze([
    'chronobiology.phase.summary',
  ]),
  packagePolicyHash: null,
  signalling: RESIDENT_SIGNALLING.LAB_SHADOW_ONLY,
  producerEpoch: 1,
  authorityMode: 'lab',
});

function manager() {
  return new ResidentManager({
    releaseRoot: ROOT,
    stateStore: {},
    fabric: { subscribeAll: () => () => {} },
    identity: { lineage: 'STAY/Genesis' },
    contracts: [L0_SNTSS_CONTRACT, CHRONOBIOLOGY_TEST_CONTRACT],
  });
}

test('CHR-INF-01 resident contract registry preserves frozen SNTSS signalling prohibition', () => {
  const registry = createResidentContractRegistry([
    L0_SNTSS_CONTRACT,
    CHRONOBIOLOGY_TEST_CONTRACT,
  ]);

  assert.equal(registry.byResidencyId.get(L0_SNTSS_CONTRACT.residencyId).signalling,
    RESIDENT_SIGNALLING.FORBIDDEN);
  assert.deepEqual(registry.byCoreId.get(L0_SNTSS_CONTRACT.coreId).outputs, []);
  assert.equal(registry.byCoreId.get(CHRONOBIOLOGY_TEST_CONTRACT.coreId).signalling,
    RESIDENT_SIGNALLING.LAB_SHADOW_ONLY);
});

test('CHR-INF-02 resident inspection selects an exact per-core contract', async (t) => {
  const residentManager = manager();
  t.after(() => residentManager.shutdown());

  const sntss = await residentManager.inspect(SNTSS_MODULE);
  assert.equal(sntss.contract.residencyId, L0_SNTSS_CONTRACT.residencyId);
  assert.deepEqual(sntss.definition.manifest.outputs, []);

  const chronobiology = await residentManager.inspect(CHRONOBIOLOGY_FIXTURE_MODULE);
  assert.equal(chronobiology.contract.residencyId, CHRONOBIOLOGY_TEST_CONTRACT.residencyId);
  assert.deepEqual(chronobiology.definition.manifest.outputs,
    CHRONOBIOLOGY_TEST_CONTRACT.outputs);
});

test('CHR-INF-03 resident contract registry rejects duplicate core identities', () => {
  assert.throws(
    () => createResidentContractRegistry([
      L0_SNTSS_CONTRACT,
      { ...CHRONOBIOLOGY_TEST_CONTRACT, coreId: L0_SNTSS_CONTRACT.coreId },
    ]),
    (error) => error && error.code === 'RESIDENT_CONTRACT_DUPLICATE',
  );
});
