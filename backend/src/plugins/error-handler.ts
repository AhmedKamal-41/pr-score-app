import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import requestContext from '@fastify/request-context';

interface ErrorResponse {
  error: {
    message: string;
    code: string;
    requestId: string;
    details?: unknown;
  };
}

export async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler(
    async (
      error: FastifyError,
      request: FastifyRequest,
      reply: FastifyReply
    ) => {
      const requestId = requestContext.get('requestId') || 'unknown';
      
      // Log the error with request context
      request.log.error(
        {
          requestId,
          error: {
            message: error.message,
            stack: error.stack,
            code: error.code,
            statusCode: error.statusCode,
          },
        },
        'Request error'
      );

      // Handle Zod validation errors
      if (error.validation || error instanceof ZodError) {
        const validationError = error.validation || error;
        const response: ErrorResponse = {
          error: {
            message: 'Validation error',
            code: 'VALIDATION_ERROR',
            requestId,
            details: Array.isArray(validationError)
              ? validationError.map((err) => ({
                  field: err.instancePath || err.path?.join('.'),
                  message: err.message,
                }))
              : validationError.errors?.map((err) => ({
                  path: err.path.join('.'),
                  message: err.message,
                })),
          },
        };
        return reply.status(400).send(response);
      }

      // Handle Fastify errors
      const statusCode = error.statusCode || 500;
      const response: ErrorResponse = {
        error: {
          message:
            statusCode === 500
              ? 'Internal server error'
              : error.message || 'An error occurred',
          code: error.code || 'INTERNAL_ERROR',
          requestId,
        },
      };

      // Include details in development
      if (process.env.NODE_ENV === 'development' && statusCode === 500) {
        response.error.details = {
          stack: error.stack,
          name: error.name,
        };
      }

      return reply.status(statusCode).send(response);
    }
  );

  // Handle 404 Not Found
  fastify.setNotFoundHandler(
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = requestContext.get('requestId') || 'unknown';
      const response: ErrorResponse = {
        error: {
          message: `Route ${request.method} ${request.url} not found`,
          code: 'NOT_FOUND',
          requestId,
        },
      };
      return reply.status(404).send(response);
    }
  );
}

