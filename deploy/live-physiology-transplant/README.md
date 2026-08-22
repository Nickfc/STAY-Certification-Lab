# Surgery A: shared-infrastructure transplant

This directory is the production-facing control plane for P1 Surgery A.  It
does not attach SNTSS, attach Chronobiology, create a founder, or grant a new
biological authority.

The certified StateStore moves an existing continuity schema from 3 to 4 on
first start.  For that reason the rollback target is a separately immutable
release using `server-surgery-a-rollback.js`.  It understands schema 4,
disables durable residents, refuses to ignore any resident state, and always
keeps the canonical forward StateStore in place.

`p1-live-preflight.sh` is read-only.  Its first host observation is the
fail-closed private-IP guard.  `p1-forward-rollback.sh` is a future write path;
it remains disabled unless the operator supplies the explicit Surgery A write
authorization environment value.
