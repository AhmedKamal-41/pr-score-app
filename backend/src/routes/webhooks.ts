import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import rawBody from '@fastify/raw-body';
import { Webhooks } from '@octokit/webhooks';
import requestContext from '@fastify/request-context';
import { scorePrQueue, ScorePrJobData } from '../lib/queue.js';

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

if (!webhookSecret) {
  console.warn(
    '⚠️  GITHUB_WEBHOOK_SECRET is not set. Webhook signature verification will fail.'
  );
}

const webhooks = new Webhooks({
  secret: webhookSecret || '',
});

export async function webhookRoute(fastify: FastifyInstance) {
  // Register raw-body plugin for this route scope
  await fastify.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  fastify.post(
    '/webhooks/github',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = requestContext.get('requestId') || 'unknown';

      // Check if webhook secret is configured
      if (!webhookSecret) {
        fastify.log.error(
          { requestId },
          'GITHUB_WEBHOOK_SECRET is not configured'
        );
        return reply.status(500).send({
          error: {
            message: 'Webhook secret not configured',
            code: 'CONFIGURATION_ERROR',
            requestId,
          },
        });
      }

      // Get signature from headers
      const signature = request.headers['x-hub-signature-256'] as string;
      if (!signature) {
        fastify.log.warn(
          { requestId },
          'Missing X-Hub-Signature-256 header'
        );
        return reply.status(401).send({
          error: {
            message: 'Missing signature header',
            code: 'UNAUTHORIZED',
            requestId,
          },
        });
      }

      // Get raw body (as Buffer from @fastify/raw-body)
      const rawBody = (request as any).rawBody as Buffer | string;
      if (!rawBody) {
        fastify.log.error(
          { requestId },
          'Raw body is missing. Ensure @fastify/raw-body is registered for this route.'
        );
        return reply.status(500).send({
          error: {
            message: 'Internal server error',
            code: 'INTERNAL_ERROR',
            requestId,
          },
        });
      }

      const bodyString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');

      // Verify signature using @octokit/webhooks
      try {
        const signatureWithoutPrefix = signature.replace('sha256=', '');
        
        // Verify the signature
        const isValid = webhooks.verify(bodyString, signatureWithoutPrefix);
        
        if (!isValid) {
          throw new Error('Signature verification failed');
        }
      } catch (error: any) {
        fastify.log.warn(
          {
            requestId,
            error: error.message,
          },
          'Webhook signature verification failed'
        );
        return reply.status(401).send({
          error: {
            message: 'Invalid webhook signature',
            code: 'UNAUTHORIZED',
            requestId,
          },
        });
      }

      // Parse the payload
      let payload: any;
      try {
        payload = JSON.parse(bodyString);
      } catch (error: any) {
        fastify.log.error(
          {
            requestId,
            error: error.message,
          },
          'Failed to parse webhook payload'
        );
        return reply.status(400).send({
          error: {
            message: 'Invalid JSON payload',
            code: 'BAD_REQUEST',
            requestId,
          },
        });
      }

      // Get event type and delivery ID from headers
      const eventType = request.headers['x-github-event'] as string;
      const deliveryId = request.headers['x-github-delivery'] as string;

      // Handle pull_request events - enqueue job for async processing
      if (eventType === 'pull_request') {
        const action = payload.action;
        const supportedActions = ['opened', 'synchronize'];
        
        if (supportedActions.includes(action)) {
          // Extract repository info
          const repository = payload.repository;
          const owner = repository.owner?.login || repository.full_name.split('/')[0];
          const name = repository.name || repository.full_name.split('/')[1];
          const prNumber = payload.pull_request?.number;
          const installationId = payload.installation?.id;

          if (!prNumber) {
            fastify.log.warn(
              { requestId, payload: payload.pull_request },
              'Missing PR number in payload'
            );
            return reply.status(200).send({ received: true });
          }

          // Prepare job data
          const jobData: ScorePrJobData = {
            owner,
            name,
            pr_number: prNumber,
            delivery_id: deliveryId || requestId,
          };

          if (installationId) {
            jobData.installation_id = installationId;
          }

          // Enqueue job immediately
          try {
            await scorePrQueue.add('score_pr', jobData, {
              jobId: `pr-${owner}-${name}-${prNumber}-${deliveryId || Date.now()}`,
            });

            fastify.log.info(
              {
                requestId,
                jobId: `pr-${owner}-${name}-${prNumber}-${deliveryId || Date.now()}`,
                owner,
                name,
                prNumber,
              },
              'Enqueued score_pr job'
            );
          } catch (error: any) {
            fastify.log.error(
              {
                requestId,
                error: error.message,
              },
              'Failed to enqueue score_pr job'
            );
            // Still return 200 to acknowledge webhook receipt
          }
        } else {
          fastify.log.debug(
            {
              requestId,
              event: 'pull_request',
              action,
            },
            'Ignoring unsupported pull_request action'
          );
        }
      } else {
        fastify.log.debug(
          {
            requestId,
            eventType,
          },
          'Received unsupported webhook event type'
        );
      }

      // Always return 200 OK immediately (<100ms) to acknowledge receipt
      return reply.status(200).send({ received: true });
    }
  );
}

