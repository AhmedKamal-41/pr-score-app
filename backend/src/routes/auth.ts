import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { SESSION_COOKIE } from '../config/constants.js';
import type { AppConfig } from '../config/env.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, revokeSession } from '../auth/sessions.js';
import type { LoginThrottle } from '../auth/throttle.js';
import { requireTrustedOrigin, sessionCookieOptions } from '../http/auth.js';
import { sendError } from '../http/errors.js';

const loginBody = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
});

export async function authRoutes(
  fastify: FastifyInstance,
  opts: { prisma: PrismaClient; config: AppConfig; throttle: LoginThrottle },
) {
  const { prisma, config, throttle } = opts;
  const trustedOrigin = requireTrustedOrigin(config);

  fastify.post('/api/auth/login', { preHandler: trustedOrigin }, async (request, reply) => {
    const body = loginBody.parse(request.body);
    const ip = request.ip;

    let gate;
    try {
      gate = await throttle.check(ip, body.username);
    } catch {
      return sendError(reply, 503, 'THROTTLE_UNAVAILABLE', 'Login is temporarily unavailable');
    }
    if (!gate.allowed) {
      reply.header('Retry-After', String(gate.retryAfterSeconds));
      return sendError(reply, 429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts; try again later');
    }

    const hash = config.auth.passwordHash;
    // Always run the KDF so timing does not reveal whether the username exists.
    const passwordOk = hash ? await verifyPassword(body.password, hash) : false;
    if (!passwordOk || body.username !== config.auth.username) {
      await throttle.recordFailure(ip, body.username).catch(() => undefined);
      request.log.warn({ ip }, 'Failed login');
      return sendError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    }
    await throttle.recordSuccess(ip).catch(() => undefined);

    // Session rotation: any session presented with the login request is revoked.
    const previous = request.cookies[SESSION_COOKIE];
    if (previous) await revokeSession(prisma, previous);

    const session = await createSession(prisma, config.auth.username, config.auth.sessionTtlMs);
    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(config, session.expiresAt));
    return reply.send({ authenticated: true, username: config.auth.username, expires_at: session.expiresAt.toISOString() });
  });

  fastify.post('/api/auth/logout', { preHandler: trustedOrigin }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await revokeSession(prisma, token);
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(config));
    return reply.send({ authenticated: false });
  });

  fastify.get('/api/auth/session', async (request) => {
    const s = request.adminSession;
    return s ? { authenticated: true, username: s.username, expires_at: s.expires_at.toISOString() } : { authenticated: false };
  });
}
