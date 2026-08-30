'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const roadmap = require('../runtime/p1-r0/lab-roadmap.json');
const { projectObservationChips } = require('../runtime/ui/chip-projection');

test('P1-ROADMAP-01 laboratory metadata is non-live LAB BUILD in fixed physiology order', () => {
  const projection = projectObservationChips({ roadmap });
  assert.deepEqual(
    projection.roadmap.map(entry => [entry.coreId, entry.stage, entry.nonLive, entry.observationOnly]),
    [
      ['metab', 'LAB BUILD', true, true],
      ['homeos', 'LAB BUILD', true, true],
      ['intero', 'LAB BUILD', true, true]
    ]
  );
  assert.deepEqual(projection.mutationEndpoints, []);
  assert.deepEqual(projection.lifecycle, []);
});

test('P1-ROADMAP-02 accepted residency replaces only its own roadmap label with a persistent lifecycle chip', () => {
  const projection = projectObservationChips({
    roadmap,
    residents: [{
      residencyId: 'resident:metab',
      coreId: 'metab',
      label: 'METAB',
      version: '0.1.0-p1r0-lab',
      status: 'RUNNING',
      lifecycle: 'RUNNING',
      mode: 'SHADOW',
      running: true,
      healthOk: true,
      checkpointGeneration: 4,
      handledEvents: 2,
      observedOutputs: 4
    }]
  });
  assert.deepEqual(projection.lifecycle.map(entry => [entry.coreId, entry.state]), [['metab', 'SHADOW']]);
  assert.deepEqual(projection.roadmap.map(entry => entry.coreId), ['homeos', 'intero']);
  assert.equal(projection.lifecycle[0].observationOnly, true);
});
