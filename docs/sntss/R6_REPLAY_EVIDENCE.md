# SNTSS R6 Replay and Isolation Evidence

- Evidence hash: `sha256:9550a662d3365c0fb96d5325c0001339b59be1f034e043f44c558c4170f165b0`
- Golden frame hash: `sha256:97e0cd0dddbd04a7e369bf7291909bea838c880fe83f09ec877cab0600b2ee77`
- Isolation corpus hash: `sha256:ea66f05e6c393fc638d0d343f5eb490e567fdccbad5c8577e27ff7efbbf4afa5`
- Profile registry hash: `sha256:839f9400d81bfdcfb479b664ecab7098157ace0daed924c48c61962416c18291`

The committed bundle is `evidence/R6_RECEPTOR_EVIDENCE.json`. It proves target validation, identical replay, distinct per-consumer frame IDs, zero-effect degradation, capped recovery, isolated queue-breaker behavior, dormant removal history, rollback restoration, and zero CoreHost production outputs.

Regenerate with `node scripts/sntss-r6-receptor-lab.js`. Verify with `node --test --test-concurrency=1 test/sntss-receptors.test.js`. Any controlling module, schema, profile, frame, lease, adaptation, or isolation change invalidates the evidence hash.
