import fp from 'fastify-plugin';
import type { AdminSession, PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { SESSION_COOKIE } from '../config/constants.js';
import type { AppConfig } from '../config/env.js';
import { findValidSession } from '../auth/sessions.js';
import { sendError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    adminSession: AdminSession | null;
  }
}

export function sessionCookieOptions(config: AppConfig, expiresAt?: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax' as const,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/**
 * Resolves the session cookie (if any) for every request. Registered with
 * fastify-plugin so the decorator and hook apply to sibling route plugins.
 */
export const sessionPlugin = fp(async (fastify, opts: { prisma: PrismaClient; config: AppConfig }) => {
  fastify.decorateRequest('adminSession', null);
  fastify.addHook('preHandler', async (request) => {
    const token = request.cookies?.[SESSION_COOKIE];
    request.adminSession = token ? await findValidSession(opts.prisma, token, opts.config.auth.username) : null;
  });
});

export const requireAdmin: preHandlerAsyncHookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  if (!request.adminSession) {
    return sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required');
  }
};

/**
 * CSRF protection for state-changing requests: the browser-supplied Origin
 * must be the dashboard's origin, and bodies must be JSON (which forces a
 * CORS preflight that this API never grants). SameSite=Lax cookies are a
 * second layer.
 */
export function requireTrustedOrigin(config: AppConfig): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== config.frontendOrigin) {
      return sendError(reply, 403, 'FORBIDDEN', 'Cross-origin or missing Origin header');
    }
    const type = request.headers['content-type'];
    if (request.method !== 'GET' && request.method !== 'HEAD' && !(typeof type === 'string' && type.startsWith('application/json'))) {
      return sendError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
    }
  };
}
