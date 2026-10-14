import express from 'express';

export function createApiApp({ repo, hub, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // Demo identity: the front end sends the signed-in user's id. A real
  // deployment would validate a token here instead of trusting a header.
  app.use((req, res, next) => {
    const userId = req.get('x-user-id');
    if (!userId) return res.status(401).json({ error: 'x-user-id header required' });
    req.userId = userId;
    next();
  });

  // Runs after the 202 has been sent. Never throws.
  async function runProcessing(userId, requestId) {
    try {
      const { claimed, request } = await repo.processUserRequest(requestId);
      if (claimed) hub.publish(userId, request);
    } catch (err) {
      log.error(`processing failed for request ${requestId}:`, err);
    }
  }

  app.post('/submissions', async (req, res, next) => {
    try {
      const idempotencyKey = req.get('idempotency-key');
      if (!idempotencyKey || idempotencyKey.length > 64) {
        return res.status(400).json({ error: 'Idempotency-Key header required (max 64 chars)' });
      }
      const packages = req.body?.packages;
      if (!Array.isArray(packages) || packages.length === 0) {
        return res.status(400).json({ error: 'packages must be a non-empty array' });
      }

      // One write of the whole body as a single line of JSON; whether it holds
      // 1 package or 1,000 makes no difference to how fast we answer.
      const { requestId, isNew } = await repo.insertUserRequest({
        userId: req.userId,
        idempotencyKey,
        payloadJson: JSON.stringify(req.body),
      });

      res.status(202).location(`/requests/${requestId}`).json({ id: requestId });

      // A retry with the same key gets the same 202 but never starts a second run.
      if (isNew) void runProcessing(req.userId, requestId);
    } catch (err) {
      next(err);
    }
  });

  app.get('/requests', async (req, res, next) => {
    try {
      res.json({ requests: await repo.getUserRequests(req.userId, 50) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/requests/:id', async (req, res, next) => {
    try {
      const request = await repo.getRequestStatus(req.userId, req.params.id);
      if (!request) return res.status(404).json({ error: 'not found' });
      res.json(request);
    } catch (err) {
      next(err);
    }
  });

  // Server-sent events: the current state of the user's recent requests as
  // `snapshot` events on connect, then `status` events as work finishes.
  app.get('/events', async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const conn = hub.connect(req.userId, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      conn.close();
    });

    try {
      const rows = await repo.getUserRequests(req.userId, 50);
      if (!res.destroyed) conn.open(rows.reverse()); // oldest first
    } catch (err) {
      log.error('could not read snapshot for /events:', err);
      res.end();
    }
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    log.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
