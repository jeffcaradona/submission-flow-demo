import { pathToFileURL } from 'node:url';
import { createFrontendApp } from './app.js';

export async function startFrontend({
  port = 3000,
  host = process.env.HOST ?? '127.0.0.1',
  apiBaseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001',
} = {}) {
  const app = createFrontendApp({ apiBaseUrl });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });

  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections(); // ends open SSE streams
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startFrontend({ port: Number(process.env.PORT ?? 3000) });
  console.log(`Front end listening on :${port}`);
}
