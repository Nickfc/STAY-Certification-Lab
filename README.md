# STAY / Project Genesis

## 0.7.0 Living Runtime Foundation

STAY 0.7 adds persistent identity and state plus versioned runtime components that can be staged, observed, switched and restored while the service remains available.

See docs/LIVING_RUNTIME_0.7.md for the architecture and migration rules.

Production state belongs in /var/lib/stay/data and remains separate from immutable release code. The current 0.6 organism is not replaced by this branch.
