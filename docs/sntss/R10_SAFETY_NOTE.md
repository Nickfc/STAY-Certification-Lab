# SNTSS R10 Candidate Safety Note

The pre-R10 generic deployer restored the full pre-deployment StateStore during automatic rollback. That behavior is prohibited for SNTSS-bearing releases once acquired biology can exist because it can rewind legitimate organism history.

R10 changes the normal rollback contract to `preserve-forward-state`: restore immutable code pointer only, retain the forward failure state as evidence, retain the pre-switch safety backup for disaster recovery, and require migration/backward-projection compatibility to preserve acquired biology.

This change is repository-only at R10 candidate stage. It does not alter the currently running Lightsail deployment or the active R8 endurance process.
