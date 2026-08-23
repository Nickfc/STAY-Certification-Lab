'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { sandboxWorkerPlan } = require('../runtime/kernel/core-sandbox');

const execFileAsync = promisify(execFile);
const FORMAT = 'stay-sntss-r11-host-certification-v1';
const ACK = 'ISOLATED-NON-LIVE';
const SAFE_LAB_PARENTS = Object.freeze(['/opt/stay/incoming', '/tmp']);
const HOST_PHASES = Object.freeze(['sandbox', 'trust', 'release', 'operator', 'revocation', 'anchor', 'lifecycle', 'r8', 'endurance']);
const PROTECTED_PATHS = Object.freeze([
  '/var/lib/stay', '/opt/stay/current', '/etc/stay', '/usr/local/lib/stay',
  '/usr/local/sbin/stay-deploy', '/etc/systemd/system', '/run/stay-forensic-anchor'
]);
const TRUSTED_VERIFIER = '/usr/local/lib/stay/trusted-release-verifier.js';
const TRUSTED_DEPLOYER = '/usr/local/sbin/stay-deploy';
const RELEASE_PUBLIC_KEY = '/etc/stay/release-authority.pub';
const ANCHOR_SOCKET_ROOT = '/run/stay-forensic-anchor';
const ANCHOR_STATE_ROOT = '/var/lib/stay-forensic-anchor';

function fail(message, code = 'R11_HOST_CERTIFICATION') { throw Object.assign(new Error(message), { code }); }
function sha256(value) { return `sha256:${crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest('hex')}`; }
async function sha256File(file) { return sha256(await fsp.readFile(file)); }
function pathInside(root, target) { const a = path.resolve(root); const b = path.resolve(target); return b === a || b.startsWith(a + path.sep); }
function overlaps(a, b) { const x = path.resolve(a); const y = path.resolve(b); return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep); }
function phaseEnabled(phases, phase) { return phases.includes('all') || phases.includes(phase); }

function parseArgs(argv = process.argv.slice(2)) {
  const out = { mode: 'plan', phases: ['all'] };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--plan') out.mode = 'plan';
    else if (v === '--execute') out.mode = 'execute';
    else if (v === '--lab-root') out.labRoot = argv[++i];
    else if (v === '--candidate-commit') out.candidateCommit = argv[++i];
    else if (v === '--phase') out.phases = String(argv[++i] || '').split(',').map(x => x.trim()).filter(Boolean);
    else if (v === '--output') out.output = argv[++i];
    else if (v === '--expected-release-key-sha256') out.expectedReleaseKeySha256 = argv[++i];
    else if (v === '--bootstrap-transcript') out.bootstrapTranscript = argv[++i];
    else if (v === '--release-root') out.releaseRoot = argv[++i];
    else if (v === '--release-archive') out.releaseArchive = argv[++i];
    else if (v === '--release-authorization') out.releaseAuthorization = argv[++i];
    else if (v === '--expected-version') out.expectedVersion = argv[++i];
    else if (v === '--release-rehearsal-review') out.releaseRehearsalReview = argv[++i];
    else if (v === '--r8-evidence') out.r8Evidence = argv[++i];
    else if (v === '--r8-review') out.r8Review = argv[++i];
    else if (v === '--r11-endurance-evidence') out.r11EnduranceEvidence = argv[++i];
    else if (v === '--r11-endurance-review') out.r11EnduranceReview = argv[++i];
    else fail(`unknown argument: ${v}`, 'R11_HOST_ARGUMENT');
  }
  if (!out.phases.length) out.phases = ['all'];
  const allowed = new Set(['all', ...HOST_PHASES]);
  for (const phase of out.phases) if (!allowed.has(phase)) fail(`unknown R11 host phase: ${phase}`, 'R11_HOST_ARGUMENT');
  if (out.phases.includes('all') && out.phases.length !== 1) fail('--phase all may not be combined with another phase', 'R11_HOST_ARGUMENT');
  return out;
}

function assertSafeLabRoot(requested) {
  if (!requested || !path.isAbsolute(requested)) fail('R11 lab root must be absolute', 'R11_HOST_LAB_ROOT');
  const resolved = path.resolve(requested);
  if (!/^r11-host-cert-[A-Za-z0-9_.-]+$/.test(path.basename(resolved))) fail('R11 lab root basename must begin with r11-host-cert-', 'R11_HOST_LAB_ROOT');
  if (!SAFE_LAB_PARENTS.includes(path.dirname(resolved))) fail('R11 lab root parent is not approved', 'R11_HOST_LAB_ROOT');
  for (const protectedPath of PROTECTED_PATHS) if (overlaps(resolved, protectedPath)) fail(`R11 lab root overlaps ${protectedPath}`, 'R11_HOST_LAB_ROOT');
  return resolved;
}

async function ensureLabRoot(labRoot, candidateCommit) {
  let created = false;
  try { await fsp.mkdir(labRoot, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fsp.lstat(labRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('R11 lab root must be a real directory', 'R11_HOST_LAB_ROOT');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('R11 lab root owner is unsafe', 'R11_HOST_LAB_ROOT_OWNER');
  if (stat.mode & 0o022) fail('R11 lab root may not be group/world writable', 'R11_HOST_LAB_ROOT_MODE');
  const markerPath = path.join(labRoot, '.r11-host-lab.json');
  let markerStat = await fsp.lstat(markerPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!markerStat) {
    if (!created && (await fsp.readdir(labRoot)).length) fail('existing R11 lab root is unmarked and non-empty', 'R11_HOST_LAB_MARKER');
    const marker = { format: 'stay-sntss-r11-host-lab-v1', candidateCommit, createdAt: new Date().toISOString() };
    await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    markerStat = await fsp.lstat(markerPath);
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.mode & 0o022) fail('R11 lab marker is unsafe', 'R11_HOST_LAB_MARKER');
  if (typeof process.getuid === 'function' && markerStat.uid !== process.getuid()) fail('R11 lab marker owner is unsafe', 'R11_HOST_LAB_MARKER');
  const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
  if (marker?.format !== 'stay-sntss-r11-host-lab-v1' || marker?.candidateCommit !== candidateCommit) fail('R11 lab marker does not bind exact candidate', 'R11_HOST_LAB_MARKER');
  return { markerSha256: await sha256File(markerPath) };
}

function planDocument(options = {}) {
  return {
    format: FORMAT, mode: 'PLAN_ONLY', productionEligible: false, liveMutationAllowed: false,
    liveChemistryAllowed: false, candidateRunsAsRoot: false, acknowledgementRequiredForExecution: ACK,
    protectedPaths: [...PROTECTED_PATHS], approvedLabParents: [...SAFE_LAB_PARENTS],
    phases: [
      { id: 'preflight', domains: [], action: 'read-only live fingerprint + active-R8 refusal' },
      { id: 'sandbox', domains: ['R11-B'], action: 'real bubblewrap escape probes' },
      { id: 'trust', domains: ['R11-G'], action: 'out-of-band trust-root fingerprint/ownership proof' },
      { id: 'release', domains: ['R11-F'], action: 'host-owned signed-artifact verification + replica rehearsal review' },
      { id: 'operator', domains: ['R11-K'], action: 'disposable authenticated operator-status probe' },
      { id: 'revocation', domains: ['R11-H'], action: 'host revocation/rollback regression on disposable state' },
      { id: 'anchor', domains: ['R11-L'], action: 'independent witness OS-separation proof' },
      { id: 'lifecycle', domains: ['R11-O'], action: 'host crash/replay regression on disposable state' },
      { id: 'r8', domains: [], action: 'strict R8 entrance-evidence + independent-review validation' },
      { id: 'endurance', domains: ['R11-N', 'R11-Q'], action: 'second 24h exact-candidate endurance/pressure + independent review' }
    ],
    labRoot: options.labRoot || '/opt/stay/incoming/r11-host-cert-<run-id>'
  };
}

async function run(file, args, options = {}) {
  try {
    const r = await execFileAsync(file, args, { cwd: options.cwd, env: options.env || process.env, timeout: options.timeoutMs || 30000, maxBuffer: options.maxBuffer || 8 * 1024 * 1024 });
    return { ok: true, code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    return { ok: false, code: Number.isInteger(error.code) ? error.code : null, signal: error.signal || null, stdout: String(error.stdout || ''), stderr: String(error.stderr || ''), message: error.message };
  }
}

async function httpJson(port, pathname, bearer = null) {
  return new Promise((resolve, reject) => {
    const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers, timeout: 2500 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({ statusCode: res.statusCode, json, text }); });
    });
    req.once('timeout', () => req.destroy(new Error('HTTP timeout'))); req.once('error', reject); req.end();
  });
}

async function currentCommit(root) {
  const r = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
  const commit = r.stdout?.trim();
  if (!r.ok || !/^[0-9a-f]{40}$/.test(commit)) fail('cannot resolve canonical candidate commit', 'R11_HOST_COMMIT');
  return commit;
}

async function activeR8Units() {
  const r = await run('systemctl', ['list-units', '--type=service', '--state=active', '--no-legend', '--no-pager', 'stay-r8-host-*']);
  if (!r.ok) return { ok: false, units: [] };
  return { ok: true, units: r.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(x => x.split(/\s+/)[0]) };
}

async function liveFoundation() {
  const r = await run('systemctl', ['show', 'stay.service', '--property=ActiveState,SubState,MainPID', '--no-pager']);
  if (!r.ok) fail('cannot inspect stay.service', 'R11_HOST_FOUNDATION');
  const service = Object.fromEntries(r.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  const health = await httpJson(8787, '/healthz');
  const releasePointer = await fsp.readlink('/opt/stay/current').catch(error => error.code === 'ENOENT' ? null : `UNREADABLE:${error.code || 'ERROR'}`);
  return { activeState: service.ActiveState, subState: service.SubState, mainPid: Number(service.MainPID) || 0, healthStatusCode: health.statusCode, health: health.json, releasePointer };
}

function deriveBwrapParts(plan) {
  const workerIndex = plan.args.lastIndexOf(plan.sandboxWorkerPath);
  let nodeIndex = -1;
  for (let i = workerIndex - 1; i >= 0; i -= 1) if (/\/node$/.test(plan.args[i])) { nodeIndex = i; break; }
  if (workerIndex < 1 || nodeIndex < 0) fail('sandbox plan is incomplete', 'R11_HOST_SANDBOX_PLAN');
  return { prefix: plan.args.slice(0, nodeIndex), node: plan.args[nodeIndex], nodeArgs: plan.args.slice(nodeIndex + 1, workerIndex) };
}

async function sandboxProbe(root, livePid) {
  const plan = sandboxWorkerPlan(path.join(root, 'cores/sntss/neutral/index.js'));
  if (!fs.existsSync(plan.executable)) fail(`bubblewrap missing: ${plan.executable}`, 'R11_HOST_BWRAP_MISSING');
  const p = deriveBwrapParts(plan);
  const shellCode = ['set -eu', 'test ! -e /var/lib/stay/data', 'test ! -e /opt/stay/current', livePid ? `test ! -e /proc/${livePid}` : ':', 'if touch /stay-release/.r11-escape 2>/dev/null; then exit 31; fi', 'test ! -e /stay-release/.r11-escape'].join('\n');
  const shell = await run(plan.executable, [...p.prefix, '/bin/sh', '-ceu', shellCode], { timeoutMs: 10000 });
  if (!shell.ok) fail('bubblewrap filesystem/PID escape probe failed', 'R11_HOST_SANDBOX_ESCAPE');
  const netCode = "const n=require('node:net'),s=n.connect({host:'127.0.0.1',port:8787});let d=0;const f=(ok)=>{if(d)return;d=1;s.destroy();process.exit(ok?0:41)};s.once('connect',()=>f(false));s.once('error',()=>f(true));setTimeout(()=>f(true),1000).unref();";
  const network = await run(plan.executable, [...p.prefix, p.node, ...p.nodeArgs, '-e', netCode], { timeoutMs: 5000 });
  if (!network.ok) fail('sandbox network namespace reached live runtime', 'R11_HOST_SANDBOX_NETWORK');
  const spawnCode = "try{require('node:child_process').spawnSync('/bin/true');process.exit(41)}catch(e){process.exit(0)}";
  const child = await run(plan.executable, [...p.prefix, p.node, ...p.nodeArgs, '-e', spawnCode], { timeoutMs: 5000 });
  if (!child.ok) fail('candidate worker retained child-process authority', 'R11_HOST_SANDBOX_SPAWN');
  return { status: 'PASS', bwrap: plan.executable, networkShared: plan.networkShared, stateStoreVisible: plan.stateStoreVisible };
}

async function operatorProbe(root, labRoot) {
  const token = crypto.randomBytes(32).toString('hex');
  const opRoot = await fsp.mkdtemp(path.join(labRoot, 'operator-')); await fsp.chmod(opRoot, 0o700);
  const credentials = path.join(opRoot, 'credentials'); const data = path.join(opRoot, 'data');
  await fsp.mkdir(credentials, { mode: 0o700 }); await fsp.mkdir(data, { mode: 0o700 });
  const tokenFile = path.join(credentials, 'status.token'); await fsp.writeFile(tokenFile, token + '\n', { mode: 0o600 });
  const port = 18000 + crypto.randomInt(0, 2000);
  const child = spawn(process.execPath, [path.join(root, 'server-secure.js')], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'], env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'test', STAY_DATA_DIR: data, STAY_ALLOW_IDENTITY_BOOTSTRAP: '1', STAY_HOST: '127.0.0.1', PORT: String(port), STAY_LEGACY_PORT: '0', STAY_OPERATOR_STATUS_TOKEN_FILE: tokenFile } });
  try {
    let health = null;
    for (let i = 0; i < 50; i += 1) { try { health = await httpJson(port, '/healthz'); if (health.statusCode) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    if (health?.statusCode !== 200 || health.json?.ok !== true) fail('disposable secure server is unhealthy', 'R11_HOST_OPERATOR_HEALTH');
    const missing = await httpJson(port, '/runtime/status'); const wrong = await httpJson(port, '/runtime/status', 'wrong-' + token);
    const query = await httpJson(port, `/runtime/status?token=${token}`); const correct = await httpJson(port, '/runtime/status', token);
    if ([missing, wrong, query].some(x => x.statusCode !== 401) || correct.statusCode !== 200 || !correct.json?.kernel) fail('operator-status capability boundary failed', 'R11_HOST_OPERATOR_AUTH');
    return { status: 'PASS', tokenSha256: sha256(token), publicHealthStatus: 200, missingCredentialStatus: 401, wrongCredentialStatus: 401, queryCredentialStatus: 401, correctCredentialStatus: 200 };
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    await fsp.rm(tokenFile, { force: true });
  }
}

async function trustRecord(file) {
  const s = await fsp.stat(file);
  return { path: file, uid: s.uid, gid: s.gid, mode: (s.mode & 0o777).toString(8).padStart(4, '0'), sha256: await sha256File(file), rootOwned: s.uid === 0, groupOrWorldWritable: Boolean(s.mode & 0o022) };
}

async function trustProof(options, root) {
  const expected = String(options.expectedReleaseKeySha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return { status: 'PENDING', reason: 'out-of-band release-key fingerprint missing' };
  for (const file of [TRUSTED_VERIFIER, TRUSTED_DEPLOYER, RELEASE_PUBLIC_KEY]) if (!fs.existsSync(file)) return { status: 'PENDING', reason: `trusted object missing: ${file}` };
  const records = await Promise.all([TRUSTED_VERIFIER, TRUSTED_DEPLOYER, RELEASE_PUBLIC_KEY].map(trustRecord));
  if (records.some(x => !x.rootOwned || x.groupOrWorldWritable)) fail('trusted object ownership/mode unsafe', 'R11_HOST_TRUST_PERMISSIONS');
  const actual = records.find(x => x.path === RELEASE_PUBLIC_KEY).sha256.slice(7);
  if (actual !== expected) fail('release-authority fingerprint mismatch', 'R11_HOST_TRUST_FINGERPRINT');
  if (!options.bootstrapTranscript) return { status: 'PENDING', reason: 'out-of-band bootstrap transcript missing', records, installedReleaseKeySha256: actual };
  const transcript = path.resolve(options.bootstrapTranscript);
  if (pathInside(root, transcript)) fail('bootstrap transcript must live outside candidate checkout', 'R11_HOST_TRUST_TRANSCRIPT');
  return { status: 'PASS', records, installedReleaseKeySha256: actual, transcriptSha256: await sha256File(transcript) };
}

async function realPathInside(root, candidate, label) {
  const [base, target] = await Promise.all([fsp.realpath(root), fsp.realpath(path.resolve(candidate))]);
  if (!pathInside(base, target)) fail(`${label} escapes R11 lab root`, 'R11_HOST_RELEASE_PATH');
  return target;
}

async function releaseProbe(options, labRoot, candidateCommit) {
  if (['releaseRoot', 'releaseArchive', 'releaseAuthorization', 'expectedVersion'].some(k => !options[k])) return { status: 'PENDING', reason: 'signed release bundle incomplete' };
  if (!fs.existsSync(TRUSTED_VERIFIER) || !fs.existsSync(RELEASE_PUBLIC_KEY)) return { status: 'PENDING', reason: 'host-owned verifier/public key missing' };
  const releaseRoot = await realPathInside(labRoot, options.releaseRoot, 'release root');
  const archive = await realPathInside(labRoot, options.releaseArchive, 'release archive');
  const authorization = await realPathInside(labRoot, options.releaseAuthorization, 'release authorization');
  const r = await run(process.execPath, [TRUSTED_VERIFIER, 'verify', '--root', releaseRoot, '--archive', archive, '--authorization', authorization, '--public-key', RELEASE_PUBLIC_KEY, '--expected-version', String(options.expectedVersion), '--expected-commit', candidateCommit, '--action', 'activate'], { timeoutMs: 30000 });
  if (!r.ok) fail('host-owned signed-release verification failed', 'R11_HOST_RELEASE_VERIFY');
  let result; try { result = JSON.parse(r.stdout.trim()); } catch { fail('trusted verifier returned malformed evidence', 'R11_HOST_RELEASE_VERIFY'); }
  if (!options.releaseRehearsalReview) return { status: 'PENDING', reason: 'production-host replica cutover/rollback review missing', verifierResult: result };
  const review = JSON.parse(await fsp.readFile(path.resolve(options.releaseRehearsalReview), 'utf8'));
  if (review?.accepted !== true || review?.replica !== true || review?.liveOrganismTouched !== false || review?.preserveForwardState !== true || review?.candidateCommit !== candidateCommit || review?.archiveSha256 !== result.archiveSha256) return { status: 'BLOCKED', reason: 'replica rehearsal review does not bind exact artifact/no-rewind result' };
  return { status: 'PASS', verifierResult: result, rehearsalReviewSha256: await sha256File(path.resolve(options.releaseRehearsalReview)) };
}

async function hostRegression(root, files) {
  const r = await run(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, timeoutMs: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (!r.ok) fail(`host regression failed: ${files.join(', ')}`, 'R11_HOST_REGRESSION');
  const n = key => Number(r.stdout.match(new RegExp(`(?:ℹ\\s+)?${key}\\s+(\\d+)`))?.[1]);
  const summary = { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), todo: n('todo') };
  if (summary.fail !== 0 || summary.skipped !== 0 || !Number.isFinite(summary.tests)) fail('host regression contains failure/skip', 'R11_HOST_REGRESSION');
  return { status: 'PASS', files, summary, outputSha256: sha256(r.stdout) };
}

async function anchorProof() {
  const r = await run('systemctl', ['show', 'stay-forensic-anchor.service', '--property=LoadState,ActiveState,SubState,User,Group,MainPID', '--no-pager']);
  if (!r.ok || /LoadState=not-found/.test(r.stdout)) return { status: 'PENDING', reason: 'stay-forensic-anchor.service not installed' };
  const service = Object.fromEntries(r.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  const records = [];
  for (const target of [ANCHOR_SOCKET_ROOT, ANCHOR_STATE_ROOT]) {
    try { const s = await fsp.stat(target); records.push({ path: target, uid: s.uid, gid: s.gid, mode: (s.mode & 0o777).toString(8).padStart(4, '0'), writableByStayUser: s.uid === process.getuid() && Boolean(s.mode & 0o200) }); }
    catch (error) { return { status: 'PENDING', reason: `anchor path unavailable: ${target} (${error.code})` }; }
  }
  if (records.some(x => x.writableByStayUser)) fail('STAY user can write independent witness root', 'R11_HOST_ANCHOR_SEPARATION');
  if (service.User === 'staydeploy') fail('forensic witness shares STAY service identity', 'R11_HOST_ANCHOR_SEPARATION');
  return { status: service.ActiveState === 'active' ? 'PASS' : 'PENDING', service, records };
}

function strictR8Acceptance(evidence) {
  const failures = [];
  if (evidence?.format !== 'stay-sntss-r8-host-evidence-v1') failures.push('wrong evidence format');
  if (evidence?.activeStatePathTouched !== false) failures.push('active StateStore touched');
  if (evidence?.activeReleasePointerChanged !== false) failures.push('active release pointer changed');
  if (evidence?.serviceRestarted !== false) failures.push('live service restarted');
  if (evidence?.disposableState !== true) failures.push('state was not disposable');
  if (evidence?.foundationStable !== true) failures.push('live foundation changed');
  if (evidence?.steady?.allHealthOk !== true) failures.push('health not continuous');
  const checks = [
    ['observedDurationMs', x => x >= 86400000, 'less than 24h steady evidence'],
    ['rssSlopeBytesPerHour', x => x <= 0, 'strict long-window RSS slope is missing or positive'],
    ['cpuDuty', x => x < 0.05, 'CPU duty is missing or not below 5%'],
    ['handlerP99Ms', x => x < 25, 'handler p99 is missing or not below 25ms'],
    ['queuePeak', x => x < 64, 'queue value is missing or reached bound'],
    ['checkpointBytes', x => x < 1024 * 1024, 'checkpoint value is missing or reached 1MiB']
  ];
  for (const [key, predicate, message] of checks) { const value = Number(evidence?.steady?.[key]); if (evidence?.steady?.[key] == null || !Number.isFinite(value) || !predicate(value)) failures.push(message); }
  for (const kind of ['oom', 'pids', 'cpu']) if (evidence?.pressure?.[kind]?.contained !== true) failures.push(`${kind} pressure not contained`);
  if (Array.isArray(evidence?.failures) && evidence.failures.length) failures.push(...evidence.failures.map(x => `script failure: ${x}`));
  return { ok: failures.length === 0, failures };
}

async function reviewedEndurance(evidencePath, reviewPath, expectedCommit = null) {
  const evidence = JSON.parse(await fsp.readFile(path.resolve(evidencePath), 'utf8')); const evidenceSha256 = await sha256File(path.resolve(evidencePath));
  if (expectedCommit && evidence?.sourceCommit !== expectedCommit) return { status: 'BLOCKED', evidenceSha256, reason: 'endurance evidence is not exact candidate' };
  const acceptance = strictR8Acceptance(evidence);
  if (!acceptance.ok) return { status: 'BLOCKED', evidenceSha256, failures: acceptance.failures };
  if (!reviewPath) return { status: 'PENDING_REVIEW', evidenceSha256, reason: 'independent review missing' };
  const review = JSON.parse(await fsp.readFile(path.resolve(reviewPath), 'utf8'));
  if (review?.accepted !== true || review?.evidenceSha256 !== evidenceSha256 || (expectedCommit && review?.candidateCommit !== expectedCommit)) return { status: 'BLOCKED', evidenceSha256, reason: 'independent review does not bind exact evidence/candidate' };
  return { status: 'PASS', evidenceSha256, reviewSha256: await sha256File(path.resolve(reviewPath)), measuredDurationMs: evidence.steady.observedDurationMs, rssSlopeBytesPerHour: evidence.steady.rssSlopeBytesPerHour };
}

async function r8Proof(options) { return options.r8Evidence ? reviewedEndurance(options.r8Evidence, options.r8Review) : { status: 'PENDING', reason: 'R8 evidence missing' }; }
async function exactCandidateEnduranceProof(options, candidateCommit) { return options.r11EnduranceEvidence ? reviewedEndurance(options.r11EnduranceEvidence, options.r11EnduranceReview, candidateCommit) : { status: 'PENDING', reason: '24h exact-candidate endurance evidence missing' }; }

function overallStatus(phases) {
  const values = Object.values(phases);
  if (!values.length || values.some(x => ['BLOCKED', 'FAIL'].includes(x?.status))) return 'BLOCKED';
  if (values.some(x => x?.status !== 'PASS')) return 'PARTIAL_BLOCKED';
  if (!HOST_PHASES.every(phase => phases[phase]?.status === 'PASS')) return 'PARTIAL_PASS_HOST_EVIDENCE_ONLY';
  return 'PASS_HOST_EVIDENCE_ONLY';
}

async function execute(options, root) {
  if (typeof process.geteuid === 'function' && process.geteuid() === 0) fail('candidate R11 host harness refuses to run as root', 'R11_HOST_ROOT_FORBIDDEN');
  if (process.env.STAY_R11_HOST_CERT_ACK !== ACK) fail(`execution requires STAY_R11_HOST_CERT_ACK=${ACK}`, 'R11_HOST_ACK');
  const labRoot = assertSafeLabRoot(options.labRoot); const actualCommit = await currentCommit(root);
  if (!/^[0-9a-f]{40}$/.test(options.candidateCommit || '') || options.candidateCommit !== actualCommit) fail('candidate commit must exactly match checked-out HEAD', 'R11_HOST_COMMIT');
  const r8 = await activeR8Units(); if (!r8.ok) fail('cannot determine active R8 units', 'R11_HOST_R8_OVERLAP'); if (r8.units.length) fail(`R8 endurance is still active: ${r8.units.join(', ')}`, 'R11_HOST_R8_OVERLAP');
  const lab = await ensureLabRoot(labRoot, actualCommit);
  const before = await liveFoundation();
  if (before.activeState !== 'active' || before.healthStatusCode !== 200 || before.health?.ok !== true) fail('live foundation unhealthy before isolated certification', 'R11_HOST_FOUNDATION');
  const phases = {};
  if (phaseEnabled(options.phases, 'sandbox')) phases.sandbox = await sandboxProbe(root, before.mainPid);
  if (phaseEnabled(options.phases, 'trust')) phases.trust = await trustProof(options, root);
  if (phaseEnabled(options.phases, 'release')) phases.release = await releaseProbe(options, labRoot, actualCommit);
  if (phaseEnabled(options.phases, 'operator')) phases.operator = await operatorProbe(root, labRoot);
  if (phaseEnabled(options.phases, 'revocation')) phases.revocation = await hostRegression(root, ['test/r11-m02-revocation.test.js']);
  if (phaseEnabled(options.phases, 'anchor')) phases.anchor = await anchorProof();
  if (phaseEnabled(options.phases, 'lifecycle')) phases.lifecycle = await hostRegression(root, ['test/hostile-closure.test.js', 'test/biological-ledger.test.js']);
  if (phaseEnabled(options.phases, 'r8')) phases.r8 = await r8Proof(options);
  if (phaseEnabled(options.phases, 'endurance')) phases.endurance = await exactCandidateEnduranceProof(options, actualCommit);
  const after = await liveFoundation(); const foundationStable = JSON.stringify(before) === JSON.stringify(after);
  if (!foundationStable) fail('live STAY foundation changed during isolated R11 certification', 'R11_HOST_LIVE_MUTATION');
  const report = { format: FORMAT, evidenceVersion: 1, runId: path.basename(labRoot), candidateCommit: actualCommit, startedAsRoot: false, productionEligible: false, liveMutationAllowed: false, liveChemistryAllowed: false, labRoot, labMarkerSha256: lab.markerSha256, protectedPaths: [...PROTECTED_PATHS], foundationBefore: before, foundationAfter: after, foundationStable, phases, status: overallStatus(phases), generatedAt: new Date().toISOString() };
  report.evidenceHash = sha256(JSON.stringify(report));
  const output = path.resolve(options.output || path.join(labRoot, 'R11_HOST_CERTIFICATION_EVIDENCE.json'));
  if (!pathInside(labRoot, output)) fail('evidence output escapes lab root', 'R11_HOST_OUTPUT_PATH');
  const [realLab, realParent] = await Promise.all([fsp.realpath(labRoot), fsp.realpath(path.dirname(output))]);
  if (!pathInside(realLab, realParent)) fail('evidence output parent escapes lab root', 'R11_HOST_OUTPUT_PATH');
  const old = await fsp.lstat(output).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)); if (old?.isSymbolicLink()) fail('evidence output may not be symlink', 'R11_HOST_OUTPUT_PATH');
  await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); return { report, output };
}

async function main() {
  const options = parseArgs(); const root = path.resolve(__dirname, '..');
  if (options.mode === 'plan') return process.stdout.write(JSON.stringify(planDocument(options), null, 2) + '\n');
  const { report, output } = await execute(options, root); process.stdout.write(JSON.stringify({ status: report.status, output, evidenceHash: report.evidenceHash }) + '\n');
  if (report.status !== 'PASS_HOST_EVIDENCE_ONLY') process.exitCode = 2;
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`); process.exitCode = 1; });
module.exports = { FORMAT, ACK, SAFE_LAB_PARENTS, HOST_PHASES, PROTECTED_PATHS, parseArgs, overlaps, assertSafeLabRoot, ensureLabRoot, planDocument, deriveBwrapParts, strictR8Acceptance, exactCandidateEnduranceProof, overallStatus };
