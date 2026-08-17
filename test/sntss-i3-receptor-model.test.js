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
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES
} = require(
  '../cores/sntss/i2/species-profile'
);

const {
  receptorProfile,
  validateReceptorProfile,
  receptorsForFamily,
  hash
} = require(
  '../cores/sntss/i3/receptor-profile'
);

const {
  observeReceptors
} = require(
  '../cores/sntss/i3/receptor-model'
);


function baselineState() {
  const state =
    createChemicalState();

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


test(
  'I3-A receptor profile is immutable, hash-valid and observation-only',
  () => {
    validateReceptorProfile(
      receptorProfile
    );

    assert.equal(
      Object.isFrozen(
        receptorProfile
      ),
      true
    );

    assert.equal(
      receptorProfile
        .productionEligible,
      false
    );

    assert.equal(
      receptorProfile
        .outputAuthority,
      false
    );

    for (
      const receptor
      of receptorProfile.receptors
    ) {
      assert.equal(
        receptor.mode,
        'observation-only'
      );

      assert.equal(
        receptor
          .productionOutputEnabled,
        false
      );

      assert.equal(
        Object.isFrozen(
          receptor
        ),
        true
      );
    }
  }
);


test(
  'I3-A every active transmitter family has receptors and dormant families have none',
  () => {
    for (
      const family
      of ACTIVE_FAMILIES
    ) {
      assert.ok(
        receptorsForFamily(
          family
        ).length >= 1,
        family
      );
    }

    for (
      const family
      of DORMANT_FAMILIES
    ) {
      assert.equal(
        receptorsForFamily(
          family
        ).length,
        0,
        family
      );
    }
  }
);


test(
  'I3-A tonic chemistry produces zero relative receptor effect',
  () => {
    const observation =
      observeReceptors(
        baselineState()
      );

    assert.equal(
      observation.outputAuthority,
      false
    );

    assert.equal(
      observation.productionEligible,
      false
    );

    for (
      const receptor
      of Object.values(
        observation.receptors
      )
    ) {
      assert.equal(
        receptor.deltaOccupancy,
        0
      );

      assert.equal(
        receptor.effect,
        0
      );

      assert.equal(
        receptor.authoritative,
        false
      );
    }
  }
);


test(
  'I3-A receptor occupancy rises monotonically and remains saturated within fixed-point bounds',
  () => {
    const low =
      baselineState();

    const high =
      baselineState();

    low.transmitters[
      'dopamine-like'
    ].C = 100000;

    high.transmitters[
      'dopamine-like'
    ].C = 900000;

    const lowObservation =
      observeReceptors(low);

    const highObservation =
      observeReceptors(high);

    const lowD1 =
      lowObservation
        .receptors[
          'dopamine-d1-like'
        ];

    const highD1 =
      highObservation
        .receptors[
          'dopamine-d1-like'
        ];

    assert.ok(
      highD1.occupancy >
        lowD1.occupancy
    );

    assert.ok(
      lowD1.occupancy >= 0
    );

    assert.ok(
      highD1.occupancy <=
        fp.SCALE
    );
  }
);


test(
  'I3-A synthetic affinity differentiates D2-like from D1-like occupancy',
  () => {
    const state =
      baselineState();

    state.transmitters[
      'dopamine-like'
    ].C = 350000;

    const observation =
      observeReceptors(state);

    const d1 =
      observation.receptors[
        'dopamine-d1-like'
      ];

    const d2 =
      observation.receptors[
        'dopamine-d2-like'
      ];

    assert.ok(
      d2.occupancy >
        d1.occupancy
    );
  }
);


test(
  'I3-A signed receptor efficacy can diverge without creating output authority',
  () => {
    const state =
      baselineState();

    const dopamine =
      state.transmitters[
        'dopamine-like'
      ];

    dopamine.C =
      Math.min(
        fp.SCALE,
        dopamine.B +
          400000
      );

    const observation =
      observeReceptors(state);

    const d1 =
      observation.receptors[
        'dopamine-d1-like'
      ];

    const d2 =
      observation.receptors[
        'dopamine-d2-like'
      ];

    assert.ok(
      d1.effect > 0
    );

    assert.ok(
      d2.effect < 0
    );

    assert.equal(
      observation.outputAuthority,
      false
    );

    assert.equal(
      d1.authoritative,
      false
    );

    assert.equal(
      d2.authoritative,
      false
    );
  }
);


test(
  'I3-A changing one transmitter family cannot mutate another family receptor observation',
  () => {
    const control =
      baselineState();

    const changed =
      baselineState();

    changed.transmitters[
      'serotonin-like'
    ].C = 850000;

    const before =
      observeReceptors(control);

    const after =
      observeReceptors(changed);

    for (
      const [
        receptorId,
        receptor
      ]
      of Object.entries(
        before.receptors
      )
    ) {
      if (
        receptor.family ===
          'serotonin-like'
      ) {
        continue;
      }

      assert.deepEqual(
        after.receptors[
          receptorId
        ],
        receptor,
        receptorId
      );
    }
  }
);


test(
  'I3-A dormant families remain receptor-empty and zero-effect',
  () => {
    const observation =
      observeReceptors(
        baselineState()
      );

    for (
      const family
      of DORMANT_FAMILIES
    ) {
      assert.deepEqual(
        observation
          .families[family]
          .receptorIds,
        []
      );

      assert.equal(
        observation
          .families[family]
          .combinedEffect,
        0
      );

      assert.equal(
        observation
          .families[family]
          .dormant,
        true
      );
    }
  }
);


test(
  'I3-A receptor observation is deterministic and all effects remain bounded',
  () => {
    const state =
      baselineState();

    state.transmitters[
      'dopamine-like'
    ].C = 800000;

    state.transmitters[
      'gaba-like'
    ].C = 700000;

    state.transmitters[
      'glutamate-like'
    ].C = 600000;

    const first =
      observeReceptors(state);

    const second =
      observeReceptors(state);

    assert.equal(
      stableStringify(first),
      stableStringify(second)
    );

    for (
      const receptor
      of Object.values(
        first.receptors
      )
    ) {
      assert.ok(
        receptor.occupancy >= 0 &&
        receptor.occupancy <=
          fp.SCALE
      );

      assert.ok(
        receptor.deltaOccupancy >=
          fp.SIGNED_MIN &&
        receptor.deltaOccupancy <=
          fp.SIGNED_MAX
      );

      assert.ok(
        receptor.effect >=
          fp.SIGNED_MIN &&
        receptor.effect <=
          fp.SIGNED_MAX
      );
    }

    for (
      const family
      of Object.values(
        first.families
      )
    ) {
      assert.ok(
        family.combinedEffect >=
          fp.SIGNED_MIN &&
        family.combinedEffect <=
          fp.SIGNED_MAX
      );

      assert.equal(
        family.authoritative,
        false
      );
    }
  }
);


test(
  'I3-A malformed chemical state fails closed before receptor evaluation',
  () => {
    const state =
      baselineState();

    delete state.transmitters[
      'dopamine-like'
    ];

    assert.throws(
      () =>
        observeReceptors(state),

      error =>
        error?.code ===
        'SNTSS_I2_FAMILY_INVENTORY'
    );
  }
);


function cloneProfile() {
  return JSON.parse(
    JSON.stringify(
      receptorProfile
    )
  );
}


function resignProfile(
  profile
) {
  for (
    const receptor
    of profile.receptors
  ) {
    const {
      profileHash:
        ignoredHash,
      ...body
    } = receptor;

    receptor.profileHash =
      hash(body);
  }

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
  'I3-A extreme concentration remains saturating and bounded',
  () => {
    const low =
      baselineState();

    const high =
      baselineState();

    low.transmitters[
      'glutamate-like'
    ].C = 0;

    high.transmitters[
      'glutamate-like'
    ].C = fp.SCALE;

    const lowProbe =
      observeReceptors(low);

    const highProbe =
      observeReceptors(high);

    for (
      const receptorId
      of [
        'glutamate-ampa-like',
        'glutamate-nmda-like'
      ]
    ) {
      const a =
        lowProbe.receptors[
          receptorId
        ];

      const b =
        highProbe.receptors[
          receptorId
        ];

      assert.equal(
        a.occupancy,
        0
      );

      assert.ok(
        b.occupancy >
          a.occupancy
      );

      assert.ok(
        b.occupancy <=
          fp.SCALE
      );

      assert.ok(
        b.effect >=
          fp.SIGNED_MIN &&
        b.effect <=
          fp.SIGNED_MAX
      );
    }
  }
);


test(
  'I3-A below-baseline chemistry produces signed suppression rather than absolute activation',
  () => {
    const state =
      baselineState();

    state.transmitters[
      'dopamine-like'
    ].C = 0;

    const observation =
      observeReceptors(state);

    const d1 =
      observation.receptors[
        'dopamine-d1-like'
      ];

    const d2 =
      observation.receptors[
        'dopamine-d2-like'
      ];

    assert.ok(
      d1.deltaOccupancy < 0
    );

    assert.ok(
      d2.deltaOccupancy < 0
    );

    assert.ok(
      d1.effect < 0
    );

    assert.ok(
      d2.effect > 0
    );

    assert.equal(
      d1.authoritative,
      false
    );

    assert.equal(
      d2.authoritative,
      false
    );
  }
);


test(
  'I3-A unrehashed receptor tampering is rejected cryptographically',
  () => {
    const forged =
      cloneProfile();

    const receptor =
      forged.receptors.find(
        value =>
          value.receptorId ===
          'dopamine-d1-like'
      );

    receptor.affinity += 1;

    assert.throws(
      () =>
        validateReceptorProfile(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3_PROFILE_HASH'
    );
  }
);


test(
  'I3-A active-family crossing remains rejected even after attacker recomputes every hash',
  () => {
    const forged =
      cloneProfile();

    const receptor =
      forged.receptors.find(
        value =>
          value.receptorId ===
          'dopamine-d1-like'
      );

    receptor.family =
      'serotonin-like';

    resignProfile(
      forged
    );

    assert.throws(
      () =>
        validateReceptorProfile(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3_PROFILE_FROZEN'
    );
  }
);


test(
  'I3-A receptor deletion cannot be authorized by re-signing',
  () => {
    const forged =
      cloneProfile();

    forged.receptors =
      forged.receptors.filter(
        receptor =>
          receptor.receptorId !==
          'gaba-a-like'
      );

    resignProfile(
      forged
    );

    assert.throws(
      () =>
        validateReceptorProfile(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3_PROFILE_FROZEN'
    );
  }
);


test(
  'I3-A efficacy inversion cannot be authorized by re-signing',
  () => {
    const forged =
      cloneProfile();

    const receptor =
      forged.receptors.find(
        value =>
          value.receptorId ===
          'serotonin-5ht2-like'
      );

    receptor.efficacy =
      -receptor.efficacy;

    resignProfile(
      forged
    );

    assert.throws(
      () =>
        validateReceptorProfile(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3_PROFILE_FROZEN'
    );
  }
);


test(
  'I3-A dormant transmitter family cannot acquire a receptor even with recomputed hashes',
  () => {
    const forged =
      cloneProfile();

    const receptor =
      forged.receptors.find(
        value =>
          value.receptorId ===
          'dopamine-d2-like'
      );

    receptor.family =
      'oxytocin-like';

    resignProfile(
      forged
    );

    assert.throws(
      () =>
        validateReceptorProfile(
          forged
        ),

      error =>
        error?.code ===
        'SNTSS_I3_RECEPTOR_FAMILY'
    );
  }
);
