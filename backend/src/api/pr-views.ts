import { Prisma, type PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env.js';
import { levelForScore, levelToApi } from '../scoring/rules.js';
import { visibleRepoSql, visibleRepoWhere } from '../lib/visibility.js';

/**
 * API view models.
 *
 * Revision semantics:
 *  - A score/AI result is "current" only if it was computed for the PR's
 *    current head SHA. Results for earlier heads remain in history but are
 *    labelled "previous_head"; pre-migration rows are "legacy_unknown".
 *  - Levels are always derived from the score with the shared boundaries
 *    (LOW ≤ 30, MED ≤ 70, HIGH > 70).
 *
 * Compatibility: `github_pr_id` used to carry the PR number. It is kept as a
 * deprecated alias of `number`; the real GitHub id is `github_id`.
 */

export type RevisionStatus = 'current' | 'previous_head' | 'legacy_unknown';

export function normalizeReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((r) => {
      if (typeof r === 'string') return r;
      // Legacy seed rows stored {type, message, severity} objects.
      if (r && typeof r === 'object' && typeof (r as { message?: unknown }).message === 'string') return (r as { message: string }).message;
      return null;
    })
    .filter((r): r is string => r !== null);
}

export function apiLevel(score: number) {
  return levelToApi(levelForScore(score));
}

export function revisionStatus(scoreHead: string | null, prHead: string): RevisionStatus {
  if (scoreHead === null) return 'legacy_unknown';
  return scoreHead === prHead ? 'current' : 'previous_head';
}

interface ScoreRow {
  id: string;
  pull_request_id: string;
  score: number;
  reasons: unknown;
  features: unknown;
  contributions: unknown;
  coverage: unknown;
  head_sha: string | null;
  scoring_version: string;
  ci_status: string | null;
  created_at: Date;
}

export function scoreView(row: ScoreRow, prHead: string) {
  const coverage = (row.coverage ?? null) as { uncertainties?: string[]; complete?: boolean; expected_files?: number; listed_files?: number; files_without_patch?: number; reason?: string | null } | null;
  return {
    score: row.score,
    level: apiLevel(row.score),
    reasons: normalizeReasons(row.reasons),
    contributions: row.contributions ?? null,
    uncertainties: coverage?.uncertainties ?? [],
    coverage: coverage
      ? {
          complete: coverage.complete ?? null,
          expected_files: coverage.expected_files ?? null,
          listed_files: coverage.listed_files ?? null,
          files_without_patch: coverage.files_without_patch ?? null,
          reason: coverage.reason ?? null,
        }
      : null,
    features: row.features ?? null,
    ci_status: row.ci_status,
    head_sha: row.head_sha,
    scoring_version: row.scoring_version,
    revision_status: revisionStatus(row.head_sha, prHead),
    created_at: row.created_at.toISOString(),
  };
}

/** Latest score per PR, preferring scores for the current head. */
async function latestScores(prisma: PrismaClient, prIds: string[]): Promise<Map<string, ScoreRow>> {
  if (prIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<ScoreRow[]>`
    SELECT DISTINCT ON (s."pull_request_id")
           s."id", s."pull_request_id", s."score", s."reasons", s."features", s."contributions", s."coverage",
           s."head_sha", s."scoring_version", s."ci_status", s."created_at"
      FROM "pr_scores" s
      JOIN "pull_requests" p ON p."id" = s."pull_request_id"
     WHERE s."pull_request_id" IN (${Prisma.join(prIds)})
     ORDER BY s."pull_request_id", (s."head_sha" IS NOT DISTINCT FROM p."head_sha") DESC, s."created_at" DESC, s."id" DESC`;
  return new Map(rows.map((r) => [r.pull_request_id, r]));
}

/** Latest analysis run for each PR's current head. */
async function currentRuns(prisma: PrismaClient, prIds: string[]) {
  if (prIds.length === 0) return new Map<string, { ai_status: string; comment_status: string }>();
  const rows = await prisma.$queryRaw<{ pull_request_id: string; ai_status: string; comment_status: string }[]>`
    SELECT DISTINCT ON (a."pull_request_id") a."pull_request_id", a."ai_status", a."comment_status"
      FROM "analysis_runs" a
      JOIN "pull_requests" p ON p."id" = a."pull_request_id" AND p."head_sha" = a."head_sha"
     WHERE a."pull_request_id" IN (${Prisma.join(prIds)})
     ORDER BY a."pull_request_id", a."created_at" DESC, a."id" DESC`;
  return new Map(rows.map((r) => [r.pull_request_id, r]));
}

async function pendingDeliveryKeys(prisma: PrismaClient, prs: { repo_github_id: bigint; number: number | null }[]) {
  const pairs = prs.filter((p) => p.number !== null);
  if (pairs.length === 0) return new Set<string>();
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['received', 'queued', 'processing', 'failed'] },
      OR: pairs.map((p) => ({ repo_github_id: p.repo_github_id, pr_number: p.number })),
    },
    select: { repo_github_id: true, pr_number: true },
  });
  return new Set(rows.map((r) => `${r.repo_github_id}:${r.pr_number}`));
}

function prBase(pr: {
  id: string;
  number: number | null;
  github_pr_id: bigint | null;
  github_id: bigint | null;
  identity_status: string;
  title: string;
  author: string;
  state: string;
  draft: boolean;
  head_sha: string;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  created_at: Date;
  updated_at: Date;
  github_created_at: Date | null;
  github_updated_at: Date | null;
  merged_at: Date | null;
  closed_at: Date | null;
  repo: { full_name: string; private: boolean; visibility: string | null; is_demo: boolean };
}) {
  const number = pr.number ?? null;
  return {
    id: pr.id,
    number,
    /** @deprecated alias of `number` (this field historically held the PR number). */
    github_pr_id: number ?? (pr.github_pr_id !== null ? Number(pr.github_pr_id) : null),
    github_id: pr.github_id !== null ? pr.github_id.toString() : null,
    identity_status: pr.identity_status,
    title: pr.title,
    author: pr.author,
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged_at !== null,
    repository: pr.repo.full_name,
    repository_private: pr.repo.visibility === null ? null : pr.repo.private,
    repository_visibility: pr.repo.visibility,
    is_demo: pr.repo.is_demo,
    head_sha: pr.head_sha,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    created_at: pr.created_at.toISOString(),
    updated_at: pr.updated_at.toISOString(),
    github_created_at: pr.github_created_at?.toISOString() ?? null,
    github_updated_at: pr.github_updated_at?.toISOString() ?? null,
    merged_at: pr.merged_at?.toISOString() ?? null,
    closed_at: pr.closed_at?.toISOString() ?? null,
  };
}

export async function listPullRequests(prisma: PrismaClient, config: AppConfig, limit: number, offset: number) {
  const where: Prisma.PullRequestWhereInput = { repo: visibleRepoWhere(config) };
  const [total, prs] = await Promise.all([
    prisma.pullRequest.count({ where }),
    prisma.pullRequest.findMany({
      where,
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
      include: { repo: { select: { full_name: true, private: true, visibility: true, is_demo: true, github_repo_id: true } } },
    }),
  ]);
  const ids = prs.map((p) => p.id);
  const [scores, runs, pending] = await Promise.all([
    latestScores(prisma, ids),
    currentRuns(prisma, ids),
    pendingDeliveryKeys(prisma, prs.map((p) => ({ repo_github_id: p.repo.github_repo_id, number: p.number }))),
  ]);
  return {
    data: prs.map((pr) => {
      const score = scores.get(pr.id);
      const run = runs.get(pr.id);
      return {
        ...prBase(pr),
        latest_score: score ? scoreView(score, pr.head_sha) : null,
        ai_status: run?.ai_status ?? (config.ai.enabled ? 'missing' : 'disabled'),
        processing: pending.has(`${pr.repo.github_repo_id}:${pr.number}`),
      };
    }),
    pagination: { limit, offset, total, has_more: offset + prs.length < total },
  };
}

export async function getPullRequestDetail(prisma: PrismaClient, config: AppConfig, id: string) {
  const pr = await prisma.pullRequest.findFirst({
    where: { id, repo: visibleRepoWhere(config) },
    include: {
      repo: { select: { full_name: true, private: true, visibility: true, is_demo: true, github_repo_id: true } },
      scores: { orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 100 },
      analysis_runs: { orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 20 },
      ai_analyses: { orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 20 },
    },
  });
  if (!pr) return null;

  const current = pr.scores.find((s) => s.head_sha === pr.head_sha) ?? null;
  const latest = current ?? pr.scores[0] ?? null;
  const runForHead = pr.analysis_runs.find((r) => r.head_sha === pr.head_sha) ?? null;
  const analysisForRun = runForHead ? pr.ai_analyses.find((a) => a.run_id === runForHead.id) ?? null : null;
  const previousAnalysis = pr.ai_analyses.find((a) => a.head_sha !== pr.head_sha) ?? null;
  const pending = await pendingDeliveryKeys(prisma, [{ repo_github_id: pr.repo.github_repo_id, number: pr.number }]);

  let aiStatus: string;
  if (runForHead) aiStatus = runForHead.ai_status;
  else if (previousAnalysis) aiStatus = 'stale';
  else aiStatus = config.ai.enabled ? 'missing' : 'disabled';

  const analysisView = (a: (typeof pr.ai_analyses)[number]) => ({
    analysis: a.analysis_json,
    model: a.model,
    prompt_version: a.prompt_version,
    head_sha: a.head_sha,
    revision_status: revisionStatus(a.head_sha, pr.head_sha),
    limitations: a.limitations,
    created_at: a.created_at.toISOString(),
  });

  return {
    ...prBase(pr),
    changed_files_list: Array.isArray(pr.changed_files_list) ? (pr.changed_files_list as unknown[]).filter((f) => typeof f === 'string') : [],
    base_ref: pr.base_ref,
    head_ref: pr.head_ref,
    processing: pending.has(`${pr.repo.github_repo_id}:${pr.number}`),
    latest_score: latest ? scoreView(latest, pr.head_sha) : null,
    score_history: pr.scores.map((s) => ({
      score: s.score,
      level: apiLevel(s.score),
      head_sha: s.head_sha,
      ci_status: s.ci_status,
      scoring_version: s.scoring_version,
      revision_status: revisionStatus(s.head_sha, pr.head_sha),
      created_at: s.created_at.toISOString(),
    })),
    ai: {
      enabled: config.ai.enabled,
      status: aiStatus,
      error: runForHead?.ai_error ?? null,
      comment_status: runForHead?.comment_status ?? null,
      analyzed_sha: runForHead?.head_sha ?? null,
      run_created_at: runForHead?.created_at.toISOString() ?? null,
      current: analysisForRun ? analysisView(analysisForRun) : null,
      previous: !analysisForRun && previousAnalysis ? analysisView(previousAnalysis) : null,
    },
  };
}

export async function workspaceStats(prisma: PrismaClient, config: AppConfig) {
  const visible = visibleRepoSql(config);
  const [summary] = await prisma.$queryRaw<
    { total_prs: bigint; scored_prs: bigint; average_score: number | null; low: bigint; medium: bigint; high: bigint }[]
  >`
    WITH visible AS (
      SELECT p."id", p."head_sha" FROM "pull_requests" p JOIN "repos" r ON r."id" = p."repo_id" WHERE ${visible}
    ), latest AS (
      SELECT DISTINCT ON (s."pull_request_id") s."pull_request_id", s."score"
        FROM "pr_scores" s JOIN visible v ON v."id" = s."pull_request_id"
       ORDER BY s."pull_request_id", (s."head_sha" IS NOT DISTINCT FROM v."head_sha") DESC, s."created_at" DESC, s."id" DESC
    )
    SELECT (SELECT COUNT(*) FROM visible) AS total_prs,
           COUNT(l.*) AS scored_prs,
           AVG(l."score")::float8 AS average_score,
           COUNT(*) FILTER (WHERE l."score" <= 30) AS low,
           COUNT(*) FILTER (WHERE l."score" > 30 AND l."score" <= 70) AS medium,
           COUNT(*) FILTER (WHERE l."score" > 70) AS high
      FROM latest l`;

  const folders = await prisma.$queryRaw<{ folder: string; pr_count: bigint; average_score: number }[]>`
    WITH visible AS (
      SELECT p."id", p."head_sha", p."changed_files_list" FROM "pull_requests" p JOIN "repos" r ON r."id" = p."repo_id"
       WHERE ${visible} AND jsonb_typeof(p."changed_files_list") = 'array'
    ), latest AS (
      SELECT DISTINCT ON (s."pull_request_id") s."pull_request_id", s."score"
        FROM "pr_scores" s JOIN visible v ON v."id" = s."pull_request_id"
       ORDER BY s."pull_request_id", (s."head_sha" IS NOT DISTINCT FROM v."head_sha") DESC, s."created_at" DESC, s."id" DESC
    ), files AS (
      SELECT v."id" AS pr_id, f.path
        FROM visible v, jsonb_array_elements_text(v."changed_files_list") AS f(path)
    ), pr_folders AS (
      -- Directory components only: the first two directories of each path.
      -- Files at the repository root have no folder; a filename is never a folder.
      SELECT DISTINCT pr_id,
             array_to_string((string_to_array(path, '/'))[1:LEAST(2, array_length(string_to_array(path, '/'), 1) - 1)], '/') AS folder
        FROM files
       WHERE array_length(string_to_array(path, '/'), 1) > 1
    )
    SELECT pf.folder, COUNT(*) AS pr_count, AVG(l."score")::float8 AS average_score
      FROM pr_folders pf JOIN latest l ON l."pull_request_id" = pf.pr_id
     GROUP BY pf.folder
     ORDER BY average_score DESC, pr_count DESC, pf.folder ASC
     LIMIT 10`;

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    total_prs: Number(summary.total_prs),
    scored_prs: Number(summary.scored_prs),
    unscored_prs: Number(summary.total_prs) - Number(summary.scored_prs),
    /** Mean of each scored PR's latest score (current head preferred); null when nothing is scored. */
    average_score: summary.average_score === null ? null : round(summary.average_score),
    counts_by_level: { low: Number(summary.low), medium: Number(summary.medium), high: Number(summary.high) },
    top_risky_folders: folders.map((f) => ({
      folder: f.folder,
      pr_count: Number(f.pr_count),
      average_score: round(f.average_score),
      level: apiLevel(f.average_score),
    })),
  };
}
