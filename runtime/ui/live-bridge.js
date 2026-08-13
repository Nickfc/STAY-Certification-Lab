'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

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
  return {
    ok: Boolean(status.health ? status.health.ok : true),
    releaseVersion,
    kernelVersion: status.kernel ? status.kernel.version : releaseVersion,
    revision: status.kernel ? status.kernel.runtimeRevision : null,
    updatedAt: new Date().toISOString(),
    cores: flattenCoreStatus(status)
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
      meta.cores.map((core) => [core.id, core.version, core.mode, core.ok])
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
