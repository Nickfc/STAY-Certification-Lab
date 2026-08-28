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
      .rails {
        display: none;
        position: fixed;
        left: var(--stay-physiology-left, 20px);
        top: var(--stay-physiology-top, 158px);
        z-index: 2147483646;
        flex-direction: column;
        align-items: flex-start;
        justify-content: flex-start;
        gap: 5px;
        max-width: calc(100vw - 28px);
        pointer-events: none;
      }
      .rails.visible { display: flex; }
      .rail { display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 6px; max-width: 100%; }
      .chip { border: 1px solid currentColor; border-radius: 999px; padding: 4px 7px; font-size: 9px; letter-spacing: .05em; white-space: nowrap; }
      .chip.live { background: rgba(141,235,178,.09); color: #8debb2; }
      .chip.shadow { background: rgba(200,167,255,.09); color: #c8a7ff; }
      .chip.quarantined { background: rgba(255,154,154,.09); color: #ff9a9a; }
      .chip.offline { background: rgba(174,181,194,.08); color: #aeb5c2; }
      .chip.recovering { background: rgba(255,211,125,.09); color: #ffd37d; }
      .chip.degraded { background: rgba(255,179,107,.09); color: #ffb36b; }
      .chip.neutral { background: rgba(137,229,255,.07); color: #89e5ff; }
      .roadmap { border: 1px dashed rgba(255,255,255,.28); border-radius: 999px; background: rgba(255,255,255,.04); color: rgba(255,255,255,.68); padding: 4px 7px; font-size: 9px; letter-spacing: .05em; white-space: nowrap; }
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
      .value { text-align: right; white-space: normal; overflow-wrap: anywhere; }
      .healthy { color: #a9ffbb; }
      .unhealthy { color: #ffaaa8; }
      .foot { margin-top: 9px; font: 10px/1.35 system-ui, sans-serif; opacity: .45; }
      .flash { animation: flash .7s ease-out; }
      @keyframes flash { 0% { transform: scale(1.07); } 100% { transform: scale(1); } }
      @media (prefers-reduced-motion: reduce) { .flash { animation: none; } }
    </style>
    <div class="rails" id="rails" aria-live="polite" aria-label="STAY physiology and non-live roadmap">
      <div class="rail" id="physiology" role="list" aria-label="STAY resident lifecycle status"></div>
      <div class="rail" id="roadmap" role="list" aria-label="STAY non-live system roadmap"></div>
    </div>
    <div class="wrap">
      <button id="badge" type="button" aria-expanded="false" aria-controls="panel" aria-label="Open STAY living runtime status" title="STAY Living Runtime status">
        <span class="dot wait" id="dot"></span>
        <span id="label">STAY · connecting…</span>
      </button>
      <div class="panel" id="panel" role="region" aria-label="STAY living runtime details" aria-hidden="true">
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
  const rails = root.getElementById('rails');
  const physiology = root.getElementById('physiology');
  const roadmap = root.getElementById('roadmap');
  let lastFingerprint = '';
  let lastMessageAt = 0;

  badge.addEventListener('click', () => {
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    badge.setAttribute('aria-expanded', String(open));
    badge.setAttribute('aria-label', `${open ? 'Close' : 'Open'} STAY living runtime status`);
    panel.setAttribute('aria-hidden', String(!open));
  });
  badge.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('open')) {
      panel.classList.remove('open');
      badge.setAttribute('aria-expanded', 'false');
      badge.setAttribute('aria-label', 'Open STAY living runtime status');
      panel.setAttribute('aria-hidden', 'true');
      badge.focus();
    }
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

  const chipOrder = ['bsf', 'sntss', 'chronobiology', 'metab', 'homeos', 'intero'];
  const chipStates = new Set(['QUARANTINED', 'OFFLINE', 'RECOVERING', 'DEGRADED', 'LIVE', 'SHADOW', 'NEUTRAL']);
  const roadmapStages = new Set(['PLANNED', 'LAB BUILD', 'LAB QUALIFIED']);
  const stateSymbols = {
    QUARANTINED: '⛔', OFFLINE: '○', RECOVERING: '↻', DEGRADED: '△',
    LIVE: '●', SHADOW: '◐', NEUTRAL: '◇'
  };

  function localState(item) {
    const status = String(item?.status || 'UNKNOWN').toUpperCase();
    const lifecycle = String(item?.lifecycle || '').toUpperCase();
    const mode = String(item?.mode || 'NEUTRAL').toUpperCase();
    if (status === 'QUARANTINED' || lifecycle === 'QUARANTINED') return 'QUARANTINED';
    if (['OFFLINE', 'DETACHED', 'STOPPED'].includes(status) || lifecycle === 'OFFLINE') return 'OFFLINE';
    if (['RECOVERING', 'STARTING'].includes(status) || lifecycle === 'RECOVERING') return 'RECOVERING';
    if (['DEGRADED', 'RESYNC_REQUIRED'].includes(status) || lifecycle === 'DEGRADED' || item?.healthOk === false) return 'DEGRADED';
    if (item?.running === false) return 'OFFLINE';
    if (item?.running === true && mode === 'LIVE') return 'LIVE';
    if (item?.running === true && mode === 'SHADOW') return 'SHADOW';
    return 'NEUTRAL';
  }

  function localChip(item, sourceKind) {
    const coreId = String(item?.coreId || item?.id || item?.residencyId || 'unknown')
      .replace(/^resident:/, '').toLowerCase();
    const state = localState(item);
    return {
      coreId,
      label: String(item?.label || coreId).toUpperCase(),
      state,
      mode: String(item?.mode || 'NEUTRAL').toUpperCase(),
      lifecycle: String(item?.lifecycle || item?.status || 'UNKNOWN').toUpperCase(),
      healthReason: state === 'QUARANTINED' ? 'RESIDENT_QUARANTINED'
        : state === 'OFFLINE' ? 'RUNTIME_NOT_RUNNING'
        : state === 'RECOVERING' ? 'BOUNDED_RECOVERY_ACTIVE'
        : state === 'DEGRADED' ? 'RUNTIME_HEALTH_DEGRADED'
        : `${state}_HEALTHY`,
      version: item?.version || null,
      checkpointGeneration: Number(item?.checkpointGeneration || 0),
      handledEvents: Number(item?.handledEvents || item?.events || 0),
      outputs: Number(item?.observedOutputs || 0),
      sourceKind
    };
  }

  function safeProjection(meta, systems, residents) {
    const supplied = meta?.chipProjection;
    let lifecycle;
    let roadmapEntries;
    if (
      supplied?.schema === 'stay-observation-chips-v1' && supplied.observationOnly === true &&
      Array.isArray(supplied.lifecycle) && Array.isArray(supplied.roadmap)
    ) {
      lifecycle = supplied.lifecycle.filter(value => value && typeof value === 'object').map(value => ({
        ...value,
        coreId: String(value.coreId || 'unknown').toLowerCase(),
        label: String(value.label || value.coreId || 'UNKNOWN').toUpperCase(),
        state: chipStates.has(String(value.state).toUpperCase())
          ? String(value.state).toUpperCase()
          : 'NEUTRAL'
      }));
      roadmapEntries = supplied.roadmap.filter(value => value && typeof value === 'object').map(value => ({
        coreId: String(value.coreId || 'unknown').toLowerCase(),
        label: String(value.label || value.coreId || 'UNKNOWN').toUpperCase(),
        stage: roadmapStages.has(String(value.stage).toUpperCase())
          ? String(value.stage).toUpperCase()
          : 'PLANNED'
      }));
    } else {
      lifecycle = systems.filter(Boolean).map(value => localChip(value, 'SYSTEM'))
        .concat(residents.filter(Boolean).map(value => localChip(value, 'RESIDENT')));
      const born = new Set(lifecycle.map(value => value.coreId));
      roadmapEntries = ['metab', 'homeos', 'intero']
        .filter(coreId => !born.has(coreId))
        .map(coreId => ({ coreId, label: coreId.toUpperCase(), stage: 'PLANNED' }));
    }
    const born = new Set(lifecycle.map(value => value.coreId));
    roadmapEntries = roadmapEntries.filter(value => !born.has(value.coreId));
    const order = value => {
      const index = chipOrder.indexOf(value.coreId);
      return index < 0 ? chipOrder.length : index;
    };
    lifecycle.sort((left, right) => order(left) - order(right));
    roadmapEntries.sort((left, right) => order(left) - order(right));
    return { lifecycle, roadmap: roadmapEntries };
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
    const projection = safeProjection(meta, systems, residents);
    const fingerprint = JSON.stringify([meta.releaseVersion, meta.kernelVersion, meta.revision, meta.revisionFrozen, meta.revisionLabel, cores.map((c) => [c.id, c.version, c.mode, c.ok]), systems.map((s) => [s.id, s.mode, s.status, s.healthOk]), residents.map((r) => [r.residencyId, r.version, r.status, r.mode]), projection]);
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
    for (const chip of projection.lifecycle) {
      const version = chip.version ? `v${chip.version} · ` : '';
      html += row(
        chip.label || chip.coreId || 'resident',
        `${version}${chip.mode || 'NEUTRAL'} · lifecycle ${chip.lifecycle || 'UNKNOWN'} · ${chip.state} · G${Number(chip.checkpointGeneration || 0).toLocaleString()} · E${Number(chip.handledEvents || 0).toLocaleString()} · O${Number(chip.outputs || 0).toLocaleString()} · ${chip.healthReason || 'HEALTH_UNKNOWN'}`,
        ['LIVE', 'SHADOW', 'NEUTRAL'].includes(chip.state)
      );
    }
    details.innerHTML = html;
    const chips = projection.lifecycle.map((chip) => {
      const state = chipStates.has(String(chip.state).toUpperCase())
        ? String(chip.state).toUpperCase()
        : 'NEUTRAL';
      const aria = `${chip.label || chip.coreId} lifecycle ${state}; ${chip.healthReason || 'health unknown'}`;
      return `<span role="listitem" class="chip ${state.toLowerCase()}" aria-label="${escapeHtml(aria)}" data-core-id="${escapeHtml(chip.coreId)}" data-state="${escapeHtml(state)}"><b>${stateSymbols[state]} ${escapeHtml(chip.label || chip.coreId || 'UNKNOWN')}</b> · ${escapeHtml(state)}</span>`;
    });
    const roadmapLabels = projection.roadmap.map((entry) =>
      `<span role="listitem" class="roadmap" aria-label="${escapeHtml(`${entry.label} non-live roadmap ${entry.stage}`)}" data-core-id="${escapeHtml(entry.coreId)}" data-roadmap-stage="${escapeHtml(entry.stage)}"><b>${escapeHtml(entry.label)}</b> · ${escapeHtml(entry.stage)}</span>`
    );
    rails.classList.toggle('visible', chips.length + roadmapLabels.length > 0);
    rails.dataset.stale = 'false';
    rails.setAttribute('aria-label', 'STAY physiology and non-live roadmap');
    physiology.style.display = chips.length ? 'flex' : 'none';
    roadmap.style.display = roadmapLabels.length ? 'flex' : 'none';
    physiology.innerHTML = chips.join('');
    roadmap.innerHTML = roadmapLabels.join('');
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
    rails.dataset.stale = 'true';
    rails.setAttribute('aria-label', 'STAY physiology and non-live roadmap; temporarily stale while reconnecting');
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
