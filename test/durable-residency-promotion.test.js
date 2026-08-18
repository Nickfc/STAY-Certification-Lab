'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const fs =
  require('node:fs/promises');

const os =
  require('node:os');

const path =
  require('node:path');

const crypto =
  require('node:crypto');

const {
  LivingKernel
} = require(
  '../runtime'
);

const {
  stableStringify
} = require(
  '../runtime/kernel/canonical-json'
);

const {
  FORMAT,
  AUTHORIZATION_CLASS,
  identityHash,
  certificateFileName
} = require(
  '../runtime/kernel/resident-promotion-authority'
);


const MODULE =
  'cores/sntss/i3d/index.js';


async function makeHarness(t) {
  const root =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'stay-l0-b3a-'
      )
    );

  const dataDir =
    path.join(
      root,
      'state'
    );

  const authorityDir =
    path.join(
      root,
      'resident-promotions'
    );

  const publicKeyPath =
    path.join(
      root,
      'release-authority.pub'
    );

  await fs.mkdir(
    authorityDir,
    {
      recursive:
        true
    }
  );


  const {
    publicKey,
    privateKey
  } =
    crypto.generateKeyPairSync(
      'ed25519'
    );


  await fs.writeFile(
    publicKeyPath,

    publicKey.export({
      type:
        'spki',

      format:
        'pem'
    })
  );


  let now =
    1000;


  const kernel =
    new LivingKernel({
      dataDir,

      allowIdentityBootstrap:
        true,

      heartbeatIntervalMs:
        0,

      snapshotIntervalMs:
        0,

      trustedTimePulseIntervalMs:
        0,

      allowLaboratoryResidentAttachment:
        false,

      residentPromotionPublicKeyPath:
        publicKeyPath,

      residentPromotionCertificateDir:
        authorityDir,

      clock:
        () => now
    });


  await kernel.start();


  t.after(
    async () => {
      await kernel
        .stop()
        .catch(
          () => {}
        );

      await fs.rm(
        root,
        {
          recursive:
            true,

          force:
            true
        }
      );
    }
  );


  const manager =
    kernel.ensureResidentManager();


  const inspected =
    await manager.inspect(
      MODULE
    );


  function certificateBody(
    overrides = {}
  ) {
    const wall =
      Date.now();

    return {
      allowedActions:
        [
          'attach-resident'
        ],

      allowedInputs:
        [
          ...inspected
            .definition
            .manifest
            .inputs
        ],

      allowedOutputs:
        [],

      authorizationClass:
        AUTHORIZATION_CLASS,

      certificateId:
        'resident-cert-' +
        crypto.randomUUID(),

      coreId:
        inspected.definition
          .manifest.coreId,

      expiresAtMs:
        wall + 600000,

      issuedAtMs:
        wall - 1000,

      manifestHash:
        inspected.manifestHash,

      moduleHash:
        inspected.definition
          .moduleDigest,

      organismId:
        kernel.identity
          .organismId,

      organismIdentityHash:
        identityHash(
          kernel.identity
        ),

      packagePolicyHash:
        inspected.definition
          .packagePolicyHash,

      residencyId:
        manager.contract
          .residencyId,

      role:
        manager.contract
          .role,

      version:
        inspected.definition
          .manifest.version,

      ...overrides
    };
  }


  async function writeCertificate(
    body
  ) {
    const signature =
      crypto.sign(
        null,

        Buffer.from(
          stableStringify(
            body
          )
        ),

        privateKey
      ).toString(
        'base64'
      );


    const record = {
      format:
        FORMAT,

      body,

      signature
    };


    const certificatePath =
      path.join(
        authorityDir,

        certificateFileName(
          manager.contract
            .residencyId
        )
      );


    await fs.writeFile(
      certificatePath,

      JSON.stringify(
        record,
        null,
        2
      ) + '\n'
    );


    return record;
  }


  return {
    kernel,
    manager,
    inspected,
    certificateBody,
    writeCertificate,

    setNow(value) {
      now =
        value;
    }
  };
}


test(
  'L0-B3A-01: exact signed zero-authority resident certificate permits frozen I3-D attachment',
  async t => {
    const harness =
      await makeHarness(t);


    await harness
      .writeCertificate(
        harness
          .certificateBody()
      );


    await harness.kernel
      .attachResident(
        MODULE
      );


    const status =
      await harness.kernel
        .status({
          force:
            true
        });


    assert.equal(
      status.residencies.length,
      1
    );


    const resident =
      status.residencies[0];


    assert.equal(
      resident.status,
      'RUNNING'
    );


    assert.equal(
      resident.coreId,
      'sntss'
    );


    assert.equal(
      resident.version,
      '0.4.0-i3d3'
    );


    assert.equal(
      resident.declaredOutputs,
      0
    );


    assert.equal(
      resident.observedOutputs,
      0
    );


    assert.equal(
      resident.authorityOwned,
      false
    );


    assert.deepEqual(
      harness.kernel
        .stateStore
        .listAuthority(),
      []
    );


    const audit =
      harness.kernel
        .stateStore
        .db
        .prepare(`
          SELECT detail_json
          FROM recovery_records
          WHERE 1=0
        `);

    assert.ok(
      audit
    );
  }
);


test(
  'L0-B3A-02: signed R11-style or other authorization class cannot authorize residency',
  async t => {
    const harness =
      await makeHarness(t);


    await harness
      .writeCertificate(
        harness
          .certificateBody({
            authorizationClass:
              'sntss-r11-certified-activation'
          })
      );


    await assert.rejects(
      () =>
        harness.kernel
          .attachResident(
            MODULE
          ),

      error =>
        error.code ===
        'RESIDENT_PROMOTION_CLASS'
    );


    assert.deepEqual(
      harness.kernel
        .stateStore
        .listResidents(),
      []
    );


    assert.deepEqual(
      harness.kernel
        .stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B3A-03: signed certificate for another organism cannot attach resident physiology',
  async t => {
    const harness =
      await makeHarness(t);


    await harness
      .writeCertificate(
        harness
          .certificateBody({
            organismId:
              'stay-another-organism',

            organismIdentityHash:
              'sha256:' +
              'a'.repeat(64)
          })
      );


    await assert.rejects(
      () =>
        harness.kernel
          .attachResident(
            MODULE
          ),

      error =>
        error.code ===
        'RESIDENT_PROMOTION_ORGANISM'
    );


    assert.deepEqual(
      harness.kernel
        .stateStore
        .listResidents(),
      []
    );
  }
);


test(
  'L0-B3A-04: even a validly signed certificate may not grant resident biological outputs',
  async t => {
    const harness =
      await makeHarness(t);


    await harness
      .writeCertificate(
        harness
          .certificateBody({
            allowedOutputs:
              [
                'forbidden.output'
              ]
          })
      );


    await assert.rejects(
      () =>
        harness.kernel
          .attachResident(
            MODULE
          ),

      error =>
        error.code ===
        'RESIDENT_PROMOTION_OUTPUTS'
    );


    assert.deepEqual(
      harness.kernel
        .stateStore
        .listResidents(),
      []
    );


    assert.deepEqual(
      harness.kernel
        .stateStore
        .listAuthority(),
      []
    );
  }
);
