'use strict';

const families = [
  require('./dopamine-like'), require('./serotonin-like'), require('./noradrenaline-like'),
  require('./acetylcholine-like'), require('./glutamate-like'), require('./gaba-like'),
  require('./endogenous-opioid-like'), require('./oxytocin-like')
];

module.exports = Object.freeze(Object.fromEntries(families.map(profile => [profile.family, profile])));
