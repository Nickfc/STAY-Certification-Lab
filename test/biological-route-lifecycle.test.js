'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { StateStore } = require('../runtime/kernel/state-store');
const { BiologicalAcceptanceBoundary } = require('../runtime/kernel/biological-acceptance');
const { AUTHORITY_MODE } = require('../runtime/kernel/biological-envelope');

async function makeStore(t, name = 'route') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `stay-ef1-g-route-${name}-`));
  const holder = { store: new StateStore(dir) };
  await holder.store.init();

  t.after(async () => {
    try { holder.store?.close(); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  holder.store.setInitialAuthority({
    coreId: 'interoception', instanceId: 'intero-1', version: '1.0.0', epoch: 1
  });
  holder.store.registerBiologicalConsumer({
    consumerId: 'core:interoception', coreId: 'interoception', topics: ['pulse.beat.raw'],
    required: true, authorityEpoch: 1
  });

  return { dir, holder };
}

function boundary({ streamId = 'pulse:beats', coreId = 'pulse', epoch = 4, nowUs = 100_000 } = {}) {
  return new BiologicalAcceptanceBoundary({
    organismId: 'stay-route-test',
    trustedTime: { async sample() { return { status: 'TRUSTED', trustedTimeUs: nowUs }; } },
    async resolveProducer(handle) {
      if (handle !== 'producer') return null;
      return {
        coreId, instanceId: `${coreId}-instance`, version: '1.0.0', authorityEpoch: epoch,
        authorityMode: AUTHORITY_MODE.SHADOW
      };
    },
    async resolveSignal() { return null; },
    async resolveStreamRange() { return []; },
    async allocateFabricSequence() { throw new Error('StateStore owns sequence'); }
  });
}

async function progress(store, b, streamId, finalizedThroughUs) {
  const prepared = await b.prepareStreamProgress({
    producerHandle: 'producer',
    progress: { producer_stream_id: streamId, finalized_through_us: finalizedThroughUs }
  });
  return store.commitBiologicalStreamProgress({
    prepared,
    finalizePrepared: value => b.finalizePreparedStreamProgress(value)
  });
}

function registerRoute(store, {
  routeId = 'route:pulse->interoception',
  streamId = 'pulse:beats',
  producerCoreId = 'pulse',
  epoch = 4,
  activeFromUs = 0,
  required = true
} = {}) {
  return store.registerBiologicalRoute({
    routeId,
    organismId: 'stay-route-test',
    consumerId: 'core:interoception',
    producerCoreId,
    producerStreamId: streamId,
    authorityEpoch: epoch,
    required,
    activeFromUs
  });
}

async function checkpoint(store, marker) {
  return store.commitCheckpoint({
    coreId: 'interoception', instanceId: 'intero-1', version: '1.0.0', authorityEpoch: 1,
    stateSchema: 1, state: { marker }, updateAuthority: true
  });
}

test('EF1-G ACTIVE required route is incomplete until explicit STREAM_PROGRESS exists', async t => {
  const { holder } = await makeStore(t, 'active-progress');
  registerRoute(holder.store, { activeFromUs: 100 });

  const before = holder.store.computeBiologicalSafeCompletenessFrontier({ consumerId: 'core:interoception' });
  assert.equal(before.frontierUs, null);
  assert.equal(before.blockers[0].reason, 'STREAM_PROGRESS_INCOMPLETE');

  const b = boundary();
  await progress(holder.store, b, 'pulse:beats', 500);
  const after = holder.store.computeBiologicalSafeCompletenessFrontier({ consumerId: 'core:interoception' });
  assert.equal(after.frontierUs, 500);
  assert.equal(after.activeRoutes.length, 1);
});

test('EF1-G safe completeness frontier is the minimum finalized frontier across ACTIVE required routes', async t => {
  const { holder } = await makeStore(t, 'minimum');
  registerRoute(holder.store, { routeId: 'route:pulse', streamId: 'pulse:beats', producerCoreId: 'pulse', epoch: 4 });
  registerRoute(holder.store, { routeId: 'route:clock', streamId: 'chrono:phase', producerCoreId: 'chronobiology', epoch: 8 });

  await progress(holder.store, boundary({ coreId: 'pulse', epoch: 4 }), 'pulse:beats', 900);
  await progress(holder.store, boundary({ coreId: 'chronobiology', epoch: 8 }), 'chrono:phase', 700);

  const safe = holder.store.computeBiologicalSafeCompletenessFrontier({ consumerId: 'core:interoception' });
  assert.equal(safe.frontierUs, 700);
  assert.equal(safe.activeRoutes.length, 2);
});

test('EF1-G DEGRADED route pins completeness at its exact barrier until consumer durably acknowledges unknown input', async t => {
  const { holder } = await makeStore(t, 'degraded');
  registerRoute(holder.store);
  await progress(holder.store, boundary(), 'pulse:beats', 900);

  holder.store.transitionBiologicalRoute({
    routeId: 'route:pulse->interoception', toState: 'DEGRADED', routeBarrierUs: 600,
    reason: 'pulse.transport.unavailable'
  });

  const pinned = holder.store.computeBiologicalSafeCompletenessFrontier({ consumerId: 'core:interoception' });
  assert.equal(pinned.frontierUs, 600);
  assert.equal(pinned.blockers[0].reason, 'ROUTE_BOUNDARY_UNACKNOWLEDGED');

  const cp = await checkpoint(holder.store, 'degraded-through-800');
  const route = holder.store.getBiologicalRoute('route:pulse->interoception');
  const ack = holder.store.acknowledgeBiologicalRouteBoundary({
    routeId: route.routeId,
    checkpointHash: cp.blobHash,
    transitionId: route.lastTransitionId,
    committedThroughUs: 800,
    semantics: 'UNKNOWN_INPUT'
  });
  assert.equal(ack.committedThroughUs, 800);

  const released = holder.store.computeBiologicalSafeCompletenessFrontier({ consumerId: 'core:interoception' });
  assert.equal(released.frontierUs, null);
  assert.equal(released.unconstrained, true);
  assert.equal(released.releasedRoutes[0].routeId, route.routeId);
});

test('EF1-G EVIDENCE_GAP carries an exact unavailable interval and cannot be acknowledged before the missing range', async t => {
  const { holder } = await makeStore(t, 'gap');
  registerRoute(holder.store);
  holder.store.transitionBiologicalRoute({
    routeId: 'route:pulse->interoception', toState: 'EVIDENCE_GAP', routeBarrierUs: 500,
    gapFromUs: 501, gapThroughUs: 750, reason: 'replay.exhausted'
  });
  const cp = await checkpoint(holder.store, 'gap');
  const route = holder.store.getBiologicalRoute('route:pulse->interoception');

  assert.throws(
    () => holder.store.acknowledgeBiologicalRouteBoundary({
      routeId: route.routeId, checkpointHash: cp.blobHash, transitionId: route.lastTransitionId,
      committedThroughUs: 749, semantics: 'UNKNOWN_INPUT'
    }),
    error => error?.code === 'BIOLOGICAL_ROUTE_BOUNDARY_ACK'
  );

  const ack = holder.store.acknowledgeBiologicalRouteBoundary({
    routeId: route.routeId, checkpointHash: cp.blobHash, transitionId: route.lastTransitionId,
    committedThroughUs: 750, semantics: 'UNKNOWN_INPUT'
  });
  assert.equal(ack.committedThroughUs, 750);
  assert.equal(route.gapFromUs, 501);
  assert.equal(route.gapThroughUs, 750);
});

test('EF1-G route cannot reactivate behind consumer-committed degraded history', async t => {
  const { holder } = await makeStore(t, 'reactivation');
  registerRoute(holder.store);
  holder.store.transitionBiologicalRoute({
    routeId: 'route:pulse->interoception', toState: 'DEGRADED', routeBarrierUs: 500
  });
  const cp = await checkpoint(holder.store, 'through-800');
  const route = holder.store.getBiologicalRoute('route:pulse->interoception');
  holder.store.acknowledgeBiologicalRouteBoundary({
    routeId: route.routeId, checkpointHash: cp.blobHash, transitionId: route.lastTransitionId,
    committedThroughUs: 800, semantics: 'UNKNOWN_INPUT'
  });

  assert.throws(
    () => holder.store.transitionBiologicalRoute({
      routeId: route.routeId, toState: 'ACTIVE', activeFromUs: 800, authorityEpoch: 5
    }),
    error => error?.code === 'BIOLOGICAL_ROUTE_REACTIVATION'
  );

  const active = holder.store.transitionBiologicalRoute({
    routeId: route.routeId, toState: 'ACTIVE', activeFromUs: 801, authorityEpoch: 5
  });
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.activeFromUs, 801);
  assert.equal(active.authorityEpoch, 5);
});

test('EF1-G CLOSED route requires a complete-end acknowledgement before RETIRED and can never reactivate', async t => {
  const { holder } = await makeStore(t, 'closed');
  registerRoute(holder.store);
  const closed = holder.store.transitionBiologicalRoute({
    routeId: 'route:pulse->interoception', toState: 'CLOSED', routeBarrierUs: 1000, reason: 'anatomy.closed'
  });

  assert.throws(
    () => holder.store.transitionBiologicalRoute({ routeId: closed.routeId, toState: 'RETIRED' }),
    error => error?.code === 'BIOLOGICAL_ROUTE_RETIREMENT'
  );

  const cp = await checkpoint(holder.store, 'closed-through-1000');
  holder.store.acknowledgeBiologicalRouteBoundary({
    routeId: closed.routeId, checkpointHash: cp.blobHash, transitionId: closed.lastTransitionId,
    committedThroughUs: 1000, semantics: 'COMPLETE_END'
  });
  const retired = holder.store.transitionBiologicalRoute({ routeId: closed.routeId, toState: 'RETIRED' });
  assert.equal(retired.state, 'RETIRED');
  assert.throws(
    () => holder.store.transitionBiologicalRoute({ routeId: closed.routeId, toState: 'ACTIVE', activeFromUs: 1001 }),
    error => error?.code === 'BIOLOGICAL_ROUTE_RETIRED'
  );
});

test('EF1-G route boundary acknowledgement must bind to an actual durable checkpoint of the consumer core', async t => {
  const { holder } = await makeStore(t, 'checkpoint');
  registerRoute(holder.store);
  const route = holder.store.transitionBiologicalRoute({
    routeId: 'route:pulse->interoception', toState: 'DEGRADED', routeBarrierUs: 100
  });
  assert.throws(
    () => holder.store.acknowledgeBiologicalRouteBoundary({
      routeId: route.routeId,
      checkpointHash: 'a'.repeat(64),
      transitionId: route.lastTransitionId,
      committedThroughUs: 100,
      semantics: 'UNKNOWN_INPUT'
    }),
    error => error?.code === 'BIOLOGICAL_ROUTE_BOUNDARY_CHECKPOINT'
  );
});

test('EF1-G route lifecycle and acknowledged unknown interval survive StateStore restart', async t => {
  const { dir, holder } = await makeStore(t, 'restart');
  registerRoute(holder.store);
  const route = holder.store.transitionBiologicalRoute({
    routeId: 'route:pulse->interoception', toState: 'EVIDENCE_GAP', routeBarrierUs: 300,
    gapFromUs: 301, gapThroughUs: 450
  });
  const cp = await checkpoint(holder.store, 'restart-gap');
  holder.store.acknowledgeBiologicalRouteBoundary({
    routeId: route.routeId, checkpointHash: cp.blobHash, transitionId: route.lastTransitionId,
    committedThroughUs: 450, semantics: 'UNKNOWN_INPUT'
  });

  holder.store.close();
  holder.store = new StateStore(dir);
  await holder.store.init();

  const recovered = holder.store.getBiologicalRoute(route.routeId);
  assert.equal(recovered.state, 'EVIDENCE_GAP');
  assert.equal(recovered.gapFromUs, 301);
  assert.equal(recovered.gapThroughUs, 450);
  assert.equal(recovered.boundaryAck.committedThroughUs, 450);
});

test('EF1-G tampered route head fails closed before completeness can be inferred', async t => {
  const { holder } = await makeStore(t, 'tamper');
  registerRoute(holder.store);
  holder.store.db.prepare(`UPDATE biological_routes SET route_barrier_us=123 WHERE route_id=?`).run('route:pulse->interoception');

  assert.throws(
    () => holder.store.getBiologicalRoute('route:pulse->interoception'),
    error => error?.code === 'BIOLOGICAL_ROUTE_CORRUPT'
  );
});

test('EF1-G silence or missing traffic never releases an ACTIVE required route without explicit progress', async t => {
  const { holder } = await makeStore(t, 'no-silence');
  registerRoute(holder.store, { activeFromUs: 1000 });
  const safe = holder.store.computeBiologicalSafeCompletenessFrontier({ consumerId: 'core:interoception' });
  assert.equal(safe.frontierUs, null);
  assert.equal(safe.blockers.length, 1);
  assert.equal(safe.blockers[0].reason, 'STREAM_PROGRESS_INCOMPLETE');
});
