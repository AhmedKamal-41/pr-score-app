import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import requestContext from '@fastify/request-context';

declare module '@fastify/request-context' {
  interface FastifyRequestContext {
    requestId: string;
  }
}

export async function requestIdPlugin(fastify: FastifyInstance) {
  // Register request context plugin
  await fastify.register(requestContext);

  // Generate or extract request ID
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const requestId =
      (request.headers['x-request-id'] as string) || randomUUID();
    
    requestContext.set('requestId', requestId);
    request.log.info({ requestId }, 'Incoming request');
  });

  // Add request ID to response headers
  fastify.addHook('onSend', async (request, reply) => {
    const requestId = requestContext.get('requestId');
    if (requestId) {
      reply.header('X-Request-ID', requestId);
    }
  });
}

