// Exercises public/live-status.js under a minimal fake DOM + EventSource. This is
// not a real browser, but it covers the behavior the script exists for: update
// the page in place, and toast once for work that finished while the user was
// elsewhere in the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/frontend/public/live-status.js', import.meta.url), 'utf8');

const fakeNode = (extra = {}) => ({
  dataset: {},
  textContent: '',
  children: [],
  append(...nodes) {
    this.children.push(...nodes);
  },
  addEventListener() {},
  remove() {},
  ...extra,
});

// A table row / <dl> carrying one request, shaped like requests.eta renders it.
function fakeRequestEl(id, status) {
  const roles = {
    status: fakeNode({ dataset: { status }, textContent: status }),
    packages: fakeNode({ textContent: '—' }),
    message: fakeNode(),
    updated: fakeNode(),
  };
  return {
    dataset: { requestId: id },
    roles,
    querySelector: (selector) => roles[selector.match(/data-role="(\w+)"/)[1]],
  };
}

// Loads the script into a fresh "page". `storage` outlives pages, like sessionStorage does.
function loadPage({ requests = [], storage = new Map() } = {}) {
  const toasts = fakeNode();
  const listeners = {};
  class FakeEventSource {
    constructor(url) {
      this.url = url;
    }
    addEventListener(type, fn) {
      listeners[type] = fn;
    }
  }
  const document = {
    querySelectorAll: () => requests,
    getElementById: (id) => (id === 'toasts' ? toasts : null),
    createElement: () => fakeNode(),
  };
  const sessionStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
  };
  const context = {
    window: { EventSource: FakeEventSource },
    document,
    sessionStorage,
    EventSource: FakeEventSource,
    setTimeout: () => 0,
    JSON,
    Date,
    Set,
    encodeURIComponent,
  };
  vm.runInNewContext(source, context);
  return {
    storage,
    toasts,
    emit: (type, data) => listeners[type]({ data: JSON.stringify(data) }),
    toastText: () => toasts.children.map((t) => t.children.map((c) => c.textContent ?? c).join('')),
  };
}

const done = (id) => ({
  id,
  status: 'Completed',
  packageCount: 3,
  message: 'Processed 3 package(s)',
  createdAt: '2026-10-14T17:00:00.000Z',
  updatedAt: '2026-10-14T17:00:02.000Z',
});

test('a status event updates the visible row in place and raises one toast', () => {
  const row = fakeRequestEl('req-1', 'Accepted');
  const page = loadPage({ requests: [row] });

  page.emit('status', done('req-1'));

  assert.equal(row.roles.status.textContent, 'Completed');
  assert.equal(row.roles.status.dataset.status, 'Completed');
  assert.equal(row.roles.packages.textContent, 3);
  assert.equal(page.toasts.children.length, 1);
  assert.match(page.toastText()[0], /completed: Processed 3 package/);

  page.emit('status', done('req-1')); // a duplicate delivery must not toast again
  assert.equal(page.toasts.children.length, 1);
});

test('completion that happened between page loads still toasts on the next page', () => {
  const storage = new Map();
  loadPage({ requests: [fakeRequestEl('req-2', 'Processing')], storage }); // user submits, page 1 watches it

  const next = loadPage({ requests: [], storage }); // navigates to a page that does not list it
  next.emit('snapshot', done('req-2'));

  assert.equal(next.toasts.children.length, 1);
  assert.match(next.toastText()[0], /req-2/);
});

test('old finished requests in the snapshot do not toast', () => {
  const page = loadPage({ requests: [] });
  page.emit('snapshot', done('long-finished'));
  assert.equal(page.toasts.children.length, 0);
});
