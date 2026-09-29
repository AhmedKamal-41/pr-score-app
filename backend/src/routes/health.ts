import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { APP_VERSION } from '../config/constants.js';
import { withTimeout } from '../lib/redis.js';

const CHECK_TIMEOUT_MS = 2_000;

async function probe(fn: () => Promise<unknown>): Promise<'up' | 'down'> {
  try {
    await withTimeout(fn(), CHECK_TIMEOUT_MS, 'readiness check');
    return 'up';
  } catch {
    return 'down';
  }
}

/**
 * GET /health  – liveness: the process is serving requests (no dependencies).
 * GET /ready   – readiness: PostgreSQL and Redis both answer. 503 otherwise.
 *                Reports only up/down per dependency; never URLs or errors.
 * GET /api/version – public build version.
 */
export async function healthRoutes(fastify: FastifyInstance, opts: { prisma: PrismaClient; redis: Redis }) {
  fastify.get('/health', async () => ({ ok: true }));

  fastify.get('/ready', async (_request, reply) => {
    const [database, redis] = await Promise.all([
      probe(() => opts.prisma.$queryRaw`SELECT 1`),
      probe(() => opts.redis.ping()),
    ]);
    const ok = database === 'up' && redis === 'up';
    return reply.status(ok ? 200 : 503).send({ ok, checks: { database, redis } });
  });

  fastify.get('/api/version', async () => ({ version: APP_VERSION }));
}
