'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('P1-B0-R1 repair preserves network isolation and only restores Bubblewrap namespace setup bounds', () => {
  const service = read('deploy/systemd/stay.service');
  const sandbox = read('runtime/kernel/core-sandbox.js');
  const repair = read('deploy/live-physiology-transplant/p1-b0-sandbox-repair.sh');

  const capabilitySet = 'CAP_SETGID CAP_SETUID CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN';
  assert.match(service, new RegExp(`^CapabilityBoundingSet=${capabilitySet}$`, 'm'));
  assert.match(service, /^AmbientCapabilities=$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(sandbox, /--unshare-all.*--unshare-user.*--disable-userns.*--cap-drop.*ALL/s);
  assert.match(sandbox, /networkShared: false/);
  assert.match(repair, new RegExp(`CAPABILITIES="${capabilitySet}"`));
  assert.match(repair, /CAP_INH_HEX="0000000000200000"/);
  assert.match(repair, /CAP_BOUND_HEX="00000000002c10c0"/);
  assert.match(repair, /status_value "\$POST_PID" CapInh/);
  assert.match(repair, /for field in CapPrm CapEff CapAmb/);
  assert.match(repair, /SERVICE_PERMITTED_CAPABILITIES=NONE/);
  assert.match(repair, /SERVICE_EFFECTIVE_CAPABILITIES=NONE/);
  assert.match(repair, /SERVICE_AMBIENT_CAPABILITIES=NONE/);
  assert.match(repair, /NO_NEW_PRIVILEGES=YES/);
  assert.doesNotMatch(repair, /--share-net|networkShared: true|AmbientCapabilities=CAP_/);
});

test('P1-B0-R2 repair is pinned to the observed clean revision-54 failure and refuses a changed cause', () => {
  const repair = read('deploy/live-physiology-transplant/p1-b0-sandbox-repair.sh');
  assert.match(repair, /PRE_PID" == 77214/);
  assert.match(repair, /pre-runtime-revision-not-54/);
  assert.match(repair, /ERROR_CODE=CORE_WORKER_EXIT/);
  assert.match(repair, /bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted/);
  assert.match(repair, /live-user-probe-root-cause-changed/);
  assert.match(repair, /cmp -s "\$BASELINE_EVIDENCE\/dropin\.expected" "\$DROPIN"/);
  assert.match(repair, /STAY_B0_SANDBOX_REPAIR_AUTHORIZED/);
});

test('P1-B0-R3 repair changes only the runtime drop-in and performs one forward continuity restart', () => {
  const repair = read('deploy/live-physiology-transplant/p1-b0-sandbox-repair.sh');
  assert.match(repair, /mv -fT "\$TEMP_DROPIN" "\$DROPIN"/);
  assert.match(repair, /systemctl daemon-reload/);
  assert.match(repair, /systemctl restart stay\.service/);
  assert.match(repair, /p1-surgery-a1-state\.js" compare/);
  assert.match(repair, /CURRENT_POINTER_CHANGE=NO/);
  assert.match(repair, /TRUST_MATERIAL_CHANGE=NO/);
  assert.match(repair, /RESIDENT_OPERATION=NO/);
  assert.match(repair, /AUTHORITY_CHANGE=NO/);
  assert.doesNotMatch(repair, /attach resident:|detach resident:|\/opt\/stay\/current.*(?:ln|mv)|continuity\.sqlite3.*(?:cp|mv)|install_atomic.*(?:release-authority|resident-sntss)/);
});

test('P1-B0-R4 post-restart gate executes exact inspection and signed promotion as staydeploy', () => {
  const repair = read('deploy/live-physiology-transplant/p1-b0-sandbox-repair.sh');
  const probe = read('deploy/live-physiology-transplant/p1-b0-live-user-probe.js');
  const preflight = read('deploy/live-physiology-transplant/p1-surgery-b-preflight.sh');
  assert.match(repair, /runuser -u staydeploy/);
  assert.match(repair, /LIVE_USER_CORE_INSPECT=PASS/);
  assert.match(repair, /LIVE_USER_PROMOTION=PASS/);
  assert.match(probe, /verifyPromotion/);
  assert.match(probe, /ERROR_MESSAGE=/);
  assert.match(preflight, /P1_B0_SANDBOX_REPAIR_FORMAT=stay-p1-b0-sandbox-repair-v3/);
  assert.doesNotMatch(preflight, /run_live_user_probe/);
  assert.match(preflight, /LIVE_SERVICE_SANDBOX_CONTEXT=PASS/);
  assert.match(preflight, /OUT_OF_PROCESS_SANDBOX_PROBE=NOT_APPLICABLE/);
  assert.match(preflight, /REPAIRED_REVISION > 54/);
});

test('P1-B0-R5 historical repair remains fixed and is absent from the R116F controller', () => {
  const remote = read('deploy/live-physiology-transplant/p1-actions-remote-controller.sh');
  const wrapper = read('deploy/live-physiology-transplant/stay-p1-production-controller');
  assert.match(remote, /repair-b0-sandbox/);
  assert.match(remote, /STAY_B0_SANDBOX_REPAIR_AUTHORIZED/);
  assert.doesNotMatch(wrapper, /repair-b0-sandbox|AUTHORIZE_B0_SANDBOX_REPAIR|B0_SANDBOX_REPAIR_RESULT/);
  assert.match(wrapper, /harden-r116f\)/);
  assert.match(wrapper, /recover-r116f\)/);
  assert.doesNotMatch(remote.match(/repair-b0-sandbox\)[\s\S]*?;;/)?.[0] || '', /attach|surgery-b-execute/);
});

test('P1-B0-R6 forward completion seals the exact revision-56 repair without another service or biological operation', () => {
  const completion = read('deploy/live-physiology-transplant/p1-b0-sandbox-repair-complete.sh');
  const remote = read('deploy/live-physiology-transplant/p1-actions-remote-controller.sh');
  const wrapper = read('deploy/live-physiology-transplant/stay-p1-production-controller');
  const launcher = read('.github/workflows/p1-production-controller-launcher.yml');
  const bootstrap = read('.github/workflows/p1-b0-sandbox-repair-bootstrap.yml');

  assert.match(completion, /EXPECTED_PID="82673"/);
  assert.match(completion, /EXPECTED_REVISION="56"/);
  assert.match(completion, /EXPECTED_DROPIN_SHA256="6225ba2a5b89031cf73fa12ff7fd959a798c3e8518db3c5be9c970983f29f71f"/);
  assert.match(completion, /stat -Lc '%U:%G' "\$EVIDENCE_DIR"/);
  assert.match(completion, /EVIDENCE_DIR_MODE" == 700 \|\| "\$EVIDENCE_DIR_MODE" == 2700/);
  assert.match(completion, /-d "\$EVIDENCE_DIR" && ! -L "\$EVIDENCE_DIR"/);
  assert.doesNotMatch(completion, /stat -Lc '%U:%G:%a:%h' "\$EVIDENCE_DIR"/);
  assert.match(completion, /EXPECTED_INITIAL_FILES=/);
  assert.match(completion, /root_regular "\$EVIDENCE_DIR\/\$file"/);
  assert.match(completion, /CAP_INH_HEX="0000000000200000"/);
  assert.match(completion, /CAP_BOUND_HEX="00000000002c10c0"/);
  assert.match(completion, /NoNewPrivs/);
  assert.match(completion, /p1-surgery-a1-state\.js" compare/);
  assert.doesNotMatch(completion, /run_live_user_probe/);
  assert.match(completion, /LIVE_SERVICE_SANDBOX_CONTEXT=PASS/);
  assert.match(completion, /OUT_OF_PROCESS_SANDBOX_PROBE=NOT_APPLICABLE/);
  assert.match(completion, /SIGNED_PROMOTION=PASS/);
  assert.match(completion, /LABORATORY_BYPASS=NO/);
  assert.match(completion, /SERVICE_RESTARTED=NO/);
  assert.match(completion, /DAEMON_RELOAD=NO/);
  assert.match(completion, /STATESTORE_WRITE=NO/);
  assert.match(completion, /RESIDENT_OPERATION=NO/);
  assert.match(completion, /AUTHORITY_CHANGE=NO/);
  assert.doesNotMatch(completion, /systemctl\s+(?:restart|stop|start|daemon-reload)|attach resident:|detach resident:|\/opt\/stay\/current.*(?:ln|mv)|continuity\.sqlite3.*(?:cp|mv)/);
  assert.match(remote, /complete-b0-sandbox-repair/);
  assert.match(remote, /STAY_B0_SANDBOX_REPAIR_COMPLETE_AUTHORIZED/);
  assert.doesNotMatch(wrapper,
    /complete-b0-sandbox-repair|AUTHORIZE_B0_SANDBOX_REPAIR_COMPLETION|B0_SANDBOX_REPAIR_COMPLETION_RESULT/);
  assert.match(launcher, /complete-b0-sandbox-repair/);
  assert.match(bootstrap, /ROOT_MODE" == 700 \|\| "\$ROOT_MODE" == 2700/);
});
