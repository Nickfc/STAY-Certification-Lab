# Manual GitHub handoff - STAY 0.8.11.3

This source tree is intended to be copied into the existing `agent/living-runtime-0.7.0` branch as one coherent change. No GitHub upload or production deployment was performed while creating it.

## Safe sequence

1. Keep a local copy of the current repository folder.
2. Switch to `agent/living-runtime-0.7.0`.
3. Copy the contents of this folder over the repository, preserving paths.
4. Confirm that `.stay-data`, `data`, live state and credentials are absent.
5. Run `npm test` with Node 24.
6. Commit as `STAY 0.8.11.3 hostile-audit repair candidate pre-certification`.
7. Push the branch.

The old Lightsail staging workflow has been changed to manual dispatch, so a normal push does not upload or deploy this pre-certification release.

## Do not deploy yet

The real 24-hour and 72-hour mixed-device runs remain the final roadmap gate. Follow `docs/ENDURANCE_CERTIFICATION_0.8.md` and only mark v0.8 certified after both reports pass.
