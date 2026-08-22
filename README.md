# STAY Certification Lab

Public orchestration repository for reproducible, compute-only certification runs against the private `Nickfc/STAY-Genesis` repository.

This repository intentionally contains **no STAY runtime source, Chronobiology source, SNTSS source, live organism state, raw TAP output, stack traces, process inventories, or plaintext legacy fixture material**.

## Chronobiology C3-C

The public workflow is started manually with `workflow_dispatch` and accepts an exact 40-character STAY-Genesis candidate SHA. The runner:

1. checks out this public orchestration repository;
2. checks out the exact private STAY-Genesis candidate using a dedicated read-only deploy key;
3. decrypts the sealed legacy certification fixture only inside the ephemeral GitHub runner;
4. runs the private silent certification entrypoint;
5. uploads only `COMPUTE_RESULT.sanitized.json`.

Raw evidence and decrypted fixture material remain ephemeral and are destroyed on success or failure.

The compute result alone is **not** a final C3-C seal. It must later be bound to the independent read-only live-host sentinel result from the actual STAY host, with matching candidate SHA, tree and compute-record digest.

## Required Actions secrets

Only the names are documented here:

- `STAY_GENESIS_READONLY_DEPLOY_KEY`
- `STAY_LEGACY_0_6_FIXTURE_PASSPHRASE`

Never commit secret values or plaintext fixture material to this repository.

## Public disclosure boundary

The only permitted plaintext certification artifact is the sanitized compute result. If a workflow failure produces private source text, raw test output, stack traces, fixture contents, or other private evidence in public logs or artifacts, treat that as a disclosure incident and stop using the workflow until reviewed.
