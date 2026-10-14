import { pathToFileURL } from 'node:url';
import sql from '#mssql';
import { createApiApp } from './app.js';
import { createRepo } from './repo.js';
import { createStatusHub } from './status-hub.js';

export async function startApi({
  port = 3001,
  host = process.env.HOST ?? '127.0.0.1',
  processMs = Number(process.env.MOCK_PROCESS_MS ?? 3000),
} = {}) {
  // `mock` is only read by the mock driver; remove it when swapping in real mssql.
  const pool = new sql.ConnectionPool({ server: 'mock', database: 'SubmissionDemo', mock: { processMs } });
  await pool.connect();

  const app = createApiApp({ repo: createRepo(pool), hub: createStatusHub() });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });

  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections(); // ends open SSE streams
      await new Promise((resolve) => server.close(resolve));
      await pool.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startApi({ port: Number(process.env.API_PORT ?? 3001) });
  console.log(`API listening on :${port}`);
}
