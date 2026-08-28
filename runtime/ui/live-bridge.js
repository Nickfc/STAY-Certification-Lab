'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readRevisionFreeze } = require('../revision-freeze');
const { projectObservationChips } = require('./chip-projection');

const SCRIPT_URL = '/__stay/live-runtime-badge.js';

function flattenCoreStatus(status) {
  const rows = [];
  for (const slot of status.cores || []) {
    for (const mode of ['active', 'candidate', 'standby']) {
      const unit = slot[mode];
      if (!unit || !unit.manifest) continue;
      rows.push({
        id: slot.coreId,
        version: unit.manifest.version || '?',
        mode,
        ok: !(unit.health && unit.health.ok === false)
      });
    }
  }
  return rows;
}

function publicMetadata(status, releaseVersion) {
  const revision = status.kernel ? status.kernel.runtimeRevision : null;
  const revisionFreeze = readRevisionFreeze(revision);
  const residentStatus = Array.isArray(status.residencies)
    ? status.residencies
    : (Array.isArray(status.health?.residencies) ? status.health.residencies : []);
  const bsfLedger = status.biologicalLedger || status.health?.biologicalLedger || null;
  const bsfOk = status.health?.persistence?.ok !== false &&
    bsfLedger?.protocol === 'stay-biological-ledger-v1';
  const systems = [{
    id: 'bsf',
    label: 'BSF',
    mode: 'LIVE',
    status: bsfOk ? 'RUNNING' : 'DEGRADED',
    running: bsfOk,
    healthOk: bsfOk,
    protocol: bsfLedger?.protocol || null,
    events: Number(bsfLedger?.events || 0),
    pendingDeliveries: Number(bsfLedger?.pendingDeliveries || 0),
    activeConsumers: Number(bsfLedger?.activeConsumers || 0)
  }];
  const residents = residentStatus.filter(Boolean).map((resident) => ({
    residencyId: resident.residencyId,
    coreId: resident.coreId,
    version: resident.version,
    status: resident.status,
    lifecycle: resident.lifecycle || resident.status || null,
    running: resident.running === true || resident.status === 'RUNNING',
    mode: resident.coreId === 'chronobiology' ||
      (resident.coreId === 'sntss' && resident.version === '0.5.0-i4g1')
      ? 'SHADOW'
      : 'NEUTRAL',
    authorityOwned: resident.authorityOwned === true,
    checkpointGeneration: Number(resident.checkpointGeneration || 0),
    handledEvents: Number(resident.handledEvents || 0),
    observedOutputs: Number(resident.observedOutputs || 0),
    healthOk: resident.health?.ok !== false
  }));
  return {
    ok: Boolean(status.health ? status.health.ok : true),
    releaseVersion,
    kernelVersion: status.kernel ? status.kernel.version : releaseVersion,
    revision,
    revisionFrozen: revisionFreeze.frozen,
    revisionLabel: revisionFreeze.label,
    updatedAt: new Date().toISOString(),
    cores: flattenCoreStatus(status),
    systems,
    residents,
    chipProjection: projectObservationChips({ systems, residents })
  };
}

function injectBadgeScript(html) {
  if (html.includes(SCRIPT_URL)) return html;
  const tag = `<script src="${SCRIPT_URL}" defer></script>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, tag + '</body>');
  if (/<\/html\s*>/i.test(html)) return html.replace(/<\/html\s*>/i, tag + '</html>');
  return html + tag;
}

function createLiveBridge({ kernel, releaseVersion, badgePath = path.join(__dirname, 'live-runtime-badge.js') }) {
  const clients = new Set();
  let lastFingerprint = '';
  let timer = null;
  let badgeCache = null;

  async function currentMetadata() {
    return publicMetadata(await kernel.status(), releaseVersion);
  }

  function fingerprint(meta) {
    return JSON.stringify([
      meta.ok,
      meta.releaseVersion,
      meta.kernelVersion,
      meta.revision,
      meta.revisionFrozen,
      meta.revisionLabel,
      meta.cores.map((core) => [core.id, core.version, core.mode, core.ok]),
      meta.systems.map((system) => [system.id, system.mode, system.status, system.healthOk,
        system.events, system.pendingDeliveries, system.activeConsumers]),
      meta.residents.map((resident) => [resident.residencyId, resident.version, resident.status,
        resident.mode, resident.checkpointGeneration, resident.handledEvents, resident.observedOutputs]),
      meta.chipProjection.lifecycle.map((chip) => [chip.chipId, chip.state, chip.lifecycle,
        chip.checkpointGeneration, chip.handledEvents, chip.outputs]),
      meta.chipProjection.roadmap.map((entry) => [entry.roadmapId, entry.stage])
    ]);
  }

  function send(res, meta) {
    res.write('event: runtime\n');
    res.write('data: ' + JSON.stringify(meta) + '\n\n');
  }

  async function broadcast(force = false) {
    if (!clients.size) return;
    try {
      const meta = await currentMetadata();
      const nextFingerprint = fingerprint(meta);
      if (!force && nextFingerprint === lastFingerprint) return;
      lastFingerprint = nextFingerprint;
      for (const res of [...clients]) {
        try { send(res, meta); }
        catch { clients.delete(res); }
      }
    } catch {
      // Existing runtime health paths remain authoritative if metadata sampling fails.
    }
  }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => broadcast(false), 1000);
    timer.unref?.();
  }

  async function handle(req, res) {
    const pathname = (req.url || '').split('?')[0];

    if (pathname === '/__stay/meta') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(await currentMetadata()));
      return true;
    }

    if (pathname === SCRIPT_URL) {
      if (!badgeCache) badgeCache = await fs.readFile(badgePath, 'utf8');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(badgeCache);
      return true;
    }

    if (pathname === '/__stay/live') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.flushHeaders?.();
      clients.add(res);
      ensureTimer();
      send(res, await currentMetadata());
      const keepalive = setInterval(() => {
        try { res.write(': stay-alive\n\n'); }
        catch { clearInterval(keepalive); clients.delete(res); }
      }, 15000);
      keepalive.unref?.();
      req.on('close', () => {
        clearInterval(keepalive);
        clients.delete(res);
      });
      return true;
    }

    return false;
  }

  return { handle, injectBadgeScript, currentMetadata, broadcast };
}

module.exports = { createLiveBridge, injectBadgeScript, publicMetadata };
