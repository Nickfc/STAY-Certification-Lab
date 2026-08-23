'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const fp =
  require('../cores/sntss/v0.1.0/fixed-point');

const kinetics =
  require('../cores/sntss/v0.1.0/kinetics');

const {
  QUANTUM_MS,
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES,
  ALL_FAMILIES,
  createChemicalState,
  validateChemicalState,
  normalizeDrives,
  advanceChemicalState
} = require(
  '../cores/sntss/i2/chemical-state'
);


test(
  'I2-A birth chemistry has the frozen transmitter inventory',
  () => {
    const state =
      createChemicalState();

    assert.deepEqual(
      Object.keys(
        state.transmitters
      ).sort(),
      [...ALL_FAMILIES].sort()
    );

    assert.equal(
      state.modelClock,
      0
    );

    assert.equal(
      state.remainderMs,
      0
    );

    validateChemicalState(state);
  }
);


test(
  'I2-A chemical time advances only on complete 250ms quanta',
  () => {
    const birth =
      createChemicalState();

    const first =
      advanceChemicalState(
        birth,
        QUANTUM_MS - 1
      );

    assert.equal(
      first.transition.steps,
      0
    );

    assert.equal(
      first.state.modelClock,
      0
    );

    assert.equal(
      first.state.remainderMs,
      QUANTUM_MS - 1
    );

    assert.deepEqual(
      first.state.transmitters,
      birth.transmitters
    );

    const second =
      advanceChemicalState(
        first.state,
        1,
        {
          'dopamine-like':
            fp.SCALE
        }
      );

    assert.equal(
      second.transition.steps,
      1
    );

    assert.equal(
      second.state.modelClock,
      QUANTUM_MS
    );

    assert.equal(
      second.state.remainderMs,
      0
    );
  }
);


test(
  'I2-A positive dopamine-like drive produces internal chemical dynamics',
  () => {
    const birth =
      createChemicalState();

    const before =
      birth.transmitters[
        'dopamine-like'
      ];

    const result =
      advanceChemicalState(
        birth,
        QUANTUM_MS,
        {
          'dopamine-like':
            fp.SCALE
        }
      );

    const after =
      result.state.transmitters[
        'dopamine-like'
      ];

    assert.ok(
      after.C > before.C
    );

    assert.ok(
      after.R < before.R ||
      result.transition
        .families[
          'dopamine-like'
        ]
        .release > 0
    );

    assert.ok(
      result.transition
        .families[
          'dopamine-like'
        ]
        .release > 0
    );
  }
);


test(
  'I2-A chemistry is deterministic for identical state time and drive',
  () => {
    const birth =
      createChemicalState();

    const drive = {
      'dopamine-like': 700000,
      'serotonin-like': 250000,
      'gaba-like': 150000,
      'noradrenaline-like': -100000
    };

    const left =
      advanceChemicalState(
        birth,
        2000,
        drive
      );

    const right =
      advanceChemicalState(
        birth,
        2000,
        drive
      );

    assert.deepEqual(
      left,
      right
    );
  }
);


test(
  'I2-A every chemical state variable remains canonically bounded',
  () => {
    let state =
      createChemicalState();

    for (
      let index = 0;
      index < 100;
      index += 1
    ) {
      state =
        advanceChemicalState(
          state,
          1000,
          {
            'dopamine-like':
              fp.SCALE,
            'glutamate-like':
              800000,
            'noradrenaline-like':
              600000,
            'gaba-like':
              250000,
            'serotonin-like':
              350000,
            'acetylcholine-like':
              500000
          }
        ).state;
    }

    for (
      const family
      of ACTIVE_FAMILIES
    ) {
      for (
        const key
        of kinetics.STATE_KEYS
      ) {
        const value =
          state.transmitters[
            family
          ][key];

        assert.ok(
          Number.isSafeInteger(value),
          `${family}.${key} integer`
        );

        assert.ok(
          value >= 0 &&
          value <= fp.SCALE,
          `${family}.${key} bounded`
        );
      }
    }
  }
);


test(
  'I2-A dormant families cannot receive chemical drive',
  () => {
    const birth =
      createChemicalState();

    for (
      const family
      of DORMANT_FAMILIES
    ) {
      assert.throws(
        () =>
          normalizeDrives({
            [family]: 1
          }),
        error =>
          error?.code ===
          'SNTSS_I2_DORMANT_DRIVE'
      );
    }

    const result =
      advanceChemicalState(
        birth,
        10000
      );

    for (
      const family
      of DORMANT_FAMILIES
    ) {
      for (
        const key
        of kinetics.STATE_KEYS
      ) {
        assert.equal(
          result.state
            .transmitters[
              family
            ][key],
          0
        );
      }
    }
  }
);


test(
  'I2-A drive surface rejects unknown families and noncanonical numbers',
  () => {
    assert.throws(
      () =>
        normalizeDrives({
          happiness: 500000
        }),
      error =>
        error?.code ===
        'SNTSS_I2_DRIVE_FAMILY'
    );

    assert.throws(
      () =>
        normalizeDrives({
          'dopamine-like':
            0.5
        }),
      error =>
        error?.code ===
        'SNTSS_I2_DRIVE_INVALID'
    );

    assert.throws(
      () =>
        normalizeDrives({
          'dopamine-like':
            fp.SCALE + 1
        }),
      error =>
        error?.code ===
        'SNTSS_I2_DRIVE_RANGE'
    );
  }
);


test(
  'I2-A advance has a hard bounded-work ceiling',
  () => {
    const state =
      createChemicalState();

    assert.throws(
      () =>
        advanceChemicalState(
          state,
          QUANTUM_MS * 4097
        ),
      error =>
        error?.code ===
        'SNTSS_I2_ADVANCE_BOUNDED'
    );
  }
);
