import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createTestPrisma, truncateAll } from '../helpers/db.js';
import { liveGithubEnv, testConfig } from '../helpers/config.js';
import { buildTestApp, login, sendWebhook, silentLogger, type TestApp } from '../helpers/app.js';
import { MockGitHub, pullRequestPayload, sha, type MockFile, type MockPr } from '../helpers/mock-github.js';
import { completion, MockOpenAI } from '../helpers/mock-openai.js';
import { TEST_REDIS_URL } from '../helpers/env.js';
import { createDeliveryProcessor } from '../../src/jobs/runtime.js';
import { GitHubClientFactory } from '../../src/github/client.js';
import { COMMENT_MARKER } from '../../src/config/constants.js';
import type { AppConfig } from '../../src/config/env.js';

const gh = new MockGitHub(4242);
const ai = new MockOpenAI();
const INST = 101;
const OTHER_INST = 202;
const REPO_A = { id: 9001, full_name: 'acme/app', private: true };
const REPO_B = { id: 9002, full_name: 'acme/lib', private: false };
const REPO_X = { id: 9003, full_name: 'other/secret', private: true };

let prisma: PrismaClient;
const redis = new Redis(TEST_REDIS_URL);

function configFor(overrides: Record<string, string> = {}): AppConfig {
  return testConfig({
    ...liveGithubEnv({ apiUrl: gh.url, privateKey: gh.privateKeyPem, appId: gh.appId, installations: [INST, OTHER_INST] }),
    AI_ENABLED: 'true',
    OPENAI_API_KEY: 'test-key-not-real',
    OPENAI_BASE_URL: ai.url,
    AI_TIMEOUT_MS: '2000',
    ...overrides,
  });
}

interface Harness {
  t: TestApp;
  process: (deliveryId: string) => ReturnType<ReturnType<typeof createDeliveryProcessor>>;
  deliver: (event: string, payload: unknown, deliveryId?: string) => Promise<string>;
}

async function harness(overrides: Record<string, string> = {}): Promise<Harness> {
  const config = configFor(overrides);
  const t = await buildTestApp(config, prisma);
  const process = createDeliveryProcessor({ config, prisma, logger: silentLogger, workerId: 'test-worker' });
  const deliver = async (event: string, payload: unknown, deliveryId: string = crypto.randomUUID()) => {
    const res = await sendWebhook(t.app, event, payload, { deliveryId });
    if (res.statusCode !== 202 && res.statusCode !== 200) throw new Error(`webhook ${res.statusCode}: ${res.body}`);
    return deliveryId;
  };
  return { t, process, deliver };
}

const iso = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();

function mockPr(number: number, head: string, files: MockFile[], extra: Partial<MockPr> = {}): MockPr {
  return {
    id: 700000 + number,
    number,
    title: `PR ${number}`,
    state: 'open',
    created_at: iso(0),
    updated_at: iso(1),
    author: 'dev',
    head_sha: head,
    head_ref: `feature/${number}`,
    base_ref: 'main',
    files,
    ...extra,
  };
}

const smallFiles = (tag: string): MockFile[] => [
  { filename: 'src/auth/session.ts', additions: 40, deletions: 5, patch: `@@ -1 +1 @@\n+// ${tag} session change` },
  { filename: 'src/util.ts', additions: 3, deletions: 1 },
];

beforeAll(async () => {
  prisma = createTestPrisma();
  await gh.start();
  await ai.start();
});

afterAll(async () => {
  await gh.stop();
  await ai.stop();
  await prisma.$disconnect();
  redis.disconnect();
});

let h: Harness;
beforeEach(async () => {
  await truncateAll(prisma);
  await redis.flushdb();
  gh.reset();
  ai.reset();
  gh.addRepo(REPO_A.full_name, { id: REPO_A.id, installationId: INST });
  gh.addRepo(REPO_B.full_name, { id: REPO_B.id, installationId: INST, private: false });
  gh.addRepo(REPO_X.full_name, { id: REPO_X.id, installationId: 999 });
});

async function withHarness(overrides: Record<string, string>, fn: () => Promise<void>) {
  h = await harness(overrides);
  try {
    await fn();
  } finally {
    await h.t.close();
  }
}

const prEvent = (action: string, repo: typeof REPO_A, number: number, head: string, installation = INST, extra = {}) =>
  pullRequestPayload(action, repo, { id: 700000 + number, number, head_sha: head }, installation, extra);

describe('analysis pipeline', () => {
  it('lists files beyond the first API page and uses them for scoring and AI selection', async () => {
    await withHarness({}, async () => {
      const head = sha('big');
      const files: MockFile[] = Array.from({ length: 250 }, (_, i) => ({ filename: `src/mod/file${i}.ts`, additions: 1, deletions: 0 }));
      files[180] = { filename: 'src/payments/charge.ts', additions: 30, deletions: 2, patch: '@@ -1 +1 @@\n+charge()' };
      gh.setPr(REPO_A.full_name, mockPr(1, head, files));
      gh.setChecks(REPO_A.full_name, head, [{ status: 'completed', conclusion: 'success' }]);

      const result = await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 1, head)));
      expect(result.outcome).toBe('succeeded');
      expect(gh.count('GET', /\/pulls\/1\/files$/)).toBe(3); // 100 + 100 + 50

      const pr = await prisma.pullRequest.findFirstOrThrow({ include: { scores: true, ai_analyses: true, analysis_runs: true } });
      expect((pr.changed_files_list as string[]).length).toBe(250);
      expect(pr.scores).toHaveLength(1);
      const score = pr.scores[0];
      expect(score).toMatchObject({ head_sha: head, scoring_version: 'v2', ci_status: 'success' });
      // +40 files (>50), +20 payments, +20 no tests; CI success adds nothing.
      expect(score.score).toBe(80);
      expect((score.features as { critical_paths_touched: string[] }).critical_paths_touched).toEqual(['Payments']);
      expect(pr.analysis_runs[0]).toMatchObject({ ai_status: 'succeeded', comment_status: 'disabled' });
      expect(ai.calls).toHaveLength(1);
      expect(ai.calls[0].messages[1].content).toContain('src/payments/charge.ts');
      expect((pr.ai_analyses[0].limitations as { selected_files: string[] }).selected_files[0]).toBe('src/payments/charge.ts');
      expect(await prisma.repo.findFirstOrThrow()).toMatchObject({ private: true, visibility: 'private' });
    });
  });

  it('reports an incomplete file list instead of implying complete analysis', async () => {
    await withHarness({}, async () => {
      const head = sha('huge');
      const files = Array.from({ length: 3000 }, (_, i) => ({ filename: `pkg/f${i}.go`, additions: 1, deletions: 0, patch: null }));
      gh.setPr(REPO_A.full_name, mockPr(2, head, files, { changed_files_override: 3500 }));
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 2, head)));
      const score = await prisma.prScore.findFirstOrThrow();
      const coverage = score.coverage as { complete: boolean; listed_files: number; expected_files: number; uncertainties: string[]; files_without_patch: number };
      expect(coverage).toMatchObject({ complete: false, listed_files: 3000, expected_files: 3500, files_without_patch: 3000 });
      expect(coverage.uncertainties.join(' ')).toMatch(/Only 3000 of 3500/);
      const cookie = await login(h.t.app);
      const detail = (await h.t.app.inject({ url: `/api/prs/${score.pull_request_id}`, headers: { cookie } })).json();
      expect(detail.latest_score.coverage.complete).toBe(false);
    });
  });

  it('keeps two repositories with the same PR number separate', async () => {
    await withHarness({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }, async () => {
      gh.setPr(REPO_A.full_name, mockPr(5, sha('a5'), smallFiles('a'), { title: 'A five' }));
      gh.setPr(REPO_B.full_name, mockPr(5, sha('b5'), [{ filename: 'README.md', additions: 1, deletions: 0 }], { id: 800005, title: 'B five' }));
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 5, sha('a5'))));
      await h.process(await h.deliver('pull_request', { ...prEvent('opened', REPO_B, 5, sha('b5')), pull_request: { id: 800005, number: 5, head: { sha: sha('b5') }, base: { ref: 'main' } } }));
      const prs = await prisma.pullRequest.findMany({ include: { repo: true, scores: true }, orderBy: { title: 'asc' } });
      expect(prs.map((p) => [p.repo.full_name, p.number, p.title, p.scores.length])).toEqual([
        ['acme/app', 5, 'A five', 1],
        ['acme/lib', 5, 'B five', 1],
      ]);
      expect(prs.map((p) => p.github_id?.toString())).toEqual(['700005', '800005']);
      expect(prs[1].scores[0].head_sha).toBe(sha('b5'));
    });
  });

  it('does not duplicate scores, AI results or comments on replay or repeated events', async () => {
    await withHarness({ GITHUB_POST_COMMENTS: 'true' }, async () => {
      const head = sha('r1');
      gh.setPr(REPO_A.full_name, mockPr(3, head, smallFiles('r')));
      const d1 = await h.deliver('pull_request', prEvent('opened', REPO_A, 3, head));
      await h.process(d1);
      // Same delivery processed again (e.g. duplicate job) is skipped.
      expect((await h.process(d1)).outcome).toBe('skipped');
      // A different delivery with identical inputs is a no-op analysis.
      await h.process(await h.deliver('pull_request', prEvent('synchronize', REPO_A, 3, head)));
      // Replaying a failed delivery reprocesses without duplicating.
      await prisma.webhookDelivery.update({ where: { id: d1 }, data: { status: 'failed' } });
      await h.process(d1);

      expect(await prisma.analysisRun.count()).toBe(1);
      expect(await prisma.prScore.count()).toBe(1);
      expect(await prisma.prAiAnalysis.count()).toBe(1);
      expect(ai.calls).toHaveLength(1);
      expect(gh.comments(REPO_A.full_name, 3)).toHaveLength(1);
      expect(gh.count('POST', /\/issues\/3\/comments$/)).toBe(1);
    });
  });

  it('adds history when CI changes on the same SHA and when a new head arrives; old results never look current', async () => {
    await withHarness({}, async () => {
      const head1 = sha('h1');
      gh.setPr(REPO_A.full_name, mockPr(4, head1, smallFiles('one')));
      gh.setChecks(REPO_A.full_name, head1, [{ status: 'in_progress', conclusion: null }]);
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 4, head1)));

      gh.setChecks(REPO_A.full_name, head1, [{ status: 'completed', conclusion: 'failure' }]);
      const suite = await h.deliver('check_suite', {
        action: 'completed',
        check_suite: { head_sha: head1, conclusion: 'failure', app: { id: 1 } },
        repository: { id: REPO_A.id, name: 'app', full_name: REPO_A.full_name, owner: { login: 'acme' }, private: true },
        installation: { id: INST },
      });
      expect((await h.process(suite)).outcome).toBe('succeeded');

      let scores = await prisma.prScore.findMany({ orderBy: { created_at: 'asc' } });
      expect(scores.map((s) => [s.ci_status, s.score])).toEqual([
        ['pending', 40],
        ['failure', 60],
      ]);

      const head2 = sha('h2');
      gh.setPr(REPO_A.full_name, mockPr(4, head2, smallFiles('two'), { updated_at: iso(5) }));
      gh.setChecks(REPO_A.full_name, head2, [{ status: 'completed', conclusion: 'success' }]);
      await h.process(await h.deliver('pull_request', prEvent('synchronize', REPO_A, 4, head2)));

      // An out-of-order older event and CI for the obsolete head change nothing.
      await h.process(await h.deliver('pull_request', prEvent('synchronize', REPO_A, 4, head1)));
      const obsolete = await h.process(
        await h.deliver('status', {
          sha: head1,
          state: 'success',
          context: 'ci/legacy',
          repository: { id: REPO_A.id, name: 'app', full_name: REPO_A.full_name, owner: { login: 'acme' }, private: true },
          installation: { id: INST },
        }),
      );
      expect(obsolete.outcome).toBe('ignored');

      scores = await prisma.prScore.findMany({ orderBy: { created_at: 'asc' } });
      expect(scores.map((s) => s.head_sha)).toEqual([head1, head1, head2]);
      const pr = await prisma.pullRequest.findFirstOrThrow();
      expect(pr.head_sha).toBe(head2);

      const cookie = await login(h.t.app);
      const detail = (await h.t.app.inject({ url: `/api/prs/${pr.id}`, headers: { cookie } })).json();
      expect(detail.latest_score).toMatchObject({ head_sha: head2, revision_status: 'current', ci_status: 'success' });
      expect(detail.ai.current.head_sha).toBe(head2);
      expect(detail.score_history.map((s: { revision_status: string }) => s.revision_status)).toEqual(['current', 'previous_head', 'previous_head']);
    });
  });

  it('rebuilds the snapshot when the head moves during fetching', async () => {
    await withHarness({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }, async () => {
      const [h1, h2] = [sha('m1'), sha('m2')];
      gh.setPr(REPO_A.full_name, mockPr(6, h1, smallFiles('m')));
      gh.beforePullGet = (_repo, _n, call) => {
        if (call === 1) gh.setPr(REPO_A.full_name, mockPr(6, h2, smallFiles('m2'), { updated_at: iso(9) }));
      };
      await h.process(await h.deliver('pull_request', prEvent('synchronize', REPO_A, 6, h1)));
      const runs = await prisma.analysisRun.findMany();
      expect(runs).toHaveLength(1);
      expect(runs[0].head_sha).toBe(h2);
    });
  });

  it('keeps the deterministic score when AI is unavailable or returns invalid output, and never comments stale analysis', async () => {
    await withHarness({ GITHUB_POST_COMMENTS: 'true' }, async () => {
      ai.responder = () => ({ status: 503, body: { error: { message: 'overloaded' } } });
      gh.setPr(REPO_A.full_name, mockPr(7, sha('ai1'), smallFiles('x')));
      const res = await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 7, sha('ai1'))));
      expect(res.outcome).toBe('succeeded');
      const run = await prisma.analysisRun.findFirstOrThrow();
      expect(run).toMatchObject({ ai_status: 'unavailable', comment_status: 'skipped' });
      expect(run.ai_error).toMatch(/AI provider error \(503\)/);
      expect(await prisma.prScore.count()).toBe(1);
      expect(gh.comments(REPO_A.full_name, 7)).toHaveLength(0);

      // A new head whose AI output is invalid: still no comment from the older analysis.
      ai.responder = () => ({ status: 200, body: completion('{"summary": "too short"}') });
      gh.setPr(REPO_A.full_name, mockPr(7, sha('ai2'), smallFiles('y'), { updated_at: iso(3) }));
      await h.process(await h.deliver('pull_request', prEvent('synchronize', REPO_A, 7, sha('ai2'))));
      const latest = await prisma.analysisRun.findFirstOrThrow({ where: { head_sha: sha('ai2') } });
      expect(latest).toMatchObject({ ai_status: 'failed', comment_status: 'skipped' });
      expect(gh.comments(REPO_A.full_name, 7)).toHaveLength(0);

      const cookie = await login(h.t.app);
      const detail = (await h.t.app.inject({ url: `/api/prs/${latest.pull_request_id}`, headers: { cookie } })).json();
      expect(detail.latest_score.score).toBe(40);
      expect(detail.ai).toMatchObject({ status: 'failed', current: null });
    });
  });

  it('refreshes metadata on close/merge without re-running analysis or AI', async () => {
    await withHarness({}, async () => {
      const head = sha('c1');
      gh.setPr(REPO_A.full_name, mockPr(8, head, smallFiles('c')));
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 8, head)));
      gh.setPr(REPO_A.full_name, mockPr(8, head, smallFiles('c'), { state: 'closed', merged_at: iso(30), closed_at: iso(30), updated_at: iso(30) }));
      await h.process(await h.deliver('pull_request', prEvent('closed', REPO_A, 8, head)));
      const pr = await prisma.pullRequest.findFirstOrThrow();
      expect(pr).toMatchObject({ state: 'closed', merged_at: new Date(iso(30)), closed_at: new Date(iso(30)) });
      expect(await prisma.analysisRun.count()).toBe(1);
      expect(ai.calls).toHaveLength(1);
      expect(gh.count('GET', /\/files$/)).toBe(1);
    });
  });

  it('maintains exactly one app comment: create, update, recreate after deletion, recover after a crash, never touch user comments', async () => {
    await withHarness({ GITHUB_POST_COMMENTS: 'true' }, async () => {
      const user = gh.addUserComment(REPO_A.full_name, 9, `I pasted ${COMMENT_MARKER} here`);
      gh.setPr(REPO_A.full_name, mockPr(9, sha('k1'), smallFiles('k1')));
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 9, sha('k1'))));
      let comments = gh.comments(REPO_A.full_name, 9);
      expect(comments).toHaveLength(2);
      const ours = comments.find((c) => c.app_id === gh.appId)!;
      expect(ours.body).toContain(COMMENT_MARKER);
      expect(ours.body).toContain(sha('k1').slice(0, 12));
      expect(user.body).toBe(`I pasted ${COMMENT_MARKER} here`);

      // New head → the same comment is updated in place.
      gh.setPr(REPO_A.full_name, mockPr(9, sha('k2'), smallFiles('k2'), { updated_at: iso(2) }));
      await h.process(await h.deliver('pull_request', prEvent('synchronize', REPO_A, 9, sha('k2'))));
      comments = gh.comments(REPO_A.full_name, 9);
      expect(comments.filter((c) => c.app_id === gh.appId)).toHaveLength(1);
      expect(comments.find((c) => c.id === ours.id)!.body).toContain(sha('k2').slice(0, 12));

      // Deleted by a user → recreated once.
      comments.splice(comments.findIndex((c) => c.id === ours.id), 1);
      gh.setPr(REPO_A.full_name, mockPr(9, sha('k3'), smallFiles('k3'), { updated_at: iso(3) }));
      await h.process(await h.deliver('pull_request', prEvent('synchronize', REPO_A, 9, sha('k3'))));
      expect(gh.comments(REPO_A.full_name, 9).filter((c) => c.app_id === gh.appId)).toHaveLength(1);

      // GitHub accepts the create but the response is lost → failed; the retry reconciles instead of duplicating.
      gh.comments(REPO_A.full_name, 9).splice(0);
      gh.failAfterCreateComment = true;
      gh.setPr(REPO_A.full_name, mockPr(9, sha('k4'), smallFiles('k4'), { updated_at: iso(4) }));
      const d = await h.deliver('pull_request', prEvent('synchronize', REPO_A, 9, sha('k4')));
      await h.process(d);
      expect((await prisma.analysisRun.findFirstOrThrow({ where: { head_sha: sha('k4') } })).comment_status).toBe('failed');
      await prisma.webhookDelivery.update({ where: { id: d }, data: { status: 'failed' } });
      await h.process(d);
      const run = await prisma.analysisRun.findFirstOrThrow({ where: { head_sha: sha('k4') } });
      expect(run.comment_status).toBe('succeeded');
      expect(gh.comments(REPO_A.full_name, 9).filter((c) => c.app_id === gh.appId)).toHaveLength(1);
      expect(ai.calls).toHaveLength(4); // one per head; the comment retry reused the stored analysis
    });
  });

  it('does not publish when the head changed after analysis', async () => {
    await withHarness({ GITHUB_POST_COMMENTS: 'true' }, async () => {
      gh.setPr(REPO_A.full_name, mockPr(10, sha('s1'), smallFiles('s')));
      ai.responder = () => {
        // The PR moves to a new head while the model is "thinking".
        gh.setPr(REPO_A.full_name, mockPr(10, sha('s2'), smallFiles('s2'), { updated_at: iso(7) }));
        return { status: 200, body: completion(JSON.stringify({ summary: 'Mocked analysis of the older head revision.', review_focus: ['a item', 'b item', 'c item'], test_suggestions: ['a test', 'b test', 'c test'], rollback_risk: 'LOW', confidence: 0.5 })) };
      };
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 10, sha('s1'))));
      expect((await prisma.analysisRun.findFirstOrThrow()).comment_status).toBe('superseded');
      expect(gh.comments(REPO_A.full_name, 10)).toHaveLength(0);
    });
  });

  it('reports missing Checks permission as unknown CI and still scores', async () => {
    await withHarness({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }, async () => {
      gh.setPr(REPO_A.full_name, mockPr(11, sha('p1'), smallFiles('p')));
      gh.failNext('GET', /check-runs$/, 403, { body: { message: 'Resource not accessible by integration' } });
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 11, sha('p1'))));
      const score = await prisma.prScore.findFirstOrThrow();
      expect(score.ci_status).toBe('unknown');
      expect((score.coverage as { uncertainties: string[] }).uncertainties.join(' ')).toMatch(/permission/);
    });
  });

  it('schedules a durable retry at the GitHub rate-limit reset instead of spinning', async () => {
    await withHarness({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }, async () => {
      gh.setPr(REPO_A.full_name, mockPr(12, sha('rl'), smallFiles('rl')));
      const reset = Math.floor(Date.now() / 1000) + 900;
      gh.failNext('GET', /\/pulls\/12$/, 403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, body: { message: 'API rate limit exceeded' } });
      const d = await h.deliver('pull_request', prEvent('opened', REPO_A, 12, sha('rl')));
      const result = await h.process(d);
      expect(result.outcome).toBe('failed');
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d } });
      expect(row.next_attempt_at?.getTime()).toBe(reset * 1000);
      expect(gh.count('GET', /\/pulls\/12$/)).toBe(1);
    });
  });

  it('isolates installations: a token for one installation cannot read another installation’s repository', async () => {
    await withHarness({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }, async () => {
      // REPO_X belongs to installation 999, but the event claims installation 202 (allowed by config).
      gh.addRepo('other/decoy', { id: 1, installationId: OTHER_INST });
      gh.setPr(REPO_X.full_name, mockPr(1, sha('x'), smallFiles('x')));
      const d = await h.deliver('pull_request', prEvent('opened', REPO_X, 1, sha('x'), OTHER_INST));
      const result = await h.process(d);
      expect(result.outcome).toBe('dead');
      expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d } })).last_error).toMatch(/404/);
      expect(await prisma.pullRequest.count()).toBe(0);
      expect(gh.tokenRequests.get(OTHER_INST)).toBe(1);
      expect(gh.tokenRequests.get(999)).toBeUndefined();
    });
  });

  it('reuses installation tokens and requests a new one when the cached token expires', async () => {
    await withHarness({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }, async () => {
      gh.setPr(REPO_A.full_name, mockPr(13, sha('t1'), smallFiles('t')));
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 13, sha('t1'))));
      expect(gh.tokenRequests.get(INST)).toBe(1); // many API calls, one installation token

      // @octokit/auth-app caches installation tokens for 59 minutes (GitHub issues 60-minute tokens).
      const factory = new GitHubClientFactory({ appId: String(gh.appId), privateKey: gh.privateKeyPem.replace(/\n/g, '\\n'), apiUrl: gh.url });
      const octokit = factory.forInstallation(INST);
      expect(factory.forInstallation(INST)).toBe(octokit); // client reuse per installation
      await octokit.rest.pulls.get({ owner: 'acme', repo: 'app', pull_number: 13 });
      await octokit.rest.pulls.get({ owner: 'acme', repo: 'app', pull_number: 13 });
      expect(gh.tokenRequests.get(INST)).toBe(2);

      // Advance both clocks by 61 minutes: Date (JWT iat/exp, token expiry) and
      // performance.now (lru-cache TTL used by @octokit/auth-app).
      const skew = 61 * 60_000;
      const realPerfNow = performance.now.bind(performance);
      vi.useFakeTimers({ toFake: ['Date'] });
      const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => realPerfNow() + skew);
      try {
        vi.setSystemTime(Date.now() + skew);
        await new Promise((resolve) => setTimeout(resolve, 5)); // let lru-cache drop its cached clock reading
        await octokit.rest.pulls.get({ owner: 'acme', repo: 'app', pull_number: 13 });
        expect(gh.tokenRequests.get(INST)).toBe(3);
      } finally {
        perfSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it('stops serving and processing repositories whose access was removed', async () => {
    await withHarness({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }, async () => {
      gh.setPr(REPO_A.full_name, mockPr(14, sha('v'), smallFiles('v')));
      await h.process(await h.deliver('pull_request', prEvent('opened', REPO_A, 14, sha('v'))));
      const cookie = await login(h.t.app);
      expect((await h.t.app.inject({ url: '/api/prs', headers: { cookie } })).json().pagination.total).toBe(1);

      const removal = await h.deliver('installation_repositories', {
        action: 'removed',
        installation: { id: INST },
        repositories_added: [],
        repositories_removed: [{ id: REPO_A.id, full_name: REPO_A.full_name }],
      });
      expect((await h.process(removal)).outcome).toBe('succeeded');
      expect((await prisma.repo.findFirstOrThrow({ where: { github_repo_id: BigInt(REPO_A.id) } })).access_status).toBe('revoked');
      expect((await h.t.app.inject({ url: '/api/prs', headers: { cookie } })).json().pagination.total).toBe(0);

      // CI for the revoked repository is not processed.
      const ci = await h.deliver('status', {
        sha: sha('v'),
        state: 'failure',
        repository: { id: REPO_A.id, name: 'app', full_name: REPO_A.full_name, owner: { login: 'acme' }, private: true },
        installation: { id: INST },
      });
      expect((await h.process(ci)).outcome).toBe('ignored');

      await h.process(await h.deliver('installation', { action: 'deleted', installation: { id: INST } }));
      expect(await prisma.repo.count({ where: { access_status: 'active', is_demo: false } })).toBe(0);
    });
  });

  it('serialises concurrent work on one PR across processors without duplicates or lost attempts', async () => {
    await withHarness({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }, async () => {
      gh.setPr(REPO_A.full_name, mockPr(15, sha('cc'), smallFiles('cc')));
      const d1 = await h.deliver('pull_request', prEvent('opened', REPO_A, 15, sha('cc')));
      const d2 = await h.deliver('pull_request', prEvent('synchronize', REPO_A, 15, sha('cc')));
      const other = createDeliveryProcessor({ config: configFor({ AI_ENABLED: 'false', OPENAI_API_KEY: '' }), prisma, logger: silentLogger, workerId: 'second-process' });
      const results = await Promise.all([h.process(d1), other(d2)]);
      const outcomes = results.map((r) => r.outcome).sort();
      expect(outcomes.every((o) => o === 'succeeded' || o === 'failed')).toBe(true);
      for (const [i, r] of results.entries()) {
        if (r.outcome === 'failed') {
          const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: [d1, d2][i] } });
          expect(row.last_error).toMatch(/being processed by another job/);
          expect(row.attempts).toBe(0); // contention does not consume an attempt
          await prisma.webhookDelivery.update({ where: { id: row.id }, data: { next_attempt_at: new Date(0) } });
          await h.process(row.id);
        }
      }
      expect(await prisma.analysisRun.count()).toBe(1);
      expect(await prisma.prScore.count()).toBe(1);
      expect(await prisma.processingLease.count()).toBe(0);
    });
  });
});
