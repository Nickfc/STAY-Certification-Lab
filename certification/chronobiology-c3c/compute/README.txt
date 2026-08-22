STAY Chronobiology C3-C compute-only certification
==================================================

Authorized orchestration repository:

  Nickfc/STAY-Certification-Lab (PUBLIC)

The source checkout must be the private Nickfc/STAY-Genesis repository at an
exact detached commit. It must be checked out with the dedicated read-only
deploy key in STAY_GENESIS_READONLY_DEPLOY_KEY, with credential persistence
disabled. No token-based private-source checkout is part of this contract.
The caller supplies the full 40-hex candidate SHA and a private absolute output
directory outside the checkout. GITHUB_REPOSITORY, or the explicit
--lab-repository argument, must equal Nickfc/STAY-Certification-Lab.

Public Actions invocation contract (PUBLIC_RUN.sh is mandatory):

  bash certification/chronobiology-c3c/compute/PUBLIC_RUN.sh \
    "$CANDIDATE_SHA" \
    >"$RUNNER_TEMP/COMPUTE_RESULT.sanitized.json"

PUBLIC_LAB_WORKFLOW.yml.example is the canonical pinned Actions contract. It
uploads only COMPUTE_RESULT.sanitized.json and never uploads the private raw
directory.

PREPARE_ENCRYPTED_FIXTURE.sh is the offline material-preparation gate. It accepts
only the canonical hash-bound source.tar.gz, explicitly refuses paths under
/opt/stay and /var/lib/stay, and writes AES-256 GPG ciphertext for the public Lab
fixture path. The plaintext archive is never committed.

Preconditions:

  * detached HEAD equals CANDIDATE_SHA and the worktree is clean;
  * the public Lab checkout contains only AES-256 GPG ciphertext at
    fixtures/legacy-0.6.0/source.tar.gz.gpg;
  * STAY_LEGACY_0_6_FIXTURE_PASSPHRASE decrypts that ciphertext ephemerally;
  * Node satisfies package.json and Unix-domain sockets work;
  * CPU steal is at most 5 percent during preflight and the complete run;
  * raw evidence storage is private and outside the source checkout.

The runner executes the Chronobiology direct suite, every targeted residency,
BSF, CoreHost, trusted-time and SNTSS regression, and the complete repository
suite. Every suite must report zero failures, skips, todos and cancellations.
The frozen 250 ms one-year catch-up gate is measured independently and is also
exercised by the direct containment suite.

The fixture builder passes the secret to GPG over stdin, never a process
argument. It verifies the decrypted archive against the SHA-256 committed in
legacy/0.6.0/SOURCE_ARCHIVE_SHA256, extracts in a private temporary directory,
verifies all eight files against SOURCE_FILES, and creates only a read-only
ephemeral fixture. The passphrase and material-path variables are unset before
tests start. No live-organism state or data is used.

Raw TAP, stack traces, process inventories, source tree and environment captures
remain mode-0700/0600 under RUNNER_TEMP while the runner is active. They and the
ephemeral legacy fixture are destroyed on both success and failure. They must
never be printed or uploaded as a plaintext public artifact. The only plaintext
public/cross-host artifact is:

  <output-root>/COMPUTE_RESULT.sanitized.json

PUBLIC_RUN.sh redirects all internal output and failures into the ephemeral
private root. It emits only the sanitized JSON after every acceptance gate has
passed. This runner does not inspect, create, emulate or modify stay.service,
/opt/stay/current, live StateStore or any live-organism sentinel.

Required Actions secrets (names only):

  STAY_GENESIS_READONLY_DEPLOY_KEY
  STAY_LEGACY_0_6_FIXTURE_PASSPHRASE
