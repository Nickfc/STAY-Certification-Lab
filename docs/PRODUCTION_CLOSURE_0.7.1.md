# STAY 0.7.1 — Production Closure

0.7.1 closes the first production deployment of the Living Runtime. It does not add cognition or alter the stable 0.6 organism model. Its purpose is to make persistence, recovery, health and the public/private boundary measurable and repeatable before native physiological/cognitive cores are introduced.

## Production baseline

First successful Living Runtime awakening on Lightsail:

- Host: `35.157.242.167`
- Successful awakening: `2026-08-13T19:38:03Z`
- Kernel process: 0.7 lineage, listening privately on `127.0.0.1:8787`
- Stable fetus compatibility process: 0.6.0, listening privately on `127.0.0.1:8788`
- Organism identity observed at awakening: `stay-045fe851-cb7d-43ce-9b86-af69186e6bc2`
- Frozen pre-awakening brain SHA-256: `b45d6addd70b13bfa684f53c075edb3ca6a76bae7d7384849f84a1df2d7d073d`
- First confirmed successful post-awakening save: `2026-08-13T19:44:31.317Z`
- First confirmed post-awakening live brain SHA-256: `ed139836936b245cb16f2d01ddc3202b7efccb71eee3c80c6a7acba746d605b0`

The post-awakening hash differing from the frozen hibernation hash is expected and is evidence that the running organism resumed persistent state evolution while the original hibernation snapshot remained unchanged.

## 0.7.1 guarantees

### Persistence health

The kernel writes a periodic runtime heartbeat into persistent life-state. Persistence status records heartbeat age, the most recent successful state write and the most recent write failure.

Persistence is represented through the normal core-health contract as `kernel-persistence`, so the existing health endpoint becomes unhealthy when persistence is no longer trustworthy.

Default heartbeat interval: 30 seconds.

### Automatic recovery snapshots

The kernel creates timestamped recovery snapshots under:

`/var/lib/stay/data/snapshots/`

A snapshot contains only selected durable state:

- organism identity
- runtime heartbeat
- active native-core state envelopes
- stable 0.6 `genesis-state.json` when present
- a SHA-256 manifest for all captured files

Operator credentials are deliberately excluded.

Default snapshot behavior:

- snapshot on kernel start
- snapshot on clean kernel stop
- periodic snapshot every 6 hours
- retain the newest 24 snapshots

### Controlled restart continuity

CI verifies that:

- organism identity persists across a kernel restart
- an active native core resumes from its persisted state after restart
- the existing shadow → live switch → warm rollback proof still passes
- the stable 0.6 compatibility core remains explicitly non-hot-swappable

### Public/private boundary

Nginx remains the only public listener on port 80.

- public viewer experience: `/`
- detailed kernel surface: `/runtime/*` blocked at the public gateway
- detailed runtime status remains available locally through `127.0.0.1:8787`
- kernel and stable fetus ports remain loopback-only

HTTPS/domain migration remains a separate production step because no final public domain has been bound yet.

## Lightsail prerequisites discovered during first awakening

These are now part of the production contract.

### Runtime user traversal

`staydeploy` must be able to traverse `/var/lib/stay` and own/write `/var/lib/stay/data`.

Reference permissions used during the successful awakening:

```bash
sudo chgrp staydeploy /var/lib/stay
sudo chmod 2750 /var/lib/stay
sudo chown -R staydeploy:staydeploy /var/lib/stay/data
```

### Stable 0.6 persistence bridge

The stable 0.6 program honors `GENESIS_STATE_PATH`, but its legacy save routine still expects a `data/` path beside `server.js`. Preserve its source files unchanged and satisfy that assumption with a compatibility symlink:

```bash
sudo ln -s /var/lib/stay/data/legacy-0.6.0 /opt/stay/legacy/0.6.0/data
```

The real life-state remains external to deployable code.

### Node executable

The Lightsail instance currently provides Node through `/usr/local/bin`. The service therefore uses `/usr/bin/env node` with an explicit `PATH=/usr/local/bin:/usr/bin:/bin` rather than assuming `/usr/bin/node` exists.

## Acceptance gate for 0.8

Do not begin native Homeostasis Core development against production until all of the following hold:

- health remains green during normal operation
- heartbeat continues updating
- stable 0.6 state saves without errors
- snapshots are being created and retained
- controlled restart preserves organism identity and state
- `/runtime/status` is unavailable from the public gateway
- frozen pre-awakening backup remains unchanged

Only after this baseline is accepted should 0.8 introduce the first native hot-upgradable physiological core.
