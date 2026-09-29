import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PrismaClient } from '@prisma/client';
import { createTestPrisma } from '../helpers/db.js';
import { TEST_DATABASE_URL } from '../helpers/env.js';
import { testConfig } from '../helpers/config.js';
import { buildTestApp, login } from '../helpers/app.js';
import { upsertRepoAndPullRequest } from '../../src/analysis/analyze.js';

/**
 * Upgrade path from the original schema (migrations 1–3, commit 6a7680b) to the
 * current one, using `prisma migrate deploy` exactly as an operator would.
 */

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = join(backendDir, 'prisma/migrations');
const ORIGINAL = ['20240101000000_init', '20240102000000_add_pr_fields', '20240103000000_add_ai_analysis'];

const url = new URL(TEST_DATABASE_URL);
const DB = 'pr_risk_scorer_upgrade_test';
const upgradeUrl = Object.assign(new URL(url.toString()), { pathname: `/${DB}` }).toString();
const adminUrl = Object.assign(new URL(url.toString()), { pathname: '/postgres' }).toString();

let workDir: string;
let prisma: PrismaClient;
const ids = {
  repoA: '11111111-1111-4111-8111-111111111111',
  repoB: '22222222-2222-4222-8222-222222222222',
  prCollided: '33333333-3333-4333-8333-333333333333',
  prB: '44444444-4444-4444-8444-444444444444',
  prInvalid: '55555555-5555-4555-8555-555555555555',
  scoreObj: '66666666-6666-4666-8666-666666666666',
  scoreStr: '77777777-7777-4777-8777-777777777777',
  ai: '88888888-8888-4888-8888-888888888888',
};

function deploy(migrationNames: string[]) {
  const dir = join(workDir, 'prisma');
  rmSync(join(dir, 'migrations'), { recursive: true, force: true });
  for (const name of migrationNames) cpSync(join(migrationsDir, name), join(dir, 'migrations', name), { recursive: true });
  cpSync(join(migrationsDir, 'migration_lock.toml'), join(dir, 'migrations', 'migration_lock.toml'));
  return execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: upgradeUrl },
    encoding: 'utf8',
  });
}

async function sql(connectionString: string, text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await sql(adminUrl, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await sql(adminUrl, `CREATE DATABASE ${DB}`);
  workDir = mkdtempSync(join(tmpdir(), 'prs-migration-'));
  cpSync(join(backendDir, 'prisma/schema.prisma'), join(workDir, 'prisma/schema.prisma'));

  // 1. The original schema.
  deploy(ORIGINAL);

  // 2. Data as the original code wrote it, including a cross-repository collision:
  //    repo B's PR #5 overwrote repo A's PR #5 row (same github_pr_id = 5).
  await sql(
    upgradeUrl,
    `INSERT INTO repos (id, github_repo_id, full_name, owner, name, installation_id, private, updated_at) VALUES
       ($1, 1001, 'org/a', 'org', 'a', 10, false, NOW()),
       ($2, 1002, 'org/b', 'org', 'b', 10, false, NOW());
     INSERT INTO pull_requests (id, repo_id, github_pr_id, title, state, author, head_sha, base_ref, head_ref, updated_at,
                                additions, deletions, changed_files, changed_files_list) VALUES
       ($3, $1, 5, 'Overwritten by org/b #5', 'open', 'bob', 'aaaa', 'main', 'x', NOW(), 10, 2, 2, '["src/auth/login.ts","prisma/schema.prisma"]'),
       ($4, $2, 7, 'B seven', 'open', 'bob', 'bbbb', 'main', 'y', NOW(), 1, 1, 1, '["README.md"]'),
       ($5, $1, 3000000000, 'Impossible number', 'closed', 'eve', 'cccc', 'main', 'z', NOW(), NULL, NULL, NULL, NULL);
     INSERT INTO pr_scores (id, pull_request_id, score, level, reasons, features, updated_at) VALUES
       ($6, $3, 45.5, 'medium', '[{"type":"large_pr","message":"PR has 50+ changed files","severity":"medium"}]', '{"files_changed":52}', NOW()),
       ($7, $3, 60, 'medium', '["No test files changed","CI status: unknown"]', '{"files_changed":2}', NOW());
     INSERT INTO pr_ai_analyses (id, pull_request_id, analysis_json, model, prompt_version, updated_at) VALUES
       ($8, $3, '{"summary":"legacy analysis text"}', 'gpt-4o-mini', 'v1', NOW());`.replace(/\$(\d)/g, (_m, n) => `'${Object.values(ids)[Number(n) - 1]}'`),
  );

  // 3. Upgrade.
  deploy(readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort());
  prisma = createTestPrisma(upgradeUrl);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
  await sql(adminUrl, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
});

describe('upgrade from the original schema', () => {
  it('ends with no drift between the migrated database and the Prisma schema', () => {
    const out = execFileSync(
      'pnpm',
      ['exec', 'prisma', 'migrate', 'diff', '--from-url', upgradeUrl, '--to-schema-datamodel', join(backendDir, 'prisma/schema.prisma'), '--exit-code'],
      { cwd: backendDir, encoding: 'utf8' },
    );
    expect(out).toMatch(/No difference detected/);
  });

  it('preserves every row, UUID and relationship', async () => {
    expect((await prisma.repo.findMany({ orderBy: { github_repo_id: 'asc' } })).map((r) => r.id)).toEqual([ids.repoA, ids.repoB]);
    const prs = await prisma.pullRequest.findMany({ include: { scores: true, ai_analyses: true } });
    expect(prs.map((p) => p.id).sort()).toEqual([ids.prCollided, ids.prB, ids.prInvalid].sort());
    const collided = prs.find((p) => p.id === ids.prCollided)!;
    expect(collided.scores.map((s) => s.id).sort()).toEqual([ids.scoreObj, ids.scoreStr].sort());
    expect(collided.ai_analyses.map((a) => a.id)).toEqual([ids.ai]);
    expect(collided.title).toBe('Overwritten by org/b #5'); // history is not rewritten or guessed
  });

  it('backfills PR numbers and marks legacy identity explicitly', async () => {
    const byId = new Map((await prisma.pullRequest.findMany()).map((p) => [p.id, p]));
    expect(byId.get(ids.prCollided)).toMatchObject({ number: 5, github_pr_id: 5n, github_id: null, identity_status: 'legacy_unverified' });
    expect(byId.get(ids.prB)).toMatchObject({ number: 7, identity_status: 'legacy_unverified' });
    expect(byId.get(ids.prInvalid)).toMatchObject({ number: null, github_pr_id: 3000000000n, identity_status: 'legacy_invalid_number' });
  });

  it('marks existing scores and analyses as legacy with unknown revision', async () => {
    const scores = await prisma.prScore.findMany();
    expect(scores.every((s) => s.scoring_version === 'legacy' && s.head_sha === null && s.run_id === null)).toBe(true);
    const ai = await prisma.prAiAnalysis.findFirstOrThrow();
    expect(ai).toMatchObject({ head_sha: null, run_id: null, prompt_version: 'v1' });
  });

  it('enforces the new identity: (repo, number) unique, legacy column no longer unique', async () => {
    await expect(
      prisma.pullRequest.create({ data: { repo_id: ids.repoA, number: 5, title: 'dup', state: 'open', author: 'x', head_sha: 'd', base_ref: 'm', head_ref: 'h' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const sameNumberOtherRepo = await prisma.pullRequest.create({
      data: { repo_id: ids.repoB, number: 5, github_pr_id: 5n, title: 'B five', state: 'open', author: 'x', head_sha: 'e', base_ref: 'm', head_ref: 'h' },
    });
    expect(sameNumberOtherRepo.number).toBe(5);
    await prisma.pullRequest.delete({ where: { id: sameNumberOtherRepo.id } });
  });

  it('lets new data attach correctly without touching legacy history', async () => {
    const meta = (repoId: number, fullName: string, title: string, head: string) => ({
      github_id: BigInt(repoId * 100 + 5),
      number: 5,
      title,
      state: 'open' as const,
      draft: false,
      merged_at: null,
      closed_at: null,
      created_at: new Date('2026-09-01T00:00:00Z'),
      updated_at: new Date('2026-09-02T00:00:00Z'),
      author: 'dev',
      head_sha: head,
      base_ref: 'main',
      head_ref: 'f',
      additions: 1,
      deletions: 0,
      changed_files: 1,
      repo: { github_id: BigInt(repoId), full_name: fullName, owner: 'org', name: fullName.split('/')[1], private: true, visibility: 'private' },
    });
    const b = await upsertRepoAndPullRequest(prisma, meta(1002, 'org/b', 'Real B five', 'f'.repeat(40)), 10n);
    expect(b.pr.id).not.toBe(ids.prCollided);
    const a = await upsertRepoAndPullRequest(prisma, meta(1001, 'org/a', 'Real A five', 'e'.repeat(40)), 10n);
    expect(a.pr.id).toBe(ids.prCollided); // same UUID, refreshed from GitHub
    expect(a.pr).toMatchObject({ title: 'Real A five', identity_status: 'verified' });
    expect(await prisma.prScore.count({ where: { pull_request_id: ids.prCollided, scoring_version: 'legacy' } })).toBe(2);
    expect(await prisma.repo.findFirstOrThrow({ where: { id: ids.repoA } })).toMatchObject({ private: true, visibility: 'private' });
  });

  it('serves legacy rows through the API with legacy labels and normalized reasons', async () => {
    const config = testConfig({ DATABASE_URL: upgradeUrl, WORKSPACE_INSTALLATION_IDS: '10' });
    const t = await buildTestApp(config, prisma);
    try {
      const cookie = await login(t.app);
      const detail = (await t.app.inject({ url: `/api/prs/${ids.prCollided}`, headers: { cookie } })).json();
      expect(detail.score_history.map((s: { revision_status: string }) => s.revision_status)).toEqual(['legacy_unknown', 'legacy_unknown']);
      // Both legacy shapes normalise to strings: seed-style {message} objects and plain strings.
      expect([['PR has 50+ changed files'], ['No test files changed', 'CI status: unknown']]).toContainEqual(detail.latest_score.reasons);
      expect(detail.latest_score).toMatchObject({ revision_status: 'legacy_unknown', scoring_version: 'legacy' });
      await prisma.prScore.update({ where: { id: ids.scoreObj }, data: { created_at: new Date('2030-01-01T00:00:00Z') } });
      const objectShape = (await t.app.inject({ url: `/api/prs/${ids.prCollided}`, headers: { cookie } })).json();
      expect(objectShape.latest_score.reasons).toEqual(['PR has 50+ changed files']);
      expect(objectShape.latest_score.level).toBe('medium'); // 45.5 → medium by the shared boundaries
      expect(detail.ai).toMatchObject({ status: 'stale', current: null });
      expect(detail.ai.previous.revision_status).toBe('legacy_unknown');
      const stats = (await t.app.inject({ url: '/api/stats', headers: { cookie } })).json();
      expect(stats.total_prs).toBeGreaterThanOrEqual(3);
      expect(stats.top_risky_folders.map((f: { folder: string }) => f.folder)).not.toContain('prisma/schema.prisma');
    } finally {
      await t.close();
    }
  });

  it('reports potentially corrupted legacy rows without guessing ownership', () => {
    const out = execFileSync('pnpm', ['exec', 'tsx', 'src/cli/report-legacy-identity.ts'], {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: upgradeUrl },
      encoding: 'utf8',
    });
    expect(out).toMatch(/PRs with legacy identity or legacy history: 3/);
    expect(out).toMatch(/More than one repository exists/);
    expect(out).toContain(ids.prCollided);
    expect(out).toContain('legacy_invalid_number');
  });
});

describe('clean install', () => {
  it('applies every migration to an empty database (the shared test database)', async () => {
    const fresh = createTestPrisma();
    try {
      const applied = await fresh.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`;
      expect(applied.map((m) => m.migration_name)).toEqual(readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort());
    } finally {
      await fresh.$disconnect();
    }
  });
});
