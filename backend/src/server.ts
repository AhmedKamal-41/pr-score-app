import 'dotenv/config';
import { loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createPrisma } from './lib/prisma.js';
import { createProducerRedis } from './lib/redis.js';
import { closeQueueAndConnection, createEventsQueue } from './lib/queue.js';
import { buildApp } from './app.js';

/** API server entry point: `node dist/server.js` (or `tsx src/server.ts`). */
async function main() {
  const config = loadConfig();
  const bootLogger = createLogger(config, 'api');
  const prisma = createPrisma(config.databaseUrl);
  const redis = createProducerRedis(config.redisUrl);
  // Avoid unhandled 'error' events while Redis is unreachable; readiness reports it.
  redis.on('error', (err) => bootLogger.debug({ err: err.message }, 'Redis connection error'));
  const queue = createEventsQueue(redis);
  queue.on('error', (err) => bootLogger.debug({ err: err.message }, 'Queue connection error'));

  const app = await buildApp({ config, prisma, redis, queue });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down API server');
    const force = setTimeout(() => {
      app.log.error('Graceful shutdown timed out; exiting');
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      await app.close(); // stops accepting connections, waits for in-flight requests
      await closeQueueAndConnection(queue, redis);
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      github: config.github.enabled ? 'enabled' : 'disabled (local demo mode)',
      ai: config.ai.enabled ? `enabled (${config.ai.model})` : 'disabled',
      comments: config.github.postComments ? 'enabled' : 'disabled',
      demo: config.demoEnabled ? 'enabled' : 'disabled',
    },
    `API listening on http://${config.host}:${config.port} — webhook endpoint POST /webhooks/github`,
  );
}

main().catch((err) => {
  // Configuration errors are printed plainly so misconfiguration is obvious.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
