# STAY v0.8 Endurance Certification

## Required nodes

- main Ryzen desktop using low CPU settings
- two WebGPU nodes, including the main desktop and a second GPU
- one CPU-only browser node
- one mobile viewer

## Qualification

Collect the browser and host observations into a copy of `HARDWARE_EVIDENCE_TEMPLATE.json`, then run the server-side harness for 24 hours while that evidence collector remains active:

```bash
node scripts/endurance-runner.js --hours 24 --run-id stay-24h-UNIQUE-CHALLENGE --evidence stay-0.8-24h-hardware.json > stay-0.8-24h-report.json
```

During the same period, keep real browser nodes connected. Exercise 1%, 5%, 20%, 50% and 100% GPU settings, a 5% CPU setting, viewer interaction, visibility changes, reconnects and one controlled optional-core failure.

## Certification

After a clean 24h qualification, run:

```bash
node scripts/endurance-runner.js --hours 72 --run-id stay-72h-UNIQUE-CHALLENGE --evidence stay-0.8-72h-hardware.json > stay-0.8-72h-report.json
```

## Required observations

- Kernel and every CoreHost RSS/heap trend
- fetus memory guardian RSS, peak, recycles and crash restarts
- browser JS heap trend and long tasks
- GPU allocated buffer estimate, device losses, 5s/30s measured duty and cooldown
- requested versus effective CPU/GPU share
- queue depth, drops, coalesces and timeouts
- authority map, epoch transitions and stale-output count
- snapshot and checkpoint integrity
- reconnects, verification failures and quarantines

## Pass conditions

- organism identity is unchanged
- exactly one authority owner exists per core at every boundary
- no unexplained recovery occurs
- no unbounded Kernel, CoreHost, fetus, browser or GPU-owned memory slope exists
- GPU measured 30-second duty meets the roadmap tolerance after warm-up when sustainable
- GPU-only performs zero CPU candidate search
- 5% CPU is physically quiet on the Ryzen PC
- no viewer freeze exceeds 250 ms without automatic backoff
- phone remains usable throughout
- final snapshots and checkpoints verify

Do not rename the release as certified or begin v0.9 biology until both runs pass and their reports are retained beside the release.

The runner refuses a 24h/72h certification result when hardware evidence is absent, too short, missing a required node class, or has an unpassed required check. A short smoke result is labeled `PASS-SMOKE-NOT-CERTIFICATION`.
