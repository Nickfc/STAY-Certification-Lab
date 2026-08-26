(() => {
  'use strict';

  if (window.__stayLiveRuntimeBadge) return;
  window.__stayLiveRuntimeBadge = true;

  const host = document.createElement('div');
  host.id = 'stay-live-runtime';
  host.setAttribute('aria-live', 'polite');
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgba(255,255,255,.92);
        pointer-events: auto;
      }
      .physiology {
        display: none;
        position: fixed;
        left: var(--stay-physiology-left, 20px);
        top: var(--stay-physiology-top, 158px);
        z-index: 2147483646;
        flex-wrap: wrap;
        justify-content: flex-start;
        gap: 6px;
        max-width: calc(100vw - 40px);
        pointer-events: none;
      }
      .physiology.visible { display: flex; }
      .chip { border: 1px solid rgba(141,235,178,.35); border-radius: 999px; background: rgba(141,235,178,.09); color: #8debb2; padding: 4px 7px; font-size: 9px; letter-spacing: .05em; white-space: nowrap; }
      .chip.shadow { border-color: rgba(200,167,255,.35); background: rgba(200,167,255,.09); color: #c8a7ff; }
      button {
        appearance: none;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(12,15,19,.82);
        backdrop-filter: blur(14px);
        color: inherit;
        border-radius: 999px;
        padding: 8px 11px;
        font: inherit;
        font-size: 11px;
        letter-spacing: .02em;
        cursor: pointer;
        box-shadow: 0 8px 28px rgba(0,0,0,.28);
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #7dff9a; box-shadow: 0 0 9px rgba(125,255,154,.75); }
      .dot.off { background: #ff8a8a; box-shadow: 0 0 9px rgba(255,138,138,.55); }
      .dot.wait { background: #ffd37d; box-shadow: 0 0 9px rgba(255,211,125,.55); }
      .panel {
        display: none;
        width: min(340px, calc(100vw - 28px));
        margin-top: 8px;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(12,15,19,.92);
        backdrop-filter: blur(18px);
        border-radius: 14px;
        padding: 12px;
        box-shadow: 0 12px 42px rgba(0,0,0,.36);
      }
      .panel.open { display: block; }
      .title { font: 600 11px/1.3 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; opacity: .65; margin-bottom: 9px; }
      .row { display: flex; justify-content: space-between; gap: 14px; padding: 5px 0; font-size: 11px; border-top: 1px solid rgba(255,255,255,.07); }
      .row:first-of-type { border-top: 0; }
      .key { opacity: .62; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .value { text-align: right; white-space: nowrap; }
      .healthy { color: #a9ffbb; }
      .unhealthy { color: #ffaaa8; }
      .foot { margin-top: 9px; font: 10px/1.35 system-ui, sans-serif; opacity: .45; }
      .flash { animation: flash .7s ease-out; }
      @keyframes flash { 0% { transform: scale(1.07); } 100% { transform: scale(1); } }
      @media (prefers-reduced-motion: reduce) { .flash { animation: none; } }
    </style>
    <div class="physiology" id="physiology" aria-label="STAY live physiology status"></div>
    <div class="wrap">
      <button id="badge" type="button" aria-expanded="false" title="STAY Living Runtime status">
        <span class="dot wait" id="dot"></span>
        <span id="label">STAY · connecting…</span>
      </button>
      <div class="panel" id="panel">
        <div class="title">Living Runtime</div>
        <div id="details"></div>
        <div class="foot" id="foot">Waiting for runtime…</div>
      </div>
    </div>`;

  const badge = root.getElementById('badge');
  const panel = root.getElementById('panel');
  const dot = root.getElementById('dot');
  const label = root.getElementById('label');
  const details = root.getElementById('details');
  const foot = root.getElementById('foot');
  const physiology = root.getElementById('physiology');
  let lastFingerprint = '';
  let lastMessageAt = 0;

  badge.addEventListener('click', () => {
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    badge.setAttribute('aria-expanded', String(open));
  });

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function revisionLabel(meta) {
    if (typeof meta?.revisionLabel === 'string' && /^R[0-9]+F?$/.test(meta.revisionLabel)) return meta.revisionLabel;
    return `R${meta?.revision ?? '?'}${meta?.revisionFrozen === true ? 'F' : ''}`;
  }

  function row(key, value, ok) {
    const cls = ok === true ? 'healthy' : ok === false ? 'unhealthy' : '';
    return `<div class="row"><span class="key">${escapeHtml(key)}</span><span class="value ${cls}">${escapeHtml(value)}</span></div>`;
  }

  function positionPhysiology() {
    const candidates = [...document.querySelectorAll('h1,h2,[class*="brand"],[class*="logo"],header *')];
    const brand = candidates.find((element) => String(element.textContent || '').trim().toUpperCase() === 'STAY');
    const rect = brand?.getBoundingClientRect();
    host.style.setProperty('--stay-physiology-left', rect ? `${Math.max(14, Math.ceil(rect.left))}px` : '20px');
    host.style.setProperty('--stay-physiology-top', rect ? `${Math.ceil(rect.bottom + 8)}px` : '158px');
  }

  positionPhysiology();
  requestAnimationFrame(positionPhysiology);
  window.addEventListener('resize', positionPhysiology);

  function apply(meta) {
    if (!meta || typeof meta !== 'object') return;
    lastMessageAt = Date.now();
    const cores = Array.isArray(meta.cores) ? meta.cores : [];
    const systems = Array.isArray(meta.systems) ? meta.systems : [];
    const residents = Array.isArray(meta.residents) ? meta.residents : [];
    const fingerprint = JSON.stringify([meta.releaseVersion, meta.kernelVersion, meta.revision, meta.revisionFrozen, meta.revisionLabel, cores.map((c) => [c.id, c.version, c.mode, c.ok]), systems.map((s) => [s.id, s.mode, s.status, s.healthOk]), residents.map((r) => [r.residencyId, r.version, r.status, r.mode])]);
    const changed = Boolean(lastFingerprint && fingerprint !== lastFingerprint);
    lastFingerprint = fingerprint;

    dot.className = 'dot' + (meta.ok === false ? ' off' : '');
    label.textContent = `LIVE · v${meta.releaseVersion || meta.kernelVersion || '?'} · ${revisionLabel(meta)}`;

    let html = row('Release', `v${meta.releaseVersion || '?'}`);
    html += row('Living Kernel', `v${meta.kernelVersion || '?'}`, meta.ok !== false);
    html += row('Runtime revision', revisionLabel(meta));
    for (const core of cores) {
      html += row(core.id || 'core', `v${core.version || '?'} · ${core.mode || 'active'}`, core.ok !== false);
    }
    for (const system of systems) {
      html += row(system.label || system.id || 'system', `${system.mode || 'LIVE'} · ${system.status || 'UNKNOWN'}`, system.running && system.healthOk !== false);
    }
    for (const resident of residents) {
      html += row(resident.coreId || resident.residencyId || 'resident', `v${resident.version || '?'} · ${resident.mode || 'NEUTRAL'} · ${resident.status || 'UNKNOWN'}`, resident.running && resident.healthOk !== false);
    }
    details.innerHTML = html;
    const chips = systems.filter((system) => system?.running === true).map((system) =>
      `<span class="chip"><b>● ${escapeHtml(String(system.label || system.id || 'SYSTEM').toUpperCase())}</b> · ${escapeHtml(system.mode || 'LIVE')}</span>`
    ).concat(residents.filter((resident) => resident?.running === true).map((resident) =>
      `<span class="chip ${resident.mode === 'SHADOW' ? 'shadow' : ''}"><b>● ${escapeHtml(String(resident.coreId || resident.residencyId || 'RESIDENT').toUpperCase())}</b> · ${escapeHtml(resident.mode || 'NEUTRAL')}</span>`
    ));
    physiology.classList.toggle('visible', chips.length > 0);
    physiology.innerHTML = chips.join('');
    positionPhysiology();
    foot.textContent = `Live stream · ${new Date(meta.updatedAt || Date.now()).toLocaleTimeString()}`;

    if (changed) {
      badge.classList.remove('flash');
      void badge.offsetWidth;
      badge.classList.add('flash');
    }
  }

  function disconnected() {
    if (Date.now() - lastMessageAt < 5000) return;
    dot.className = 'dot wait';
    label.textContent = lastFingerprint ? 'STAY · reconnecting…' : 'STAY · connecting…';
  }

  function start() {
    if (!('EventSource' in window)) {
      setInterval(async () => {
        try {
          const response = await fetch('/__stay/meta', { cache: 'no-store' });
          if (!response.ok) throw new Error('metadata unavailable');
          apply(await response.json());
        } catch { disconnected(); }
      }, 2000);
      return;
    }

    const events = new EventSource('/__stay/live');
    events.addEventListener('runtime', (event) => {
      try { apply(JSON.parse(event.data)); } catch {}
    });
    events.onopen = () => { lastMessageAt = Date.now(); };
    events.onerror = disconnected;
    setInterval(disconnected, 3000);
  }

  start();
})();
