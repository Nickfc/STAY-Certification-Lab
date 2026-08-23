'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/stage-lightsail-0.7.yml');
const REMOTE = path.join(ROOT,
  'deploy/live-physiology-transplant/p1-actions-remote-controller.sh');
const ROLLBACK = path.join(ROOT,
  'deploy/live-physiology-transplant/p1-forward-rollback.sh');

test('P1-ACTIONS-01 workflow pins candidate, tree and production host identities', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(source, /EXACT_CANDIDATE_SHA: 7d040592ccf1f149f0f0a170f79cf76bb5f05d92/);
  assert.match(source, /EXACT_CANDIDATE_TREE: 450cc22f70b7abf3b5733fe882049d88cd52de74/);
  assert.match(source, /PRODUCTION_PUBLIC_IPV4: 35\.157\.242\.167/);
  assert.match(source, /PRODUCTION_PRIVATE_IPV4: 172\.26\.9\.207/);
  assert.match(source, /ref: 7d040592ccf1f149f0f0a170f79cf76bb5f05d92/);
});

test('P1-ACTIONS-02 dispatch exposes only fixed operations and separate authorization inputs', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(source, /options:\n\s+- preflight\n\s+- surgery-a\n\s+- rollback-a/);
  assert.match(source, /surgery_a_authorization:/);
  assert.match(source, /rollback_a_authorization:/);
  assert.doesNotMatch(source, /(?:shell_command|remote_command|arbitrary_command):/);
  assert.match(source, /AUTHORIZE_SURGERY_A_7D040592CCF1F149/);
  assert.match(source, /AUTHORIZE_ROLLBACK_A_FORWARD_STATE_7D040592CCF1F149/);
});

test('P1-ACTIONS-03 secret boundary is a fresh job with no checkout or candidate execution', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  const split = source.indexOf('\n  production-bridge:');
  assert.ok(split > 0);
  const build = source.slice(0, split);
  const bridge = source.slice(split);
  assert.doesNotMatch(build, /secrets\./);
  assert.match(build, /npm test/);
  assert.match(build, /p1-build-surgery-a\.js/);
  assert.match(bridge, /secrets\.STAY_DEPLOY_KEY/);
  assert.doesNotMatch(bridge, /actions\/checkout@|npm test|p1-build-surgery-a\.js|node .*candidate/);
});

test('P1-ACTIONS-04 first authenticated remote action is the fail-closed IP guard', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  const bridgeAt = source.indexOf('\n  production-bridge:');
  const firstSsh = source.indexOf('\n          ssh ', bridgeAt);
  const firstScp = source.indexOf('\n          scp ', bridgeAt);
  const guard = source.indexOf('EXPECTED_PRIVATE_IPV4="172.26.9.207"', firstSsh);
  assert.ok(firstSsh > bridgeAt && guard > firstSsh && firstScp > guard);
  assert.match(source.slice(firstSsh, firstScp), /HOST_IDENTITY_GUARD=PASS/);
});

test('P1-ACTIONS-05 evidence is sanitized and Surgery B remains a fixed terminal operation', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(source, /Build sanitized Actions evidence/);
  assert.match(source, /p1-surgery-a-evidence-/);
  assert.match(source, /preflight-b/);
  assert.match(source, /surgery-b/);
  assert.match(source, /rollback-b/);
  assert.match(source, /AUTHORIZE_SURGERY_B_SNTSS_NEUTRAL_7D040592CCF1F149/);
  assert.match(source, /AUTHORIZE_ROLLBACK_B_PRESERVE_STATE_7D040592CCF1F149/);
  assert.doesNotMatch(source, /surgery-c|attach resident:chronobiology/);
});

test('P1-ACTIONS-06 remote dispatch and rollback preserve canonical forward state', () => {
  const remote = fs.readFileSync(REMOTE, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK, 'utf8');
  assert.match(remote, /case "\$OPERATION" in/);
  assert.match(remote, /preflight\)/);
  assert.match(remote, /surgery-a\)/);
  assert.match(remote, /rollback-a\)/);
  assert.match(rollback, /STAY_ROLLBACK_A_WRITE_AUTHORIZED/);
  assert.match(rollback, /CANONICAL_FORWARD_STATE_PRESERVED=YES/);
  assert.match(rollback, /STATESTORE_POST_SCHEMA=4/);
  assert.match(rollback, /server-surgery-a-rollback\.js/);
  assert.doesNotMatch(rollback,
    /sqlite3\s+[^\n]*restore|cp\s+[^\n]*(continuity\.sqlite3|stay-data)|tar\s+[^\n]*-x|rm\s+[^\n]*\/var\/lib\/stay\/data/);
});
