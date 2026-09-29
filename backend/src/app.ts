import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { AppConfig } from './config/env.js';
import type { EventsQueue } from './lib/queue.js';
import { loggerOptions, type Logger } from './lib/logger.js';
import { LoginThrottle } from './auth/throttle.js';
import { errorHandlerPlugin } from './http/errors.js';
import { generateRequestId, requestIdHeaderPlugin } from './http/request-id.js';
import { sessionPlugin } from './http/auth.js';
import { healthRoutes } from './routes/health.js';
import { webhookRoutes } from './routes/webhooks.js';
import { authRoutes } from './routes/auth.js';
import { prRoutes } from './routes/prs.js';
import { adminRoutes } from './routes/admin.js';
import { demoRoutes } from './routes/demo.js';

export interface AppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  /** Fail-fast producer connection (see lib/redis.ts). */
  redis: Redis;
  queue: EventsQueue;
  /** Optional logger instance (tests pass a silent one). */
  logger?: Logger;
}

/**
 * Build the HTTP application without starting it. Importing this module has
 * no side effects: no listeners, connections or database writes happen until
 * the caller invokes `listen` (see server.ts) or `inject` (tests).
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, prisma, redis, queue } = deps;
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger as FastifyBaseLogger } : { logger: loggerOptions(config) }),
    genReqId: generateRequestId,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  const logger = app.log as unknown as Logger;
  const dispatch = { prisma, queue, logger };

  // Root-level (fastify-plugin) plugins: apply to every route registered below.
  await app.register(requestIdHeaderPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(cookie);
  await app.register(sessionPlugin, { prisma, config });

  await app.register(healthRoutes, { prisma, redis });
  await app.register(webhookRoutes, { config, dispatch });
  await app.register(authRoutes, { prisma, config, throttle: new LoginThrottle(redis) });
  await app.register(prRoutes, { prisma, config });
  await app.register(adminRoutes, { prisma, config, dispatch });
  await app.register(demoRoutes, { prisma, config });

  return app;
}
