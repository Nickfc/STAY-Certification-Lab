# R10.5 Trusted Boundary Bootstrap Ceremony

Status: **required before R11 host certification**. This ceremony establishes the first host-owned STAY release verifier without trusting executable code from the candidate checkout.

## Why this exists

A host-owned verifier is only meaningful if the act of installing it is itself trustworthy. Running `sudo ./deploy/install-trusted-boundary.sh ...` directly from an unauthenticated checkout would be circular: a malicious checkout could replace the installer and verifier before either became trusted.

Therefore **no repository script, Node program, or candidate executable is run as root until the exact bootstrap bytes have been independently authenticated with host/system tools**.

## Trust root

The release-authority Ed25519 public-key fingerprint is the root of trust for this ceremony.

The expected SHA-256 fingerprint of `release-authority-public.pem` must be obtained through an independent channel and recorded outside the candidate archive/repository. A fingerprint copied from the same checkout being verified is not independent evidence.

The private release-authority key remains offline and is never copied to GitHub, Lightsail, the STAY host, a release archive, or `/etc/stay`.

## Frozen bootstrap bundle

For the exact frozen candidate, the trusted control machine produces:

- `release-authority-public.pem`
- `TRUSTED_BOUNDARY_BOOTSTRAP.sha256`
- `TRUSTED_BOUNDARY_BOOTSTRAP.sha256.sig`
- the candidate checkout containing exactly:
  - `deploy/install-trusted-boundary.sh`
  - `deploy/trusted-release-verifier.js`
  - `deploy/stay-deploy.sh`

The SHA256 manifest is canonical text produced with:

```bash
/usr/bin/sha256sum \
  deploy/install-trusted-boundary.sh \
  deploy/trusted-release-verifier.js \
  deploy/stay-deploy.sh \
  > TRUSTED_BOUNDARY_BOOTSTRAP.sha256
```

The manifest is signed offline with the release-authority private key. One compatible OpenSSL 3 command is:

```bash
/usr/bin/openssl pkeyutl -sign -rawin \
  -inkey /offline/path/release-authority-private.pem \
  -in TRUSTED_BOUNDARY_BOOTSTRAP.sha256 \
  -out TRUSTED_BOUNDARY_BOOTSTRAP.sha256.sig
```

The private key and the machine holding it are outside the production trust domain.

## Host-side verification — before sudoing repository code

On the non-live certification host, use system binaries directly.

First verify the public-key fingerprint against the independently recorded value:

```bash
/usr/bin/sha256sum release-authority-public.pem
```

If it differs by one byte, **stop**. Do not run the installer.

Then verify the detached signature over the bootstrap manifest:

```bash
/usr/bin/openssl pkeyutl -verify -pubin -rawin \
  -inkey release-authority-public.pem \
  -in TRUSTED_BOUNDARY_BOOTSTRAP.sha256 \
  -sigfile TRUSTED_BOUNDARY_BOOTSTRAP.sha256.sig
```

A failed signature is a hard stop.

Then verify the exact repository files using the authenticated manifest:

```bash
cd /path/to/frozen-candidate
/usr/bin/sha256sum -c /path/to/TRUSTED_BOUNDARY_BOOTSTRAP.sha256
```

All three entries must report `OK`. No repository script or Node executable has been trusted or executed to reach this point.

## Second-stage installation

Only after all checks above pass may the now-authenticated installer run:

```bash
sudo env STAY_BOOTSTRAP_PREVERIFIED=1 \
  ./deploy/install-trusted-boundary.sh \
  --public-key /path/to/release-authority-public.pem \
  --public-key-sha256 <independently-recorded-64-hex-fingerprint> \
  --manifest /path/to/TRUSTED_BOUNDARY_BOOTSTRAP.sha256
```

The second-stage installer rechecks:

- the independently supplied public-key SHA-256;
- that the manifest contains exactly the three allowed trusted-boundary files;
- all three file hashes;
- bubblewrap availability;
- final root ownership and non-writable modes;
- the installed public-key fingerprint.

It installs:

- `/usr/local/lib/stay/trusted-release-verifier.js` as root-owned `0555`;
- `/usr/local/sbin/stay-deploy` as root-owned `0555`;
- `/etc/stay/release-authority.pub` as root-owned `0444`.

It does **not** activate a release and does **not** touch `/var/lib/stay/data`.

## Fail-closed rules

The ceremony fails if any of the following is true:

- the public-key fingerprint was not obtained independently;
- the detached manifest signature fails;
- a bootstrap hash differs;
- the manifest contains an extra path or misses one of the three required paths;
- the second-stage installer is invoked without explicit `STAY_BOOTSTRAP_PREVERIFIED=1`;
- bubblewrap is unavailable;
- the installed trust files are not root-owned or are group/world writable.

No override flag exists for production certification.

## R11 evidence

R11 must record the exact:

- frozen candidate commit;
- release-authority public-key SHA-256;
- signed bootstrap-manifest SHA-256;
- detached-signature SHA-256;
- three verified source hashes;
- installed verifier/deployer/key hashes and permissions;
- operator timestamp and host identity;
- proof that no candidate executable ran before external verification.

Repository tests can prove the ceremony is required and fail-closed. They cannot manufacture the independent key-fingerprint ceremony; that evidence must come from the actual non-live host rehearsal.
