# SNTSS R6 Receptor Profile Register

Status: laboratory candidate; production receptor consumers disabled

Registry hash: `sha256:839f9400d81bfdcfb479b664ecab7098157ace0daed924c48c61962416c18291`

R6 contains two static Receptor Probe profiles so targeting and isolation can be tested without behavior authority. Neither profile is a production consumer. Every profile and registry object is immutable and hash-verified; callers cannot create or tune receptors dynamically.

| Consumer | Receptors | Permitted observation lanes |
| --- | ---: | --- |
| `receptor-probe-alpha` | 3 | encoding gain, attention gain, interrupt sensitivity |
| `receptor-probe-beta` | 3 | inhibition, association readiness, persistence |

Each receptor declares a stable ID, active R4 family, synthetic analogue, affinity, Hill coefficient, polarity, capped efficacy, birth density/sensitivity, exposure/desensitization/recovery constants, one permitted function, and neutral fallback `0`.

Wildcard consumers, dormant families, efficacy above `250000`, non-neutral fallback, unknown fields, partial profiles, unregistered hashes, production eligibility, and caller-authored profiles fail closed. Removal marks local population history dormant. Re-registering the exact profile restores that history; it never creates a fresh population over acquired history.

The profiles are laboratory calibration contracts, not claims about emotion or behavior. They cannot select actions, create goals, grant trust, alter identity, override safety, change resources, or promote code.
