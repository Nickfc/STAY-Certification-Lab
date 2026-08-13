'use strict';

const { LivingKernel } = require('../runtime');
if (typeof LivingKernel !== 'function') throw new Error('LivingKernel export missing');
console.log('Living Runtime module verified');
