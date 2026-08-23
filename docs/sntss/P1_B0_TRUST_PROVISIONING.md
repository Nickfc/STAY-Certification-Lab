# P1 B.0 resident trust provisioning ceremony

This ceremony provisions only the public resident trust boundary and the certified 25 ms trusted-time scheduler. It never possesses or transports the release-authority private key and does not attach a resident.

## 1. Read-only certificate request

Run the fixed `preflight-b0` workflow operation. Its sanitized artifact contains `RESIDENT_CERTIFICATE_REQUEST`, bound to the live organism identity and the frozen I3-D3 contract. Confirm the baseline is runtime revision 52 and that SNTSS and Chronobiology are absent.

## 2. Independent release-authority authentication

Obtain the SHA-256 fingerprint of the exact R10.5/R11 `release-authority-public.pem` through the independent channel used for the original trusted-boundary ceremony. Do not derive the expected fingerprint from this repository, the certificate request, or the Actions bundle.

Stop if that fingerprint cannot be independently authenticated. The private authority key remains on the offline signing system and must never be copied to GitHub, Actions, Lightsail, `/etc/stay`, or a release archive.

## 3. Offline resident certificate

On the offline authority system, complete the request body with only `certificateId`, `issuedAtMs`, and `expiresAtMs`. Keep the exact requested values for residency, core, version, role, organism binding, executable hashes, package policy, inputs, empty outputs, `allowedActions=["attach-resident"]`, and `authorizationClass=sntss-resident-zero-authority`.

Canonicalize and sign the body using the existing `stay-resident-promotion-v1` Ed25519 certificate format. Produce `resident-sntss.json`.

Create the two-entry manifest from a directory containing only the public material:

```bash
/usr/bin/sha256sum release-authority-public.pem resident-sntss.json \
  > P1_B0_TRUST_MATERIAL.sha256
/usr/bin/openssl pkeyutl -sign -rawin \
  -inkey /offline/path/release-authority-private.pem \
  -in P1_B0_TRUST_MATERIAL.sha256 \
  -out P1_B0_TRUST_MATERIAL.sha256.sig
```

The private key remains offline.

## 4. Actions public-material inputs

After independent fingerprint comparison and detached-signature verification with system tools, configure these repository Actions secrets:

- `STAY_B0_RELEASE_AUTHORITY_PUBLIC_KEY_B64`
- `STAY_B0_RESIDENT_SNTSS_CERTIFICATE_B64`
- `STAY_B0_TRUST_MATERIAL_SHA256_B64`
- `STAY_B0_TRUST_MATERIAL_SIGNATURE_B64`
- `STAY_B0_RELEASE_AUTHORITY_PUBLIC_KEY_SHA256`

The first four values are base64 encodings of the four public bundle files. The final value is the independently authenticated lowercase 64-hex public-key fingerprint. None is a private key.

The fresh production-bridge job decodes and verifies these bytes with runner system tools before invoking any privileged production operation. The root controller repeats the fingerprint, detached-signature, exact-manifest, file-hash, resident-certificate, and frozen-contract checks.

## 5. Fixed operation

Only after `preflight-b0` passes and the public bundle is configured may `configure-b0` be selected with:

`AUTHORIZE_B0_TRUST_RUNTIME_7D040592CCF1F149`

This authorization does not authorize Surgery B. Rollback has a distinct phrase:

`AUTHORIZE_ROLLBACK_B0_FORWARD_STATE_7D040592CCF1F149`

After a green B.0 run, `preflight-b` binds the root-owned B.0 baseline seal and runtime revision 53. Surgery B remains restart-free and separately authorized.
