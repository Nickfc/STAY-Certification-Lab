(() => {
  'use strict';

  if (window.__stayLiveVersionBadge) return;
  window.__stayLiveVersionBadge = true;

  const host = document.createElement('div');
  host.id = 'stay-live-version';
  host.setAttribute('aria-live', 'polite');
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2147483647;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgba(255,255,255,.92);
        pointer-events: auto;
      }
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
        width: min(330px, calc(100vw - 28px));
        margin-bottom: 8px;
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
    <div class="wrap">
      <div class="panel" id="panel">
        <div class="title">Living Runtime</div>
        <div id="details"></div>
        <div class="foot" id="foot">Waiting for runtime…</div>
      </div>
      <button id="badge" type="button" aria-expanded="false" title="STAY Living Runtime status">
        <span class="dot wait" id="dot"></span>
        <span id="label">STAY · connecting…</span>
      </button>
    </div>`;

  const badge = root.getElementById('badge');
  const panel = root.getElementById('panel');
  const dot = root.getElementById('dot');
  const label = root.getElementById('label');
  const details = root.getElementById('details');
  const foot = root.getElementById('foot');
  let lastFingerprint = '';
  let lastMessageAt = 0;

  badge.addEventListener('click', () => {
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    badge.setAttribute('aria-expanded', String(open));
  });

  function row(key, value, ok) {
    const cls = ok === true ? 'healthy' : ok === false ? 'unhealthy' : '';
    return `<div class="row"><span class="key">${escapeHtml(key)}</span><span class="value ${cls}">${escapeHtml(value)}</span></div>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function apply(meta) {
    if (!meta || typeof meta !== 'object') return;
    lastMessageAt = Date.now();
    const cores = Array.isArray(meta.cores) ? meta.cores : [];
    const fingerprint = JSON.stringify([meta.releaseVersion, meta.kernelVersion, meta.revision, cores.map((c) => [c.id, c.version, c.mode, c.ok])]);
    const changed = lastFingerprint && fingerprint !== lastFingerprint;
    lastFingerprint = fingerprint;

    dot.className = 'dot' + (meta.ok === false ? ' off' : '');
    label.textContent = `STAY ${meta.kernelVersion || meta.releaseVersion || '?'} · LIVE · rev ${meta.revision ?? '?'}`;

    let html = '';
    html += row('Kernel', `v${meta.kernelVersion || '?'}`, meta.ok !== false);
    html += row('Release', `v${meta.releaseVersion || '?'}`);
    html += row('Runtime revision', String(meta.revision ?? '?'));
    for (const core of cores) {
      html += row(core.id || 'core', `v${core.version || '?'} · ${core.mode || 'active'}`, core.ok !== false);
    }
    details.innerHTML = html;
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
