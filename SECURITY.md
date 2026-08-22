# Security boundary

`STAY-Certification-Lab` is intentionally public. Its purpose is orchestration only.

The following material must never be committed, printed to Actions logs, or uploaded as a plaintext artifact:

- private STAY source code;
- Chronobiology or SNTSS implementation source;
- raw TAP/test output;
- stack traces containing private source details;
- process/source inventories;
- live organism state or StateStore data;
- plaintext legacy fixture archives or extracted fixture files;
- deploy-key private material or fixture passphrases.

Only `COMPUTE_RESULT.sanitized.json` is permitted as a plaintext certification artifact.

The private STAY checkout must use the dedicated read-only deploy key secret `STAY_GENESIS_READONLY_DEPLOY_KEY` with credential persistence disabled.

The encrypted legacy fixture may be stored only as ciphertext at `fixtures/legacy-0.6.0/source.tar.gz.gpg`. Its passphrase is supplied only through the Actions secret `STAY_LEGACY_0_6_FIXTURE_PASSPHRASE`.

The workflow is manual-only (`workflow_dispatch`). Pull requests, pushes, forks and schedules must not trigger certification.
