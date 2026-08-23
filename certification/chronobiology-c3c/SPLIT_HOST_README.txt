STAY Chronobiology C3-C — Split-host certification topology

The final candidate requires two independent PASS records:

1. Compute record: produced only through compute/PUBLIC_RUN.sh in the PUBLIC
   Nickfc/STAY-Certification-Lab repository from an exact detached private-source
   candidate checked out with its dedicated read-only deploy key.
2. Live record: produced only by live/RUN.sh on the actual Lightsail host after
   validating the compute record and observing the real unchanged live sentinel.

The records are accepted only when candidate SHA, candidate tree, and the
compute-record digest all bind exactly. VERIFY_SPLIT_EVIDENCE.js enforces that
contract and can produce only CANDIDATE_CERTIFIED_UNSEALED. It cannot create the
final C3-C seal.

Legacy 0.6 fixture identity is the frozen eight-entry SOURCE_FILES SHA-256
inventory. The encrypted public-lab blob contains only a deterministic transport
of those files; neither historical tar metadata nor migration state contributes
to canonical identity.

Verify and bind:

  node certification/chronobiology-c3c/VERIFY_SPLIT_EVIDENCE.js \
    --compute "$COMPUTE_RESULT" \
    --live "$LIVE_RESULT" \
    --output "$PRIVATE_BINDING_RESULT"

The legacy combined RUN.sh remains useful as an actual-host diagnostic, but its
result alone is not sufficient for a final seal under this split-host contract.
