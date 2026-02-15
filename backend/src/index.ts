import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import { healthRoute } from './routes/health.js';
import { versionRoute } from './routes/version.js';
import { webhookRoute } from './routes/webhooks.js';
import { prsRoute } from './routes/prs.js';
import { statsRoute } from './routes/stats.js';
import { demoRoute } from './routes/demo.js';
import { requestIdPlugin } from './plugins/request-id.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';

dotenv.config();

// Configure structured logging
const isDevelopment = process.env.NODE_ENV === 'development';
const loggerConfig = isDevelopment
  ? {
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          colorize: true,
        },
      },
    }
  : {
      level: process.env.LOG_LEVEL || 'info',
      serializers: {
        req: (req: any) => ({
          method: req.method,
          url: req.url,
          headers: req.headers,
        }),
        res: (res: any) => ({
          statusCode: res.statusCode,
        }),
      },
    };

const fastify = Fastify({
  logger: loggerConfig,
  requestIdHeader: 'x-request-id',
  requestIdLogLabel: 'requestId',
  genReqId: () => {
    // Will be overridden by request-id plugin, but this is a fallback
    return undefined as any;
  },
});

// Register plugins and routes
async function registerPlugins() {
  // Register plugins (order matters)
  await fastify.register(requestIdPlugin);
  await fastify.register(errorHandlerPlugin);

  // Register CORS
  await fastify.register(cors, {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  });

  // Register routes
  await fastify.register(healthRoute);
  await fastify.register(versionRoute);
  await fastify.register(webhookRoute);
  await fastify.register(prsRoute);
  await fastify.register(statsRoute);
  await fastify.register(demoRoute);
}

const start = async () => {
  try {
    await registerPlugins();
    const port = Number(process.env.PORT) || 4000;
    await fastify.listen({ port, host: '0.0.0.0' });
    
    const localWebhookUrl = `http://localhost:${port}/webhooks/github`;
    const webhookProxyUrl = process.env.WEBHOOK_PROXY_URL;
    
    fastify.log.info(`🚀 Backend server running on http://localhost:${port}`);
    fastify.log.info(`📡 Webhook endpoint: ${localWebhookUrl}`);
    
    if (webhookProxyUrl) {
      fastify.log.info(`🔗 GitHub App webhook URL: ${webhookProxyUrl}`);
    } else {
      fastify.log.info(`💡 Set WEBHOOK_PROXY_URL in .env and use Smee.io for local webhook testing`);
      fastify.log.info(`   See README.md "Local Webhook Dev" section for instructions`);
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

