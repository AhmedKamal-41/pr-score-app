import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { EVENTS_QUEUE } from '../config/constants.js';

/** Queue payload: only a pointer to the durable delivery row. */
export interface DeliveryJobData {
  deliveryId: string;
}

export type EventsQueue = Queue<DeliveryJobData>;

export function createEventsQueue(connection: Redis): EventsQueue {
  return new Queue<DeliveryJobData>(EVENTS_QUEUE, {
    connection,
    defaultJobOptions: {
      // Exactly one BullMQ attempt per enqueue. Retries are scheduled durably
      // in PostgreSQL (webhook_deliveries.next_attempt_at) by the dispatcher,
      // so they survive Redis loss and are not multiplied across layers.
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400 },
    },
  });
}

/** BullMQ job id for a given delivery attempt. Deterministic so re-dispatch deduplicates. */
export function deliveryJobId(deliveryId: string, attempts: number): string {
  return `delivery__${deliveryId}__${attempts}`;
}

/**
 * Close a queue together with the Redis connection it uses.
 *
 * Order matters. BullMQ removes its listeners in `queue.close()` but leaves a
 * shared connection open, and a connection that never became ready (Redis
 * down) rejects BullMQ's pending readiness promise only when it finally emits
 * 'end' — asynchronously, after `quit()` has resolved. So: end the connection,
 * wait for the 'end' event (bounded), let BullMQ's promise chain settle and
 * report to the queue's still-attached listeners (one macrotask), and only
 * then close the queue. Otherwise the last connection error surfaces as an
 * unhandled rejection.
 */
export async function closeQueueAndConnection(queue: EventsQueue, connection: Redis): Promise<void> {
  if (connection.status !== 'end') {
    let timer: NodeJS.Timeout | undefined;
    const ended = new Promise<void>((resolve) => {
      connection.once('end', () => resolve());
      timer = setTimeout(resolve, 2_000);
      timer.unref();
    });
    await connection.quit().catch(() => connection.disconnect());
    await ended;
    clearTimeout(timer);
  }
  await new Promise((resolve) => setImmediate(resolve));
  await queue.close().catch(() => {});
}
