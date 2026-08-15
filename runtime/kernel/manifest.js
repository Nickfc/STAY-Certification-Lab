'use strict';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('manifest field missing: ' + field);
}

function requireTopics(value, field) {
  if (!Array.isArray(value)) throw new Error('manifest topic list missing: ' + field);
  for (const entry of value) requireText(entry, field);
}

function validateResources(value) {
  if (value == null) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest.resources must be an object');
  const allowed = new Set([
    'softRamMiB', 'hardRamMiB', 'sampleIntervalMs', 'hardConfirmations', 'trendSamples',
    'storageMiB', 'queueCapacity', 'handlerTimeoutMs', 'healthTimeoutMs',
    'maxRestarts', 'restartWindowMs', 'restartBackoffMs', 'softCpuPercent', 'hardCpuPercent',
    'outputCapacity', 'outputLimitPerEvent', 'outputBytesPerEvent', 'pidsMax'
  ]);
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error('unknown manifest resource field: ' + key);
    if (!Number.isFinite(Number(entry)) || Number(entry) <= 0) throw new Error('manifest resource must be positive: ' + key);
  }
  return Object.freeze({ ...value });
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('core manifest must be an object');
  requireText(manifest.coreId, 'coreId');
  requireText(manifest.version, 'version');
  requireText(manifest.protocol, 'protocol');
  if (!Number.isInteger(manifest.stateSchema) || manifest.stateSchema < 1) throw new Error('manifest.stateSchema must be an integer >= 1');
  requireTopics(manifest.inputs || [], 'inputs');
  requireTopics(manifest.outputs || [], 'outputs');
  if (typeof manifest.hotSwap !== 'boolean') throw new Error('manifest.hotSwap must be a boolean');
  const priority = manifest.priority || 'normal';
  if (!['critical', 'normal', 'optional'].includes(priority)) throw new Error('manifest.priority must be critical, normal or optional');
  return Object.freeze({
    ...manifest,
    priority,
    inputs: Object.freeze([...(manifest.inputs || [])]),
    outputs: Object.freeze([...(manifest.outputs || [])]),
    resources: validateResources(manifest.resources)
  });
}

function assertUpgradeCompatible(currentManifest, candidateManifest) {
  if (currentManifest.coreId !== candidateManifest.coreId) throw new Error('candidate coreId does not match active core');
  if (currentManifest.protocol !== candidateManifest.protocol) throw new Error('candidate protocol does not match active core');
  if (currentManifest.hotSwap !== true || candidateManifest.hotSwap !== true) throw new Error('this core requires a controlled compatibility migration rather than a live hot-swap');
  return true;
}

module.exports = { validateManifest, assertUpgradeCompatible };
