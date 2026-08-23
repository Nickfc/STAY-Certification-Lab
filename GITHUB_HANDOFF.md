# GitHub Handoff — STAY 0.8.11.3

This directory is a complete repository tree based on `Nickfc/STAY-Genesis` branch
`agent/living-runtime-0.7.0` at commit
`41f7c5fabfae10de398b63f1ca7b5f2bc694264b`.

## What to upload

Upload the contents of this directory to the repository root, including `.github/`,
and remove the old `runtime/kernel/instance.js` file if it still exists there.
Do not upload runtime-generated `.stay-data/`, SQLite, log or temporary files.
Verify the supplied `HANDOFF_MANIFEST.sha256` before copying the files.

Every workflow capable of writing to Lightsail is manual-only (`workflow_dispatch`).
Placing these files in GitHub does not upload or deploy STAY. The ordinary test
workflow runs on push/pull request but has no deployment secret or external-write step.

## Verify before committing

Use Node.js 24, then run:

```sh
node --test --test-concurrency=1 test/*.test.js
node scripts/continuity-check.js
node scripts/failure-injection-lab.js
node --test --test-concurrency=1 test/hostile-closure.test.js
node scripts/endurance-runner.js --seconds 15
```

The smoke result is deliberately labeled `PASS-SMOKE-NOT-CERTIFICATION`. The implementation is intentionally labeled `pre-certification`. The 24-hour and
72-hour mixed-device endurance gates in `docs/ENDURANCE_CERTIFICATION_0.8.md` still
require real target hardware before promotion to a certified release.
