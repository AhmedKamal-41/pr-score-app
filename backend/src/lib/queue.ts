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
