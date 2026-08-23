# STAY 0.8.11.3 pre-v3 migration hotfix

Upload the two included files to the existing `agent/living-runtime-0.7.0` branch at these exact repository paths:

- `deploy/stay-deploy.sh`
- `test/hostile-closure.test.js`

The deployer now distinguishes two valid cases:

1. Existing v3 installations must pass SQLite `quick_check` before switching.
2. The first migration from 0.7, where `continuity.sqlite3` does not yet exist, must instead pass strict identity and legacy-brain JSON validation.

After candidate startup, both cases require the v3 database to exist and pass SQLite `quick_check`. A failed migration still triggers the existing code-and-state rollback.

Do not redeploy commit `3c03e1e4fddbd831dc280f80a461cddbe20dc940`; use the new commit produced by this hotfix.
