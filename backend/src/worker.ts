import 'dotenv/config';
import { hostname } from 'node:os';
import { Worker } from 'bullmq';
import { loadConfig } from './config/env.js';
import { EVENTS_QUEUE } from './config/constants.js';
import { createLogger } from './lib/logger.js';
import { createPrisma } from './lib/prisma.js';
import { createWorkerRedis } from './lib/redis.js';
import { closeQueueAndConnection, createEventsQueue, type DeliveryJobData } from './lib/queue.js';
import { createDeliveryProcessor, startDispatcher } from './jobs/runtime.js';

/** Worker entry point: `node dist/worker.js` (or `tsx src/worker.ts`). */
async function main() {
  const config = loadConfig();
  const logger = createLogger(config, 'worker');
  const prisma = createPrisma(config.databaseUrl);
  const connection = createWorkerRedis(config.redisUrl);
  connection.on('error', (err) => logger.warn({ err: err.message }, 'Redis connection error'));
  const queueConnection = createWorkerRedis(config.redisUrl);
  queueConnection.on('error', () => {}); // reported via the queue's 'error' event
  const queue = createEventsQueue(queueConnection);
  queue.on('error', (err) => logger.warn({ err: err.message }, 'Queue connection error'));

  const workerId = `${hostname()}:${process.pid}`;
  const processor = createDeliveryProcessor({ config, prisma, logger, workerId });
  const worker = new Worker<DeliveryJobData>(EVENTS_QUEUE, async (job) => processor(job.data.deliveryId), {
    connection,
    concurrency: config.worker.concurrency,
  });
  worker.on('error', (err) => logger.warn({ err: err.message }, 'Worker error'));
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'Job failed unexpectedly'));

  const dispatcher = startDispatcher({ prisma, queue, logger }, config.worker.dispatcherIntervalMs);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down worker (waiting for active jobs)');
    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; exiting');
      process.exit(1);
    }, 60_000);
    force.unref();
    try {
      await dispatcher.stop();
      await worker.close(); // waits for in-flight jobs
      await closeQueueAndConnection(queue, queueConnection);
      await connection.quit().catch(() => connection.disconnect());
      await prisma.$disconnect();
      logger.info('Worker stopped');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info(
    { concurrency: config.worker.concurrency, github: config.github.enabled, ai: config.ai.enabled, comments: config.github.postComments },
    `Worker started, consuming "${EVENTS_QUEUE}"`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
