import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createTestPrisma, truncateAll } from '../helpers/db.js';
import { testConfig } from '../helpers/config.js';
import { buildTestApp, login, type TestApp } from '../helpers/app.js';
import { TEST_REDIS_URL } from '../helpers/env.js';
import { DEMO_SCENARIOS, seedDemoData } from '../../src/demo/seed.js';
import { sha } from '../helpers/mock-github.js';

let prisma: PrismaClient;
let t: TestApp;
let cookie: string;
const redis = new Redis(TEST_REDIS_URL);

beforeAll(async () => {
  prisma = createTestPrisma();
  t = await buildTestApp(testConfig({ DEMO_ENABLED: 'true' }), prisma);
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await truncateAll(prisma);
  await redis.flushdb();
  cookie = await login(t.app);
});

const get = async (url: string) => {
  const res = await t.app.inject({ url, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe('statistics', () => {
  it('reports an empty workspace consistently', async () => {
    expect(await get('/api/stats')).toEqual({
      total_prs: 0,
      scored_prs: 0,
      unscored_prs: 0,
      average_score: null,
      counts_by_level: { low: 0, medium: 0, high: 0 },
      top_risky_folders: [],
    });
  });

  it('counts each PR once per folder using its latest applicable score', async () => {
    const repo = await prisma.repo.create({ data: { github_repo_id: -1n, full_name: 'demo/x', owner: 'demo', name: 'x', installation_id: 0n, is_demo: true } });
    const mk = async (number: number, files: string[], head: string) =>
      prisma.pullRequest.create({
        data: { repo_id: repo.id, number, title: `pr${number}`, state: 'open', author: 'a', head_sha: head, base_ref: 'm', head_ref: 'h', changed_files_list: files },
      });
    const p1 = await mk(1, ['src/auth/a.ts', 'src/auth/b.ts', 'src/auth/deep/c.ts', 'README.md', 'prisma/schema.prisma'], sha('p1'));
    const p2 = await mk(2, ['src/auth/z.ts'], sha('p2'));
    await mk(3, ['src/other/q.ts'], sha('p3')); // unscored
    const score = (pr: string, value: number, head: string | null, at: string) =>
      prisma.prScore.create({ data: { pull_request_id: pr, score: value, level: 'x', reasons: [], features: {}, head_sha: head, created_at: new Date(at) } });
    await score(p1.id, 100, sha('old-head'), '2026-09-02T00:00:00Z'); // newer but for an old head
    await score(p1.id, 40, sha('p1'), '2026-09-01T00:00:00Z'); // current head → used
    await score(p2.id, 80, sha('p2'), '2026-09-01T00:00:00Z');

    const stats = await get('/api/stats');
    expect(stats).toMatchObject({ total_prs: 3, scored_prs: 2, unscored_prs: 1, average_score: 60, counts_by_level: { low: 0, medium: 1, high: 1 } });
    expect(stats.top_risky_folders).toEqual([
      { folder: 'src/auth', pr_count: 2, average_score: 60, level: 'medium' },
      { folder: 'prisma', pr_count: 1, average_score: 40, level: 'medium' },
    ]);
  });
});

describe('demo data', () => {
  it('is deterministic and idempotent, with separate demo identities', async () => {
    const first = await seedDemoData(prisma);
    const second = await seedDemoData(prisma);
    expect(first).toEqual({ repositories: 3, pull_requests: 11, new_scores: 11 });
    expect(second).toEqual({ repositories: 3, pull_requests: 11, new_scores: 0 });
    expect(DEMO_SCENARIOS).toHaveLength(11);
    expect(await prisma.prScore.count()).toBe(11);
    expect(await prisma.analysisRun.count()).toBe(11);
    const repos = await prisma.repo.findMany();
    expect(repos.every((r) => r.is_demo && r.github_repo_id < 0n)).toBe(true);
    const prs = await prisma.pullRequest.findMany();
    expect(prs.every((p) => p.github_id === null && p.github_pr_id === null)).toBe(true);
  });

  it('produces the documented metrics under scoring contract v2', async () => {
    await seedDemoData(prisma);
    const list = await get('/api/prs?limit=100');
    const byTitle = Object.fromEntries(
      list.data.map((p: { title: string; latest_score: { score: number; level: string; ci_status: string } }) => [p.title, [p.latest_score.score, p.latest_score.level, p.latest_score.ci_status]]),
    );
    expect(byTitle).toEqual({
      'Add unit tests for user service': [0, 'low', 'success'],
      'Fix typo in README': [20, 'low', 'success'],
      'Update dependencies': [20, 'low', 'pending'],
      'Add loading spinner component': [0, 'low', 'success'],
      'Refactor authentication middleware': [40, 'medium', 'success'],
      'Add payment processing endpoint': [40, 'medium', 'failure'],
      'Update CI/CD configuration': [60, 'medium', 'success'],
      'Migrate database schema': [60, 'medium', 'unknown'],
      'Add feature flags system': [20, 'low', 'success'],
      'Major refactor: Rewrite authentication system': [100, 'high', 'success'],
      'Implement payment gateway integration': [100, 'high', 'pending'],
    });
    const stats = await get('/api/stats');
    expect(stats).toMatchObject({
      total_prs: 11,
      scored_prs: 11,
      average_score: 41.82,
      counts_by_level: { low: 5, medium: 4, high: 2 },
    });
    expect(stats.top_risky_folders.map((f: { folder: string; pr_count: number; average_score: number }) => [f.folder, f.pr_count, f.average_score])).toEqual([
      ['src/auth', 1, 100],
      ['src/payments', 1, 100],
      ['src/config', 4, 65],
      ['.github/workflows', 1, 60],
      ['prisma', 1, 60],
      ['prisma/migrations', 1, 60],
      ['src/lib', 1, 60],
      ['src/models', 1, 60],
      ['src/services', 5, 52],
      ['src/types', 2, 40],
    ]);
  });

  it('seeds through the authenticated, CSRF-protected endpoint and shows the fixture AI analysis', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/demo/seed',
      headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, prs_created: 11 });
    const pr = await prisma.pullRequest.findFirstOrThrow({ where: { title: 'Refactor authentication middleware' } });
    const detail = await get(`/api/prs/${pr.id}`);
    expect(detail.ai).toMatchObject({ status: 'succeeded', analyzed_sha: pr.head_sha });
    expect(detail.ai.current.model).toBe('demo-fixture');
  });
});

describe('pagination', () => {
  it('pages with stable ordering, accurate totals and no overlap', async () => {
    await seedDemoData(prisma);
    await prisma.pullRequest.updateMany({ data: { updated_at: new Date('2026-09-01T00:00:00Z') } }); // force ties
    const pages = [await get('/api/prs?limit=4&offset=0'), await get('/api/prs?limit=4&offset=4'), await get('/api/prs?limit=4&offset=8')];
    const idsSeen = pages.flatMap((p) => p.data.map((d: { id: string }) => d.id));
    expect(new Set(idsSeen).size).toBe(11);
    expect(pages.map((p) => p.pagination)).toEqual([
      { limit: 4, offset: 0, total: 11, has_more: true },
      { limit: 4, offset: 4, total: 11, has_more: true },
      { limit: 4, offset: 8, total: 11, has_more: false },
    ]);
    expect(idsSeen).toEqual([...idsSeen].sort().reverse()); // id tie-breaker, descending
    expect((await get('/api/prs?limit=4&offset=0')).data.map((d: { id: string }) => d.id)).toEqual(pages[0].data.map((d: { id: string }) => d.id));
  });

  it('exposes number, the deprecated github_pr_id alias, and genuine timestamps', async () => {
    await seedDemoData(prisma);
    const item = (await get('/api/prs?limit=1')).data[0];
    expect(item.github_pr_id).toBe(item.number);
    expect(item.github_updated_at).toMatch(/^2026-01-/);
    expect(item.updated_at).not.toBe(item.github_updated_at);
  });
});
