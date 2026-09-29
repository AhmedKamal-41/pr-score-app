import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env.js';
import { requireAdmin, requireTrustedOrigin } from '../http/auth.js';
import { sendError } from '../http/errors.js';
import { seedDemoData } from '../demo/seed.js';

/**
 * POST /api/demo/seed – development only (DEMO_ENABLED=true, never in
 * production), and only for an authenticated admin. No browser-side secret.
 */
export async function demoRoutes(fastify: FastifyInstance, opts: { prisma: PrismaClient; config: AppConfig }) {
  fastify.post('/api/demo/seed', { preHandler: [requireAdmin, requireTrustedOrigin(opts.config)] }, async (request, reply) => {
    if (!opts.config.demoEnabled) {
      return sendError(reply, 403, 'FORBIDDEN', 'Demo data is disabled on this server');
    }
    const result = await seedDemoData(opts.prisma);
    request.log.info(result, 'Demo data seeded');
    return {
      success: true,
      message: `Demo data ready: ${result.pull_requests} demo PRs (${result.new_scores} new scores)`,
      prs_created: result.pull_requests,
      ...result,
    };
  });

  fastify.get('/api/demo/status', { preHandler: requireAdmin }, async () => ({ enabled: opts.config.demoEnabled }));
}
