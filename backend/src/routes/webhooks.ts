import type { FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import type { AppConfig } from '../config/env.js';
import type { DispatchDeps } from '../jobs/dispatch.js';
import { sendError } from '../http/errors.js';
import { verifyWebhookSignature } from '../webhooks/signature.js';
import { classifyWebhook } from '../webhooks/classify.js';
import { acceptDelivery, payloadDigest } from '../webhooks/inbox.js';
import { sanitizeErrorForStorage } from '../lib/sanitize.js';

/** GitHub caps webhook payloads at 25 MB. */
const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;
const DELIVERY_ID = /^[A-Za-z0-9-]{8,100}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;
const INVALID_JSON = Symbol('invalid-json');

/**
 * POST /webhooks/github
 *
 * Order of operations:
 *   1. signature over the exact raw bytes (401 when missing/malformed/wrong),
 *   2. required headers (400), JSON (400), payload validation (400),
 *   3. ping → 200; ignored events → 202 without storage or jobs,
 *   4. durable insert into webhook_deliveries, then enqueue,
 *   5. 202 only after the row is committed; 503 if it could not be stored.
 * Note: GitHub does not automatically redeliver failed deliveries — see the
 * recovery procedure in project.md.
 */
export async function webhookRoutes(fastify: FastifyInstance, opts: { config: AppConfig; dispatch: DispatchDeps }) {
  const { config, dispatch } = opts;

  // Encapsulated: these parsers and the raw-body capture apply only here.
  await fastify.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: false, // Buffer: HMAC is computed over the original bytes
    runFirst: true,
  });
  // Parse leniently so an invalid-JSON body with a bad signature is answered
  // 401 (signature is checked first), never 400. Removing the inherited
  // parsers only affects this encapsulated scope.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, body, done) => {
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(null, INVALID_JSON);
    }
  });
  fastify.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, _body, done) => done(null, INVALID_JSON));

  fastify.post(
    '/webhooks/github',
    { config: { rawBody: true }, bodyLimit: WEBHOOK_BODY_LIMIT },
    async (request, reply) => {
      if (!config.github.enabled || !config.github.webhookSecret) {
        return sendError(reply, 503, 'GITHUB_DISABLED', 'GitHub integration is disabled on this server');
      }
      const raw = request.rawBody;
      if (!Buffer.isBuffer(raw)) {
        request.log.error('Raw webhook body was not captured');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error');
      }

      const signatureHeader = request.headers['x-hub-signature-256'];
      const signature = verifyWebhookSignature(
        config.github.webhookSecret,
        raw,
        typeof signatureHeader === 'string' ? signatureHeader : undefined,
      );
      if (signature !== 'valid') {
        request.log.warn({ signature }, 'Rejected webhook with bad signature');
        const message =
          signature === 'missing' ? 'Missing X-Hub-Signature-256 header' : signature === 'malformed' ? 'Malformed signature header' : 'Invalid webhook signature';
        return sendError(reply, 401, 'UNAUTHORIZED', message);
      }

      const event = request.headers['x-github-event'];
      const deliveryId = request.headers['x-github-delivery'];
      if (typeof event !== 'string' || !EVENT_NAME.test(event)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Missing or invalid X-GitHub-Event header');
      }
      if (typeof deliveryId !== 'string' || !DELIVERY_ID.test(deliveryId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Missing or invalid X-GitHub-Delivery header');
      }
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.startsWith('application/json')) {
        return sendError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Webhook content type must be application/json');
      }
      if (request.body === INVALID_JSON || typeof request.body !== 'object' || request.body === null) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Invalid JSON payload');
      }

      const classification = classifyWebhook(event, request.body, config);
      switch (classification.kind) {
        case 'ping':
          return reply.status(200).send({ ok: true, event: 'ping' });
        case 'ignore':
          request.log.info({ event, deliveryId, reason: classification.reason }, 'Webhook ignored');
          return reply.status(202).send({ status: 'ignored', reason: classification.reason });
        case 'invalid':
          return sendError(reply, 400, 'INVALID_PAYLOAD', classification.message, classification.details);
        case 'accept':
          break;
      }

      let outcome;
      try {
        outcome = await acceptDelivery(dispatch, deliveryId, payloadDigest(raw), classification.row);
      } catch (err) {
        request.log.error({ deliveryId, err: sanitizeErrorForStorage(err) }, 'Could not durably store webhook delivery');
        return sendError(reply, 503, 'STORAGE_UNAVAILABLE', 'Delivery could not be stored; redeliver it from GitHub once the service is healthy');
      }

      if (outcome.result === 'conflict') {
        request.log.warn({ deliveryId }, 'Delivery id reused with different content');
        return sendError(reply, 409, 'DELIVERY_ID_CONFLICT', 'This delivery id was already received with different content');
      }
      if (outcome.result === 'duplicate') {
        return reply.status(200).send({ status: 'duplicate', delivery_status: outcome.status });
      }
      return reply.status(202).send({ status: outcome.result, queued: outcome.enqueued });
    },
  );
}
