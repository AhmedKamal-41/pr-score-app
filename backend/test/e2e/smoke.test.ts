import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createTestPrisma, truncateAll } from '../helpers/db.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from '../helpers/env.js';
import { TEST_ADMIN, TEST_WEBHOOK_SECRET } from '../helpers/config.js';
import { MockGitHub, pullRequestPayload, sha, type MockFile } from '../helpers/mock-github.js';
import { MockOpenAI } from '../helpers/mock-openai.js';
import { freePort, startProcess, waitForHttp, waitUntil, type ManagedProcess } from '../helpers/processes.js';
import { ToggleProxy } from '../helpers/tcp-proxy.js';
import { signPayload } from '../../src/webhooks/signature.js';
import { EXAMPLE_ADMIN_PASSWORD_HASH } from '../../src/config/env.js';
import { COMMENT_MARKER } from '../../src/config/constants.js';

/**
 * End-to-end smoke test of the compiled system:
 *   node dist/server.js + node dist/worker.js + next start (production build)
 *   real PostgreSQL + Redis, mocked GitHub and OpenAI HTTP APIs.
 * Run with `pnpm test:e2e` (builds backend and frontend first).
 */

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const frontendDir = join(backendDir, '../frontend');
const INST = 3100;
const REPO_A = { id: 61001, full_name: 'e2e/api', private: true };
const REPO_B = { id: 61002, full_name: 'e2e/web', private: false };

const gh = new MockGitHub(9911);
const ai = new MockOpenAI();
let prisma: PrismaClient;
let api: ManagedProcess;
let worker: ManagedProcess;
let web: ManagedProcess;
let apiUrl = '';
let webUrl = '';
let redisProxy: ToggleProxy;
let baseEnv: NodeJS.ProcessEnv;
const scratch = mkdtempSync(join(tmpdir(), 'prs-e2e-')); // cwd without any .env file

function startWorker(): ManagedProcess {
  return startProcess('worker', process.execPath, [join(backendDir, 'dist/worker.js')], { cwd: scratch, env: baseEnv });
}

async function webhook(event: string, payload: unknown, opts: { deliveryId?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  return fetch(`${apiUrl}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': opts.deliveryId ?? crypto.randomUUID(),
      'x-hub-signature-256': signPayload(opts.secret ?? TEST_WEBHOOK_SECRET, body),
    },
    body,
  });
}

const status = (id: string) => prisma.webhookDelivery.findUnique({ where: { id } }).then((d) => d?.status ?? 'missing');
const waitProcessed = (id: string, timeoutMs = 45_000) => waitUntil(() => status(id), (s) => s === 'succeeded' || s === 'ignored', timeoutMs, `delivery ${id}`);

beforeAll(async () => {
  for (const f of ['dist/server.js', 'dist/worker.js']) {
    if (!existsSync(join(backendDir, f))) throw new Error(`${f} missing: run \`pnpm test:e2e\` (it builds first)`);
  }
  if (!existsSync(join(frontendDir, '.next/BUILD_ID'))) throw new Error('frontend production build missing: run `pnpm --filter frontend build`');

  prisma = createTestPrisma();
  await truncateAll(prisma);
  const flush = new Redis(TEST_REDIS_URL);
  await flush.flushdb();
  flush.disconnect();

  await gh.start();
  await ai.start();
  gh.addRepo(REPO_A.full_name, { id: REPO_A.id, installationId: INST });
  gh.addRepo(REPO_B.full_name, { id: REPO_B.id, installationId: INST, private: false });

  const redisUrl = new URL(TEST_REDIS_URL);
  redisProxy = new ToggleProxy({ host: redisUrl.hostname, port: Number(redisUrl.port) });
  await redisProxy.start();

  const [apiPort, webPort] = [await freePort(), await freePort()];
  apiUrl = `http://127.0.0.1:${apiPort}`;
  webUrl = `http://127.0.0.1:${webPort}`;
  const guard = `--import=${pathToFileURL(join(backendDir, 'test/setup/network-guard.mjs')).href}`;
  baseEnv = {
    PATH: process.env.PATH,
    NODE_OPTIONS: guard,
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    HOST: '127.0.0.1',
    PORT: String(apiPort),
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    FRONTEND_URL: webUrl,
    ADMIN_USERNAME: TEST_ADMIN.username,
    ADMIN_PASSWORD_HASH: EXAMPLE_ADMIN_PASSWORD_HASH,
    GITHUB_ENABLED: 'true',
    GITHUB_APP_ID: String(gh.appId),
    GITHUB_PRIVATE_KEY: gh.privateKeyPem.replace(/\n/g, '\\n'),
    GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    GITHUB_API_URL: gh.url,
    WORKSPACE_INSTALLATION_IDS: String(INST),
    GITHUB_POST_COMMENTS: 'true',
    AI_ENABLED: 'true',
    OPENAI_API_KEY: 'test-key-not-real',
    OPENAI_BASE_URL: ai.url,
    AI_TIMEOUT_MS: '3000',
    DISPATCHER_INTERVAL_MS: '500',
  };
  // The API reaches Redis through the toggle proxy so a Redis outage can be simulated.
  api = startProcess('api', process.execPath, [join(backendDir, 'dist/server.js')], {
    cwd: scratch,
    env: { ...baseEnv, REDIS_URL: `redis://127.0.0.1:${redisProxy.port}${redisUrl.pathname}` },
  });
  worker = startWorker();
  web = startProcess('web', process.execPath, [join(frontendDir, 'node_modules/next/dist/bin/next'), 'start', '-p', String(webPort), '-H', '127.0.0.1'], {
    cwd: frontendDir,
    env: { PATH: process.env.PATH, NODE_OPTIONS: guard, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', API_INTERNAL_URL: apiUrl },
  });
  await waitForHttp(`${apiUrl}/ready`, (s) => s === 200, 60_000, api);
  await waitForHttp(`${webUrl}/login`, (s) => s === 200, 90_000, web);
});

afterAll(async () => {
  await Promise.all([api?.stop(), worker?.stop(), web?.stop()]);
  await redisProxy?.stop();
  await gh.stop();
  await ai.stop();
  await prisma?.$disconnect();
});

const files = (n: number, critical: MockFile): MockFile[] => {
  const list: MockFile[] = Array.from({ length: n }, (_, i) => ({ filename: `src/pkg/file${i}.ts`, additions: 2, deletions: 1 }));
  list[n - 5] = critical; // beyond the first 100-file page
  return list;
};

describe('end-to-end smoke', () => {
  let prAId = '';

  it('rejects an invalid signature and unauthenticated reads', async () => {
    const bad = await webhook('pull_request', { action: 'opened' }, { secret: 'not-the-secret-value' });
    expect(bad.status).toBe(401);
    expect((await fetch(`${apiUrl}/api/prs`)).status).toBe(401);
    const page = await fetch(`${webUrl}/prs`, { redirect: 'manual' });
    expect([307, 308]).toContain(page.status);
    expect(page.headers.get('location')).toContain('/login?next=%2Fprs');
  });

  it('processes a signed PR webhook through the real queue, worker and database', async () => {
    const head = sha('e2e-a1');
    gh.setPr(REPO_A.full_name, {
      id: 91,
      number: 1,
      title: 'E2E: rotate session keys',
      state: 'open',
      created_at: '2026-09-20T10:00:00Z',
      updated_at: '2026-09-20T10:05:00Z',
      author: 'e2e-dev',
      head_sha: head,
      head_ref: 'feature/rotate',
      base_ref: 'main',
      files: files(140, { filename: 'src/auth/session.ts', additions: 60, deletions: 10, patch: '@@ -1 +1 @@\n+rotateKeys()' }),
    });
    gh.setChecks(REPO_A.full_name, head, [{ status: 'in_progress', conclusion: null }]);

    const deliveryId = crypto.randomUUID();
    const res = await webhook('pull_request', pullRequestPayload('opened', REPO_A, { id: 91, number: 1, head_sha: head }, INST), { deliveryId });
    expect(res.status).toBe(202);
    await waitProcessed(deliveryId);

    const pr = await prisma.pullRequest.findFirstOrThrow({ where: { number: 1, repo: { github_repo_id: BigInt(REPO_A.id) } }, include: { scores: true, ai_analyses: true } });
    prAId = pr.id;
    expect((pr.changed_files_list as string[]).length).toBe(140);
    expect(pr.scores).toHaveLength(1);
    // +40 (>50 files) +20 (Authentication) +20 (no tests); CI pending adds nothing.
    expect(pr.scores[0]).toMatchObject({ score: 80, ci_status: 'pending', head_sha: head, scoring_version: 'v2' });
    expect(pr.ai_analyses).toHaveLength(1);
    expect(ai.calls).toHaveLength(1);
    const comments = gh.comments(REPO_A.full_name, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(COMMENT_MARKER);

    // Same-event replay is deduplicated.
    const replay = await webhook('pull_request', pullRequestPayload('opened', REPO_A, { id: 91, number: 1, head_sha: head }, INST), { deliveryId });
    expect(replay.status).toBe(200);
    expect(await prisma.prScore.count()).toBe(1);
  });

  it('re-scores when CI changes on the same SHA and updates the single comment', async () => {
    const head = sha('e2e-a1');
    gh.setChecks(REPO_A.full_name, head, [{ status: 'completed', conclusion: 'failure' }]);
    const id = crypto.randomUUID();
    const res = await webhook(
      'check_suite',
      {
        action: 'completed',
        check_suite: { head_sha: head, conclusion: 'failure', app: { id: 15368 } },
        repository: { id: REPO_A.id, name: 'api', full_name: REPO_A.full_name, owner: { login: 'e2e' }, private: true },
        installation: { id: INST },
      },
      { deliveryId: id },
    );
    expect(res.status).toBe(202);
    await waitProcessed(id);
    const scores = await prisma.prScore.findMany({ where: { pull_request_id: prAId }, orderBy: { created_at: 'asc' } });
    expect(scores.map((s) => [s.ci_status, s.score])).toEqual([
      ['pending', 80],
      ['failure', 100],
    ]);
    expect(gh.comments(REPO_A.full_name, 1)).toHaveLength(1);
    expect(gh.comments(REPO_A.full_name, 1)[0].body).toContain('CI:** failure');
  });

  it('keeps a same-numbered PR in another repository separate and preserves its score when AI fails', async () => {
    ai.responder = () => ({ status: 500, body: { error: { message: 'boom' } } });
    const head = sha('e2e-b1');
    gh.setPr(REPO_B.full_name, {
      id: 92,
      number: 1,
      title: 'E2E: docs tweak',
      state: 'open',
      created_at: '2026-09-21T10:00:00Z',
      updated_at: '2026-09-21T10:05:00Z',
      author: 'e2e-dev',
      head_sha: head,
      head_ref: 'docs',
      base_ref: 'main',
      files: [{ filename: 'docs/guide.md', additions: 3, deletions: 1 }],
    });
    gh.setChecks(REPO_B.full_name, head, [{ status: 'completed', conclusion: 'success' }]);
    const id = crypto.randomUUID();
    await webhook('pull_request', pullRequestPayload('opened', REPO_B, { id: 92, number: 1, head_sha: head }, INST), { deliveryId: id });
    await waitProcessed(id);
    const prs = await prisma.pullRequest.findMany({ where: { number: 1 }, include: { repo: true, analysis_runs: true, scores: true } });
    expect(prs).toHaveLength(2);
    const b = prs.find((p) => p.repo.full_name === REPO_B.full_name)!;
    expect(b.scores[0].score).toBe(20);
    expect(b.analysis_runs[0]).toMatchObject({ ai_status: 'unavailable', comment_status: 'skipped' });
    expect(gh.comments(REPO_B.full_name, 1)).toHaveLength(0);
    ai.reset();
  });

  it('accepts webhooks during a Redis outage and processes them after recovery', async () => {
    redisProxy.cut();
    const head = sha('e2e-a2');
    gh.setPr(REPO_A.full_name, { ...gh.repo(REPO_A.full_name).prs.get(1)!, head_sha: head, updated_at: '2026-09-22T10:00:00Z' });
    gh.setChecks(REPO_A.full_name, head, [{ status: 'completed', conclusion: 'success' }]);
    const id = crypto.randomUUID();
    const res = await webhook('pull_request', pullRequestPayload('synchronize', REPO_A, { id: 91, number: 1, head_sha: head }, INST), { deliveryId: id });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted', queued: false });
    const ready = await fetch(`${apiUrl}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ok: false, checks: { database: 'up', redis: 'down' } });
    redisProxy.restore();
    await waitProcessed(id); // the worker's dispatcher re-enqueues from PostgreSQL
    await waitForHttp(`${apiUrl}/ready`);
  });

  it('survives a worker restart: events accepted while it is down are processed afterwards', async () => {
    expect(await worker.stop('SIGTERM')).toBe(0); // graceful shutdown
    const head = sha('e2e-a3');
    gh.setPr(REPO_A.full_name, { ...gh.repo(REPO_A.full_name).prs.get(1)!, head_sha: head, updated_at: '2026-09-23T10:00:00Z' });
    gh.setChecks(REPO_A.full_name, head, [{ status: 'completed', conclusion: 'success' }]);
    const id = crypto.randomUUID();
    await webhook('pull_request', pullRequestPayload('synchronize', REPO_A, { id: 91, number: 1, head_sha: head }, INST), { deliveryId: id });
    expect(await status(id)).toBe('queued');
    worker = startWorker();
    await waitProcessed(id, 60_000);
    const pr = await prisma.pullRequest.findUniqueOrThrow({ where: { id: prAId } });
    expect(pr.head_sha).toBe(head);
    expect(gh.comments(REPO_A.full_name, 1)).toHaveLength(1);
    expect(gh.comments(REPO_A.full_name, 1)[0].body).toContain(head.slice(0, 12));
  });

  it('shows score, history, statistics and the AI analysis in the authenticated dashboard', async () => {
    const login = await fetch(`${webUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: webUrl },
      body: JSON.stringify({ username: TEST_ADMIN.username, password: TEST_ADMIN.password }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie().find((c) => c.startsWith('prs_session='))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const cookie = setCookie.split(';')[0];
    const page = async (path: string) => {
      const res = await fetch(`${webUrl}${path}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      // Compare rendered text, not markup: strip tags/scripts and decode the few entities used.
      const html = await res.text();
      return html
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<!-- -->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');
    };

    const list = await page('/prs');
    expect(list).toContain('E2E: rotate session keys');
    expect(list).toContain('E2E: docs tweak');
    expect(list).toContain('Showing 1 – 2 of 2 pull requests');

    const detail = await page(`/prs/${prAId}`);
    expect(detail).toContain('Mocked analysis: authentication changes without tests need careful review.');
    expect(detail).toContain('Session handling changes');
    expect(detail).toContain('Model-reported confidence');
    expect(detail).toContain(sha('e2e-a3').slice(0, 12));
    expect(detail).toContain('Score history');
    expect(detail.match(/older revision/g)?.length ?? 0).toBeGreaterThanOrEqual(3);

    const stats = await page('/stats');
    expect(stats).toContain('Riskiest folders');
    expect(stats).toContain('src/pkg');

    // Logout revokes the session.
    const out = await fetch(`${webUrl}/api/auth/logout`, { method: 'POST', headers: { cookie, origin: webUrl, 'content-type': 'application/json' }, body: '{}' });
    expect(out.status).toBe(200);
    expect((await fetch(`${webUrl}/prs`, { headers: { cookie }, redirect: 'manual' })).status).toBe(307);
  });

  it('shuts the API down gracefully', async () => {
    expect(await api.stop('SIGTERM')).toBe(0);
    expect(api.output()).not.toMatch(/prs_session=|test-key-not-real|integration-test-webhook-secret|BEGIN RSA PRIVATE KEY/);
    expect(worker.output()).not.toMatch(/test-key-not-real|BEGIN RSA PRIVATE KEY|rotateKeys/);
  });
});
