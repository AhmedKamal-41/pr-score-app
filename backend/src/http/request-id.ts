import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import fp from 'fastify-plugin';

const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accept a well-formed incoming X-Request-ID; otherwise generate a UUID. */
export function generateRequestId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)) return incoming;
  return randomUUID();
}

/** Echo the request id on every response (root-level hook, applies to all routes). */
export const requestIdHeaderPlugin = fp(async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id);
  });
});
