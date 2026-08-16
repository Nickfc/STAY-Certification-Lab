# R11 M-01 Operator Status Authentication

Status: **IMPLEMENTED IN CANDIDATE / HOST PROOF STILL REQUIRED**

This closes the repository architecture portion of hostile re-audit finding M-01. Detailed `/runtime/status` diagnostics no longer rely only on loopback binding and the nginx `/runtime/*` deny rule.

## Control

Production starts through `server-secure.js`. Before `server.js` creates its HTTP server, the secure entrypoint installs `runtime/operator-status-guard.js` into the trusted Node HTTP layer.

For `/runtime/status` only:

- only `GET` is accepted;
- a valid `Authorization: Bearer ...` capability is required;
- query-string credentials are never accepted;
- the configured token is hashed with SHA-256 and comparisons use `crypto.timingSafeEqual` over fixed-size digests;
- the token value is never logged or returned;
- successful and rejected responses are `no-store`;
- a missing/unreadable/invalid credential returns `503` and does not expose status;
- an absent or incorrect bearer capability returns `401`;
- public `/healthz` and bounded `/__stay/meta` remain independent of operator authentication.

The bearer secret is not stored in Git and is not placed directly in a systemd environment variable. The production unit uses:

```text
LoadCredential=operator-status-token:/etc/stay/operator-status.token
STAY_OPERATOR_STATUS_TOKEN_FILE=/run/credentials/stay.service/operator-status-token
```

The source credential is expected to be provisioned out-of-band as a root-controlled file before the R11 host rehearsal. A safe generation pattern that does not echo the token is:

```bash
sudo install -d -m 0700 /etc/stay
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/stay/operator-status.token'
```

Do not place the token in shell history, GitHub secrets used for builds, release archives, URLs, query strings or browser storage.

## Defense in depth

This is intentionally not the only boundary. The runtime remains bound to loopback and production nginx continues to deny `/runtime/*`. The application-layer capability means an accidental nginx exposure or another ordinary loopback client does not automatically gain privileged runtime diagnostics.

## R11 host proof still required

M-01 is not final-certified until the frozen candidate is rehearsed on the non-live certification host and evidence proves:

1. the systemd credential exists with the intended ownership/mode;
2. unauthenticated and wrong-capability requests fail closed;
3. query-string credential attempts fail closed;
4. the correct capability returns status only over the local operator path;
5. public health remains available when operator authentication fails;
6. the credential value is absent from logs, process arguments, public metadata and forensic/public telemetry.

No part of this change authorizes live chemistry, SNTSS activation or live-organism mutation.
