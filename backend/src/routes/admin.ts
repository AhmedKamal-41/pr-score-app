import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { requireAdmin, requireTrustedOrigin } from '../http/auth.js';
import { recoverDeliveries, type DispatchDeps } from '../jobs/dispatch.js';

const listQuery = z.object({
  status: z.enum(['received', 'queued', 'processing', 'succeeded', 'ignored', 'failed', 'dead']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
const recoverBody = z
  .object({ ids: z.array(z.string().min(1).max(100)).max(500).optional(), include_dead: z.boolean().default(false) })
  .default({});

/** Delivery inspection and recovery (authenticated, CSRF-protected mutations). */
export async function adminRoutes(fastify: FastifyInstance, opts: { prisma: PrismaClient; config: AppConfig; dispatch: DispatchDeps }) {
  const { prisma, config, dispatch } = opts;

  fastify.get('/api/admin/deliveries', { preHandler: requireAdmin }, async (request, reply) => {
    const { status, limit } = listQuery.parse(request.query);
    const rows = await prisma.webhookDelivery.findMany({
      where: status ? { status } : {},
      orderBy: [{ received_at: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    reply.header('Cache-Control', 'no-store');
    return {
      data: rows.map((d) => ({
        id: d.id,
        event: d.event,
        action: d.action,
        status: d.status,
        repository: d.repo_full_name,
        pr_number: d.pr_number,
        head_sha: d.head_sha,
        attempts: d.attempts,
        last_error: d.last_error,
        ignored_reason: d.ignored_reason,
        next_attempt_at: d.next_attempt_at?.toISOString() ?? null,
        received_at: d.received_at.toISOString(),
        processed_at: d.processed_at?.toISOString() ?? null,
      })),
    };
  });

  fastify.post('/api/admin/deliveries/recover', { preHandler: [requireAdmin, requireTrustedOrigin(config)] }, async (request) => {
    const body = recoverBody.parse(request.body ?? {});
    return recoverDeliveries(dispatch, { ids: body.ids, includeDead: body.include_dead });
  });
}
