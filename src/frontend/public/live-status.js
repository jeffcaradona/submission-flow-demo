// Progressive enhancement, loaded by the layout on every page. Pages are fully
// server-rendered without it; this only keeps the status on screen current.
//
// Because each page load opens a fresh EventSource, the API's snapshot-on-connect
// brings the page up to date no matter where the user navigated while a request
// was running. `watching` (per tab session) remembers which requests we still owe
// the user an answer on, so a completion that happened between two page loads
// still produces a toast on the next one.
(() => {
  if (!('EventSource' in window)) return;

  const TERMINAL = new Set(['Completed', 'Failed']);
  const KEY = 'watching';

  const load = () => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  };
  const save = (set) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify([...set]));
    } catch {
      /* storage unavailable: toasts degrade, pages still update */
    }
  };
  const fmt = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

  const watching = load();

  // Anything already on this page that is still in flight is something to watch.
  for (const el of document.querySelectorAll('[data-request-id]')) {
    const status = el.querySelector('[data-role="status"]')?.dataset.status;
    if (status && !TERMINAL.has(status)) watching.add(el.dataset.requestId);
  }
  save(watching);

  function applyToPage(r) {
    for (const el of document.querySelectorAll('[data-request-id]')) {
      if (el.dataset.requestId !== r.id) continue;
      const status = el.querySelector('[data-role="status"]');
      if (status) {
        status.dataset.status = r.status;
        status.textContent = r.status;
      }
      const set = (role, text) => {
        const node = el.querySelector(`[data-role="${role}"]`);
        if (node) node.textContent = text;
      };
      set('packages', r.packageCount ?? '—');
      set('message', r.message ?? '');
      set('updated', fmt(r.updatedAt));
    }
  }

  function toast(r) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast';
    const link = document.createElement('a');
    link.href = `/requests/${encodeURIComponent(r.id)}`;
    link.textContent = `Request ${r.id.slice(0, 8)}`;
    el.append(link, ` ${r.status.toLowerCase()}${r.message ? ': ' + r.message : ''}`);
    el.addEventListener('click', () => el.remove());
    box.append(el);
    setTimeout(() => el.remove(), 12_000);
  }

  function onEvent(event) {
    const r = JSON.parse(event.data);
    applyToPage(r);
    if (!TERMINAL.has(r.status)) {
      watching.add(r.id);
      save(watching);
    } else if (watching.delete(r.id)) {
      save(watching);
      toast(r);
    }
  }

  const source = new EventSource('/events'); // the browser reconnects on its own if it drops
  source.addEventListener('snapshot', onEvent);
  source.addEventListener('status', onEvent);
})();
