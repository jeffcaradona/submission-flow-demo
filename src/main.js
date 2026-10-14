// Runs both servers in one process for the demo. The API owns the mock database;
// the front end only knows the API's URL.

import { startApi } from './api/server.js';
import { startFrontend } from './frontend/server.js';

const api = await startApi({ port: Number(process.env.API_PORT ?? 3001) });
const web = await startFrontend({
  port: Number(process.env.PORT ?? 3000),
  apiBaseUrl: `http://127.0.0.1:${api.port}`,
});

console.log(`API        http://127.0.0.1:${api.port}`);
console.log(`Front end  http://127.0.0.1:${web.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await Promise.all([web.close(), api.close()]);
    process.exit(0);
  });
}
