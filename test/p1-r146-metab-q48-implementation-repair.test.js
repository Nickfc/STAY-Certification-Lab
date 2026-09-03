'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createNeutralMetabInitialState } = require(
  '../runtime/p1-r0/residents/metab-neutral'
);
const shadow = require('../runtime/p1-r0/residents/metab-shadow');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const profiles = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
).profiles;
const {
  BASELINE,
  REPAIR,
  repairIncompleteCheckpointState,
  validateRelease
} = require('../deploy/live-physiology-transplant/p1-r146-metab-q48-implementation-repair');

const ROOT = path.resolve(__dirname, '..');
const IDENTITY = Object.freeze({
  organismId: 'stay-r146-metab-repair-test',
  createdAt: '2026-09-03T20:00:00.000Z',
  lineage: 'STAY/Genesis'
});
const IDENTITY_HASH = sha256(IDENTITY);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function incompleteState() {
  const profile = clone(profiles.METAB);
  profile.profileId = 'metab.p1-r0.r146-repair-test.v1';
  const neutral = createNeutralMetabInitialState({
    binding: {
      bindingVersion: 1,
      identitySha256: IDENTITY_HASH,
      organismLineage: IDENTITY.lineage,
      issuedAt: 10_000,
      runtimeRevision: 141,
      authorityEpoch: 141,
      kernelVersion: '0.8.11.3'
    },
    founder: {
      recordVersion: 'P1ResidentFounderBindingV1',
      coreId: 'METAB',
      organismId: IDENTITY.organismId,
      organismIdentityHash: IDENTITY_HASH,
      founderId: 'founder:metab:r146:repair-test',
      lineageId: 'lineage:metab:r146:repair-test',
      residencyId: 'resident:metab',
      profileId: profile.profileId,
      profileHash: sha256(profile),
      profile,
      mode: 'NEUTRAL',
      authorityEpoch: '0'
    }
  });
  const state = clone(await shadow.migrateState({
    state: neutral,
    fromSchema: 1,
    toSchema: 2
  }));
  state.activation = {
    protocol: 'stay-p1-r0-metab-shadow-activation-v1',
    organismIdentityHash: IDENTITY_HASH,
    residencyId: 'resident:metab',
    instanceId: BASELINE.instanceId,
    fromVersion: '0.1.0-p1r0-neutral.1',
    fromStateSchema: 1,
    sourceCheckpointGeneration: 1,
    sourceCheckpointHash: `sha256:${'a'.repeat(64)}`,
    toVersion: shadow.VERSION,
    toStateSchema: 2,
    runtimeRevision: 139,
    parentRevision: 127,
    parentFreezeRecordSha256: `sha256:${'b'.repeat(64)}`,
    mode: 'SHADOW',
    authorityEpoch: '0',
    outputPolicy: 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT',
    eventId: 'evt-r146-repair-activation',
    eventSequence: 1,
    signalId: 'runtime.metab.shadow-activation:r139:g1:test'
  };
  state.engineState.frameIndex = BASELINE.acceptedFrame;
  state.engineState.inputCursors['p1r0.capacity.metab'] = String(BASELINE.inputCursor - 4);
  state.engineState.saturationLossQ48 = '9223328894317739274';
  state.handledEvents = 196003;
  state.lastAcceptedFrame = BASELINE.acceptedFrame;
  state.lastAcceptedTimeMs = 904365919;
  state.pendingEligible = {
    capacityClass: 'HOST_RESOURCE_HEADROOM_V1',
    eligibleCapacityQ48: '152203406388281',
    eventId: 'evt-r146-repair-pending',
    observedAtMs: 904366416,
    producerSequence: String(BASELINE.inputCursor),
    pulseId: `metab-capacity-r128-f${BASELINE.pendingFrame}`,
    safetyCeilingQ48: '281474976710656',
    sampleFrame: BASELINE.pendingFrame,
    signalId: `runtime.metab.capacity.eligible:r128:f${BASELINE.pendingFrame}`
  };
  return state;
}

test('R146-METAB-REPAIR-01 patched package keeps exact identity and zero-output containment', () => {
  const definition = validateRelease(ROOT);
  assert.equal(definition.manifest.version, BASELINE.version);
  assert.equal(definition.manifest.stateSchema, BASELINE.stateSchema);
  assert.equal(definition.manifest.productionEligible, false);
  assert.deepEqual(definition.manifest.outputs, []);
  assert.match(REPAIR.moduleHash, /^sha256:[0-9a-f]{64}$/);
});

test('R146-METAB-REPAIR-02 discards only the incomplete future input and preserves accepted biology', async () => {
  const definition = validateRelease(ROOT);
  const state = await incompleteState();
  const repaired = repairIncompleteCheckpointState(state, definition);
  assert.equal(repaired.pendingEligible, null);
  assert.equal(repaired.pendingQuality, null);
  assert.equal(repaired.lastAcceptedFrame, BASELINE.acceptedFrame);
  assert.deepEqual(repaired.engineState, state.engineState);
  assert.deepEqual(repaired.activation, state.activation);
  assert.notEqual(repaired, state);
  assert.equal(state.pendingEligible.sampleFrame, BASELINE.pendingFrame);
});

test('R146-METAB-REPAIR-03 mismatched partial-frame identity fails closed', async () => {
  const definition = validateRelease(ROOT);
  const state = await incompleteState();
  state.pendingEligible.sampleFrame += 1;
  assert.throws(
    () => repairIncompleteCheckpointState(state, definition),
    { code: 'P1_METAB_SHADOW_STATE' }
  );
});
