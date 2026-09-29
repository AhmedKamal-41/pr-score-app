import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { requireAdmin } from '../http/auth.js';
import { sendError } from '../http/errors.js';
import { getPullRequestDetail, listPullRequests, workspaceStats } from '../api/pr-views.js';

const pagination = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().max(1_000_000).default(0),
});
const idParam = z.object({ id: z.string().uuid() });

export async function prRoutes(fastify: FastifyInstance, opts: { prisma: PrismaClient; config: AppConfig }) {
  const { prisma, config } = opts;

  fastify.get('/api/prs', { preHandler: requireAdmin }, async (request, reply) => {
    const { limit, offset } = pagination.parse(request.query);
    reply.header('Cache-Control', 'no-store');
    return listPullRequests(prisma, config, limit, offset);
  });

  fastify.get('/api/prs/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const detail = await getPullRequestDetail(prisma, config, id);
    if (!detail) return sendError(reply, 404, 'NOT_FOUND', `PR with ID ${id} not found`);
    reply.header('Cache-Control', 'no-store');
    return detail;
  });

  fastify.get('/api/stats', { preHandler: requireAdmin }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return workspaceStats(prisma, config);
  });
}
