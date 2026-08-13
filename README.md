# STAY / Project Genesis

## 0.7.0 Living Runtime Foundation

STAY 0.7 adds persistent identity and state plus versioned runtime components that can be staged, observed, switched and restored while the service remains available.

The supplied stable 0.6 fetus is now represented by a transitional compatibility core. It preserves the original 0.6 server/UI/brain-state boundary while the new Living Kernel becomes the persistent runtime around it. The old monolith is deliberately not claimed to be live hot-swappable; future native cores are.

See `docs/LIVING_RUNTIME_0.7.md` for the architecture and `docs/AWAKENING_0.7.md` for the first Lightsail awakening procedure.

Production state belongs in `/var/lib/stay/data` and remains separate from immutable release code.
