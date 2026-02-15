import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import requestContext from '@fastify/request-context';
import { seedDemoPRs } from '../../scripts/demo_seed_pr.js';

export async function demoRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/demo/seed',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = requestContext.get('requestId') || 'unknown';

      // Check if in production
      if (process.env.NODE_ENV === 'production') {
        fastify.log.warn(
          { requestId },
          'Demo seed endpoint called in production - blocked'
        );
        return reply.status(403).send({
          error: {
            message: 'Demo mode is disabled in production',
            code: 'FORBIDDEN',
            requestId,
          },
        });
      }

      // Check for demo secret
      const demoSecret = process.env.DEMO_SECRET;
      if (!demoSecret) {
        fastify.log.warn(
          { requestId },
          'DEMO_SECRET not configured - demo endpoint disabled'
        );
        return reply.status(403).send({
          error: {
            message: 'Demo mode is not configured',
            code: 'FORBIDDEN',
            requestId,
          },
        });
      }

      // Get secret from header
      const providedSecret = request.headers['x-demo-secret'] as string;
      if (!providedSecret) {
        fastify.log.warn(
          { requestId },
          'Demo seed endpoint called without secret'
        );
        return reply.status(401).send({
          error: {
            message: 'Missing demo secret',
            code: 'UNAUTHORIZED',
            requestId,
          },
        });
      }

      // Verify secret
      if (providedSecret !== demoSecret) {
        fastify.log.warn(
          { requestId },
          'Demo seed endpoint called with invalid secret'
        );
        return reply.status(401).send({
          error: {
            message: 'Invalid demo secret',
            code: 'UNAUTHORIZED',
            requestId,
          },
        });
      }

      // Execute seed
      try {
        fastify.log.info({ requestId }, 'Starting demo seed');
        const prsCreated = await seedDemoPRs();
        fastify.log.info(
          { requestId, prsCreated },
          'Demo seed completed successfully'
        );

        return reply.status(200).send({
          success: true,
          message: `Successfully created ${prsCreated} demo PRs`,
          prs_created: prsCreated,
        });
      } catch (error: any) {
        fastify.log.error(
          {
            requestId,
            error: error.message,
            stack: error.stack,
          },
          'Demo seed failed'
        );
        return reply.status(500).send({
          error: {
            message: 'Failed to seed demo data',
            code: 'INTERNAL_ERROR',
            requestId,
          },
        });
      }
    }
  );
}

