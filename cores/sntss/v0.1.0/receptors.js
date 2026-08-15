'use strict';

const { assertActiveFamily } = require('./validation');

// R4 blocks dormant-family references. Receptor profiles and frames belong to R6.
function authorizeLaboratoryFamily(family) { return assertActiveFamily(family, 'laboratory receptor'); }

module.exports = { stage: 'r4-family-guard-only', authorizeLaboratoryFamily };
