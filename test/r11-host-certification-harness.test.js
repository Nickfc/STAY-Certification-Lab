'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {
  ACK, HOST_PHASES, PROTECTED_PATHS, parseArgs, assertSafeLabRoot, ensureLabRoot,
  planDocument, strictR8Acceptance, overallStatus
} = require('../scripts/sntss-r11-host-certification');

const root = path.resolve(__dirname, '..');

function validEvidence(overrides = {}) {
  const base = {
    format: 'stay-sntss-r8-host-evidence-v1', activeStatePathTouched: false,
    activeReleasePointerChanged: false, serviceRestarted: false, disposableState: true,
    foundationStable: true,
    steady: { allHealthOk: true, observedDurationMs: 86400001, rssSlopeBytesPerHour: -1, cpuDuty: 0.001, handlerP99Ms: 2, queuePeak: 0, checkpointBytes: 1024 },
    pressure: { oom: { contained: true }, pids: { contained: true }, cpu: { contained: true } }, failures: []
  };
  return { ...base, ...overrides, steady: { ...base.steady, ...(overrides.steady || {}) }, pressure: { ...base.pressure, ...(overrides.pressure || {}) } };
}

test('R11-HOST-01 plan is non-live, unprivileged and includes every host phase', () => {
  const plan = planDocument({});
  assert.equal(plan.mode, 'PLAN_ONLY');
  assert.equal(plan.productionEligible, false);
  assert.equal(plan.liveMutationAllowed, false);
  assert.equal(plan.liveChemistryAllowed, false);
  assert.equal(plan.candidateRunsAsRoot, false);
  assert.equal(plan.acknowledgementRequiredForExecution, ACK);
  const ids = plan.phases.map(x => x.id);
  for (const phase of ['preflight', ...HOST_PHASES]) assert.ok(ids.includes(phase), phase);
  const endurance = plan.phases.find(x => x.id === 'endurance');
  assert.ok(endurance.domains.includes('R11-N'));
  assert.ok(endurance.domains.includes('R11-Q'));
});

test('R11-HOST-02 lab root is narrow, marked and exact-commit bound', async t => {
  assert.throws(() => assertSafeLabRoot('relative/r11-host-cert-x'), { code: 'R11_HOST_LAB_ROOT' });
  assert.throws(() => assertSafeLabRoot('/tmp/not-r11'), { code: 'R11_HOST_LAB_ROOT' });
  assert.throws(() => assertSafeLabRoot('/var/lib/stay/r11-host-cert-x'), { code: 'R11_HOST_LAB_ROOT' });
  const commit = 'a'.repeat(40);
  const labRoot = `/tmp/r11-host-cert-unit-${process.pid}-${Date.now()}`;
  t.after(() => fsp.rm(labRoot, { recursive: true, force: true }));
  assert.equal(assertSafeLabRoot(labRoot), labRoot);
  const first = await ensureLabRoot(labRoot, commit);
  assert.match(first.markerSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await ensureLabRoot(labRoot, commit)).markerSha256, first.markerSha256);
  await assert.rejects(() => ensureLabRoot(labRoot, 'b'.repeat(40)), { code: 'R11_HOST_LAB_MARKER' });
  await fsp.chmod(labRoot, 0o777);
  await assert.rejects(() => ensureLabRoot(labRoot, commit), { code: 'R11_HOST_LAB_ROOT_MODE' });
  await fsp.chmod(labRoot, 0o700);
});

test('R11-HOST-03 harness has no live stay.service mutation command and refuses root/R8 overlap', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/sntss-r11-host-certification.js'), 'utf8');
  assert.match(source, /candidate R11 host harness refuses to run as root/);
  assert.match(source, /R8 endurance is still active/);
  assert.match(source, /STAY_R11_HOST_CERT_ACK/);
  assert.match(source, /live STAY foundation changed/);
  for (const protectedPath of PROTECTED_PATHS) assert.ok(source.includes(protectedPath), protectedPath);
  for (const verb of ['start', 'stop', 'restart', 'enable', 'disable']) {
    assert.equal(source.includes(`['${verb}', 'stay.service']`), false, verb);
    assert.equal(source.includes(`["${verb}", "stay.service"]`), false, verb);
  }
  assert.equal(/\bsudo\b/.test(source), false);
});

test('R11-HOST-04 phase selection cannot fake whole-host PASS', () => {
  assert.throws(() => parseArgs(['--execute', '--phase', 'made-up']), { code: 'R11_HOST_ARGUMENT' });
  assert.throws(() => parseArgs(['--execute', '--phase', 'all,sandbox']), { code: 'R11_HOST_ARGUMENT' });
  assert.deepEqual(parseArgs(['--execute', '--phase', 'sandbox,operator']).phases, ['sandbox', 'operator']);
  const complete = Object.fromEntries(HOST_PHASES.map(phase => [phase, { status: 'PASS' }]));
  assert.equal(overallStatus(complete), 'PASS_HOST_EVIDENCE_ONLY');
  const partial = { ...complete }; delete partial.endurance;
  assert.equal(overallStatus(partial), 'PARTIAL_PASS_HOST_EVIDENCE_ONLY');
  assert.equal(overallStatus({ sandbox: { status: 'PENDING' } }), 'PARTIAL_BLOCKED');
  assert.equal(overallStatus({ sandbox: { status: 'BLOCKED' } }), 'BLOCKED');
  assert.equal(overallStatus({}), 'BLOCKED');
});

test('R11-HOST-05 strict endurance proof needs finite values and non-positive 24h RSS slope', () => {
  assert.equal(strictR8Acceptance(validEvidence()).ok, true);
  assert.equal(strictR8Acceptance(validEvidence({ steady: { rssSlopeBytesPerHour: 0 } })).ok, true);
  assert.equal(strictR8Acceptance(validEvidence({ steady: { rssSlopeBytesPerHour: 1 } })).ok, false);
  assert.equal(strictR8Acceptance(validEvidence({ steady: { rssSlopeBytesPerHour: null } })).ok, false);
  assert.equal(strictR8Acceptance(validEvidence({ steady: { cpuDuty: null } })).ok, false);
  assert.equal(strictR8Acceptance(validEvidence({ steady: { queuePeak: 64 } })).ok, false);
  assert.equal(strictR8Acceptance(validEvidence({ steady: { observedDurationMs: 86399999 } })).ok, false);
  assert.equal(strictR8Acceptance(validEvidence({ pressure: { oom: { contained: false } } })).ok, false);
});

test('R11-HOST-06 package commands and host runbook preserve manual R8-gated execution', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['plan:sntss-r11-host'], 'node scripts/sntss-r11-host-certification.js --plan');
  assert.equal(pkg.scripts['certify:sntss-r11-host'], 'node scripts/sntss-r11-host-certification.js --execute');
  const runbook = fs.readFileSync(path.join(root, 'docs/sntss/R11_HOST_CERTIFICATION_HARNESS.md'), 'utf8');
  assert.match(runbook, /must not be executed while.*R8/i);
  assert.match(runbook, /never run as root/i);
  assert.match(runbook, /second 24-hour.*exact-candidate/i);
  assert.match(runbook, /does not certify R11/i);
});
