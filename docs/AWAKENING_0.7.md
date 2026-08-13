# STAY 0.7 — First Lightsail Awakening Runbook

This runbook is for the first transition from the hibernated stable 0.6.0 fetus to the 0.7 Living Runtime on Lightsail.

## Non-negotiable rules

- Never commit `genesis-state.json` or an operator credential to Git.
- Never edit the supplied hibernation state before first awakening.
- Never start the compatibility core if source or state fingerprints do not match.
- Take a byte-for-byte backup of the hibernation state before the first start.
- The stable 0.6 monolith is a compatibility core and is **not** a live hot-swap target.
- Do not expose the public gateway until both runtime health and persistence have been proven.

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

The stable 0.6 server honors `GENESIS_STATE_PATH`, but its unchanged save routine also calls `mkdir(__dirname/data)` before writing the external state file. Preserve the original source while satisfying that legacy assumption with a compatibility symlink:

```bash
sudo rm -rf /opt/stay/legacy/0.6.0/data
sudo ln -s /var/lib/stay/data/legacy-0.6.0 /opt/stay/legacy/0.6.0/data
sudo chown -h root:root /opt/stay/legacy/0.6.0/data
```

Verify that `/opt/stay/legacy/0.6.0/data` resolves to `/var/lib/stay/data/legacy-0.6.0`. Do not copy live state back into the immutable source tree.

Also ensure the service account can traverse `/var/lib/stay` and owns the actual data tree. On the current Lightsail layout the parent is group-traversable by `staydeploy` while the data tree itself is private to `staydeploy`.

## 3. Verify the hibernation state

The expected SHA-256 for the supplied hibernation state is:

`b45d6addd70b13bfa684f53c075edb3ca6a76bae7d7384849f84a1df2d7d073d`

Verify the file before proceeding:

```bash
sha256sum /var/lib/stay/data/legacy-0.6.0/genesis-state.json
```

If it differs before the first accepted awakening, stop. Do not start STAY.

## 4. Make the pre-awakening backup

Before the first accepted start:

```bash
sudo mkdir -p /var/backups/stay/pre-0.7-awakening
sudo cp -a /var/lib/stay/data/legacy-0.6.0/genesis-state.json /var/backups/stay/pre-0.7-awakening/genesis-state.json
sha256sum /var/backups/stay/pre-0.7-awakening/genesis-state.json
```

The backup hash must be identical to the hibernation hash above. After a successful awakening and save, the live state is expected to diverge from this frozen backup.

## 5. Stage the 0.7 release

Install the reviewed 0.7 release into a new immutable directory under `/opt/stay/releases/` and only then point `/opt/stay/current` at it atomically.

Do not place persistent state inside the release directory.

## 6. Install the service and gateway

The repository contains:

- `deploy/systemd/stay.service`
- `deploy/nginx/gateway.conf`

Install the systemd unit and Nginx gateway, validate Nginx configuration, and reload systemd. The Living Kernel listens only on `127.0.0.1:8787`; the stable fetus listens only on `127.0.0.1:8788`; Nginx is the public observation gateway on port 80.

Keep Nginx on the old/public-safe configuration until private awakening acceptance is complete.

## 7. First start and persistence acceptance

Start `stay.service`. The compatibility core will refuse to awaken if its stable runtime file fingerprints or the first-import hibernation state fingerprint do not match.

Immediately verify privately:

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/runtime/status
```

Expected result: the kernel reports healthy and `fetus-legacy` reports healthy with `sourceVerified` and `hibernationVerified`.

Then keep it private for at least one 0.6 persistence interval (more than five seconds). Check the journal for `Could not save state` messages. There must be none. Verify the live `genesis-state.json` receives a new `savedAt` value and that its SHA-256 can diverge from the untouched pre-awakening backup. That divergence is expected evidence of a successful live save, not corruption.

If persistence fails, stop `stay.service` immediately and do not expose Nginx. A process being reachable is not sufficient for awakening acceptance if organism history cannot be persisted.

Only after health **and** persistence are accepted should Nginx be reloaded and `/` exposed publicly.

## 8. Observe before evolving

For the first accepted awakening, do not add new cognitive cores. Let the exact stable fetus run behind 0.7 first and verify that its website, persistence, compute participation, world state and operator path behave as they did in 0.6.

Only after that baseline is accepted should we begin extracting native cores such as primordial instincts, SNTSS, memory, self-model and morphology.

## Rollback principle

A failed 0.7 startup or persistence acceptance must never delete or regenerate organism state. Stop the service, preserve any failed-run evidence separately for inspection, and retain the untouched pre-awakening backup. Release code can be replaced; organism history cannot.
