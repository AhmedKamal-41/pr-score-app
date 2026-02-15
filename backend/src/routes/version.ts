import { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../config/constants.js';

export async function versionRoute(fastify: FastifyInstance) {
  fastify.get('/api/version', async (request, reply) => {
    return { version: APP_VERSION };
  });
}

