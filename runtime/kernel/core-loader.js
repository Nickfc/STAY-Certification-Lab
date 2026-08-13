'use strict';

const path = require('node:path');
const { validateManifest } = require('./manifest');

function loadCoreModule(modulePath) {
  const absolute = path.resolve(modulePath);
  const coreModule = require(absolute);
  const manifest = validateManifest(coreModule.manifest);
  if (typeof coreModule.createCore !== 'function') throw new Error('core must export createCore(context)');
  return {
    modulePath: absolute,
    manifest,
    createCore: coreModule.createCore,
    migrateState: typeof coreModule.migrateState === 'function' ? coreModule.migrateState : null
  };
}

module.exports = { loadCoreModule };
