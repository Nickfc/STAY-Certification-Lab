'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { enforcePackagePolicy } = require('../runtime/kernel/package-policy');
const { normalizePolicy } = require('../runtime/kernel/resource-governor');
const { cgroupLimitValues } = require('../runtime/kernel/cgroup-governor');
const containment = require('../cores/sntss/v0.1.0/containment');
const sntss = require('../cores/sntss/v0.1.0');
const { hash } = require('../cores/sntss/v0.1.0/species-profile');

const root = path.resolve(__dirname, '..');
const entrypoint = path.join(root, 'cores/sntss/v0.1.0/index.js');
function digestFile(relative) { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}`; }
function incident(kind, index, severity = 'warning') {
  return {
    incidentId: `r8-${kind}-${index}`, kind, scope: 'global', severity, observedAtCursor: index,
    evidenceHash: hash({ kind, index, evidence: true }), checkpointHash: hash({ checkpoint: 1 }),
    detailHash: hash({ kind, detail: true }), runtimeTrusted: true
  };
}

const packageRecord = enforcePackagePolicy(entrypoint);
const modeledFailures = {};
for (const [index, kind] of [
  'hang', 'event-flood', 'oom', 'pids-exhaustion', 'cpu-pressure', 'sigkill',
  'invalid-checkpoint', 'output-abuse', 'process-escape', 'audit-flood', 'migration-overrun', 'unsafe-shutdown'
].entries()) {
  const result = containment.recordIncident(containment.createContainmentState(hash({ lineage: kind }), hash({ checkpoint: 1 })), incident(kind, index, ['invalid-checkpoint', 'process-escape', 'unsafe-shutdown'].includes(kind) ? 'critical' : 'warning'));
  modeledFailures[kind] = { contained: ['degraded', 'quarantined'].includes(result.mode), mode: result.mode, forceTermination: result.forceTermination, evidenceRetained: result.incidents.length === 1 };
}
const escaped = containment.recordIncident(containment.createContainmentState(hash({ lineage: 'escape' }), hash({ checkpoint: 1 })), incident('process-escape', 99, 'critical'));
const neutral = containment.neutralizationDirective(escaped, hash({ failedState: 'preserved' }));
const killed = containment.forceTerminationDirective(escaped, { trustedRuntime: true, kernelGovernor: true });
const normalized = normalizePolicy(sntss.manifest.resources, sntss.manifest.priority);
const moduleFiles = [
  'runtime/kernel/package-policy.js', 'runtime/kernel/core-loader.js', 'runtime/kernel/core-host-client.js',
  'runtime/kernel/core-sandbox.js', 'runtime/core-host/host.js', 'runtime/core-host/sandbox-host.js', 'runtime/core-host/worker.js',
  'runtime/kernel/resource-governor.js', 'runtime/kernel/cgroup-governor.js',
  'cores/sntss/v0.1.0/containment.js', 'cores/sntss/v0.1.0/package-policy.json',
  'cores/sntss/schemas/containment-policy.schema.json', 'test/sntss-containment.test.js'
];
const body = {
  evidenceVersion: 1, stage: 'R8-security-containment-resource-laboratory', productionEligible: false,
  activeStatePathTouched: false, destructiveLiveFaultInjection: false,
  packagePolicyHash: packageRecord.policy.policyHash, attestedFiles: packageRecord.attestedFiles,
  dependencyAllowlistClosed: true, environmentSanitized: true, diagnosticsDisabled: true,
  ambientCapabilities: packageRecord.policy.ambientCapabilities,
  resourceContract: { normalized, cgroupLimits: cgroupLimitValues(normalized), delegatedLevels: ['stay-cores', 'sntss-<instance>'], kernelGovernorOwned: true },
  bounds: packageRecord.policy.bounds, modeledFailures,
  neutralization: {
    failedStatePreserved: neutral.directive.preserveFailedState,
    chemistryMutation: neutral.directive.mutateAcquiredBiology,
    chemistryFrames: neutral.directive.emitChemistryFrames,
    forceTerminationSignal: killed.directive.signal,
    restartMode: killed.directive.restartMode
  },
  executableEvidence: {
    r8Suite: 'test/sntss-containment.test.js',
    hangQueueEscape: 'test/corehost.test.js',
    outputAbuseAndCgroupHierarchy: 'test/audit-regressions.test.js + test/hostile-closure.test.js',
    sustainedHeadroom: 'test:smoke',
    productionHostCgroupPressureDrillRequired: true
  },
  coreHostActivation: { inputsChanged: false, outputs: [], chemistryActive: false, productionGenesis: false },
  moduleHashes: Object.fromEntries(moduleFiles.map(file => [file, digestFile(file)]))
};
const evidence = { ...body, evidenceHash: hash(body) };
const destination = path.join(root, 'docs/sntss/evidence/R8_CONTAINMENT_EVIDENCE.json');
fs.writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ destination: path.relative(root, destination), evidenceHash: evidence.evidenceHash, packagePolicyHash: evidence.packagePolicyHash, modeledFailures: Object.keys(evidence.modeledFailures).length })}\n`);

module.exports = { evidence };
