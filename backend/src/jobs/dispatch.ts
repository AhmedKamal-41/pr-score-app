import type { PrismaClient, WebhookDelivery } from '@prisma/client';
import type { EventsQueue } from '../lib/queue.js';
import { deliveryJobId } from '../lib/queue.js';
import { withTimeout } from '../lib/redis.js';
import { sanitizeErrorForStorage } from '../lib/sanitize.js';
import type { Logger } from '../lib/logger.js';

/** A delivery queued longer than this without being claimed is re-enqueued (lost job). */
export const QUEUED_STALE_MS = 5 * 60_000;
/** A delivery stuck in "processing" longer than this is assumed crashed and re-enqueued. */
export const PROCESSING_STALE_MS = 10 * 60_000;
const ENQUEUE_TIMEOUT_MS = 3_000;

export interface DispatchDeps {
  prisma: PrismaClient;
  queue: EventsQueue;
  logger: Logger;
}

type DeliveryRef = Pick<WebhookDelivery, 'id' | 'status' | 'attempts'>;

/**
 * Put a delivery on the queue. Job ids are deterministic per (delivery,
 * attempt) so re-dispatching the same attempt never duplicates a waiting job;
 * a finished job with that id is removed first so it can run again.
 * Returns false (and leaves the delivery for the dispatcher) if Redis is down.
 */
export async function enqueueDelivery(deps: DispatchDeps, delivery: DeliveryRef): Promise<boolean> {
  const jobId = deliveryJobId(delivery.id, delivery.attempts);
  try {
    await withTimeout(
      (async () => {
        // Waits for the (fail-fast) connection to be ready, bounded by the timeout.
        await deps.queue.waitUntilReady();
        const existing = await deps.queue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (state !== 'completed' && state !== 'failed' && state !== 'unknown') return; // still pending/active
          await existing.remove();
        }
        await deps.queue.add('delivery', { deliveryId: delivery.id }, { jobId });
      })(),
      ENQUEUE_TIMEOUT_MS,
      'enqueue',
    );
  } catch (err) {
    deps.logger.warn({ deliveryId: delivery.id, err: sanitizeErrorForStorage(err) }, 'Could not enqueue delivery; the dispatcher will retry');
    return false;
  }
  await deps.prisma.webhookDelivery.updateMany({
    where: { id: delivery.id, status: delivery.status },
    data: { status: 'queued', enqueued_at: new Date() },
  });
  return true;
}

/** Enqueue every delivery that is due: new, lost, crashed, or scheduled for retry. */
export async function dispatchDueDeliveries(deps: DispatchDeps, now: Date = new Date(), limit = 100): Promise<{ due: number; enqueued: number }> {
  const due = await deps.prisma.webhookDelivery.findMany({
    where: {
      OR: [
        { status: 'received' },
        { status: 'queued', OR: [{ enqueued_at: null }, { enqueued_at: { lt: new Date(now.getTime() - QUEUED_STALE_MS) } }] },
        { status: 'failed', OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }] },
        { status: 'processing', updated_at: { lt: new Date(now.getTime() - PROCESSING_STALE_MS) } },
      ],
    },
    orderBy: [{ received_at: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, status: true, attempts: true },
  });
  let enqueued = 0;
  for (const delivery of due) {
    if (await enqueueDelivery(deps, delivery)) enqueued += 1;
  }
  return { due: due.length, enqueued };
}

/**
 * Manual recovery: make failed (and optionally dead) deliveries due now,
 * resetting their attempt budget, then dispatch. Used by the CLI and the
 * admin API after an outage or after fixing configuration.
 */
export async function recoverDeliveries(
  deps: DispatchDeps,
  options: { ids?: string[]; includeDead?: boolean } = {},
): Promise<{ reset: number; due: number; enqueued: number }> {
  const statuses = options.includeDead ? ['failed', 'dead'] : ['failed'];
  const reset = await deps.prisma.webhookDelivery.updateMany({
    where: { status: { in: statuses }, ...(options.ids?.length ? { id: { in: options.ids } } : {}) },
    data: { status: 'failed', attempts: 0, next_attempt_at: new Date(0) },
  });
  const result = await dispatchDueDeliveries(deps);
  return { reset: reset.count, ...result };
}
