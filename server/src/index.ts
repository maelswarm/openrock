import { serve } from '@hono/node-server';
import { config, ensureDir } from './config.js';
import { createApp } from './app.js';

ensureDir(config.dataDir);
const app = createApp();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`[open-rock] listening on http://${host}:${info.port}`);
  console.log(`[open-rock] data: ${config.dataDir}`);
  console.log(`[open-rock] web client: ${config.webDir ?? 'not served (run the Vite dev server or build the web app)'}`);
  if (config.authToken) console.log('[open-rock] access token required for API calls');
  // The desktop shell waits for this line.
  console.log(`OPEN_ROCK_READY ${info.port}`);
});

function shutdown() {
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// When launched by the desktop app, exit if the app disappears without stopping us.
if (config.parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(config.parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();
}
