'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { StateStore } =
  require('../runtime/kernel/state-store');

const {
  TrustedOrganismTime,
  STATUS,
  STATE_PROTOCOL,
  BOOTSTRAP_PROTOCOL,
  CONTINUITY_PROOF_PROTOCOL
} =
  require('../runtime/kernel/trusted-organism-time');

async function makeDir() {
  return fs.mkdtemp(
    path.join(
      os.tmpdir(),
      'stay-ef1a-trusted-time-'
    )
  );
}

async function openStore(dir) {
  const store = new StateStore(dir);
  await store.init();
  return store;
}

async function cleanup(dir, ...stores) {
  for (const store of stores) {
    if (!store) continue;

    try {
      store.close();
    } catch {}
  }

  await fs.rm(
    dir,
    {
      recursive: true,
      force: true
    }
  );
}

function bootstrap(
  organismId,
  trustedTimeUs = 0,
  proofId = 'bootstrap-proof'
) {
  return {
    protocol:
      BOOTSTRAP_PROTOCOL,

    organismId,

    trustedTimeUs,

    proofId
  };
}

function continuityProof({
  organismId,
  fromBootId,
  toBootId,
  anchorTrustedTimeUs,
  elapsedSinceAnchorUs,
  proofId = 'continuity-proof'
}) {
  return {
    protocol:
      CONTINUITY_PROOF_PROTOCOL,

    organismId,

    fromBootId,
    toBootId,

    anchorTrustedTimeUs,
    elapsedSinceAnchorUs,

    proofId,

    trusted:
      true
  };
}

function makeClock({
  store,
  organismId,
  boot,
  mono,
  verifiedProofIds = new Set()
}) {
  return new TrustedOrganismTime({
    stateStore:
      store,

    organismId,

    bootIdProvider:
      () => boot.value,

    monotonicNowUs:
      () => mono.value,

    continuityProofVerifier:
      async proof =>
        verifiedProofIds.has(
          proof?.proofId
        )
  });
}


test(
  'EF1-A bootstrap creates one persistent trusted organism timeline and wall time cannot drive it',
  async () => {
    const dir =
      await makeDir();

    let store;

    const organismId =
      'stay-ef1a-bootstrap';

    const boot = {
      value:
        'boot-a'
    };

    const mono = {
      value:
        1_000_000
    };

    const originalDateNow =
      Date.now;

    try {
      store =
        await openStore(dir);

      const clock =
        makeClock({
          store,
          organismId,
          boot,
          mono
        });

      const started =
        await clock.start({
          bootstrap:
            bootstrap(
              organismId,
              5_000_000,
              'migration-seed-1'
            )
        });

      assert.equal(
        started.protocol,
        STATE_PROTOCOL
      );

      assert.equal(
        started.status,
        STATUS.TRUSTED
      );

      assert.equal(
        started.trustedTimeUs,
        5_000_000
      );

      assert.equal(
        started.continuityEpoch,
        1
      );

      Date.now =
        () => 9_000_000_000_000;

      mono.value +=
        2_500;

      const forward =
        await clock.sample();

      assert.equal(
        forward.trustedTimeUs,
        5_002_500
      );

      Date.now =
        () => 1;

      const rewoundWall =
        await clock.sample();

      assert.equal(
        rewoundWall.trustedTimeUs,
        5_002_500
      );

      const checkpoint =
        await clock.checkpoint();

      assert.equal(
        checkpoint.trustedTimeUs,
        5_002_500
      );

      const persisted =
        await store.readLife(
          'trusted-organism-time',
          null
        );

      assert.equal(
        persisted.organismId,
        organismId
      );

      assert.equal(
        persisted.status,
        STATUS.TRUSTED
      );

      assert.equal(
        persisted.trustedTimeUs,
        5_002_500
      );

      assert.equal(
        persisted.bootId,
        'boot-a'
      );
    } finally {
      Date.now =
        originalDateNow;

      await cleanup(
        dir,
        store
      );
    }
  }
);


test(
  'EF1-A same-boot process restart continues from persisted monotonic anchor and cannot be re-bootstraped',
  async () => {
    const dir =
      await makeDir();

    const organismId =
      'stay-ef1a-same-boot';

    const boot = {
      value:
        'boot-a'
    };

    const mono = {
      value:
        10_000
    };

    let firstStore;
    let secondStore;

    try {
      firstStore =
        await openStore(dir);

      const first =
        makeClock({
          store:
            firstStore,

          organismId,
          boot,
          mono
        });

      await first.start({
        bootstrap:
          bootstrap(
            organismId,
            500_000,
            'bootstrap-a'
          )
      });

      mono.value =
        16_000;

      const committed =
        await first.checkpoint();

      assert.equal(
        committed.trustedTimeUs,
        506_000
      );

      firstStore.close();
      firstStore = null;

      secondStore =
        await openStore(dir);

      /*
       * Four milliseconds of trusted monotonic
       * time elapsed after the durable anchor.
       */
      mono.value =
        20_000;

      const restarted =
        makeClock({
          store:
            secondStore,

          organismId,
          boot,
          mono
        });

      const recovered =
        await restarted.start({
          /*
           * Existing canonical time MUST win.
           * A second bootstrap is not allowed
           * to reset or rewrite the timeline.
           */
          bootstrap:
            bootstrap(
              organismId,
              1,
              'attempted-reset'
            )
        });

      assert.equal(
        recovered.status,
        STATUS.TRUSTED
      );

      assert.equal(
        recovered.trustedTimeUs,
        510_000
      );

      assert.equal(
        recovered.continuityEpoch,
        1
      );
    } finally {
      await cleanup(
        dir,
        firstStore,
        secondStore
      );
    }
  }
);


test(
  'EF1-A certified whole-host continuity advances by exactly the proven elapsed interval',
  async () => {
    const dir =
      await makeDir();

    const organismId =
      'stay-ef1a-certified-host-gap';

    const boot = {
      value:
        'boot-a'
    };

    const mono = {
      value:
        10_000
    };

    let firstStore;
    let secondStore;

    try {
      firstStore =
        await openStore(dir);

      const first =
        makeClock({
          store:
            firstStore,

          organismId,
          boot,
          mono
        });

      await first.start({
        bootstrap:
          bootstrap(
            organismId,
            500_000,
            'bootstrap-host-gap'
          )
      });

      mono.value =
        16_000;

      const anchor =
        await first.checkpoint();

      assert.equal(
        anchor.trustedTimeUs,
        506_000
      );

      firstStore.close();
      firstStore = null;

      boot.value =
        'boot-b';

      mono.value =
        100;

      secondStore =
        await openStore(dir);

      const second =
        makeClock({
          store:
            secondStore,

          organismId,
          boot,
          mono,

          verifiedProofIds:
            new Set([
              'host-gap-proof-1'
            ])
        });

      const recovered =
        await second.start({
          continuityProof:
            continuityProof({
              organismId,
              fromBootId:
                'boot-a',

              toBootId:
                'boot-b',

              anchorTrustedTimeUs:
                506_000,

              elapsedSinceAnchorUs:
                123_456,

              proofId:
                'host-gap-proof-1'
            })
        });

      assert.equal(
        recovered.status,
        STATUS.TRUSTED
      );

      assert.equal(
        recovered.trustedTimeUs,
        629_456
      );

      assert.equal(
        recovered.continuityEpoch,
        2
      );

      assert.equal(
        recovered.bootId,
        'boot-b'
      );

      assert.equal(
        recovered.lastProofId,
        'host-gap-proof-1'
      );
    } finally {
      await cleanup(
        dir,
        firstStore,
        secondStore
      );
    }
  }
);


test(
  'EF1-A unproven whole-host downtime becomes TRUSTED_TIME_UNCERTAIN and never guesses catch-up',
  async () => {
    const dir =
      await makeDir();

    const organismId =
      'stay-ef1a-uncertain-gap';

    const boot = {
      value:
        'boot-a'
    };

    const mono = {
      value:
        10_000
    };

    let firstStore;
    let secondStore;

    try {
      firstStore =
        await openStore(dir);

      const first =
        makeClock({
          store:
            firstStore,

          organismId,
          boot,
          mono
        });

      await first.start({
        bootstrap:
          bootstrap(
            organismId,
            800_000,
            'bootstrap-uncertain'
          )
      });

      mono.value =
        20_000;

      await first.checkpoint();

      firstStore.close();
      firstStore = null;

      boot.value =
        'boot-b';

      mono.value =
        100;

      secondStore =
        await openStore(dir);

      const second =
        makeClock({
          store:
            secondStore,

          organismId,
          boot,
          mono
        });

      const uncertain =
        await second.start();

      assert.equal(
        uncertain.status,
        STATUS.UNCERTAIN
      );

      assert.equal(
        uncertain.trustedTimeUs,
        810_000
      );

      assert.equal(
        uncertain.reasonCode,
        'TRUSTED_TIME_CONTINUITY_UNPROVEN'
      );

      /*
       * Local monotonic time after the unknown
       * host gap cannot magically repair the
       * missing absolute continuity.
       */
      mono.value =
        9_000_000;

      const later =
        await second.sample();

      assert.equal(
        later.status,
        STATUS.UNCERTAIN
      );

      assert.equal(
        later.trustedTimeUs,
        810_000
      );

      const persisted =
        await secondStore.readLife(
          'trusted-organism-time',
          null
        );

      assert.equal(
        persisted.status,
        STATUS.UNCERTAIN
      );

      assert.equal(
        persisted.observedBootId,
        'boot-b'
      );
    } finally {
      await cleanup(
        dir,
        firstStore,
        secondStore
      );
    }
  }
);


test(
  'EF1-A malformed or mismatched continuity proof cannot advance organism time',
  async () => {
    const dir =
      await makeDir();

    const organismId =
      'stay-ef1a-bad-proof';

    const boot = {
      value:
        'boot-a'
    };

    const mono = {
      value:
        100
    };

    let firstStore;
    let secondStore;

    try {
      firstStore =
        await openStore(dir);

      const first =
        makeClock({
          store:
            firstStore,

          organismId,
          boot,
          mono
        });

      await first.start({
        bootstrap:
          bootstrap(
            organismId,
            1_000_000,
            'bootstrap-proof-test'
          )
      });

      mono.value =
        1_100;

      await first.checkpoint();

      firstStore.close();
      firstStore = null;

      boot.value =
        'boot-b';

      mono.value =
        50;

      secondStore =
        await openStore(dir);

      const second =
        makeClock({
          store:
            secondStore,

          organismId,
          boot,
          mono,

          verifiedProofIds:
            new Set([
              'forged-proof'
            ])
        });

      const result =
        await second.start({
          continuityProof:
            continuityProof({
              organismId,
              fromBootId:
                'boot-a',

              toBootId:
                'boot-b',

              /*
               * Deliberately forged anchor.
               */
              anchorTrustedTimeUs:
                999,

              elapsedSinceAnchorUs:
                5_000_000,

              proofId:
                'forged-proof'
            })
        });

      assert.equal(
        result.status,
        STATUS.UNCERTAIN
      );

      assert.equal(
        result.reasonCode,
        'TRUSTED_TIME_PROOF_INVALID'
      );

      assert.equal(
        result.trustedTimeUs,
        1_001_000
      );
    } finally {
      await cleanup(
        dir,
        firstStore,
        secondStore
      );
    }
  }
);


test(
  'EF1-A monotonic source rewind fails closed into uncertainty instead of rewinding biology',
  async () => {
    const dir =
      await makeDir();

    const organismId =
      'stay-ef1a-mono-rewind';

    const boot = {
      value:
        'boot-a'
    };

    const mono = {
      value:
        10_000
    };

    let firstStore;
    let secondStore;

    try {
      firstStore =
        await openStore(dir);

      const first =
        makeClock({
          store:
            firstStore,

          organismId,
          boot,
          mono
        });

      await first.start({
        bootstrap:
          bootstrap(
            organismId,
            300_000,
            'bootstrap-rewind'
          )
      });

      mono.value =
        16_000;

      await first.checkpoint();

      firstStore.close();
      firstStore = null;

      /*
       * Same boot ID with a smaller monotonic
       * value is impossible under a healthy
       * source and must fail closed.
       */
      mono.value =
        15_000;

      secondStore =
        await openStore(dir);

      const second =
        makeClock({
          store:
            secondStore,

          organismId,
          boot,
          mono
        });

      const result =
        await second.start();

      assert.equal(
        result.status,
        STATUS.UNCERTAIN
      );

      assert.equal(
        result.reasonCode,
        'TRUSTED_TIME_MONOTONIC_REWIND'
      );

      assert.equal(
        result.trustedTimeUs,
        306_000
      );

      const persisted =
        await secondStore.readLife(
          'trusted-organism-time',
          null
        );

      assert.equal(
        persisted.status,
        STATUS.UNCERTAIN
      );
    } finally {
      await cleanup(
        dir,
        firstStore,
        secondStore
      );
    }
  }
);


test(
  'EF1-A persisted organism binding cannot be reopened under a different organism identity',
  async () => {
    const dir =
      await makeDir();

    const boot = {
      value:
        'boot-a'
    };

    const mono = {
      value:
        1_000
    };

    let firstStore;
    let secondStore;

    try {
      firstStore =
        await openStore(dir);

      const first =
        makeClock({
          store:
            firstStore,

          organismId:
            'stay-organism-a',

          boot,
          mono
        });

      await first.start({
        bootstrap:
          bootstrap(
            'stay-organism-a',
            42_000,
            'bootstrap-organism-a'
          )
      });

      await first.checkpoint();

      firstStore.close();
      firstStore = null;

      secondStore =
        await openStore(dir);

      const wrongOrganism =
        makeClock({
          store:
            secondStore,

          organismId:
            'stay-organism-b',

          boot,
          mono
        });

      await assert.rejects(
        () =>
          wrongOrganism.start(),

        error =>
          error &&
          error.code ===
            'TRUSTED_TIME_ORGANISM_MISMATCH'
      );
    } finally {
      await cleanup(
        dir,
        firstStore,
        secondStore
      );
    }
  }
);


test(
  'EF1-A a perfectly formed self-asserted continuity proof cannot authorize its own time advance',
  async () => {
    const dir =
      await makeDir();

    const organismId =
      'stay-ef1a-unverified-proof';

    const boot = {
      value:
        'boot-a'
    };

    const mono = {
      value:
        1_000
    };

    let firstStore;
    let secondStore;

    try {
      firstStore =
        await openStore(dir);

      const first =
        makeClock({
          store:
            firstStore,

          organismId,
          boot,
          mono
        });

      await first.start({
        bootstrap:
          bootstrap(
            organismId,
            700_000,
            'bootstrap-unverified-proof'
          )
      });

      mono.value =
        2_000;

      const anchor =
        await first.checkpoint();

      assert.equal(
        anchor.trustedTimeUs,
        701_000
      );

      firstStore.close();
      firstStore = null;

      boot.value =
        'boot-b';

      mono.value =
        100;

      secondStore =
        await openStore(dir);

      /*
       * No proof ID is registered with the trusted
       * verifier. The proof is structurally perfect
       * and even says trusted:true, but that statement
       * carries zero authority.
       */
      const second =
        makeClock({
          store:
            secondStore,

          organismId,
          boot,
          mono
        });

      const result =
        await second.start({
          continuityProof:
            continuityProof({
              organismId,
              fromBootId:
                'boot-a',

              toBootId:
                'boot-b',

              anchorTrustedTimeUs:
                701_000,

              elapsedSinceAnchorUs:
                9_999_999,

              proofId:
                'self-asserted-proof'
            })
        });

      assert.equal(
        result.status,
        STATUS.UNCERTAIN
      );

      assert.equal(
        result.reasonCode,
        'TRUSTED_TIME_PROOF_UNVERIFIED'
      );

      assert.equal(
        result.trustedTimeUs,
        701_000
      );

      const persisted =
        await secondStore.readLife(
          'trusted-organism-time',
          null
        );

      assert.equal(
        persisted.trustedTimeUs,
        701_000
      );

      assert.equal(
        persisted.status,
        STATUS.UNCERTAIN
      );
    } finally {
      await cleanup(
        dir,
        firstStore,
        secondStore
      );
    }
  }
);


test(
  'EF1-A corrupt persisted continuity state is rejected rather than silently regenerated',
  async () => {
    const dir =
      await makeDir();

    let store;

    try {
      store =
        await openStore(dir);

      await store.writeLife(
        'trusted-organism-time',
        {
          protocol:
            'corrupt-time-state',

          trustedTimeUs:
            -1
        }
      );

      const boot = {
        value:
          'boot-a'
      };

      const mono = {
        value:
          1_000
      };

      const clock =
        makeClock({
          store,

          organismId:
            'stay-corrupt-test',

          boot,
          mono
        });

      await assert.rejects(
        () =>
          clock.start({
            bootstrap:
              bootstrap(
                'stay-corrupt-test',
                0,
                'do-not-regenerate'
              )
          }),

        error =>
          error &&
          error.code ===
            'TRUSTED_TIME_STATE_INVALID'
      );
    } finally {
      await cleanup(
        dir,
        store
      );
    }
  }
);
