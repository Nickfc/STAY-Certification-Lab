'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const trusted =
  require('../deploy/trusted-release-verifier');

const release =
  require('../runtime/release/sntss-release-control');

const repositoryRoot =
  path.resolve(__dirname, '..');

function excludedFromFixture(relative) {
  return (
    relative === '.git' ||
    relative.startsWith('.git/') ||
    relative === '.stay-data' ||
    relative.startsWith('.stay-data/') ||
    relative === 'data' ||
    relative.startsWith('data/') ||
    relative === 'release-output' ||
    relative.startsWith('release-output/') ||
    relative === 'node_modules' ||
    relative.startsWith('node_modules/')
  );
}

async function fixture(productionEligible) {
  const base =
    await fsp.mkdtemp(
      path.join(
        os.tmpdir(),
        'stay-p3b-'
      )
    );

  const root =
    path.join(base, 'release');

  const external =
    path.join(base, 'external');

  await fsp.mkdir(
    external,
    {
      recursive: true
    }
  );

  /*
   * Use the same shape as a real STAY release.
   * This is deliberately based on the repository
   * rather than a hand-built miniature fixture.
   */
  await fsp.cp(
    repositoryRoot,
    root,
    {
      recursive: true,

      filter(source) {
        const relative =
          path
            .relative(
              repositoryRoot,
              source
            )
            .split(path.sep)
            .join('/');

        if (!relative) {
          return true;
        }

        return !excludedFromFixture(
          relative
        );
      }
    }
  );

  const packageJson =
    JSON.parse(
      await fsp.readFile(
        path.join(
          root,
          'package.json'
        ),
        'utf8'
      )
    );

  const version =
    String(
      packageJson.stayVersion ||
      packageJson.version ||
      ''
    );

  assert.notEqual(
    version,
    ''
  );

  const commit =
    'a'.repeat(40);

  const documents =
    await release.createReleaseDocuments(
      root,
      {
        version,
        commit,
        builder:
          'p3b-test',
        branch:
          'p3b-regression',
        productionEligible
      }
    );

  /*
   * Match writeReleaseDocuments exactly:
   * provenance carries its dependency inventory.
   */
  await fsp.writeFile(
    path.join(
      root,
      'RELEASE_INVENTORY.json'
    ),
    JSON.stringify(
      documents.inventory,
      null,
      2
    ) + '\n'
  );

  await fsp.writeFile(
    path.join(
      root,
      'RELEASE_PROVENANCE.json'
    ),
    JSON.stringify(
      {
        ...documents.provenance,
        dependencies:
          documents.dependencies
      },
      null,
      2
    ) + '\n'
  );

  const {
    publicKey,
    privateKey
  } =
    crypto.generateKeyPairSync(
      'ed25519'
    );

  const publicKeyPath =
    path.join(
      external,
      'release-authority.pub'
    );

  const privateKeyPath =
    path.join(
      external,
      'release-authority-private.pem'
    );

  await fsp.writeFile(
    publicKeyPath,
    publicKey.export({
      type: 'spki',
      format: 'pem'
    })
  );

  await fsp.writeFile(
    privateKeyPath,
    privateKey.export({
      type: 'pkcs8',
      format: 'pem'
    }),
    {
      mode: 0o600
    }
  );

  /*
   * Synthetic archive is external to release root,
   * exactly like the real deployer relationship.
   */
  const archive =
    path.join(
      external,
      'candidate.tar.gz'
    );

  await fsp.writeFile(
    archive,
    'p3b-external-archive'
  );

  const inventoryHash =
    await trusted.verifyInventory(
      root,
      documents.inventory
    );

  const provenanceHash =
    trusted.verifyProvenance(
      {
        ...documents.provenance,
        dependencies:
          documents.dependencies
      },
      inventoryHash,
      version,
      commit
    );

  const archiveSha256 =
    trusted.sha256(
      await fsp.readFile(
        archive
      )
    );

  return {
    base,
    root,
    external,
    version,
    commit,
    archive,
    publicKeyPath,
    privateKeyPath,
    privateKey,
    inventoryHash,
    provenanceHash,
    archiveSha256,
    provenance: {
      ...documents.provenance,
      dependencies:
        documents.dependencies
    }
  };
}

function authorization(
  f,
  action
) {
  const now =
    Date.now();

  const body = {
    allowedActions: [
      action
    ],

    archiveSha256:
      f.archiveSha256,

    authorizationClass:
      'p3b-regression',

    commit:
      f.commit,

    inventoryHash:
      f.inventoryHash,

    issuedAtMs:
      now,

    nonce:
      '0123456789abcdef0123456789abcdef',

    provenanceHash:
      f.provenanceHash,

    version:
      f.version,

    expiresAtMs:
      now + 600000
  };

  const signature =
    crypto.sign(
      null,
      Buffer.from(
        trusted.stableStringify(
          body
        )
      ),
      f.privateKey
    ).toString('base64');

  const file =
    path.join(
      f.external,
      `authorization-${action}.json`
    );

  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        format:
          trusted.AUTH_FORMAT,
        body,
        signature
      },
      null,
      2
    ) + '\n'
  );

  return file;
}

function cleanup(t, fixture) {
  t.after(async () => {
    await fsp.rm(
      fixture.base,
      {
        recursive: true,
        force: true
      }
    );
  });
}

test(
  'P3B-01 provenance requires productionEligible boolean',
  async t => {
    const f =
      await fixture(false);

    cleanup(t, f);

    const malformed = {
      ...f.provenance
    };

    delete malformed.productionEligible;

    assert.throws(
      () =>
        trusted.verifyProvenance(
          malformed,
          f.inventoryHash,
          f.version,
          f.commit
        ),
      /productionEligible.*boolean/i
    );
  }
);

test(
  'P3B-02 activation fails closed for non-production release',
  async t => {
    const f =
      await fixture(false);

    cleanup(t, f);

    const auth =
      authorization(
        f,
        'activate'
      );

    await assert.rejects(
      trusted.verifyCli([
        '--root',
        f.root,

        '--archive',
        f.archive,

        '--authorization',
        auth,

        '--public-key',
        f.publicKeyPath,

        '--expected-version',
        f.version,

        '--expected-commit',
        f.commit,

        '--action',
        'activate'
      ]),
      error =>
        error &&
        error.code ===
          'STAY_RELEASE_NOT_PRODUCTION_ELIGIBLE'
    );
  }
);

test(
  'P3B-03 historical non-production release remains verifiable',
  async t => {
    const f =
      await fixture(false);

    cleanup(t, f);

    const auth =
      authorization(
        f,
        'verify'
      );

    const result =
      await trusted.verifyCli([
        '--root',
        f.root,

        '--archive',
        f.archive,

        '--authorization',
        auth,

        '--public-key',
        f.publicKeyPath,

        '--expected-version',
        f.version,

        '--expected-commit',
        f.commit,

        '--action',
        'verify'
      ]);

    assert.equal(
      result.status,
      'PASS'
    );

    assert.equal(
      result.action,
      'verify'
    );
  }
);

test(
  'P3B-04 production release passes activation gate',
  async t => {
    const f =
      await fixture(true);

    cleanup(t, f);

    const auth =
      authorization(
        f,
        'activate'
      );

    const result =
      await trusted.verifyCli([
        '--root',
        f.root,

        '--archive',
        f.archive,

        '--authorization',
        auth,

        '--public-key',
        f.publicKeyPath,

        '--expected-version',
        f.version,

        '--expected-commit',
        f.commit,

        '--action',
        'activate'
      ]);

    assert.equal(
      result.status,
      'PASS'
    );

    assert.equal(
      result.action,
      'activate'
    );
  }
);

test(
  'P3B-05 offline signer refuses non-production activation',
  async t => {
    const f =
      await fixture(false);

    cleanup(t, f);

    const output =
      path.join(
        f.external,
        'forbidden.authorization.json'
      );

    const signer =
      path.join(
        repositoryRoot,
        'tools',
        'sign-release-authorization.js'
      );

    const run =
      spawnSync(
        process.execPath,
        [
          signer,

          '--private-key',
          f.privateKeyPath,

          '--root',
          f.root,

          '--archive',
          f.archive,

          '--output',
          output,

          '--version',
          f.version,

          '--commit',
          f.commit,

          '--actions',
          'activate'
        ],
        {
          encoding:
            'utf8'
        }
      );

    assert.notEqual(
      run.status,
      0
    );

    assert.match(
      run.stderr,
      /refusing activation authorization for non-production release/i
    );

    assert.equal(
      fs.existsSync(
        output
      ),
      false
    );
  }
);
