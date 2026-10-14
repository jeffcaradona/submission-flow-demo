import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import sql from '#mssql';
import { createStore } from '../src/mssql-mock/store.js';
import { createApiApp } from '../src/api/app.js';
import { createRepo } from '../src/api/repo.js';
import { createStatusHub } from '../src/api/status-hub.js';
import { createFrontendApp } from '../src/frontend/app.js';

// ---------- harness ----------

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;
const quiet = { error() {} };

async function startStack({ processMs = 40 } = {}) {
  const pool = new sql.ConnectionPool({ server: 'mock', mock: { processMs, store: createStore() } });
  await pool.connect();
  const repo = createRepo(pool);
  const calls = { process: 0 };
  const spied = {
    ...repo,
    processUserRequest(id) {
      calls.process += 1;
      return repo.processUserRequest(id);
    },
  };
  const api = await listen(createApiApp({ repo: spied, hub: createStatusHub(), log: quiet }));
  const web = await listen(createFrontendApp({ apiBaseUrl: urlOf(api), userId: 'tester', log: quiet }));
  return {
    calls,
    apiUrl: urlOf(api),
    webUrl: urlOf(web),
    async stop() {
      web.closeAllConnections();
      api.closeAllConnections();
      await Promise.all([new Promise((r) => web.close(r)), new Promise((r) => api.close(r))]);
      await pool.close();
    },
  };
}

const USER = { 'x-user-id': 'tester' };
const postSubmission = (apiUrl, key, body) =>
  fetch(`${apiUrl}/submissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...USER },
    body: JSON.stringify(body),
  });
const getStatus = async (apiUrl, id) => (await fetch(`${apiUrl}/requests/${id}`, { headers: USER })).json();

async function waitFor(fn, { timeout = 3000, every = 10 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(every);
  }
}

function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  return data.length ? { event, data: JSON.parse(data.join('\n')) } : null;
}

async function openSse(url, headers = {}) {
  const abort = new AbortController();
  const res = await fetch(url, { headers, signal: abort.signal });
  const events = [];
  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const parsed = parseBlock(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (parsed) events.push(parsed);
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    events,
    find: (pred) => waitFor(() => events.find(pred)),
    close: () => abort.abort(),
  };
}

// ---------- API: accept fast, process after ----------

test('202 comes back before processing finishes, then status becomes Completed', async () => {
  const s = await startStack({ processMs: 300 });
  try {
    const res = await postSubmission(s.apiUrl, randomUUID(), { packages: ['A1', 'B2', 'C3'] });
    assert.equal(res.status, 202);
    const { id } = await res.json();
    assert.match(res.headers.get('location'), new RegExp(`/requests/${id}$`));

    const early = await getStatus(s.apiUrl, id);
    assert.ok(['Accepted', 'Processing'].includes(early.status), `unexpected early status ${early.status}`);

    const done = await waitFor(async () => {
      const r = await getStatus(s.apiUrl, id);
      return r.status === 'Completed' ? r : null;
    });
    assert.equal(done.packageCount, 3);
  } finally {
    await s.stop();
  }
});

test('a Failed outcome is reported with its message', async () => {
  const s = await startStack();
  try {
    const { id } = await (await postSubmission(s.apiUrl, randomUUID(), { packages: ['A1', 'POISON'] })).json();
    const failed = await waitFor(async () => {
      const r = await getStatus(s.apiUrl, id);
      return r.status === 'Failed' ? r : null;
    });
    assert.match(failed.message, /POISON/);
  } finally {
    await s.stop();
  }
});

test('rejects missing key and empty packages without writing', async () => {
  const s = await startStack();
  try {
    const noKey = await fetch(`${s.apiUrl}/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...USER },
      body: JSON.stringify({ packages: ['A1'] }),
    });
    assert.equal(noKey.status, 400);
    const empty = await postSubmission(s.apiUrl, randomUUID(), { packages: [] });
    assert.equal(empty.status, 400);
    const list = await (await fetch(`${s.apiUrl}/requests`, { headers: USER })).json();
    assert.equal(list.requests.length, 0);
  } finally {
    await s.stop();
  }
});

// ---------- idempotency ----------

test('same key twice returns the same id and processes once', async () => {
  const s = await startStack();
  try {
    const key = randomUUID();
    const first = await postSubmission(s.apiUrl, key, { packages: ['A1'] });
    const second = await postSubmission(s.apiUrl, key, { packages: ['A1'] });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const [a, b] = [await first.json(), await second.json()];
    assert.equal(a.id, b.id);

    await waitFor(async () => (await getStatus(s.apiUrl, a.id)).status === 'Completed');
    assert.equal(s.calls.process, 1);
    const list = await (await fetch(`${s.apiUrl}/requests`, { headers: USER })).json();
    assert.equal(list.requests.length, 1);
  } finally {
    await s.stop();
  }
});

test('concurrent duplicates collapse to one request and one processing run', async () => {
  const s = await startStack();
  try {
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postSubmission(s.apiUrl, key, { packages: ['A1', 'B2'] })),
    );
    const ids = new Set();
    for (const r of responses) {
      assert.equal(r.status, 202);
      ids.add((await r.json()).id);
    }
    assert.equal(ids.size, 1);
    await waitFor(async () => (await getStatus(s.apiUrl, [...ids][0])).status === 'Completed');
    assert.equal(s.calls.process, 1);
  } finally {
    await s.stop();
  }
});

// ---------- SSE ----------

test('status on connect: a late subscriber still sees the finished result', async () => {
  const s = await startStack();
  try {
    const { id } = await (await postSubmission(s.apiUrl, randomUUID(), { packages: ['A1'] })).json();
    await waitFor(async () => (await getStatus(s.apiUrl, id)).status === 'Completed');

    const sse = await openSse(`${s.apiUrl}/events`, USER);
    const snap = await sse.find((e) => e.event === 'snapshot' && e.data.id === id);
    assert.equal(snap.data.status, 'Completed');
    sse.close();
  } finally {
    await s.stop();
  }
});

test('subscribed through the front end: snapshot first, then the live completion', async () => {
  const s = await startStack({ processMs: 300 });
  try {
    // Submit the way a browser does: form POST to the front end.
    const form = await (await fetch(`${s.webUrl}/submit`)).text();
    const key = form.match(/name="idempotencyKey" value="([^"]+)"/)[1];
    const posted = await fetch(`${s.webUrl}/submit`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ idempotencyKey: key, packages: 'A1\nB2' }),
    });
    const id = posted.headers.get('location').split('/').pop();

    const sse = await openSse(`${s.webUrl}/events`);
    const snap = await sse.find((e) => e.event === 'snapshot' && e.data.id === id);
    assert.ok(['Accepted', 'Processing'].includes(snap.data.status));
    const live = await sse.find((e) => e.event === 'status' && e.data.id === id);
    assert.equal(live.data.status, 'Completed');
    assert.equal(live.data.packageCount, 2);
    sse.close();
  } finally {
    await s.stop();
  }
});

// ---------- front end ----------

test('front end form: redirect after submit, and a re-POST with the same key lands on the same request', async () => {
  const s = await startStack();
  try {
    const page = await fetch(`${s.webUrl}/submit`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const key = html.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
    assert.match(key, /^[0-9a-f-]{36}$/);

    const submit = () =>
      fetch(`${s.webUrl}/submit`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ idempotencyKey: key, packages: 'A1, B2\nC3' }),
      });
    const first = await submit();
    const second = await submit();
    assert.equal(first.status, 303);
    assert.equal(second.status, 303);
    assert.equal(first.headers.get('location'), second.headers.get('location'));

    const detail = await fetch(`${s.webUrl}${first.headers.get('location')}`);
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /data-request-id=/);

    await waitFor(async () => (await (await fetch(`${s.webUrl}/requests`)).text()).includes('Completed'));
    assert.equal(s.calls.process, 1);
  } finally {
    await s.stop();
  }
});

test('front end form: empty submission re-renders with the error and keeps the same key', async () => {
  const s = await startStack();
  try {
    const key = randomUUID();
    const res = await fetch(`${s.webUrl}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ idempotencyKey: key, packages: '  \n ' }),
    });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /Enter at least one tracking number/);
    assert.ok(html.includes(`value="${key}"`));
  } finally {
    await s.stop();
  }
});

test('front end 404s an unknown request id', async () => {
  const s = await startStack();
  try {
    const missing = await fetch(`${s.webUrl}/requests/${randomUUID()}`);
    assert.equal(missing.status, 404);
  } finally {
    await s.stop();
  }
});

// ---------- the mock itself ----------

test('mock mirrors the node-mssql surface the app relies on', async () => {
  const pool = new sql.ConnectionPool({ server: 'mock', mock: { store: createStore() } });
  await pool.connect();

  const insert = () =>
    pool
      .request()
      .input('UserId', sql.NVarChar(128), 'u1')
      .input('IdempotencyKey', 'k1') // two-argument form, type inferred
      .input('Payload', sql.NVarChar(sql.MAX), '{"packages":["A1"]}')
      .execute('dbo.usp_InsertUserRequest');

  const first = await insert();
  const again = await insert();
  assert.equal(first.recordset[0].is_new, 1);
  assert.equal(again.recordset[0].is_new, 0);
  assert.equal(first.recordset[0].request_id, again.recordset[0].request_id);
  assert.equal(first.returnValue, 0);

  await assert.rejects(pool.request().execute('dbo.usp_Nope'), { code: 'EREQUEST', number: 2812 });
  // Omitting a required parameter fails like SQL Server does (error 201).
  await assert.rejects(pool.request().execute('dbo.usp_GetUserRequests'), { code: 'EREQUEST', number: 201 });

  await pool.close();
  await assert.rejects(pool.request().execute('dbo.usp_GetUserRequests'), { code: 'ECONNCLOSED' });
});
