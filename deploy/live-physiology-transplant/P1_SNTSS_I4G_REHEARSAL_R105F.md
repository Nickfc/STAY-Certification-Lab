# P1 SNTSS I4-G1 R105F Non-Live Rehearsal

This operation rehearses SNTSS `0.5.0-i4g1` against a verified copy of the current R105F SNTSS checkpoint. It does not install a release, move `/opt/stay/current`, restart or reload a service, attach or detach a resident, publish to the live BSF, alter SQLite, create live authority, advance the live revision, or stop the R105F benchmark.

The runner requires:

- live health and public metadata at exact `R105F`;
- current release `0.8.11.3-p1g-cold-recovery-736a6845b750`;
- the accepted R105 freeze digest;
- active `stay.service` and benchmark service;
- live SNTSS `0.4.0-i3d3`, schema 4, running, zero outputs, and zero authority;
- an intact current checkpoint blob whose binding matches the organism identity;
- candidate `0.5.0-i4g1`, schema 5, zero outputs, and exact package policy.

It then starts only bundle-local CoreHost workers in standby mode, migrates a copied checkpoint, performs an isolated continuity genesis, proves exact replay idempotence, proves second-genesis rejection, restarts from the isolated schema-5 snapshot, and advances one simulated 250 ms physiology quantum. No generated seed is written; only its commitment appears in evidence.

After the rehearsal it rechecks service PID/start identity, restart count, release pointer, runtime revision, freeze label, benchmark PID, live resident identity, authority, and outputs. Evidence is written beneath `/var/lib/stay/evidence/sntss-continuity-rehearsal/` only after every assertion passes.

Expected completion begins with:

```text
P1_SNTSS_I4G_REHEARSAL_RESULT=PASS
LIVE_REVISION=R105F
```

and ends with `LIVE_SERVICE_RESTARTED=NO`, `LIVE_REVISION_CHANGED=NO`, `LIVE_RESIDENT_REPLACED=NO`, and `BENCHMARK_INTERRUPTED=NO`.

Authorization token:

```text
STAY_P1_SNTSS_I4G_REHEARSAL_AUTHORIZATION=REHEARSE_R105F_CHECKPOINT_WITHOUT_LIVE_MUTATION
```

This is candidate and host evidence only. It does not authorize live SNTSS replacement or a live continuity-genesis event.
