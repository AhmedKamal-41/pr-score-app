import pino from 'pino';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../src/config/env.js';
import { buildApp } from '../../src/app.js';
import { createProducerRedis } from '../../src/lib/redis.js';
import { createEventsQueue, type EventsQueue } from '../../src/lib/queue.js';
import { signPayload } from '../../src/webhooks/signature.js';
import type { Logger } from '../../src/lib/logger.js';
import { TEST_ADMIN, TEST_ORIGIN, TEST_WEBHOOK_SECRET } from './config.js';

export const silentLogger = pino({ level: 'silent' }) as Logger;

export interface TestApp {
  app: FastifyInstance;
  queue: EventsQueue;
  close: () => Promise<void>;
}

export async function buildTestApp(config: AppConfig, prisma: PrismaClient, redisUrl: string = config.redisUrl): Promise<TestApp> {
  const redis = createProducerRedis(redisUrl);
  redis.on('error', () => {});
  const queue = createEventsQueue(redis);
  queue.on('error', () => {});
  const app = await buildApp({ config, prisma, redis, queue, logger: silentLogger });
  await app.ready();
  return {
    app,
    queue,
    close: async () => {
      await app.close();
      await queue.close().catch(() => {});
      redis.disconnect();
    },
  };
}

export async function login(app: FastifyInstance, password = TEST_ADMIN.password): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
    payload: { username: TEST_ADMIN.username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === 'prs_session');
  if (!cookie) throw new Error('no session cookie');
  return `prs_session=${cookie.value}`;
}

export function sendWebhook(
  app: FastifyInstance,
  event: string,
  payload: unknown,
  opts: { deliveryId?: string; secret?: string; signature?: string | null; rawBody?: Buffer; contentType?: string } = {},
) {
  const raw = opts.rawBody ?? Buffer.from(JSON.stringify(payload));
  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/json',
    'x-github-event': event,
    'x-github-delivery': opts.deliveryId ?? crypto.randomUUID(),
  };
  const signature = opts.signature === undefined ? signPayload(opts.secret ?? TEST_WEBHOOK_SECRET, raw) : opts.signature;
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: raw });
}
