(() => {
  'use strict';
  if (document.getElementById('stay-live-runtime-host')) return;

  const host = document.createElement('div');
  host.id = 'stay-live-runtime-host';
  host.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483647;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:white;';
  document.body.appendChild(host);

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.textContent = 'STAY · connecting…';
  badge.style.cssText = 'border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(12,15,19,.84);backdrop-filter:blur(14px);color:inherit;padding:8px 11px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 8px 28px rgba(0,0,0,.28);cursor:pointer;';
  host.appendChild(badge);

  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;position:absolute;top:42px;right:0;min-width:290px;max-width:calc(100vw - 28px);border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(12,15,19,.94);backdrop-filter:blur(18px);color:inherit;padding:12px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 12px 42px rgba(0,0,0,.36);';
  host.appendChild(panel);

  badge.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  const esc = (v) => String(v).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  let previous = '';

  async function refresh() {
    try {
      const response = await fetch('/__stay/meta', { cache: 'no-store' });
      if (!response.ok) throw new Error('metadata unavailable');
      const meta = await response.json();
      const cores = Array.isArray(meta.cores) ? meta.cores : [];
      const fingerprint = JSON.stringify([meta.version, meta.revision, meta.ok, cores]);

      badge.textContent = `${meta.ok === false ? '○' : '●'} LIVE · v${meta.version || '?'} · R${meta.revision ?? '?'}`;
      panel.innerHTML =
        '<div style="opacity:.55;margin-bottom:8px;letter-spacing:.08em">LIVING RUNTIME</div>' +
        `<div>STAY <b>v${esc(meta.version || '?')}</b></div>` +
        `<div style="margin-top:6px">runtime revision <b>R${esc(meta.revision ?? '?')}</b></div>` +
        cores.map(c => `<div style="margin-top:6px">${esc(c.id)} <b>v${esc(c.version)}</b> · ${esc(c.mode || 'active')}</div>`).join('');

      if (previous && previous !== fingerprint && badge.animate) {
        badge.animate([{ transform: 'scale(1.07)' }, { transform: 'scale(1)' }], { duration: 500 });
      }
      previous = fingerprint;
    } catch {
      badge.textContent = previous ? 'STAY · reconnecting…' : 'STAY · connecting…';
    }
  }

  refresh();
  setInterval(refresh, 1000);
})();
