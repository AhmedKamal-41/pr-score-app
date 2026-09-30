import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createTestPrisma, truncateAll } from '../helpers/db.js';
import { liveGithubEnv, testConfig } from '../helpers/config.js';
import { buildTestApp, sendWebhook, silentLogger, type TestApp } from '../helpers/app.js';
import { MockGitHub, pullRequestPayload, sha } from '../helpers/mock-github.js';
import { TEST_REDIS_URL } from '../helpers/env.js';
import { createDeliveryProcessor, startDispatcher } from '../../src/jobs/runtime.js';
import { dispatchDueDeliveries, recoverDeliveries, PROCESSING_STALE_MS, QUEUED_STALE_MS } from '../../src/jobs/dispatch.js';
import { closeQueueAndConnection, createEventsQueue, type DeliveryJobData, type EventsQueue } from '../../src/lib/queue.js';
import { createWorkerRedis } from '../../src/lib/redis.js';
import { EVENTS_QUEUE } from '../../src/config/constants.js';

/**
 * Crash boundaries of the delivery pipeline:
 *   webhook → [A] durable row → [B] enqueue → [C] worker claim → [D] analysis → [E] outcome recorded
 * Each test breaks the chain at one boundary and proves the delivery is still
 * processed exactly once in effect (one run, one score).
 */

const gh = new MockGitHub(4243);
const INST = 101;
const REPO = { id: 9101, full_name: 'acme/svc', private: true };
let prisma: PrismaClient;
const flush = new Redis(TEST_REDIS_URL);
let t: TestApp;
let queue: EventsQueue;
let queueConn: Redis;
let config: ReturnType<typeof testConfig>;

function startWorker(): Worker<DeliveryJobData> {
  const processor = createDeliveryProcessor({ config, prisma, logger: silentLogger, workerId: `w-${Math.random()}` });
  return new Worker<DeliveryJobData>(EVENTS_QUEUE, async (job) => processor(job.data.deliveryId), {
    connection: createWorkerRedis(TEST_REDIS_URL),
    concurrency: 2,
  });
}

async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting; last value ${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const deliveryStatus = (id: string) => prisma.webhookDelivery.findUniqueOrThrow({ where: { id } }).then((d) => d.status);

beforeAll(async () => {
  prisma = createTestPrisma();
  await gh.start();
  config = testConfig({
    ...liveGithubEnv({ apiUrl: gh.url, privateKey: gh.privateKeyPem, appId: gh.appId, installations: [INST] }),
  });
  t = await buildTestApp(config, prisma);
  queueConn = createWorkerRedis(TEST_REDIS_URL);
  queue = createEventsQueue(queueConn);
});

afterAll(async () => {
  await closeQueueAndConnection(queue, queueConn);
  await t.close();
  await gh.stop();
  await prisma.$disconnect();
  flush.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
  await flush.flushdb();
  gh.reset();
  gh.addRepo(REPO.full_name, { id: REPO.id, installationId: INST });
  gh.setPr(REPO.full_name, {
    id: 42,
    number: 42,
    title: 'Recovery PR',
    state: 'open',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:01:00Z',
    author: 'dev',
    head_sha: sha('rec'),
    head_ref: 'f',
    base_ref: 'main',
    files: [{ filename: 'src/a.ts', additions: 1, deletions: 0 }],
  });
});

const payload = () => pullRequestPayload('opened', REPO, { id: 42, number: 42, head_sha: sha('rec') }, INST);

async function expectProcessedOnce(deliveryId: string) {
  await waitFor(() => deliveryStatus(deliveryId), (s) => s === 'succeeded');
  expect(await prisma.analysisRun.count()).toBe(1);
  expect(await prisma.prScore.count()).toBe(1);
}

describe('delivery recovery across crash boundaries', () => {
  it('[A→B] a delivery stored while Redis was down is enqueued by the dispatcher and processed', async () => {
    const offline = await buildTestApp(config, prisma, 'redis://127.0.0.1:1');
    const id = crypto.randomUUID();
    try {
      expect((await sendWebhook(offline.app, 'pull_request', payload(), { deliveryId: id })).json()).toEqual({ status: 'accepted', queued: false });
    } finally {
      await offline.close();
    }
    expect(await deliveryStatus(id)).toBe('received');
    const worker = startWorker();
    try {
      expect(await dispatchDueDeliveries({ prisma, queue, logger: silentLogger })).toEqual({ due: 1, enqueued: 1 });
      await expectProcessedOnce(id);
    } finally {
      await worker.close();
    }
  });

  it('[B→C] a queued delivery whose Redis job was lost (queue cleanup, flush) is re-enqueued', async () => {
    const id = crypto.randomUUID();
    await sendWebhook(t.app, 'pull_request', payload(), { deliveryId: id });
    expect(await deliveryStatus(id)).toBe('queued');
    await flush.flushdb(); // the job is gone
    // Not yet stale → not re-enqueued (avoids duplicate work for healthy queues).
    expect((await dispatchDueDeliveries({ prisma, queue, logger: silentLogger })).due).toBe(0);
    const later = new Date(Date.now() + QUEUED_STALE_MS + 1000);
    const worker = startWorker();
    try {
      expect(await dispatchDueDeliveries({ prisma, queue, logger: silentLogger }, later)).toEqual({ due: 1, enqueued: 1 });
      await expectProcessedOnce(id);
    } finally {
      await worker.close();
    }
  });

  it('[C→E] a delivery abandoned mid-processing by a crashed worker is taken over after the stale window', async () => {
    const id = crypto.randomUUID();
    await sendWebhook(t.app, 'pull_request', payload(), { deliveryId: id });
    await flush.flushdb();
    // Simulate a worker that claimed the delivery and died.
    await prisma.webhookDelivery.update({ where: { id }, data: { status: 'processing', attempts: 1 } });
    const processor = createDeliveryProcessor({ config, prisma, logger: silentLogger, workerId: 'late' });
    expect((await processor(id)).outcome).toBe('skipped'); // still owned by the "crashed" worker
    const worker = startWorker();
    try {
      const later = new Date(Date.now() + PROCESSING_STALE_MS + 1000);
      expect((await dispatchDueDeliveries({ prisma, queue, logger: silentLogger }, later)).enqueued).toBe(1);
      // The processor re-checks staleness with the real clock, so age the row instead of waiting 10 minutes.
      await prisma.$executeRaw`UPDATE "webhook_deliveries" SET "updated_at" = NOW() - INTERVAL '11 minutes' WHERE "id" = ${id}`;
      await dispatchDueDeliveries({ prisma, queue, logger: silentLogger });
      await expectProcessedOnce(id);
    } finally {
      await worker.close();
    }
  });

  it('[D→E] a crash after the score was written but before the outcome was recorded does not duplicate history', async () => {
    const id = crypto.randomUUID();
    await sendWebhook(t.app, 'pull_request', payload(), { deliveryId: id });
    await flush.flushdb();
    const processor = createDeliveryProcessor({ config, prisma, logger: silentLogger, workerId: 'first' });
    await processor(id);
    // Pretend the success was never recorded.
    await prisma.webhookDelivery.update({ where: { id }, data: { status: 'processing', processed_at: null } });
    await prisma.$executeRaw`UPDATE "webhook_deliveries" SET "updated_at" = NOW() - INTERVAL '11 minutes' WHERE "id" = ${id}`;
    expect((await processor(id)).outcome).toBe('succeeded');
    expect(await prisma.analysisRun.count()).toBe(1);
    expect(await prisma.prScore.count()).toBe(1);
  });

  it('retries failed deliveries on schedule and gives up after the attempt budget', async () => {
    const id = crypto.randomUUID();
    gh.failNext('GET', /\/pulls\/42$/, 502, { times: 100 });
    await sendWebhook(t.app, 'pull_request', payload(), { deliveryId: id });
    await flush.flushdb();
    const processor = createDeliveryProcessor({ config, prisma, logger: silentLogger, workerId: 'r' });
    const first = await processor(id);
    expect(first.outcome).toBe('failed');
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect((await dispatchDueDeliveries({ prisma, queue, logger: silentLogger })).due).toBe(0); // not due yet

    for (let i = 2; i <= config.worker.deliveryMaxAttempts; i += 1) {
      await prisma.webhookDelivery.update({ where: { id }, data: { next_attempt_at: new Date(0) } });
      await processor(id);
    }
    const dead = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(dead).toMatchObject({ status: 'dead', attempts: config.worker.deliveryMaxAttempts });
    expect(dead.last_error).toMatch(/502/);
  });

  it('recovers dead deliveries on demand (CLI/admin API) after the cause is fixed', async () => {
    const id = crypto.randomUUID();
    await sendWebhook(t.app, 'pull_request', payload(), { deliveryId: id });
    await flush.flushdb();
    await prisma.webhookDelivery.update({ where: { id }, data: { status: 'dead', attempts: 6, last_error: 'old outage' } });
    expect((await recoverDeliveries({ prisma, queue, logger: silentLogger })).reset).toBe(0); // dead excluded by default
    const worker = startWorker();
    try {
      const result = await recoverDeliveries({ prisma, queue, logger: silentLogger }, { includeDead: true });
      expect(result).toMatchObject({ reset: 1, enqueued: 1 });
      await expectProcessedOnce(id);
    } finally {
      await worker.close();
    }
  });

  it('processes jobs that were queued while no worker was running (worker restart)', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const w1 = startWorker();
    await w1.close(); // worker stops
    for (const id of ids) await sendWebhook(t.app, 'pull_request', payload(), { deliveryId: id });
    expect(await Promise.all(ids.map(deliveryStatus))).toEqual(['queued', 'queued']);
    // Worker restarts; like the real worker entry point it also runs the dispatcher,
    // which re-dispatches a delivery that had to wait for the other one's PR lease.
    const w2 = startWorker();
    const dispatcher = startDispatcher({ prisma, queue, logger: silentLogger }, 500);
    try {
      for (const id of ids) await waitFor(() => deliveryStatus(id), (s) => s === 'succeeded', 40_000);
      expect(await prisma.prScore.count()).toBe(1); // identical inputs → one run
      expect((await prisma.webhookDelivery.findMany()).every((d) => d.attempts <= 1)).toBe(true);
    } finally {
      await dispatcher.stop();
      await w2.close();
    }
  });
});
