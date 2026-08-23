# SNTSS R7 Developmental Update Contract

Contract hash: `sha256:bf0a96a38d4c76d5d002dc1ec7ce9702b4a941902b4cb3c7913b49ae02056f32`

Development is not reward maximization. R7 permits one slow variable: the tonic baseline `B` of each active transmitter. It cannot change reserves, circulating concentration, precursor supply, exposure, opponent load, refractory state, receptor history, family/profile parameters, evidence gates, or authorization rules.

An eligible summary requires:

- independently verified authorization from the current `sntss-development-review` authority;
- a content hash binding the complete summary to that review;
- healthy, authoritative, time-trusted and unclamped operation;
- non-synthetic, non-replay evidence;
- at least 64 accepted facts from at least four sources;
- no source above 50% of the window and no more than 10% extreme evidence;
- a contiguous trusted window of one hour to one day;
- forward-only durable cursors;
- proposed baselines within +/-100,000 of the reviewed birth baseline.

Maximum movement is `1,000` fixed-point units per eligible day, prorated by eligible experience time. Rejected windows add zero developmental time and return the original state object unchanged. Downtime, missing sources, floods, replay, clamps, clock uncertainty, synthetic tests, concentrated evidence, self-authorization, unknown fields, and out-of-range targets do not count as experience.

The contract is immutable, `productionEnabled: false`, and cannot authorize its own replacement.
