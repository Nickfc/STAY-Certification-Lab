(() => {
  'use strict';
  if (document.getElementById('stay-live-runtime-host')) return;

  const SHARE_KEY = 'stay-compute-share';
  const clampPercent = (value) => Math.max(1, Math.min(100, Math.round(Number(value) || 5)));
  const storedShare = Number(localStorage.getItem(SHARE_KEY));
  let selectedPercent = clampPercent(Number.isFinite(storedShare) && storedShare > 0 ? storedShare * 100 : 5);
  const ENGINE_KEY = 'stay-compute-engine';
  const HYBRID_KEY = 'stay-hybrid-gpu-share';
  const validEngines = new Set(['auto', 'cpu', 'gpu', 'hybrid']);
  let selectedEngine = String(localStorage.getItem(ENGINE_KEY) || 'auto').toLowerCase();
  if (!validEngines.has(selectedEngine)) selectedEngine = 'auto';
  let hybridGpuPercent = Math.max(10, Math.min(90, Math.round((Number(localStorage.getItem(HYBRID_KEY)) || 0.8) * 100)));
  let shareDebounce = null;

  const host = document.createElement('div');
  host.id = 'stay-live-runtime-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:white;';
  document.body.appendChild(host);

  function positionRuntimeHost() {
    const presence = document.querySelector('.presence');
    if (presence) {
      const rect = presence.getBoundingClientRect();
      host.style.top = `${Math.ceil(rect.bottom + 8)}px`;
      host.style.right = `${Math.max(14, Math.ceil(window.innerWidth - rect.right))}px`;
      return;
    }
    host.style.top = '64px';
    host.style.right = '14px';
  }

  positionRuntimeHost();
  requestAnimationFrame(positionRuntimeHost);
  window.addEventListener('resize', positionRuntimeHost);

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.id = 'stay-live-runtime-button';
  badge.setAttribute('aria-expanded', 'false');
  badge.setAttribute('aria-controls', 'stay-live-runtime-panel');
  badge.setAttribute('aria-label', 'Open STAY living runtime status');
  badge.textContent = 'STAY · connecting…';
  badge.style.cssText = 'border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(12,15,19,.84);backdrop-filter:blur(14px);color:inherit;padding:8px 11px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 8px 28px rgba(0,0,0,.28);cursor:pointer;';
  host.appendChild(badge);

  const physiologyHost = document.createElement('div');
  physiologyHost.id = 'stay-physiology-strip';
  physiologyHost.setAttribute('aria-live', 'polite');
  physiologyHost.setAttribute('aria-label', 'STAY physiology and non-live roadmap');
  physiologyHost.style.cssText = 'display:none;position:fixed;z-index:2147483646;left:20px;top:158px;flex-direction:column;align-items:flex-start;gap:5px;max-width:calc(100vw - 28px);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:white;pointer-events:none;';
  document.body.appendChild(physiologyHost);

  const lifecycleRail = document.createElement('div');
  lifecycleRail.id = 'stay-lifecycle-chips';
  lifecycleRail.setAttribute('role', 'list');
  lifecycleRail.setAttribute('aria-label', 'STAY resident lifecycle status');
  lifecycleRail.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-start;gap:6px;max-width:100%;';
  physiologyHost.appendChild(lifecycleRail);

  const roadmapRail = document.createElement('div');
  roadmapRail.id = 'stay-roadmap-labels';
  roadmapRail.setAttribute('role', 'list');
  roadmapRail.setAttribute('aria-label', 'STAY non-live system roadmap');
  roadmapRail.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-start;gap:6px;max-width:100%;';
  physiologyHost.appendChild(roadmapRail);

  function positionPhysiologyHost() {
    const candidates = [...document.querySelectorAll('h1,h2,[class*="brand"],[class*="logo"],header *')];
    const brand = candidates.find((element) => String(element.textContent || '').trim().toUpperCase() === 'STAY');
    if (!brand) {
      physiologyHost.style.left = '20px';
      physiologyHost.style.top = '158px';
      return;
    }
    const rect = brand.getBoundingClientRect();
    physiologyHost.style.left = `${Math.max(14, Math.ceil(rect.left))}px`;
    physiologyHost.style.top = `${Math.ceil(rect.bottom + 8)}px`;
  }

  positionPhysiologyHost();
  requestAnimationFrame(positionPhysiologyHost);
  window.addEventListener('resize', positionPhysiologyHost);

  const panel = document.createElement('div');
  panel.id = 'stay-live-runtime-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'STAY living runtime details');
  panel.setAttribute('aria-hidden', 'true');
  panel.style.cssText = 'display:none;position:absolute;top:42px;right:0;width:360px;max-width:calc(100vw - 28px);border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(12,15,19,.94);backdrop-filter:blur(18px);color:inherit;padding:12px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 12px 42px rgba(0,0,0,.36);';
  host.appendChild(panel);

  panel.innerHTML = `
    <div style="opacity:.55;margin-bottom:8px;letter-spacing:.08em">LIVING RUNTIME</div>
    <div>STAY <b id="stay-version">—</b></div>
    <div style="margin-top:6px">runtime revision <b id="stay-revision">—</b></div>
    <div id="stay-cores" style="margin-top:6px"></div>
    <div id="stay-systems" style="margin-top:9px"></div>
    <div id="stay-residents" style="margin-top:9px"></div>
    <div style="height:1px;background:rgba(255,255,255,.10);margin:12px 0"></div>
    <label style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:6px">
      <span>Compute engine</span>
      <select id="stay-compute-engine" style="background:#111722;color:white;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:4px 6px;font:inherit">
        <option value="auto">Auto</option>
        <option value="gpu">GPU</option>
        <option value="cpu">CPU</option>
        <option value="hybrid">Hybrid</option>
      </select>
    </label>
    <div id="stay-engine-status" style="opacity:.62;margin-bottom:10px">Detecting compute engines…</div>
    <div id="stay-hybrid-row" style="display:none;margin:0 0 10px">
      <label for="stay-hybrid-slider" style="display:flex;justify-content:space-between;gap:12px">
        <span>Hybrid GPU share</span><b id="stay-hybrid-value">${hybridGpuPercent}%</b>
      </label>
      <input id="stay-hybrid-slider" type="range" min="10" max="90" step="5" value="${hybridGpuPercent}" style="width:100%;margin:7px 0 0;accent-color:#fff">
    </div>
    <label for="stay-compute-slider" style="display:flex;justify-content:space-between;gap:12px;align-items:center">
      <span>This browser contributes</span>
      <b id="stay-compute-value">${selectedPercent}%</b>
    </label>
    <input id="stay-compute-slider" type="range" min="1" max="100" step="1" value="${selectedPercent}"
      style="width:100%;margin:9px 0 5px;accent-color:#fff">
    <div id="stay-compute-effective" style="opacity:.65">Preparing worker plan…</div>
    <div style="opacity:.45;margin-top:6px;line-height:1.35">1–100% · measured duty · applies live · saved on this browser</div>
  `;

  const versionEl = panel.querySelector('#stay-version');
  const revisionEl = panel.querySelector('#stay-revision');
  const coresEl = panel.querySelector('#stay-cores');
  const systemsEl = panel.querySelector('#stay-systems');
  const residentsEl = panel.querySelector('#stay-residents');
  const slider = panel.querySelector('#stay-compute-slider');
  const valueEl = panel.querySelector('#stay-compute-value');
  const effectiveEl = panel.querySelector('#stay-compute-effective');
  const engineSelect = panel.querySelector('#stay-compute-engine');
  const engineStatusEl = panel.querySelector('#stay-engine-status');
  const hybridRow = panel.querySelector('#stay-hybrid-row');
  const hybridSlider = panel.querySelector('#stay-hybrid-slider');
  const hybridValue = panel.querySelector('#stay-hybrid-value');
  engineSelect.value = selectedEngine;

  let latestMeta = null;
  let previousFingerprint = '';

  const esc = (v) => String(v).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const chipOrder = ['bsf', 'sntss', 'chronobiology', 'metab', 'homeos', 'intero'];
  const chipStates = new Set(['QUARANTINED', 'OFFLINE', 'RECOVERING', 'DEGRADED', 'LIVE', 'SHADOW', 'NEUTRAL']);
  const roadmapStages = new Set(['PLANNED', 'LAB BUILD', 'LAB QUALIFIED']);
  const statePresentation = {
    QUARANTINED: { symbol: '⛔', color: '#ff9a9a' },
    OFFLINE: { symbol: '○', color: '#aeb5c2' },
    RECOVERING: { symbol: '↻', color: '#ffd37d' },
    DEGRADED: { symbol: '△', color: '#ffb36b' },
    LIVE: { symbol: '●', color: '#8debb2' },
    SHADOW: { symbol: '◐', color: '#c8a7ff' },
    NEUTRAL: { symbol: '◇', color: '#89e5ff' }
  };
  const revisionLabel = (meta) => {
    if (typeof meta?.revisionLabel === 'string' && /^R[0-9]+F?$/.test(meta.revisionLabel)) return meta.revisionLabel;
    return `R${meta?.revision ?? '?'}${meta?.revisionFrozen === true ? 'F' : ''}`;
  };

  function updateBadge() {
    if (!latestMeta) return;
    const plan = window.__stayComputePlan || {};
    const engine = String(plan.engineResolved || selectedEngine || 'auto').toUpperCase();
    badge.textContent = `${latestMeta.ok === false ? '○' : '●'} LIVE · v${latestMeta.version || '?'} · ${revisionLabel(latestMeta)} · ${engine} ${selectedPercent}%`;
  }

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

  function localChip(item, kind) {
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
      sourceKind: kind.toUpperCase()
    };
  }

  function safeProjection(meta, systems, residents) {
    const supplied = meta?.chipProjection;
    let lifecycle;
    let roadmap;
    if (
      supplied?.schema === 'stay-observation-chips-v1' &&
      supplied.observationOnly === true &&
      Array.isArray(supplied.lifecycle) &&
      Array.isArray(supplied.roadmap)
    ) {
      lifecycle = supplied.lifecycle.filter(value => value && typeof value === 'object').map(value => ({
        ...value,
        coreId: String(value.coreId || 'unknown').toLowerCase(),
        label: String(value.label || value.coreId || 'UNKNOWN').toUpperCase(),
        state: chipStates.has(String(value.state).toUpperCase())
          ? String(value.state).toUpperCase()
          : 'NEUTRAL'
      }));
      roadmap = supplied.roadmap.filter(value => value && typeof value === 'object').map(value => ({
        coreId: String(value.coreId || 'unknown').toLowerCase(),
        label: String(value.label || value.coreId || 'UNKNOWN').toUpperCase(),
        stage: roadmapStages.has(String(value.stage).toUpperCase())
          ? String(value.stage).toUpperCase()
          : 'PLANNED'
      }));
    } else {
      lifecycle = systems.filter(Boolean).map(value => localChip(value, 'system'))
        .concat(residents.filter(Boolean).map(value => localChip(value, 'resident')));
      const born = new Set(lifecycle.map(value => value.coreId));
      roadmap = ['metab', 'homeos', 'intero'].filter(coreId => !born.has(coreId)).map(coreId => ({
        coreId, label: coreId.toUpperCase(), stage: 'PLANNED'
      }));
    }
    const born = new Set(lifecycle.map(value => value.coreId));
    roadmap = roadmap.filter(value => !born.has(value.coreId));
    const order = value => {
      const index = chipOrder.indexOf(value.coreId);
      return index < 0 ? chipOrder.length : index;
    };
    lifecycle.sort((left, right) => order(left) - order(right));
    roadmap.sort((left, right) => order(left) - order(right));
    return { lifecycle, roadmap };
  }

  function renderPhysiology(systems, residents, projection) {
    const lifecycleHtml = projection.lifecycle.map((chip) => {
      const state = chipStates.has(String(chip.state).toUpperCase())
        ? String(chip.state).toUpperCase()
        : 'NEUTRAL';
      const presentation = statePresentation[state];
      const aria = `${chip.label || chip.coreId} lifecycle ${state}; ${chip.healthReason || 'health unknown'}`;
      return `<span role="listitem" aria-label="${esc(aria)}" data-core-id="${esc(chip.coreId)}" data-state="${esc(state)}" style="border:1px solid ${presentation.color}66;border-radius:999px;background:${presentation.color}17;color:${presentation.color};padding:4px 7px;font-size:9px;letter-spacing:.05em;white-space:nowrap"><b>${presentation.symbol} ${esc(chip.label || chip.coreId || 'UNKNOWN')}</b> · ${esc(state)}</span>`;
    }).join('');
    const roadmapHtml = projection.roadmap.map((entry) =>
      `<span role="listitem" aria-label="${esc(`${entry.label} non-live roadmap ${entry.stage}`)}" data-core-id="${esc(entry.coreId)}" data-roadmap-stage="${esc(entry.stage)}" style="border:1px dashed rgba(255,255,255,.28);border-radius:999px;background:rgba(255,255,255,.04);color:rgba(255,255,255,.68);padding:4px 7px;font-size:9px;letter-spacing:.05em;white-space:nowrap"><b>${esc(entry.label)}</b> · ${esc(entry.stage)}</span>`
    ).join('');
    physiologyHost.style.display = lifecycleHtml || roadmapHtml ? 'flex' : 'none';
    lifecycleRail.style.display = lifecycleHtml ? 'flex' : 'none';
    roadmapRail.style.display = roadmapHtml ? 'flex' : 'none';
    lifecycleRail.innerHTML = lifecycleHtml;
    roadmapRail.innerHTML = roadmapHtml;
    positionPhysiologyHost();
    const chipsByCore = new Map(projection.lifecycle.map(chip => [chip.coreId, chip]));
    systemsEl.innerHTML = systems.length
      ? `<div style="opacity:.55;margin-bottom:5px;letter-spacing:.08em">BIOLOGICAL FABRIC</div>${systems.map((system) => {
          const chip = chipsByCore.get(String(system.id || '').toLowerCase()) || localChip(system, 'system');
          const presentation = statePresentation[chip.state] || statePresentation.NEUTRAL;
          return `<div style="margin-top:6px"><span style="color:${presentation.color}">${presentation.symbol}</span> ${esc(system.label || system.id || 'system')} · ${esc(system.mode || 'LIVE')} · lifecycle ${esc(chip.lifecycle)} · ${esc(chip.state)} · E${Number(system.events || 0).toLocaleString()} · P${Number(system.pendingDeliveries || 0).toLocaleString()} · C${Number(system.activeConsumers || 0).toLocaleString()} · ${esc(chip.healthReason)}</div>`;
        }).join('')}`
      : '<div style="opacity:.55">Biological fabric unavailable</div>';
    residentsEl.innerHTML = residents.length
      ? `<div style="opacity:.55;margin-bottom:5px;letter-spacing:.08em">RESIDENT PHYSIOLOGY</div>${residents.map((resident) => {
          const coreId = String(resident.coreId || resident.residencyId || '').replace(/^resident:/, '').toLowerCase();
          const chip = chipsByCore.get(coreId) || localChip(resident, 'resident');
          const presentation = statePresentation[chip.state] || statePresentation.NEUTRAL;
          return `<div style="margin-top:6px"><span style="color:${presentation.color}">${presentation.symbol}</span> ${esc(resident.coreId || resident.residencyId)} <b>v${esc(resident.version || '?')}</b> · ${esc(resident.mode || 'NEUTRAL')} · lifecycle ${esc(chip.lifecycle)} · ${esc(chip.state)} · G${Number(resident.checkpointGeneration || 0).toLocaleString()} · E${Number(resident.handledEvents || 0).toLocaleString()} · O${Number(resident.observedOutputs || 0).toLocaleString()} · ${esc(chip.healthReason)}</div>`;
        }).join('')}`
      : '<div style="opacity:.55">No resident physiology attached</div>';
  }

  function updateComputeReadout() {
    const plan = window.__stayComputePlan;
    const gpu = window.__stayGpuStatus || {};
    hybridRow.style.display = selectedEngine === 'hybrid' ? 'block' : 'none';

    if (!window.isSecureContext) {
      engineStatusEl.textContent = selectedEngine === 'gpu'
        ? 'GPU ONLY selected · CPU fallback OFF · HTTPS required before GPU can run'
        : 'GPU locked: HTTPS is required by WebGPU';
    } else if (gpu.ready) {
      const adapter = gpu.adapterInfo || {};
      const adapterName = adapter.description || adapter.device || adapter.architecture || adapter.vendor || 'WebGPU adapter';
      engineStatusEl.textContent = `GPU ready · ${adapterName}${gpu.lastCandidates ? ` · ${Math.round((gpu.candidatesPerMs || 0) * 1000).toLocaleString()} cand/s · ${Number(gpu.lastElapsedMs || 0).toFixed(1)} ms job · ${Number(gpu.lastCooldownMs || 0).toFixed(0)} ms cooldown · 5s ${(Number(gpu.measuredDuty5s || 0) * 100).toFixed(1)}% / 30s ${(Number(gpu.measuredDuty30s || 0) * 100).toFixed(1)}% · ${Math.round(Number(gpu.allocatedBufferBytes || 0) / 1024)} KiB buffers` : ' · awaiting first task'}`;
    } else if (gpu.supported === false) {
      const detail = gpu.lastError ? `${gpu.reason || 'WebGPU unavailable'} · ${gpu.lastError}` : (gpu.reason || 'WebGPU unavailable');
      engineStatusEl.textContent = selectedEngine === 'gpu'
        ? `GPU ONLY selected · CPU fallback OFF · ${detail}`
        : `GPU unavailable · ${detail}`;
    } else {
      const detail = gpu.lastError ? `${gpu.reason || 'initializing…'} · ${gpu.lastError}` : (gpu.reason || 'initializing…');
      engineStatusEl.textContent = selectedEngine === 'gpu'
        ? `GPU ONLY selected · CPU fallback OFF · ${detail}`
        : `GPU ${detail}`;
    }

    if (!plan) {
      effectiveEl.textContent = `Requested ${selectedPercent}%`;
      return;
    }

    const resolved = String(plan.engineResolved || selectedEngine || 'cpu').toUpperCase();
    const cpu = Math.max(0, Number(plan.cpuShare) || 0) * 100;
    const gpuShare = Math.max(0, Number(plan.gpuShare) || 0) * 100;
    const effective = Math.max(0, Number(plan.effectiveShare) || 0) * 100;
    const responsive = window.__stayResponsivenessStatus || {};
    const safeGpu = Math.max(0, Number(gpu.effectiveDuty) || 0) * 100;
    const reason = responsive.backoffReason && responsive.backoffReason !== 'none' ? ` · backoff: ${responsive.backoffReason}` : '';

    if (resolved === 'GPU-WAITING') {
      effectiveEl.textContent =
        `GPU ONLY · requested ${selectedPercent}% · CPU 0.0% · GPU paused until available`;
    } else if (resolved === 'HYBRID-DEGRADED') {
      effectiveEl.textContent =
        `HYBRID · requested ${selectedPercent}% · CPU ${cpu.toFixed(1)}% · GPU share paused (not moved to CPU)`;
    } else {
      effectiveEl.textContent =
        `${resolved} · requested ${selectedPercent}% · CPU ${cpu.toFixed(1)}% (safe ${effective.toFixed(1)}%, peak ${Number(plan.peakConcurrency || 0)}) · GPU ${gpuShare.toFixed(1)}% (safe ${safeGpu.toFixed(1)}%)${reason}`;
    }
  }

  badge.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    panel.setAttribute('aria-hidden', String(!open));
    badge.setAttribute('aria-expanded', String(open));
    badge.setAttribute('aria-label', `${open ? 'Close' : 'Open'} STAY living runtime status`);
    updateComputeReadout();
    if (open) refresh();
  });
  badge.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.style.display !== 'none') {
      panel.style.display = 'none';
      panel.setAttribute('aria-hidden', 'true');
      badge.setAttribute('aria-expanded', 'false');
      badge.setAttribute('aria-label', 'Open STAY living runtime status');
      badge.focus();
    }
  });

  engineSelect.addEventListener('change', () => {
    selectedEngine = validEngines.has(engineSelect.value) ? engineSelect.value : 'auto';
    localStorage.setItem(ENGINE_KEY, selectedEngine);
    hybridRow.style.display = selectedEngine === 'hybrid' ? 'block' : 'none';
    window.dispatchEvent(new CustomEvent('stay-compute-engine-change', {
      detail: { engine: selectedEngine }
    }));
    updateBadge();
    setTimeout(updateComputeReadout, 80);
  });

  hybridSlider.addEventListener('input', () => {
    hybridGpuPercent = Math.max(10, Math.min(90, Math.round(Number(hybridSlider.value) || 80)));
    hybridValue.textContent = `${hybridGpuPercent}%`;
  });

  hybridSlider.addEventListener('change', () => {
    hybridGpuPercent = Math.max(10, Math.min(90, Math.round(Number(hybridSlider.value) || 80)));
    localStorage.setItem(HYBRID_KEY, String(hybridGpuPercent / 100));
    hybridValue.textContent = `${hybridGpuPercent}%`;
    window.dispatchEvent(new CustomEvent('stay-hybrid-split-change', {
      detail: { gpuShare: hybridGpuPercent / 100 }
    }));
    setTimeout(updateComputeReadout, 80);
  });

  window.addEventListener('stay-gpu-status', () => {
    updateComputeReadout();
    updateBadge();
  });
  window.addEventListener('stay-responsiveness-status', updateComputeReadout);

  slider.addEventListener('input', () => {
    selectedPercent = clampPercent(slider.value);
    valueEl.textContent = `${selectedPercent}%`;
    updateBadge();
    clearTimeout(shareDebounce);
    shareDebounce = setTimeout(() => {
      localStorage.setItem(SHARE_KEY, String(selectedPercent / 100));
      window.dispatchEvent(new CustomEvent('stay-compute-share-change', { detail: { share: selectedPercent / 100, dragging: true } }));
    }, 120);
  });

  slider.addEventListener('change', () => {
    clearTimeout(shareDebounce);
    selectedPercent = clampPercent(slider.value);
    localStorage.setItem(SHARE_KEY, String(selectedPercent / 100));
    valueEl.textContent = `${selectedPercent}%`;
    updateBadge();
    window.dispatchEvent(new CustomEvent('stay-compute-share-change', {
      detail: { share: selectedPercent / 100 }
    }));
    setTimeout(updateComputeReadout, 80);
  });

  async function refresh() {
    try {
      const response = await fetch('/__stay/meta', { cache: 'no-store' });
      if (!response.ok) throw new Error('metadata unavailable');
      const meta = await response.json();
      latestMeta = meta;
      const cores = Array.isArray(meta.cores) ? meta.cores : [];
      const systems = Array.isArray(meta.systems) ? meta.systems : [];
      const residents = Array.isArray(meta.residents) ? meta.residents : [];
      const projection = safeProjection(meta, systems, residents);
      const fingerprint = JSON.stringify([meta.version, meta.revision, meta.revisionFrozen, meta.revisionLabel, meta.ok, cores, systems, residents, projection]);

      updateBadge();
      versionEl.textContent = `v${meta.version || '?'}`;
      revisionEl.textContent = revisionLabel(meta);
      coresEl.innerHTML = cores.map(c => {
        const g = c.memoryGuardian;
        const memory = g && Number.isFinite(Number(g.rssMiB))
          ? ` · ${Number(g.rssMiB).toFixed(0)} MiB RSS / ${Number(g.recycleAtMiB || 0).toFixed(0)} MiB guard · G${Number(g.guardianRecycles || 0)} R${Number(g.crashRestarts || 0)}`
          : '';
        return `<div style="margin-top:6px">${esc(c.id)} <b>v${esc(c.version)}</b> · ${esc(c.mode || 'active')}${memory}</div>`;
      }).join('');
      physiologyHost.dataset.stale = 'false';
      physiologyHost.setAttribute('aria-label', 'STAY physiology and non-live roadmap');
      renderPhysiology(systems, residents, projection);
      updateComputeReadout();

      if (previousFingerprint && previousFingerprint !== fingerprint && badge.animate) {
        badge.animate([{ transform: 'scale(1.07)' }, { transform: 'scale(1)' }], { duration: 500 });
      }
      previousFingerprint = fingerprint;
    } catch {
      badge.textContent = previousFingerprint ? 'STAY · reconnecting…' : 'STAY · connecting…';
      physiologyHost.dataset.stale = 'true';
      physiologyHost.setAttribute('aria-label', 'STAY physiology and non-live roadmap; temporarily stale while reconnecting');
    }
  }

  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await refresh();
      scheduleRefresh();
    }, document.visibilityState === 'visible' ? 5000 : 30000);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); scheduleRefresh(); });
  refresh();
  scheduleRefresh();
})();
