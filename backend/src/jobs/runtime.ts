import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env.js';
import { generateAiAnalysis } from '../ai/client.js';
import { GitHubClientFactory } from '../github/client.js';
import { pruneSessions } from '../auth/sessions.js';
import type { Logger } from '../lib/logger.js';
import { sanitizeErrorForStorage } from '../lib/sanitize.js';
import { dispatchDueDeliveries, type DispatchDeps } from './dispatch.js';
import { processDelivery, type DeliveryDeps } from './process-delivery.js';

/** Wire real dependencies into the delivery processor (used by the worker entry point). */
export function createDeliveryProcessor(opts: {
  config: AppConfig;
  prisma: PrismaClient;
  logger: Logger;
  workerId: string;
  fetch?: typeof fetch;
}) {
  const { config } = opts;
  const factory =
    config.github.enabled && config.github.appId && config.github.privateKey
      ? new GitHubClientFactory({ appId: config.github.appId, privateKey: config.github.privateKey, apiUrl: config.github.apiUrl }, { fetch: opts.fetch })
      : null;
  const deps: DeliveryDeps = {
    prisma: opts.prisma,
    config,
    logger: opts.logger,
    workerId: opts.workerId,
    github: factory ? (id) => factory.forInstallation(id) : null,
    appId: factory ? factory.appId : null,
    generateAi: (prompt) =>
      generateAiAnalysis(prompt, {
        apiKey: config.ai.apiKey,
        model: config.ai.model,
        baseUrl: config.ai.baseUrl,
        timeoutMs: config.ai.timeoutMs,
        fetch: opts.fetch,
      }),
  };
  return (deliveryId: string) => processDelivery(deps, deliveryId);
}

/** Periodically enqueue due deliveries (recovery after Redis outages, crashes and retries). */
export function startDispatcher(deps: DispatchDeps, intervalMs: number) {
  let running: Promise<void> | null = null;
  let ticks = 0;
  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        const result = await dispatchDueDeliveries(deps);
        if (result.due > 0) deps.logger.info(result, 'Dispatcher enqueued due deliveries');
        ticks += 1;
        if (ticks % 240 === 1) await pruneSessions(deps.prisma);
      } catch (err) {
        deps.logger.warn({ err: sanitizeErrorForStorage(err) }, 'Dispatcher tick failed');
      } finally {
        running = null;
      }
    })();
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      if (running) await running;
    },
  };
}
