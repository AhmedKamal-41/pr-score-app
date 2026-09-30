import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { createPrisma } from '../lib/prisma.js';
import { createWorkerRedis } from '../lib/redis.js';
import { closeQueueAndConnection, createEventsQueue } from '../lib/queue.js';
import { recoverDeliveries } from '../jobs/dispatch.js';

/**
 * Re-dispatch stored webhook deliveries.
 *   pnpm --filter backend deliveries:recover                 # failed deliveries
 *   pnpm --filter backend deliveries:recover --include-dead  # also give-up ("dead") ones
 *   pnpm --filter backend deliveries:recover --id <delivery-guid> [--id …]
 *   pnpm --filter backend deliveries:recover --list          # show non-final deliveries only
 * A running worker processes what this enqueues.
 */
const { values } = parseArgs({
  options: {
    id: { type: 'string', multiple: true },
    'include-dead': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

const config = loadConfig();
const prisma = createPrisma(config.databaseUrl);
const redis = createWorkerRedis(config.redisUrl);
redis.on('error', () => {});
const queue = createEventsQueue(redis);
queue.on('error', () => {});
const logger = createLogger({ ...config, logLevel: 'warn' }, 'recover');

try {
  if (values.list) {
    const rows = await prisma.webhookDelivery.findMany({
      where: { status: { notIn: ['succeeded', 'ignored'] } },
      orderBy: { received_at: 'asc' },
      take: 200,
    });
    for (const d of rows) {
      console.log([d.id, d.status, d.event, d.action ?? '-', d.repo_full_name ?? '-', d.pr_number ?? '-', `attempts=${d.attempts}`, d.last_error ?? ''].join('\t'));
    }
    console.log(`${rows.length} delivery(ies) not yet succeeded/ignored`);
  } else {
    const result = await recoverDeliveries({ prisma, queue, logger }, { ids: values.id, includeDead: values['include-dead'] });
    console.log(`reset=${result.reset} due=${result.due} enqueued=${result.enqueued}`);
    if (result.due > result.enqueued) {
      console.error('Some deliveries could not be enqueued (is Redis reachable?). They remain stored and will be retried.');
      process.exitCode = 2;
    }
  }
} finally {
  await closeQueueAndConnection(queue, redis);
  await prisma.$disconnect();
}
