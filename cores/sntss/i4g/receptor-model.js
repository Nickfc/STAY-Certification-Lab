'use strict';

/*
 * STAY / SNTSS I3-A receptor observation engine.
 *
 * Converts the existing deterministic chemical state
 * into bounded receptor occupancy/effect telemetry.
 *
 * It has no runtime/Event Fabric authority.
 */

const fp =
  require('./fixed-point');

const {
  validateChemicalState
} = require(
  './chemical-state'
);

const {
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES,
  ALL_FAMILIES
} = require(
  './species-profile'
);

const {
  receptorProfile,
  validateReceptorProfile
} = require(
  './receptor-profile'
);


function clone(value) {
  return JSON.parse(
    JSON.stringify(value)
  );
}


function observeReceptors(
  inputState
) {
  validateChemicalState(
    inputState
  );

  validateReceptorProfile(
    receptorProfile
  );

  const receptors = {};

  const familyEffects =
    Object.fromEntries(
      ALL_FAMILIES.map(
        family => [
          family,
          []
        ]
      )
    );


  for (
    const profile
    of receptorProfile.receptors
  ) {
    const transmitter =
      inputState
        .transmitters[
          profile.family
        ];

    const occupancy =
      fp.hill(
        transmitter.C,
        profile.affinity,
        profile.hill
      );

    const tonicOccupancy =
      fp.hill(
        transmitter.B,
        profile.affinity,
        profile.hill
      );

    const deltaOccupancy =
      fp.clamp(
        occupancy -
          tonicOccupancy,
        fp.SIGNED_MIN,
        fp.SIGNED_MAX
      );

    const effect =
      fp.clamp(
        fp.mul(
          deltaOccupancy,
          profile.efficacy
        ),
        fp.SIGNED_MIN,
        fp.SIGNED_MAX
      );


    const record = {
      receptorId:
        profile.receptorId,

      family:
        profile.family,

      concentration:
        transmitter.C,

      baseline:
        transmitter.B,

      affinity:
        profile.affinity,

      hill:
        profile.hill,

      efficacy:
        profile.efficacy,

      occupancy,

      tonicOccupancy,

      deltaOccupancy,

      effect,

      authoritative:
        false
    };


    receptors[
      profile.receptorId
    ] = record;

    familyEffects[
      profile.family
    ].push(effect);
  }


  const families = {};


  for (
    const family
    of ALL_FAMILIES
  ) {
    const receptorIds =
      receptorProfile
        .receptors
        .filter(
          receptor =>
            receptor.family === family
        )
        .map(
          receptor =>
            receptor.receptorId
        );

    const combinedEffect =
      familyEffects[family]
        .length === 0
        ? 0
        : fp.saturatingCombine(
            familyEffects[family]
          );


    families[family] = {
      family,

      active:
        ACTIVE_FAMILIES.includes(
          family
        ),

      dormant:
        DORMANT_FAMILIES.includes(
          family
        ),

      receptorIds,

      combinedEffect,

      authoritative:
        false
    };
  }


  return clone({
    format:
      'stay-sntss-i3a-receptor-observation-v1',

    stage:
      'i3a-receptor-observation',

    modelClock:
      inputState.modelClock,

    receptorProfileHash:
      receptorProfile.profileHash,

    productionEligible:
      false,

    outputAuthority:
      false,

    receptors,

    families
  });
}


module.exports = {
  observeReceptors
};
