import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { InboxRow } from './classify.js';
import { enqueueDelivery, type DispatchDeps } from '../jobs/dispatch.js';

export type AcceptOutcome =
  | { result: 'accepted' | 'requeued'; enqueued: boolean }
  | { result: 'duplicate'; status: string }
  | { result: 'conflict' };

export function payloadDigest(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Durably record a delivery, then try to enqueue it.
 *  - The caller acknowledges GitHub only after this resolves (row committed).
 *  - Replays of the same delivery id + identical payload are deduplicated;
 *    a replay of a failed/dead delivery (e.g. a manual GitHub redelivery)
 *    makes it due again instead of being dropped.
 *  - The same delivery id with different content is a conflict.
 *  - If Redis is unavailable the row stays "received" and the dispatcher
 *    enqueues it later.
 * Database errors propagate so the route can answer 503.
 */
export async function acceptDelivery(
  deps: DispatchDeps & { prisma: PrismaClient },
  deliveryId: string,
  digest: string,
  row: InboxRow,
): Promise<AcceptOutcome> {
  const { prisma } = deps;
  try {
    await prisma.webhookDelivery.create({
      data: { id: deliveryId, payload_sha256: digest, status: 'received', ...row },
    });
    const enqueued = await enqueueDelivery(deps, { id: deliveryId, status: 'received', attempts: 0 });
    return { result: 'accepted', enqueued };
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
  }

  const existing = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
  if (existing.payload_sha256 !== digest) return { result: 'conflict' };

  if (existing.status === 'failed' || existing.status === 'dead') {
    const reset = await prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: existing.status },
      data: { status: 'received', attempts: 0, next_attempt_at: null },
    });
    if (reset.count === 1) {
      const enqueued = await enqueueDelivery(deps, { id: deliveryId, status: 'received', attempts: 0 });
      return { result: 'requeued', enqueued };
    }
  }
  return { result: 'duplicate', status: existing.status };
}
