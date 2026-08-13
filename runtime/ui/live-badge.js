(() => {
  'use strict';
  if (document.getElementById('stay-live-runtime-host')) return;

  const SHARE_KEY = 'stay-compute-share';
  const clampPercent = (value) => Math.max(1, Math.min(100, Math.round(Number(value) || 5)));
  const storedShare = Number(localStorage.getItem(SHARE_KEY));
  let selectedPercent = clampPercent(Number.isFinite(storedShare) && storedShare > 0 ? storedShare * 100 : 5);

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

  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;position:absolute;top:42px;right:0;width:320px;max-width:calc(100vw - 28px);border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(12,15,19,.94);backdrop-filter:blur(18px);color:inherit;padding:12px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 12px 42px rgba(0,0,0,.36);';
  host.appendChild(panel);

  panel.innerHTML = `
    <div style="opacity:.55;margin-bottom:8px;letter-spacing:.08em">LIVING RUNTIME</div>
    <div>STAY <b id="stay-version">—</b></div>
    <div style="margin-top:6px">runtime revision <b id="stay-revision">—</b></div>
    <div id="stay-cores" style="margin-top:6px"></div>
    <div style="height:1px;background:rgba(255,255,255,.10);margin:12px 0"></div>
    <label for="stay-compute-slider" style="display:flex;justify-content:space-between;gap:12px;align-items:center">
      <span>This browser contributes</span>
      <b id="stay-compute-value">${selectedPercent}%</b>
    </label>
    <input id="stay-compute-slider" type="range" min="1" max="100" step="1" value="${selectedPercent}"
      style="width:100%;margin:9px 0 5px;accent-color:#fff">
    <div id="stay-compute-effective" style="opacity:.65">Preparing worker plan…</div>
    <div style="opacity:.45;margin-top:6px;line-height:1.35">1–100% · saved on this browser · applies when released</div>
  `;

  const versionEl = panel.querySelector('#stay-version');
  const revisionEl = panel.querySelector('#stay-revision');
  const coresEl = panel.querySelector('#stay-cores');
  const slider = panel.querySelector('#stay-compute-slider');
  const valueEl = panel.querySelector('#stay-compute-value');
  const effectiveEl = panel.querySelector('#stay-compute-effective');

  let latestMeta = null;
  let previousFingerprint = '';

  const esc = (v) => String(v).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  function updateBadge() {
    if (!latestMeta) return;
    badge.textContent = `${latestMeta.ok === false ? '○' : '●'} LIVE · v${latestMeta.version || '?'} · R${latestMeta.revision ?? '?'} · ${selectedPercent}%`;
  }

  function updateComputeReadout() {
    const plan = window.__stayComputePlan;
    if (!plan) {
      effectiveEl.textContent = `Requested ${selectedPercent}%`;
      return;
    }
    const effective = Math.max(0, Number(plan.effectiveShare) || 0) * 100;
    effectiveEl.textContent =
      `effective ~${effective.toFixed(1)}% · ${plan.poolSize} worker${plan.poolSize === 1 ? '' : 's'} / ${plan.logicalCores} threads`;
  }

  badge.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    updateComputeReadout();
  });

  slider.addEventListener('input', () => {
    selectedPercent = clampPercent(slider.value);
    valueEl.textContent = `${selectedPercent}%`;
    updateBadge();
  });

  slider.addEventListener('change', () => {
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
      const fingerprint = JSON.stringify([meta.version, meta.revision, meta.ok, cores]);

      updateBadge();
      versionEl.textContent = `v${meta.version || '?'}`;
      revisionEl.textContent = `R${meta.revision ?? '?'}`;
      coresEl.innerHTML = cores.map(c =>
        `<div style="margin-top:6px">${esc(c.id)} <b>v${esc(c.version)}</b> · ${esc(c.mode || 'active')}</div>`
      ).join('');
      updateComputeReadout();

      if (previousFingerprint && previousFingerprint !== fingerprint && badge.animate) {
        badge.animate([{ transform: 'scale(1.07)' }, { transform: 'scale(1)' }], { duration: 500 });
      }
      previousFingerprint = fingerprint;
    } catch {
      badge.textContent = previousFingerprint ? 'STAY · reconnecting…' : 'STAY · connecting…';
    }
  }

  refresh();
  setInterval(refresh, 1000);
})();
