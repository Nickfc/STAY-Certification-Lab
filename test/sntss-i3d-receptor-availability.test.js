'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');


const {
  stableStringify
} = require(
  '../runtime/kernel/canonical-json'
);


const fp =
  require(
    '../cores/sntss/i3c/fixed-point'
  );


const {
  QUANTUM_MS,
  createChemicalState
} = require(
  '../cores/sntss/i3c/chemical-state'
);


const {
  observeReceptors
} = require(
  '../cores/sntss/i3c/receptor-model'
);


const {
  createReceptorAdaptationState,
  advanceReceptorAdaptation,
  buildProbe
} = require(
  '../cores/sntss/i3c/receptor-adaptation'
);


const {
  availabilityProfile,
  validateAvailabilityProfile,
  hash
} = require(
  '../cores/sntss/i3d/receptor-availability-profile'
);


const {
  createReceptorAvailabilityState,
  advanceReceptorAvailability,
  buildRegulatedProbe,
  validateState
} = require(
  '../cores/sntss/i3d/receptor-availability'
);


function clone(value) {
  return JSON.parse(
    JSON.stringify(value)
  );
}


function neutralProbe(
  modelClock = 0
) {
  const chemistry =
    createChemicalState(
      modelClock
    );

  const observation =
    observeReceptors(
      chemistry
    );

  const adaptation =
    createReceptorAdaptationState(
      observation
    );

  return buildProbe(
    adaptation,
    observation
  );
}


function runGabaHistory(
  steps = 240
) {
  let chemistry =
    createChemicalState(0);

  let observation =
    observeReceptors(
      chemistry
    );

  let adaptation =
    createReceptorAdaptationState(
      observation
    );

  let adaptedProbe =
    buildProbe(
      adaptation,
      observation
    );

  let availability =
    createReceptorAvailabilityState(
      adaptedProbe
    );

  let lastPressure = null;


  for (
    let index = 1;
    index <= steps;
    index += 1
  ) {
    chemistry =
      createChemicalState(
        index *
        QUANTUM_MS
      );

    chemistry.transmitters[
      'gaba-like'
    ].C = 900000;

    observation =
      observeReceptors(
        chemistry
      );

    adaptation =
      advanceReceptorAdaptation(
        adaptation,
        observation
      ).state;

    adaptedProbe =
      buildProbe(
        adaptation,
        observation
      );

    const advanced =
      advanceReceptorAvailability(
        availability,
        adaptedProbe
      );

    availability =
      advanced.state;

    lastPressure =
      advanced.pressure;
  }


  return {
    chemistry,
    observation,
    adaptation,
    adaptedProbe,
    availability,
    lastPressure
  };
}


test(
  'I3-D1 availability profile is frozen, bounded and authority-free',
  () => {
    assert.equal(
      availabilityProfile.stage,
      'i3d1-receptor-availability'
    );

    assert.equal(
      availabilityProfile.quantumMs,
      QUANTUM_MS
    );

    assert.equal(
      availabilityProfile
        .initialAvailability,
      fp.SCALE
    );

    assert.equal(
      availabilityProfile
        .maximumAvailability,
      fp.SCALE
    );

    assert.ok(
      availabilityProfile
        .minimumAvailability > 0
    );

    assert.equal(
      availabilityProfile
        .productionEligible,
      false
    );

    assert.equal(
      availabilityProfile
        .outputAuthority,
      false
    );

    assert.equal(
      availabilityProfile
        .behaviourAuthority,
      false
    );

    assert.equal(
      availabilityProfile
        .persistentState,
      true
    );

    assert.doesNotThrow(
      () =>
        validateAvailabilityProfile(
          availabilityProfile
        )
    );
  }
);


test(
  'I3-D1 rejects re-signed availability physiology mutation',
  () => {
    const forged =
      clone(
        availabilityProfile
      );

    forged.downregulationRate +=
      1;

    const {
      profileHash: _oldHash,
      ...body
    } = forged;

    forged.profileHash =
      hash(body);

    assert.throws(
      () =>
        validateAvailabilityProfile(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3D_AVAILABILITY_FROZEN'
    );
  }
);


test(
  'I3-D1 receptor availability starts at complete synthetic birth baseline',
  () => {
    const state =
      createReceptorAvailabilityState(
        neutralProbe()
      );

    for (
      const receptor
      of Object.values(
        state.receptors
      )
    ) {
      assert.equal(
        receptor.availability,
        fp.SCALE
      );
    }
  }
);


test(
  'I3-D1 sustained GABA-like history down-regulates AMPA-like receptor availability',
  () => {
    const result =
      runGabaHistory();

    const ampa =
      result.availability
        .receptors[
          'glutamate-ampa-like'
        ].availability;

    assert.ok(
      result.lastPressure
        .receptors[
          'glutamate-ampa-like'
        ]
        .crossInhibitionPressure >
        0
    );

    assert.ok(
      result.lastPressure
        .receptors[
          'glutamate-ampa-like'
        ]
        .netRegulatoryBias <
        0
    );

    assert.ok(
      ampa <
        availabilityProfile
          .initialAvailability
    );

    assert.ok(
      ampa >=
        availabilityProfile
          .minimumAvailability
    );
  }
);


test(
  'I3-D1 same current glutamate signal produces different response after receptor history',
  () => {
    const history =
      runGabaHistory();

    const clock =
      history.availability
        .modelClock;

    const chemistry =
      createChemicalState(
        clock
      );

    chemistry.transmitters[
      'glutamate-like'
    ].C = 900000;

    const observation =
      observeReceptors(
        chemistry
      );

    /*
     * Keep the actual receptor-adaptation memory
     * created by the GABA history. Only current
     * chemistry changes here.
     */
    const adaptedProbe =
      buildProbe(
        history.adaptation,
        observation
      );

    const baselineAvailability =
      createReceptorAvailabilityState(
        adaptedProbe
      );

    const baseline =
      buildRegulatedProbe(
        baselineAvailability,
        adaptedProbe
      );

    const historical =
      buildRegulatedProbe(
        history.availability,
        adaptedProbe
      );

    const baselineEffect =
      Math.abs(
        baseline
          .receptors[
            'glutamate-ampa-like'
          ].regulatedEffect
      );

    const historicalEffect =
      Math.abs(
        historical
          .receptors[
            'glutamate-ampa-like'
          ].regulatedEffect
      );

    assert.ok(
      adaptedProbe
        .receptors[
          'glutamate-ampa-like'
        ].adaptedEffect !== 0
    );

    assert.ok(
      history.availability
        .receptors[
          'glutamate-ampa-like'
        ].availability <
        fp.SCALE
    );

    assert.ok(
      historicalEffect <
        baselineEffect
    );
  }
);


test(
  'I3-D1 availability advances only one exact trusted biological quantum',
  () => {
    const initial =
      createReceptorAvailabilityState(
        neutralProbe(0)
      );

    assert.throws(
      () =>
        advanceReceptorAvailability(
          initial,
          neutralProbe(
            QUANTUM_MS * 2
          )
        ),

      error =>
        error?.code ===
        'SNTSS_I3D_AVAILABILITY_TIME_STEP'
    );

    assert.throws(
      () =>
        advanceReceptorAvailability(
          initial,
          neutralProbe(0)
        ),

      error =>
        error?.code ===
        'SNTSS_I3D_AVAILABILITY_TIME_STEP'
    );
  }
);


test(
  'I3-D1 availability evolution is deterministic and does not mutate inputs',
  () => {
    const state =
      createReceptorAvailabilityState(
        neutralProbe(0)
      );

    const probe =
      neutralProbe(
        QUANTUM_MS
      );

    const stateBefore =
      stableStringify(state);

    const probeBefore =
      stableStringify(probe);

    const first =
      advanceReceptorAvailability(
        state,
        probe
      );

    const second =
      advanceReceptorAvailability(
        state,
        probe
      );

    assert.equal(
      stableStringify(
        first
      ),
      stableStringify(
        second
      )
    );

    assert.equal(
      stableStringify(state),
      stateBefore
    );

    assert.equal(
      stableStringify(probe),
      probeBefore
    );
  }
);


test(
  'I3-D1 forged persisted availability outside frozen range fails closed',
  () => {
    const state =
      createReceptorAvailabilityState(
        neutralProbe()
      );

    state.receptors[
      'dopamine-d1-like'
    ].availability =
      availabilityProfile
        .minimumAvailability -
      1;

    assert.throws(
      () =>
        validateState(state),

      error =>
        error?.code ===
        'SNTSS_I3D_AVAILABILITY_BOUNDS'
    );
  }
);


test(
  'I3-D1 regulated receptor probe remains bounded and authority-free',
  () => {
    const history =
      runGabaHistory();

    const probe =
      buildRegulatedProbe(
        history.availability,
        history.adaptedProbe
      );

    assert.equal(
      probe.productionEligible,
      false
    );

    assert.equal(
      probe.outputAuthority,
      false
    );

    assert.equal(
      probe.behaviourAuthority,
      false
    );

    assert.equal(
      probe.authoritative,
      false
    );

    for (
      const receptor
      of Object.values(
        probe.receptors
      )
    ) {
      assert.ok(
        receptor.availability >=
          availabilityProfile
            .minimumAvailability
      );

      assert.ok(
        receptor.availability <=
          availabilityProfile
            .maximumAvailability
      );

      assert.ok(
        receptor.regulatedSensitivity >=
          0 &&
        receptor.regulatedSensitivity <=
          fp.SCALE
      );

      assert.ok(
        receptor.regulatedEffect >=
          fp.SIGNED_MIN &&
        receptor.regulatedEffect <=
          fp.SIGNED_MAX
      );

      assert.equal(
        receptor.authoritative,
        false
      );
    }

    for (
      const family
      of Object.values(
        probe.families
      )
    ) {
      assert.ok(
        family.combinedRegulatedEffect >=
          fp.SIGNED_MIN &&
        family.combinedRegulatedEffect <=
          fp.SIGNED_MAX
      );

      assert.equal(
        family.authoritative,
        false
      );
    }
  }
);
