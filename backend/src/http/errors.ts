import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export interface ErrorEnvelope {
  error: { message: string; code: string; requestId: string; details?: unknown };
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  const body: ErrorEnvelope = { error: { message, code, requestId: reply.request.id } };
  if (details !== undefined) body.error.details = details;
  return reply.status(statusCode).send(body);
}

/**
 * One error envelope for every route (registered with fastify-plugin so it
 * applies across encapsulation boundaries): validation, not found,
 * authentication, client and internal errors all carry the request id.
 * Internal errors never expose messages or stacks to clients.
 */
export const errorHandlerPlugin = fp(async function errorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        'Validation error',
        error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      );
    }
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (error.validation) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        'Validation error',
        error.validation.map((v) => ({ field: v.instancePath, message: v.message })),
      );
    }
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled request error');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
    const code =
      statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : statusCode === 404 ? 'NOT_FOUND' : 'BAD_REQUEST';
    return sendError(reply, statusCode, code, statusCode === 400 ? 'Bad request' : error.message);
  });

  fastify.setNotFoundHandler((request, reply) =>
    sendError(reply, 404, 'NOT_FOUND', `Route ${request.method} ${request.url.split('?')[0]} not found`),
  );
});
