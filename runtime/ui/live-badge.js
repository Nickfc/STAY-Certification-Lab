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
  badge.textContent = 'STAY · connecting…';
  badge.style.cssText = 'border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(12,15,19,.84);backdrop-filter:blur(14px);color:inherit;padding:8px 11px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 8px 28px rgba(0,0,0,.28);cursor:pointer;';
  host.appendChild(badge);

  const physiologyHost = document.createElement('div');
  physiologyHost.id = 'stay-physiology-strip';
  physiologyHost.setAttribute('aria-label', 'STAY live physiology status');
  physiologyHost.style.cssText = 'display:none;position:fixed;z-index:2147483646;left:20px;top:158px;align-items:center;flex-wrap:wrap;justify-content:flex-start;gap:6px;max-width:calc(100vw - 40px);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:white;pointer-events:none;';
  document.body.appendChild(physiologyHost);

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

  const esc = (v) => String(v).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
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

  function renderPhysiology(systems, residents) {
    const liveSystems = systems.filter((system) => system && system.running === true);
    const present = residents.filter((resident) => resident && resident.running === true);
    const chips = liveSystems.map((system) => {
      const color = '#8debb2';
      const label = String(system.label || system.id || 'SYSTEM').toUpperCase();
      return `<span style="border:1px solid ${color}55;border-radius:999px;background:${color}16;color:${color};padding:4px 7px;font-size:9px;letter-spacing:.05em;white-space:nowrap"><b>● ${esc(label)}</b> · ${esc(system.mode || 'LIVE')}</span>`;
    }).concat(present.map((resident) => {
      const shadow = resident.mode === 'SHADOW';
      const color = shadow ? '#c8a7ff' : '#89e5ff';
      const label = resident.coreId === 'chronobiology' ? 'CHRONOBIOLOGY' : String(resident.coreId || resident.residencyId || 'RESIDENT').toUpperCase();
      return `<span style="border:1px solid ${color}55;border-radius:999px;background:${color}16;color:${color};padding:4px 7px;font-size:9px;letter-spacing:.05em;white-space:nowrap"><b>● ${esc(label)}</b> · ${esc(resident.mode || 'NEUTRAL')}</span>`;
    }));
    physiologyHost.style.display = chips.length ? 'flex' : 'none';
    physiologyHost.innerHTML = chips.join('');
    positionPhysiologyHost();
    systemsEl.innerHTML = systems.length
      ? `<div style="opacity:.55;margin-bottom:5px;letter-spacing:.08em">BIOLOGICAL FABRIC</div>${systems.map((system) => {
          const ok = system.running && system.healthOk !== false;
          return `<div style="margin-top:6px"><span style="color:${ok ? '#8debb2' : '#ff9a9a'}">${ok ? '●' : '○'}</span> ${esc(system.label || system.id || 'system')} · ${esc(system.mode || 'LIVE')} · ${esc(system.status || 'UNKNOWN')} · E${Number(system.events || 0).toLocaleString()} · P${Number(system.pendingDeliveries || 0).toLocaleString()} · C${Number(system.activeConsumers || 0).toLocaleString()}</div>`;
        }).join('')}`
      : '<div style="opacity:.55">Biological fabric unavailable</div>';
    residentsEl.innerHTML = residents.length
      ? `<div style="opacity:.55;margin-bottom:5px;letter-spacing:.08em">RESIDENT PHYSIOLOGY</div>${residents.map((resident) => {
          const ok = resident.running && resident.healthOk !== false;
          return `<div style="margin-top:6px"><span style="color:${ok ? '#8debb2' : '#ff9a9a'}">${ok ? '●' : '○'}</span> ${esc(resident.coreId || resident.residencyId)} <b>v${esc(resident.version || '?')}</b> · ${esc(resident.mode || 'NEUTRAL')} · ${esc(resident.status || 'UNKNOWN')} · G${Number(resident.checkpointGeneration || 0).toLocaleString()} · E${Number(resident.handledEvents || 0).toLocaleString()} · O${Number(resident.observedOutputs || 0).toLocaleString()}</div>`;
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
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    updateComputeReadout();
    if (panel.style.display !== 'none') refresh();
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
      const fingerprint = JSON.stringify([meta.version, meta.revision, meta.revisionFrozen, meta.revisionLabel, meta.ok, cores, systems, residents]);

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
      renderPhysiology(systems, residents);
      updateComputeReadout();

      if (previousFingerprint && previousFingerprint !== fingerprint && badge.animate) {
        badge.animate([{ transform: 'scale(1.07)' }, { transform: 'scale(1)' }], { duration: 500 });
      }
      previousFingerprint = fingerprint;
    } catch {
      badge.textContent = previousFingerprint ? 'STAY · reconnecting…' : 'STAY · connecting…';
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
