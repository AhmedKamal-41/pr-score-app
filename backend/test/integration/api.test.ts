import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestPrisma, truncateAll } from '../helpers/db.js';
import { liveGithubEnv, testConfig, TEST_ORIGIN } from '../helpers/config.js';
import { buildTestApp, login, sendWebhook, type TestApp } from '../helpers/app.js';
import { MockGitHub, pullRequestPayload, sha } from '../helpers/mock-github.js';
import { seedDemoData } from '../../src/demo/seed.js';
import { SESSION_COOKIE } from '../../src/config/constants.js';
import { Redis } from 'ioredis';
import { TEST_REDIS_URL } from '../helpers/env.js';

const gh = new MockGitHub(4242);
const INSTALLATION = 101;
const REPO = { id: 9001, full_name: 'acme/app', private: true };
let prisma: PrismaClient;
let t: TestApp;
let config: ReturnType<typeof testConfig>;
const redis = new Redis(TEST_REDIS_URL);

beforeAll(async () => {
  prisma = createTestPrisma();
  config = testConfig({
    ...liveGithubEnv({ apiUrl: 'http://127.0.0.1:9', privateKey: gh.privateKeyPem, appId: gh.appId, installations: [INSTALLATION] }),
    DEMO_ENABLED: 'true',
  });
  t = await buildTestApp(config, prisma);
});

afterAll(async () => {
  await t?.close();
  await prisma?.$disconnect();
  redis.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
  await redis.flushdb();
});

const prPayload = (action = 'opened', number = 7, head = sha(`head-${number}`)) =>
  pullRequestPayload(action, REPO, { id: 555000 + number, number, head_sha: head }, INSTALLATION);

describe('health, readiness, request ids and errors', () => {
  it('serves liveness without dependencies and readiness with dependency status', async () => {
    expect((await t.app.inject('/health')).json()).toEqual({ ok: true });
    const ready = await t.app.inject('/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true, checks: { database: 'up', redis: 'up' } });
  });

  it('reports unavailable dependencies accurately without exposing credentials', async () => {
    const brokenPrisma = createTestPrisma('postgresql://postgres:postgres@127.0.0.1:1/unreachable_test');
    const broken = await buildTestApp(config, brokenPrisma, 'redis://:secretpw@127.0.0.1:1');
    try {
      const res = await broken.app.inject('/ready');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false, checks: { database: 'down', redis: 'down' } });
      expect(res.body).not.toMatch(/secretpw|postgres:postgres|127\.0\.0\.1/);
    } finally {
      await broken.close();
      await brokenPrisma.$disconnect();
    }
  });

  it('returns a request id header and uses it in error envelopes', async () => {
    const res = await t.app.inject({ url: '/nope', headers: { 'x-request-id': 'client-supplied-id-123' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('client-supplied-id-123');
    expect(res.json()).toEqual({ error: { message: 'Route GET /nope not found', code: 'NOT_FOUND', requestId: 'client-supplied-id-123' } });
  });

  it('replaces malformed incoming request ids with generated UUIDs', async () => {
    const res = await t.app.inject({ url: '/health', headers: { 'x-request-id': 'bad id\n' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns validation errors in the envelope', async () => {
    const cookie = await login(t.app);
    const res = await t.app.inject({ url: '/api/prs?limit=0', headers: { cookie } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
    expect(body.error.details[0].field).toBe('limit');
  });

  it('serves the public version endpoint', async () => {
    expect((await t.app.inject('/api/version')).json()).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });
});

describe('authentication and authorization', () => {
  it.each(['/api/prs', '/api/stats', `/api/prs/${crypto.randomUUID()}`, '/api/admin/deliveries'])('rejects unauthenticated reads of %s', async (url) => {
    const res = await t.app.inject(url);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('logs in with an HttpOnly SameSite session cookie and reads data', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { username: 'admin', password: 'local-dev-password-change-me' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
    expect(cookie.secure).toBeFalsy(); // Secure is enabled when NODE_ENV=production
    const stored = await prisma.adminSession.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).not.toBe(cookie.value); // only a hash is stored
    const prs = await t.app.inject({ url: '/api/prs', headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` } });
    expect(prs.statusCode).toBe(200);
    expect(prs.headers['cache-control']).toBe('no-store');
  });

  it('rejects wrong credentials and throttles repeated failures', async () => {
    const attempt = (password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: TEST_ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: { username: 'admin', password },
      });
    for (let i = 0; i < 5; i += 1) expect((await attempt('wrong-password-123')).statusCode).toBe(401);
    const blocked = await attempt('local-dev-password-change-me');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rotates the session on login and revokes it on logout', async () => {
    const first = await login(t.app);
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json', cookie: first },
      payload: { username: 'admin', password: 'local-dev-password-change-me' },
    });
    const secondCookie = `${SESSION_COOKIE}=${second.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
    expect((await t.app.inject({ url: '/api/prs', headers: { cookie: first } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/prs', headers: { cookie: secondCookie } })).statusCode).toBe(200);

    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json', cookie: secondCookie }, payload: {} });
    expect(out.statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/prs', headers: { cookie: secondCookie } })).statusCode).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const cookie = await login(t.app);
    await prisma.adminSession.updateMany({ data: { expires_at: new Date(Date.now() - 1000) } });
    expect((await t.app.inject({ url: '/api/prs', headers: { cookie } })).statusCode).toBe(401);
  });

  it('enforces origin checks on authenticated mutations (CSRF)', async () => {
    const cookie = await login(t.app);
    const seed = (headers: Record<string, string>) => t.app.inject({ method: 'POST', url: '/api/demo/seed', headers: { cookie, ...headers }, payload: {} });
    expect((await seed({ origin: 'https://evil.example', 'content-type': 'application/json' })).statusCode).toBe(403);
    expect((await seed({ 'content-type': 'application/json' })).statusCode).toBe(403);
    expect((await seed({ origin: TEST_ORIGIN, 'content-type': 'text/plain' })).statusCode).toBe(415);
    expect((await seed({ origin: TEST_ORIGIN, 'content-type': 'application/json' })).statusCode).toBe(200);
  });

  it('requires authentication for demo seeding and recovery', async () => {
    const headers = { origin: TEST_ORIGIN, 'content-type': 'application/json' };
    expect((await t.app.inject({ method: 'POST', url: '/api/demo/seed', headers, payload: {} })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/deliveries/recover', headers, payload: {} })).statusCode).toBe(401);
  });
});

describe('workspace data policy', () => {
  it('serves demo data and workspace installations only, and hides revoked repositories', async () => {
    await seedDemoData(prisma);
    const outsider = await prisma.repo.create({ data: { github_repo_id: 777n, full_name: 'other/org', owner: 'other', name: 'org', installation_id: 999n } });
    await prisma.pullRequest.create({ data: { repo_id: outsider.id, number: 1, title: 'not ours', state: 'open', author: 'x', head_sha: sha('x'), base_ref: 'main', head_ref: 'x' } });
    const ours = await prisma.repo.create({ data: { github_repo_id: 778n, full_name: 'acme/app', owner: 'acme', name: 'app', installation_id: BigInt(INSTALLATION) } });
    const ourPr = await prisma.pullRequest.create({ data: { repo_id: ours.id, number: 1, title: 'ours', state: 'open', author: 'x', head_sha: sha('y'), base_ref: 'main', head_ref: 'y' } });

    const cookie = await login(t.app);
    const list = (await t.app.inject({ url: '/api/prs?limit=100', headers: { cookie } })).json();
    expect(list.pagination.total).toBe(12);
    expect(list.data.map((p: { title: string }) => p.title)).not.toContain('not ours');

    await prisma.repo.update({ where: { id: ours.id }, data: { access_status: 'revoked' } });
    expect((await t.app.inject({ url: '/api/prs?limit=100', headers: { cookie } })).json().pagination.total).toBe(11);
    expect((await t.app.inject({ url: `/api/prs/${ourPr.id}`, headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('webhook intake', () => {
  it('rejects missing, malformed, wrong and tampered signatures before storing anything', async () => {
    const payload = prPayload();
    const raw = Buffer.from(JSON.stringify(payload));
    const cases = [
      await sendWebhook(t.app, 'pull_request', payload, { signature: null }),
      await sendWebhook(t.app, 'pull_request', payload, { signature: 'sha256=nothex' }),
      await sendWebhook(t.app, 'pull_request', payload, { secret: 'a-different-secret-value' }),
      await sendWebhook(t.app, 'pull_request', payload, {
        rawBody: Buffer.from(JSON.stringify({ ...payload, number: 8 })),
        signature: (await import('../../src/webhooks/signature.js')).signPayload('integration-test-webhook-secret', raw),
      }),
    ];
    expect(cases.map((r) => r.statusCode)).toEqual([401, 401, 401, 401]);
    expect(cases.map((r) => r.json().error.code)).toEqual(['UNAUTHORIZED', 'UNAUTHORIZED', 'UNAUTHORIZED', 'UNAUTHORIZED']);
    expect(await prisma.webhookDelivery.count()).toBe(0);
    expect(await t.queue.count()).toBe(0);
  });

  it('checks the signature before parsing JSON', async () => {
    const bad = await sendWebhook(t.app, 'pull_request', null, { rawBody: Buffer.from('{not json'), signature: `sha256=${'0'.repeat(64)}` });
    expect(bad.statusCode).toBe(401);
    const signedInvalid = await sendWebhook(t.app, 'pull_request', null, { rawBody: Buffer.from('{not json') });
    expect(signedInvalid.statusCode).toBe(400);
  });

  it('validates required headers and content type', async () => {
    const payload = prPayload();
    expect((await sendWebhook(t.app, 'pull_request', payload, { deliveryId: '' })).statusCode).toBe(400);
    expect((await sendWebhook(t.app, 'PULL REQUEST', payload)).statusCode).toBe(400);
    expect((await sendWebhook(t.app, 'pull_request', payload, { contentType: 'application/x-www-form-urlencoded' })).statusCode).toBe(415);
  });

  it('answers ping without storing or enqueueing', async () => {
    const res = await sendWebhook(t.app, 'ping', { zen: 'Keep it logically awesome.', hook_id: 1 });
    expect(res.statusCode).toBe(200);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it.each([
    ['unsupported event', 'issues', { action: 'opened' }],
    ['unsupported PR action', 'pull_request', { ...prPayload(), action: 'labeled' }],
    ['non-completed check suite', 'check_suite', { action: 'requested' }],
  ])('acknowledges %s without a job', async (_name, event, payload) => {
    const res = await sendWebhook(t.app, event, payload);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('ignored');
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('ignores installations outside the workspace', async () => {
    const res = await sendWebhook(t.app, 'pull_request', pullRequestPayload('opened', REPO, { id: 1, number: 1, head_sha: sha(1) }, 999));
    expect(res.statusCode).toBe(202);
    expect(res.json().reason).toMatch(/not part of this workspace/);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it.each([
    ['non-positive PR number', { ...prPayload(), number: 0 }],
    ['missing installation', (({ installation: _i, ...rest }) => rest)(prPayload())],
    ['bad head SHA', { ...prPayload(), pull_request: { ...prPayload().pull_request, head: { sha: 'abc' } } }],
    ['mismatched numbers', { ...prPayload(), number: 8 }],
    ['missing repository', (({ repository: _r, ...rest }) => rest)(prPayload())],
  ])('rejects malformed supported events: %s', async (_name, payload) => {
    const res = await sendWebhook(t.app, 'pull_request', payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toMatch(/INVALID_PAYLOAD|BAD_REQUEST/);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('stores a minimal payload durably, enqueues it, and acknowledges with 202', async () => {
    const deliveryId = crypto.randomUUID();
    const res = await sendWebhook(t.app, 'pull_request', prPayload(), { deliveryId });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', queued: true });
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(row).toMatchObject({ event: 'pull_request', action: 'opened', status: 'queued', pr_number: 7, repo_full_name: 'acme/app' });
    expect(Object.keys(row.payload as object).sort()).toEqual(['action', 'base_changed', 'github_id', 'head_sha', 'number', 'repository']);
    expect(JSON.stringify(row.payload)).not.toMatch(/sender|someone|ignored by the app/);
    expect(await t.queue.getJob(`delivery__${deliveryId}__0`)).toBeTruthy();
  });

  it('deduplicates replays, detects conflicting reuse, and requeues failed deliveries', async () => {
    const deliveryId = crypto.randomUUID();
    await sendWebhook(t.app, 'pull_request', prPayload(), { deliveryId });
    const replay = await sendWebhook(t.app, 'pull_request', prPayload(), { deliveryId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: 'duplicate', delivery_status: 'queued' });
    expect(await prisma.webhookDelivery.count()).toBe(1);

    const conflict = await sendWebhook(t.app, 'pull_request', prPayload('opened', 7, sha('other')), { deliveryId });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('DELIVERY_ID_CONFLICT');

    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'dead', attempts: 6, last_error: 'boom' } });
    const redelivered = await sendWebhook(t.app, 'pull_request', prPayload(), { deliveryId });
    expect(redelivered.statusCode).toBe(202);
    expect(redelivered.json().status).toBe('requeued');
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } })).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('still accepts durably when Redis is unavailable (recovered later by the dispatcher)', async () => {
    const offline = await buildTestApp(config, prisma, 'redis://127.0.0.1:1');
    try {
      const deliveryId = crypto.randomUUID();
      const started = Date.now();
      const res = await sendWebhook(offline.app, 'pull_request', prPayload(), { deliveryId });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'accepted', queued: false });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } })).status).toBe('received');
    } finally {
      await offline.close();
    }
  });

  it('returns a retryable 503 when the delivery cannot be stored', async () => {
    const brokenPrisma = createTestPrisma('postgresql://postgres:postgres@127.0.0.1:1/unreachable_test');
    const broken = await buildTestApp(config, brokenPrisma);
    try {
      const res = await sendWebhook(broken.app, 'pull_request', prPayload());
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('STORAGE_UNAVAILABLE');
      expect(await t.queue.count()).toBe(0);
    } finally {
      await broken.close();
      await brokenPrisma.$disconnect();
    }
  });

  it('answers 503 when GitHub integration is disabled', async () => {
    const local = await buildTestApp(testConfig(), prisma);
    try {
      const res = await sendWebhook(local.app, 'pull_request', prPayload());
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('GITHUB_DISABLED');
    } finally {
      await local.close();
    }
  });
});
