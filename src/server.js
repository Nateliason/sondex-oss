import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { createEmailSync } from './services/email-sync.js';

export async function startServer(config) {
  const { db, pool } = createDb(config.database_url);
  const emailSync = createEmailSync({ db, config });

  const app = createApp({ db, config, emailSync });

  await pool.query('SELECT 1');

  const server = serve({
    fetch: app.fetch,
    port: config.port
  });

  emailSync.start();

  const shutdown = async () => {
    emailSync.stop();
    await pool.end();
    server.close();
  };

  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });

  return { server, pool };
}
