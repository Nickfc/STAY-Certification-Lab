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
    '../cores/sntss/i2/fixed-point'
  );

const {
  createChemicalState
} = require(
  '../cores/sntss/i2/chemical-state'
);

const {
  receptorProfile
} = require(
  '../cores/sntss/i3/receptor-profile'
);

const {
  observeReceptors
} = require(
  '../cores/sntss/i3/receptor-model'
);

const {
  adaptationProfile,
  validateAdaptationProfile,
  hash
} = require(
  '../cores/sntss/i3/receptor-adaptation-profile'
);

const {
  createReceptorAdaptationState,
  advanceReceptorAdaptation,
  buildProbe,
  validateState
} = require(
  '../cores/sntss/i3/receptor-adaptation'
);


const Q =
  adaptationProfile.quantumMs;


function chemical(
  modelClock = 0
) {
  const state =
    createChemicalState(
      modelClock
    );

  for (
    const transmitter
    of Object.values(
      state.transmitters
    )
  ) {
    transmitter.C =
      transmitter.B;
  }

  return state;
}


function observationAt(
  modelClock,
  family = null,
  concentration = null
) {
  const state =
    chemical(
      modelClock
    );

  if (
    family !== null
  ) {
    state.transmitters[
      family
    ].C =
      concentration;
  }

  return observeReceptors(
    state
  );
}


function advanceMany(
  initialState,
  count,
  family,
  concentration
) {
  let state =
    initialState;

  let probe =
    null;

  for (
    let index = 0;
    index < count;
    index += 1
  ) {
    const nextClock =
      state.modelClock + Q;

    const result =
      advanceReceptorAdaptation(
        state,

        observationAt(
          nextClock,
          family,
          concentration
        )
      );

    state =
      result.state;

    probe =
      result.probe;
  }

  return {
    state,
    probe
  };
}


test(
  'I3-B adaptation profile is bound to frozen I3-A receptors and remains observation-only',
  () => {
    validateAdaptationProfile(
      adaptationProfile
    );

    assert.equal(
      adaptationProfile
        .receptorProfileHash,
      receptorProfile.profileHash
    );

    assert.equal(
      adaptationProfile
        .productionEligible,
      false
    );

    assert.equal(
      adaptationProfile
        .outputAuthority,
      false
    );

    assert.equal(
      Object.keys(
        adaptationProfile.receptors
      ).length,
      receptorProfile.receptors.length
    );
  }
);


test(
  'I3-B newborn receptor memory is zero and sensitivity is complete',
  () => {
    const observation =
      observationAt(0);

    const state =
      createReceptorAdaptationState(
        observation
      );

    const probe =
      buildProbe(
        state,
        observation
      );

    validateState(state);

    for (
      const receptor
      of Object.values(
        probe.receptors
      )
    ) {
      assert.equal(
        receptor.exposure,
        0
      );

      assert.equal(
        receptor.desensitization,
        0
      );

      assert.equal(
        receptor.tolerance,
        0
      );

      assert.equal(
        receptor.sensitivity,
        fp.SCALE
      );

      assert.equal(
        receptor.authoritative,
        false
      );
    }
  }
);


test(
  'I3-B tonic chemistry does not manufacture receptor tolerance',
  () => {
    let state =
      createReceptorAdaptationState(
        observationAt(0)
      );

    for (
      let index = 0;
      index < 100;
      index += 1
    ) {
      const result =
        advanceReceptorAdaptation(
          state,

          observationAt(
            state.modelClock + Q
          )
        );

      state =
        result.state;
    }

    for (
      const receptor
      of Object.values(
        state.receptors
      )
    ) {
      assert.equal(
        receptor.exposure,
        0
      );

      assert.equal(
        receptor.desensitization,
        0
      );

      assert.equal(
        receptor.tolerance,
        0
      );
    }
  }
);


test(
  'I3-B sustained dopamine-like stimulation creates exposure, desensitization and slower tolerance',
  () => {
    const initialObservation =
      observationAt(0);

    const initialState =
      createReceptorAdaptationState(
        initialObservation
      );

    const result =
      advanceMany(
        initialState,
        400,
        'dopamine-like',
        900000
      );

    const memory =
      result.state
        .receptors[
          'dopamine-d1-like'
        ];

    const receptor =
      result.probe
        .receptors[
          'dopamine-d1-like'
        ];

    assert.ok(
      memory.exposure > 0
    );

    assert.ok(
      memory.desensitization > 0
    );

    assert.ok(
      memory.tolerance > 0
    );

    assert.ok(
      memory.desensitization >
        memory.tolerance
    );

    assert.ok(
      receptor.sensitivity <
        fp.SCALE
    );

    assert.ok(
      Math.abs(
        receptor.adaptedEffect
      ) <
      Math.abs(
        receptor.rawEffect
      )
    );
  }
);


test(
  'I3-B inhibitory-efficacy receptors also desensitize by occupancy rather than effect sign',
  () => {
    let state =
      createReceptorAdaptationState(
        observationAt(0)
      );

    const result =
      advanceMany(
        state,
        300,
        'dopamine-like',
        900000
      );

    const d2 =
      result.probe
        .receptors[
          'dopamine-d2-like'
        ];

    assert.ok(
      d2.rawEffect < 0
    );

    assert.ok(
      d2.exposure > 0
    );

    assert.ok(
      d2.sensitivity <
        fp.SCALE
    );

    assert.ok(
      Math.abs(
        d2.adaptedEffect
      ) <
      Math.abs(
        d2.rawEffect
      )
    );
  }
);


test(
  'I3-B below-tonic chemistry causes recovery rather than negative tolerance',
  () => {
    let state =
      createReceptorAdaptationState(
        observationAt(0)
      );

    state =
      advanceMany(
        state,
        250,
        'dopamine-like',
        900000
      ).state;

    const before =
      state.receptors[
        'dopamine-d1-like'
      ];

    const beforeProbe =
      buildProbe(
        state,

        observationAt(
          state.modelClock,
          'dopamine-like',
          900000
        )
      );

    const sensitivityBefore =
      beforeProbe
        .receptors[
          'dopamine-d1-like'
        ].sensitivity;


    const recovered =
      advanceMany(
        state,
        600,
        'dopamine-like',
        0
      );


    const after =
      recovered.state
        .receptors[
          'dopamine-d1-like'
        ];

    const sensitivityAfter =
      recovered.probe
        .receptors[
          'dopamine-d1-like'
        ].sensitivity;


    assert.ok(
      after.exposure <
        before.exposure
    );

    assert.ok(
      after.desensitization <
        before.desensitization
    );

    assert.ok(
      after.tolerance <
        before.tolerance
    );

    assert.ok(
      sensitivityAfter >
        sensitivityBefore
    );

    assert.ok(
      after.exposure >= 0 &&
      after.desensitization >= 0 &&
      after.tolerance >= 0
    );
  }
);


test(
  'I3-B adaptation cannot advance without exactly one trusted chemical quantum',
  () => {
    const initial =
      createReceptorAdaptationState(
        observationAt(0)
      );

    assert.throws(
      () =>
        advanceReceptorAdaptation(
          initial,
          observationAt(0)
        ),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_TIME_STEP'
    );

    assert.throws(
      () =>
        advanceReceptorAdaptation(
          initial,
          observationAt(
            Q * 2
          )
        ),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_TIME_STEP'
    );

    assert.throws(
      () =>
        advanceReceptorAdaptation(
          {
            ...initial,
            modelClock: Q
          },
          observationAt(0)
        ),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_TIME_STEP'
    );
  }
);


test(
  'I3-B state receptor inventory cannot lose or gain memory slots',
  () => {
    const state =
      createReceptorAdaptationState(
        observationAt(0)
      );

    delete state.receptors[
      'gaba-a-like'
    ];

    assert.throws(
      () =>
        validateState(state),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_INVENTORY'
    );
  }
);


test(
  'I3-B adaptation is deterministic and bounded under prolonged exposure',
  () => {
    const initial =
      createReceptorAdaptationState(
        observationAt(0)
      );

    const first =
      advanceMany(
        initial,
        1000,
        'glutamate-like',
        fp.SCALE
      );

    const second =
      advanceMany(
        initial,
        1000,
        'glutamate-like',
        fp.SCALE
      );

    assert.equal(
      stableStringify(
        first
      ),
      stableStringify(
        second
      )
    );

    for (
      const receptor
      of Object.values(
        first.probe.receptors
      )
    ) {
      assert.ok(
        receptor.exposure >= 0 &&
        receptor.exposure <=
          fp.SCALE
      );

      assert.ok(
        receptor.desensitization >= 0 &&
        receptor.desensitization <=
          fp.SCALE
      );

      assert.ok(
        receptor.tolerance >= 0 &&
        receptor.tolerance <=
          fp.SCALE
      );

      const floor =
        adaptationProfile
          .receptors[
            receptor.receptorId
          ]
          .minimumSensitivity;

      assert.ok(
        receptor.sensitivity >=
          floor
      );

      assert.ok(
        receptor.sensitivity <=
          fp.SCALE
      );

      assert.equal(
        receptor.authoritative,
        false
      );
    }

    assert.equal(
      first.probe.outputAuthority,
      false
    );

    assert.equal(
      first.probe.productionEligible,
      false
    );
  }
);


test(
  'I3-B adaptation profile binding fails closed when receptor observation claims another profile',
  () => {
    const initial =
      createReceptorAdaptationState(
        observationAt(0)
      );

    const forged =
      observationAt(Q);

    forged.receptorProfileHash =
      'sha256:' +
      '0'.repeat(64);

    assert.throws(
      () =>
        advanceReceptorAdaptation(
          initial,
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3_OBSERVATION_BINDING'
    );
  }
);


function cloneAdaptationProfile() {
  return JSON.parse(
    JSON.stringify(
      adaptationProfile
    )
  );
}


function resignAdaptationProfile(
  profile
) {
  const {
    profileHash:
      ignoredProfileHash,
    ...body
  } = profile;

  profile.profileHash =
    hash(body);

  return profile;
}


test(
  'I3-B recomputed hash cannot authorize altered adaptation physiology',
  () => {
    const forged =
      cloneAdaptationProfile();

    forged.receptors[
      'dopamine-d1-like'
    ].maxTolerance += 1;

    resignAdaptationProfile(
      forged
    );

    assert.throws(
      () =>
        validateAdaptationProfile(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_FROZEN'
    );
  }
);


test(
  'I3-B forged desensitization above frozen maximum fails closed',
  () => {
    const state =
      createReceptorAdaptationState(
        observationAt(0)
      );

    const receptorId =
      'dopamine-d1-like';

    state.receptors[
      receptorId
    ].desensitization =
      adaptationProfile
        .receptors[
          receptorId
        ]
        .maxDesensitization + 1;

    assert.throws(
      () =>
        validateState(state),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_STATE_BOUNDS'
    );
  }
);


test(
  'I3-B forged tolerance above frozen maximum fails closed',
  () => {
    const state =
      createReceptorAdaptationState(
        observationAt(0)
      );

    const receptorId =
      'serotonin-5ht2-like';

    state.receptors[
      receptorId
    ].tolerance =
      adaptationProfile
        .receptors[
          receptorId
        ]
        .maxTolerance + 1;

    assert.throws(
      () =>
        validateState(state),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_STATE_BOUNDS'
    );
  }
);


test(
  'I3-B legal maximum adaptation can never kill a receptor completely',
  () => {
    const state =
      createReceptorAdaptationState(
        observationAt(0)
      );

    for (
      const receptorId
      of Object.keys(
        state.receptors
      )
    ) {
      const parameters =
        adaptationProfile
          .receptors[
            receptorId
          ];

      state.receptors[
        receptorId
      ].desensitization =
        parameters.maxDesensitization;

      state.receptors[
        receptorId
      ].tolerance =
        parameters.maxTolerance;
    }

    validateState(state);

    const probe =
      buildProbe(
        state,
        observationAt(0)
      );

    for (
      const receptor
      of Object.values(
        probe.receptors
      )
    ) {
      const floor =
        adaptationProfile
          .receptors[
            receptor.receptorId
          ]
          .minimumSensitivity;

      assert.ok(
        receptor.sensitivity >=
          floor
      );

      assert.ok(
        receptor.sensitivity > 0
      );

      assert.equal(
        receptor.authoritative,
        false
      );
    }
  }
);


test(
  'I3-B rapid alternating exposure remains deterministic bounded and reversible',
  () => {
    function run() {
      let state =
        createReceptorAdaptationState(
          observationAt(0)
        );

      let probe = null;

      for (
        let index = 0;
        index < 1200;
        index += 1
      ) {
        const concentration =
          index % 2 === 0
            ? fp.SCALE
            : 0;

        const result =
          advanceReceptorAdaptation(
            state,

            observationAt(
              state.modelClock + Q,
              'dopamine-like',
              concentration
            )
          );

        state =
          result.state;

        probe =
          result.probe;
      }

      return {
        state,
        probe
      };
    }

    const first =
      run();

    const second =
      run();

    assert.equal(
      stableStringify(first),
      stableStringify(second)
    );

    for (
      const receptor
      of Object.values(
        first.probe.receptors
      )
    ) {
      const parameters =
        adaptationProfile
          .receptors[
            receptor.receptorId
          ];

      assert.ok(
        receptor.exposure >= 0 &&
        receptor.exposure <=
          fp.SCALE
      );

      assert.ok(
        receptor.desensitization >= 0 &&
        receptor.desensitization <=
          parameters.maxDesensitization
      );

      assert.ok(
        receptor.tolerance >= 0 &&
        receptor.tolerance <=
          parameters.maxTolerance
      );

      assert.ok(
        receptor.sensitivity >=
          parameters.minimumSensitivity
      );

      assert.ok(
        receptor.sensitivity > 0
      );
    }
  }
);


test(
  'I3-B dopamine exposure cannot manufacture adaptation memory in another transmitter family',
  () => {
    let state =
      createReceptorAdaptationState(
        observationAt(0)
      );

    const result =
      advanceMany(
        state,
        500,
        'dopamine-like',
        fp.SCALE
      );

    for (
      const receptorId
      of [
        'gaba-a-like',
        'gaba-b-like',
        'serotonin-5ht1-like',
        'serotonin-5ht2-like'
      ]
    ) {
      const memory =
        result.state.receptors[
          receptorId
        ];

      assert.equal(
        memory.exposure,
        0,
        receptorId
      );

      assert.equal(
        memory.desensitization,
        0,
        receptorId
      );

      assert.equal(
        memory.tolerance,
        0,
        receptorId
      );
    }
  }
);


test(
  'I3-B fake clock jumps and rewinds cannot bypass one-quantum progression',
  () => {
    const initial =
      createReceptorAdaptationState(
        observationAt(1000)
      );

    const jump =
      observationAt(
        1000 + Q * 100,
        'dopamine-like',
        fp.SCALE
      );

    assert.throws(
      () =>
        advanceReceptorAdaptation(
          initial,
          jump
        ),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_TIME_STEP'
    );


    const rewind =
      observationAt(
        1000 - Q,
        'dopamine-like',
        fp.SCALE
      );

    assert.throws(
      () =>
        advanceReceptorAdaptation(
          initial,
          rewind
        ),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_TIME_STEP'
    );
  }
);
