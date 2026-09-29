import pino, { type LoggerOptions } from 'pino';
import type { AppConfig } from '../config/env.js';

/**
 * Paths that must never appear in logs. Request/response headers are not
 * logged at all (see the serializers below); these paths guard objects that
 * application code might log explicitly.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-hub-signature"]',
  'req.headers["x-demo-secret"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.privateKey',
  '*.private_key',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.webhookSecret',
  '*.patch',
  '*.patches',
  '*.diff',
  '*.payload',
  '*.body',
];

const SAFE_HEADERS = ['user-agent', 'x-github-event', 'x-github-delivery', 'x-github-hook-id', 'content-length'];

interface MinimalRequest {
  id?: string;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}

export function loggerOptions(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): LoggerOptions {
  const options: LoggerOptions = {
    level: config.nodeEnv === 'test' && config.logLevel === 'info' ? 'warn' : config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      req(req: MinimalRequest) {
        const headers: Record<string, unknown> = {};
        for (const name of SAFE_HEADERS) {
          if (req.headers?.[name] !== undefined) headers[name] = req.headers[name];
        }
        // Query strings are dropped: they are never needed for debugging here.
        return { id: req.id, method: req.method, url: req.url?.split('?')[0], headers };
      },
      res(res: { statusCode?: number }) {
        return { statusCode: res.statusCode };
      },
      err: pino.stdSerializers.err,
    },
  };
  if (config.nodeEnv === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname', colorize: true },
    };
  }
  return options;
}

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>, name: string) {
  return pino({ ...loggerOptions(config), name });
}

export type Logger = pino.Logger;
