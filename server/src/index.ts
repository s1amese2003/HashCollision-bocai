import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { reconcile } from './ledger.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const { fastify, hub, tick } = await buildApp({ cfg, db });

const report = reconcile(db);
if (!report.ok) fastify.log.error({ report }, 'reconcile failed on startup');

tick();
const timer = setInterval(() => {
  try {
    tick();
  } catch (err) {
    fastify.log.error(err, 'tick failed');
  }
}, 10_000);

await fastify.listen({ host: cfg.host, port: cfg.port });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info(`${signal} received, shutting down`);
  clearInterval(timer);
  hub.closeAll();
  await fastify.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
