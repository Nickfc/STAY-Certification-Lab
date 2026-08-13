# STAY 0.7 — First Lightsail Awakening Runbook

This runbook is for the first transition from the hibernated stable 0.6.0 fetus to the 0.7 Living Runtime on Lightsail.

## Non-negotiable rules

- Never commit `genesis-state.json` or an operator credential to Git.
- Never edit the supplied hibernation state before first awakening.
- Never start the compatibility core if source or state fingerprints do not match.
- Take a byte-for-byte backup of the hibernation state before the first start.
- The stable 0.6 monolith is a compatibility core and is **not** a live hot-swap target.

## Production locations

- Living Runtime releases: `/opt/stay/releases/`
- Active release symlink: `/opt/stay/current`
- Incoming/staging: `/opt/stay/incoming/`
- Stable 0.6 source: `/opt/stay/legacy/0.6.0/`
- Persistent life-state: `/var/lib/stay/data/`
- Hibernated 0.6 state: `/var/lib/stay/data/legacy-0.6.0/genesis-state.json`
- Backups: `/var/backups/stay/`

## 1. Transfer the hibernation migration package

Transfer `STAY_0.6_to_0.7_Hibernation_Migration.zip` to the Lightsail instance without placing it in Git. A suitable temporary destination is `/opt/stay/incoming/`.

The package deliberately excludes the old `operator-token.txt`.

## 2. Extract without starting anything

Extract the package into a temporary directory. Copy the package's `source/0.6.0/` tree to `/opt/stay/legacy/0.6.0/` and its `state/legacy-0.6.0/genesis-state.json` to `/var/lib/stay/data/legacy-0.6.0/genesis-state.json`.

The source directory should be treated as immutable after installation. The state directory must be writable by `staydeploy`.

## 3. Verify the hibernation state

The expected SHA-256 for the supplied hibernation state is:

`b45d6addd70b13bfa684f53c075edb3ca6a76bae7d7384849f84a1df2d7d073d`

Verify the file before proceeding:

```bash
sha256sum /var/lib/stay/data/legacy-0.6.0/genesis-state.json
```

If it differs, stop. Do not start STAY.

## 4. Make the pre-awakening backup

Before the first start:

```bash
sudo mkdir -p /var/backups/stay/pre-0.7-awakening
sudo cp -a /var/lib/stay/data/legacy-0.6.0/genesis-state.json /var/backups/stay/pre-0.7-awakening/genesis-state.json
sha256sum /var/backups/stay/pre-0.7-awakening/genesis-state.json
```

The backup hash must be identical to the hibernation hash above.

## 5. Stage the 0.7 release

Install the reviewed 0.7 release into a new immutable directory under `/opt/stay/releases/` and only then point `/opt/stay/current` at it atomically.

Do not place persistent state inside the release directory.

## 6. Install the service and gateway

The repository contains:

- `deploy/systemd/stay.service`
- `deploy/nginx/gateway.conf`

Install the systemd unit and Nginx gateway, validate Nginx configuration, and reload systemd. The Living Kernel listens only on `127.0.0.1:8787`; the stable fetus listens only on `127.0.0.1:8788`; Nginx is the public observation gateway on port 80.

## 7. First start

Start `stay.service`. The compatibility core will refuse to awaken if its stable runtime file fingerprints or the first-import hibernation state fingerprint do not match.

Immediately verify:

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/runtime/status
curl -I http://127.0.0.1/
```

Expected result: the kernel reports healthy, `fetus-legacy` reports healthy with `sourceVerified` and `hibernationVerified`, and `/` is served through the original 0.6 UI.

## 8. Observe before evolving

For the first awakening, do not add new cognitive cores. Let the exact stable fetus run behind 0.7 first and verify that its website, persistence, compute participation, world state and operator path behave as they did in 0.6.

Only after that baseline is accepted should we begin extracting native cores such as primordial instincts, SNTSS, memory, self-model and morphology.

## Rollback principle

A failed 0.7 startup must never delete or regenerate organism state. Stop the service, preserve the failed-run state separately for inspection, and retain the untouched pre-awakening backup. Release code can be replaced; organism history cannot.
