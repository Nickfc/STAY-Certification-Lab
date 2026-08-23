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
  createChemicalState,
  QUANTUM_MS
} = require(
  '../cores/sntss/i3c/chemical-state'
);


const {
  receptorProfile
} = require(
  '../cores/sntss/i3c/receptor-profile'
);


const {
  adaptationProfile
} = require(
  '../cores/sntss/i3c/receptor-adaptation-profile'
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
  regulationProfile,
  validateRegulationProfile,
  hash
} = require(
  '../cores/sntss/i3d/regulation-profile'
);


const {
  evaluateRegulation,
  validateAdaptedProbe
} = require(
  '../cores/sntss/i3d/receptor-regulation'
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


function stimulatedProbe(
  family,
  concentration = 900000
) {
  const chemistry =
    createChemicalState(0);

  const neutralObservation =
    observeReceptors(
      chemistry
    );

  const adaptation =
    createReceptorAdaptationState(
      neutralObservation
    );

  chemistry.transmitters[
    family
  ].C = concentration;

  const stimulatedObservation =
    observeReceptors(
      chemistry
    );

  return buildProbe(
    adaptation,
    stimulatedObservation
  );
}


function adaptedDopamineProbe() {
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


  for (
    let index = 1;
    index <= 80;
    index += 1
  ) {
    chemistry =
      createChemicalState(
        index *
        QUANTUM_MS
      );

    chemistry.transmitters[
      'dopamine-like'
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
  }


  return {
    adaptation,
    chemistry,
    probe:
      buildProbe(
        adaptation,
        observation
      )
  };
}


test(
  'I3-D0 profile is frozen, bound and authority-free',
  () => {
    assert.equal(
      regulationProfile
        .formatVersion,
      1
    );

    assert.equal(
      regulationProfile.stage,
      'i3d0-regulatory-pressure'
    );

    assert.equal(
      regulationProfile
        .receptorProfileHash,
      receptorProfile.profileHash
    );

    assert.equal(
      regulationProfile
        .adaptationProfileHash,
      adaptationProfile.profileHash
    );

    assert.equal(
      regulationProfile
        .productionEligible,
      false
    );

    assert.equal(
      regulationProfile
        .outputAuthority,
      false
    );

    assert.equal(
      regulationProfile
        .behaviourAuthority,
      false
    );

    assert.equal(
      regulationProfile
        .persistentState,
      false
    );

    assert.equal(
      regulationProfile.edges.length,
      12
    );

    assert.doesNotThrow(
      () =>
        validateRegulationProfile(
          regulationProfile
        )
    );
  }
);


test(
  'I3-D0 rejects re-signed canonical regulation mutation',
  () => {
    const forged =
      clone(
        regulationProfile
      );

    const original =
      forged.edges[0];

    const {
      edgeHash: _oldEdgeHash,
      ...oldBody
    } = original;

    const changedBody = {
      ...oldBody,
      gain:
        oldBody.gain + 1
    };

    forged.edges[0] = {
      ...changedBody,
      edgeHash:
        hash(
          changedBody
        )
    };

    const {
      profileHash: _oldProfileHash,
      ...profileBody
    } = forged;

    forged.profileHash =
      hash(
        profileBody
      );

    assert.throws(
      () =>
        validateRegulationProfile(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3D_REGULATION_FROZEN'
    );
  }
);


test(
  'I3-D0 neutral tonic physiology creates zero regulatory pressure',
  () => {
    const result =
      evaluateRegulation(
        neutralProbe()
      );

    for (
      const receptor
      of Object.values(
        result.receptors
      )
    ) {
      assert.equal(
        receptor
          .activityMagnitude,
        0
      );

      assert.equal(
        receptor
          .availabilityReductionPressure,
        0
      );

      assert.equal(
        receptor
          .availabilityRecoveryPressure,
        0
      );

      assert.equal(
        receptor
          .crossSensitizationPressure,
        0
      );

      assert.equal(
        receptor
          .crossInhibitionPressure,
        0
      );

      assert.equal(
        receptor
          .netCrossModulation,
        0
      );

      assert.equal(
        receptor
          .netRegulatoryBias,
        0
      );
    }
  }
);


test(
  'I3-D0 dopamine sibling activity creates compensatory cross-sensitization pressure',
  () => {
    const result =
      evaluateRegulation(
        stimulatedProbe(
          'dopamine-like'
        )
      );

    const d2 =
      result.receptors[
        'dopamine-d2-like'
      ];

    assert.ok(
      d2.crossSensitizationPressure >
        0
    );

    assert.ok(
      d2.incoming.some(
        edge =>
          edge.sourceReceptorId ===
            'dopamine-d1-like' &&
          edge.polarity ===
            'sensitize' &&
          edge.contribution > 0
      )
    );
  }
);


test(
  'I3-D0 GABA-like activity creates inhibitory regulatory pressure on AMPA-like receptors',
  () => {
    const result =
      evaluateRegulation(
        stimulatedProbe(
          'gaba-like'
        )
      );

    const ampa =
      result.receptors[
        'glutamate-ampa-like'
      ];

    assert.ok(
      ampa.crossInhibitionPressure >
        0
    );

    assert.ok(
      ampa.netCrossModulation <
        0
    );
  }
);


test(
  'I3-D0 glutamate-like activity creates compensatory sensitization pressure on GABA-like receptors',
  () => {
    const result =
      evaluateRegulation(
        stimulatedProbe(
          'glutamate-like'
        )
      );

    const gabaA =
      result.receptors[
        'gaba-a-like'
      ];

    assert.ok(
      gabaA.crossSensitizationPressure >
        0
    );

    assert.ok(
      gabaA.netCrossModulation >
        0
    );
  }
);


test(
  'I3-D0 persistent receptor adaptation creates homeostatic reduction pressure',
  () => {
    const {
      probe
    } =
      adaptedDopamineProbe();

    const result =
      evaluateRegulation(
        probe
      );

    const d1 =
      result.receptors[
        'dopamine-d1-like'
      ];

    assert.ok(
      d1.exposure > 0
    );

    assert.ok(
      d1.desensitization > 0
    );

    assert.ok(
      d1.tolerance > 0
    );

    assert.ok(
      d1
        .availabilityReductionPressure >
        0
    );
  }
);


test(
  'I3-D0 adapted receptor memory can create recovery pressure when current stimulation becomes quiet',
  () => {
    const {
      adaptation
    } =
      adaptedDopamineProbe();

    const quietChemistry =
      createChemicalState(
        adaptation.modelClock
      );

    const quietProbe =
      buildProbe(
        adaptation,
        observeReceptors(
          quietChemistry
        )
      );

    const result =
      evaluateRegulation(
        quietProbe
      );

    const d1 =
      result.receptors[
        'dopamine-d1-like'
      ];

    assert.ok(
      d1.desensitization > 0
    );

    assert.ok(
      d1.tolerance > 0
    );

    assert.ok(
      d1
        .availabilityRecoveryPressure >
        0
    );
  }
);


test(
  'I3-D0 evaluation is deterministic and never mutates its adapted probe',
  () => {
    const probe =
      stimulatedProbe(
        'glutamate-like'
      );

    const before =
      stableStringify(
        probe
      );

    const first =
      evaluateRegulation(
        probe
      );

    const second =
      evaluateRegulation(
        probe
      );

    assert.equal(
      stableStringify(first),
      stableStringify(second)
    );

    assert.equal(
      stableStringify(probe),
      before
    );
  }
);


test(
  'I3-D0 rejects forged adapted receptor effects',
  () => {
    const probe =
      stimulatedProbe(
        'dopamine-like'
      );

    const forged =
      clone(
        probe
      );

    forged
      .receptors[
        'dopamine-d1-like'
      ]
      .adaptedEffect += 1;

    assert.throws(
      () =>
        validateAdaptedProbe(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3D_PROBE_INVALID'
    );
  }
);


test(
  'I3-D0 regulatory observations remain bounded and authority-free',
  () => {
    const result =
      evaluateRegulation(
        stimulatedProbe(
          'glutamate-like',
          fp.SCALE
        )
      );

    assert.equal(
      result.productionEligible,
      false
    );

    assert.equal(
      result.outputAuthority,
      false
    );

    assert.equal(
      result.behaviourAuthority,
      false
    );

    assert.equal(
      result.persistentState,
      false
    );

    assert.equal(
      result.authoritative,
      false
    );

    for (
      const receptor
      of Object.values(
        result.receptors
      )
    ) {
      for (
        const field
        of [
          'activityMagnitude',
          'availabilityReductionPressure',
          'availabilityRecoveryPressure',
          'crossSensitizationPressure',
          'crossInhibitionPressure'
        ]
      ) {
        assert.ok(
          receptor[field] >= 0 &&
          receptor[field] <=
            fp.SCALE
        );
      }

      assert.ok(
        receptor.netCrossModulation >=
          fp.SIGNED_MIN &&
        receptor.netCrossModulation <=
          fp.SIGNED_MAX
      );

      assert.ok(
        receptor.netRegulatoryBias >=
          fp.SIGNED_MIN &&
        receptor.netRegulatoryBias <=
          fp.SIGNED_MAX
      );

      assert.equal(
        receptor.authoritative,
        false
      );
    }
  }
);
