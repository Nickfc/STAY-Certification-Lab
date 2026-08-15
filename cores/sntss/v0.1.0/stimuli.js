'use strict';

const { assertActiveFamily, validateDriveMap } = require('./validation');

// R4 exposes only a simulator guard. Authoritative semantic stimulus mapping belongs to R5.
function authorizeLaboratoryFamily(family) { return assertActiveFamily(family, 'laboratory stimulus'); }

module.exports = { stage: 'r4-family-guard-only', authorizeLaboratoryFamily, validateDriveMap };
