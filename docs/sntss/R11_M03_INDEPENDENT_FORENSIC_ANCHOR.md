# R11 M-03 Independent Forensic Anchoring

Status: **IMPLEMENTED IN CANDIDATE / SEPARATE-OS-IDENTITY HOST PROOF STILL REQUIRED**

This closes the repository architecture portion of hostile re-audit finding M-03. The SNTSS forensic chain now has a concrete external witness design whose retained evidence is outside the mutable organism StateStore and outside release code.

## Security model

STAY does not receive filesystem write access to the external anchor ledger.

The observation plane sends only R9 forensic **segment manifests** over a bounded Unix-domain socket. A separately installed trusted process (`stayanchor`) independently validates the manifest and appends a second hash-chained receipt to its own StateDirectory.

```text
SNTSS forensic records
        |
        v
R9 segment manifest (hashes/counts only)
        |
        | AF_UNIX, one bounded manifest/request
        v
trusted stayanchor service
        |
        v
/var/lib/stay-forensic-anchor/anchors.jsonl
```

The live organism StateStore is not mounted or referenced by the anchor service.

## External witness rules

`deploy/trusted-forensic-anchor.js` is intended to be installed as a root-verified immutable trusted-boundary component at `/usr/local/lib/stay/trusted-forensic-anchor.js` before R11 host certification. Candidate release code must not become the trust root merely by copying itself there.

The daemon:

- accepts only the exact `stay-sntss-forensic-segment-v2` manifest whitelist;
- independently reproduces and verifies `manifestHash`;
- requires monotonic `segmentIndex`;
- requires contiguous forensic record sequences;
- requires every next `anchorHash` to equal the previously witnessed segment head;
- starts from an independently supplied initial anchor hash;
- requires non-regressing trusted receipt time;
- accepts at most **60 new receipts per rolling minute** by default;
- writes only bounded receipt metadata, never raw stimulus/private state;
- adds an external monotonic receipt sequence;
- chains every receipt to `previousReceiptHash`;
- fsyncs every accepted append;
- refuses startup if historical receipt JSON, receipt time, sequence, segment continuity, previous hash or receipt hash is corrupted;
- accepts one bounded request per Unix connection.

The receipt-rate ceiling is deliberately in the external trust domain. A compromised observer can make anchoring fail visibly, but cannot force the witness to grow its durable ledger at arbitrary speed. Anchor rejection remains an observability failure, never chemistry authority.

The runtime client verifies segment integrity before sending and requires an acknowledgement that names the exact submitted manifest hash and resulting external receipt hash.

## OS separation

The provided `stay-forensic-anchor.service` is deliberately separate from `stay.service`:

- `User=stayanchor`;
- `Group=staydeploy` only so STAY may connect to the socket;
- anchor StateDirectory mode `0700`;
- runtime directory mode `0750` and socket mode `0660`;
- `PrivateNetwork=true`;
- only `AF_UNIX` is permitted;
- empty capability/ambient capability sets;
- strict filesystem protection;
- no `/var/lib/stay/data` path;
- independent CPU/memory/task ceilings.

Because the receipt file is mode `0600` under the `stayanchor` identity and its parent StateDirectory is mode `0700`, the `staydeploy` organism process cannot open or rewrite it merely because it can connect to the Unix socket.

For the certification host, the receipt file should additionally be created/verified with the filesystem append-only attribute (`chattr +a`) where supported. The `stayanchor` service receives no capability that would allow it to clear that attribute. Host evidence must record `lsattr`, ownership and mode.

## Failure semantics

External anchoring is deliberately **not in the chemistry or authority transaction**.

`SntssObservabilityPlane` invokes `anchorSink` as an observation-side callback. A rejected Promise or thrown anchor sink increments `sinkFailures`; it does not reject the state transition and cannot mutate SNTSS chemistry.

```text
external witness down/rate-limited -> observability degraded + alert
external witness down/rate-limited -X-> chemistry failure
external witness down/rate-limited -X-> authority transfer
```

R11 may still refuse final certification or future promotion while the external witness is unhealthy. That is a release/certification decision, not a chemical control path.

## Initial-anchor bootstrap

The trusted service requires an initial forensic anchor supplied through a systemd credential:

```text
LoadCredential=initial-anchor:/etc/stay/forensic-initial-anchor
STAY_FORENSIC_INITIAL_ANCHOR_FILE=/run/credentials/stay-forensic-anchor.service/initial-anchor
```

The source file is provisioned out-of-band by the R11 trust ceremony. Its exact value and the trusted daemon digest become part of `externalForensicAnchorIdentity` in frozen R11 evidence.

## R11 host proof still required

M-03 is not final-certified until the frozen candidate proves on the non-live certification host that:

1. the trusted daemon was installed only after out-of-band hash/signature verification;
2. `staydeploy` can connect to the anchor socket but cannot read, truncate, replace or delete the receipt ledger;
3. `stayanchor` cannot access `/var/lib/stay/data` or release-write paths;
4. a valid forensic segment produces one durable receipt and survives daemon/kernel restart;
5. altered, omitted, reordered and non-contiguous segments are rejected;
6. receipt-history tampering makes daemon startup fail closed;
7. stopping/killing/rate-limiting the anchor daemon degrades observability only;
8. receipt flood attempts hit the independent rate ceiling without unbounded ledger growth;
9. receipt ownership/modes and append-only filesystem evidence are captured;
10. the final external receipt head and trusted daemon identity are included in the exact R11 freeze inventory.

No part of this change authorizes live SNTSS chemistry, production genesis, or destructive testing against the live organism.
