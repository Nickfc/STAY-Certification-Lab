STAY Chronobiology C3-C — Actual-host sentinel lane

Run this only on the actual STAY Lightsail host, from the exact candidate source.
It validates an already-passed sanitized compute record, captures the real
stay.service and /opt/stay/current sentinel before and after a read-only source
identity capture, and emits a sanitized live-sentinel record.

It does not run compute tests. It does not restart stay.service, switch
/opt/stay/current, deploy source, mutate StateStore, or emulate a live organism.

Invocation:

  sudo -u staydeploy bash certification/chronobiology-c3c/live/RUN.sh \
    --candidate-sha "$CANDIDATE_SHA" \
    --candidate-tree "$CANDIDATE_TREE" \
    --compute-result "$COMPUTE_RESULT" \
    --output-root /var/tmp/stay-chronobiology-c3c-live

Keep OUTPUT_ROOT private. Only LIVE_RESULT.sanitized.json may cross the evidence
boundary.
