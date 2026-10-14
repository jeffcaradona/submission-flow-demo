// Server-rendered Express + Eta front end. No SPA: every route is a full page,
// the submit is a plain form POST followed by a redirect, and the one script in
// the layout (public/live-status.js) only enhances pages with live status.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Eta } from 'eta';

const here = path.dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fmt = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

export function createFrontendApp({ apiBaseUrl, userId = process.env.DEMO_USER_ID ?? 'demo-user', log = console }) {
  const app = express();
  app.disable('x-powered-by');

  const eta = new Eta({ views: path.join(here, 'views'), cache: true });
  const render = (view, data = {}) => eta.render(view, { fmt, ...data });

  // The front end never touches the database; everything goes through the API.
  const api = (route, init = {}) =>
    fetch(new URL(route, apiBaseUrl), { ...init, headers: { 'x-user-id': userId, ...init.headers } });

  app.use('/public', express.static(path.join(here, 'public')));

  app.get('/', (req, res) => res.redirect('/submit'));

  // The idempotency key is minted when the form is rendered, not when it is
  // submitted, so a double-click, retry or re-POST all carry the same key.
  app.get('/submit', (req, res) => {
    res.send(render('submit', { idempotencyKey: randomUUID(), packages: '', error: null }));
  });

  app.post('/submit', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const key = String(req.body.idempotencyKey ?? '');
      const raw = String(req.body.packages ?? '');
      const packages = raw.split(/[\s,]+/).filter(Boolean);

      if (!UUID_RE.test(key)) {
        return res.status(400).send(
          render('submit', { idempotencyKey: randomUUID(), packages: raw, error: 'That form expired. Please submit again.' }),
        );
      }
      if (packages.length === 0) {
        return res.status(400).send(
          render('submit', { idempotencyKey: key, packages: raw, error: 'Enter at least one tracking number.' }),
        );
      }

      const upstream = await api('/submissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ packages }),
      });
      if (upstream.status !== 202) {
        const body = await upstream.json().catch(() => ({}));
        return res.status(502).send(
          render('submit', { idempotencyKey: key, packages: raw, error: body.error ?? 'The request could not be accepted.' }),
        );
      }

      // Post/redirect/get: refreshing the next page can never resubmit the form.
      const { id } = await upstream.json();
      res.redirect(303, `/requests/${encodeURIComponent(id)}`);
    } catch (err) {
      next(err);
    }
  });

  app.get('/requests', async (req, res, next) => {
    try {
      const upstream = await api('/requests');
      if (!upstream.ok) throw new Error(`API responded ${upstream.status}`);
      const { requests } = await upstream.json();
      res.send(render('requests', { requests }));
    } catch (err) {
      next(err);
    }
  });

  app.get('/requests/:id', async (req, res, next) => {
    try {
      const upstream = await api(`/requests/${encodeURIComponent(req.params.id)}`);
      if (upstream.status === 404) return res.status(404).send(render('not-found'));
      if (!upstream.ok) throw new Error(`API responded ${upstream.status}`);
      res.send(render('request', { request: await upstream.json() }));
    } catch (err) {
      next(err);
    }
  });

  // Same-origin SSE for the browser, piped straight through from the API.
  app.get('/events', async (req, res, next) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const upstream = await api('/events', { headers: { accept: 'text/event-stream' }, signal: abort.signal });
      if (!upstream.ok || !upstream.body) return res.status(502).end();
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
    } catch (err) {
      if (!abort.signal.aborted) next(err);
    }
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(err);
    res.status(500).send(render('error'));
  });

  return app;
}
