import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, AnalysisRun, PullRequest, Repo } from '@prisma/client';
import type { Octokit } from '@octokit/rest';
import type { AppConfig } from '../config/env.js';
import { PROMPT_VERSION, SCORING_VERSION } from '../config/constants.js';
import { computeScore, levelToApi, type ScoringResult } from '../scoring/rules.js';
import { selectRiskyFiles } from '../ai/file-selector.js';
import { buildPromptParts } from '../ai/prompt-builder.js';
import type { AiResult } from '../ai/client.js';
import type { AiInput, AiLimitations, AiOutput } from '../ai/types.js';
import { fetchPrSnapshot, fetchPullRequestMeta, type PrSnapshot, type PullRequestMeta } from '../github/pr-snapshot.js';
import { formatAnalysisComment, upsertAnalysisComment } from '../github/comments.js';
import { RetryableError } from '../lib/errors.js';
import { sanitizeErrorForStorage } from '../lib/sanitize.js';
import type { Logger } from '../lib/logger.js';
import { acquireLease, releaseLease } from './lease.js';
import { runFingerprint, sha256, stableStringify } from './fingerprint.js';

export const LEASE_TTL_MS = 5 * 60_000;
export const MAX_AI_ATTEMPTS_PER_RUN = 3;

export interface AnalysisDeps {
  prisma: PrismaClient;
  config: AppConfig;
  logger: Logger;
  /** Installation-scoped Octokit (GitHubClientFactory.forInstallation). */
  github: (installationId: bigint) => Octokit;
  /** GitHub App id, used to ignore our own check runs and verify comment authorship. */
  appId: number;
  /** AI generation (injected so tests can mock it). */
  generateAi: (prompt: { system: string; user: string }) => Promise<AiResult>;
  /** Stable identifier of this worker process for leases. */
  workerId?: string;
}

export interface RepoRef {
  owner: string;
  name: string;
  githubRepoId: bigint;
  installationId: bigint;
}

export type AnalysisMode = 'full' | 'metadata';

export interface AnalysisOutcome {
  pullRequestId: string;
  headSha: string;
  mode: AnalysisMode;
  runId: string | null;
  newRun: boolean;
  score: number | null;
  aiStatus: string | null;
  commentStatus: string | null;
  staleMetadataIgnored: boolean;
}

const RETRYABLE_AI_STATUSES = new Set(['pending', 'failed', 'unavailable']);
const RETRYABLE_COMMENT_STATUSES = new Set(['pending', 'failed']);

/** Upsert repository + PR metadata. Never lets an older GitHub snapshot overwrite newer metadata. */
export async function upsertRepoAndPullRequest(
  prisma: PrismaClient,
  meta: PullRequestMeta,
  installationId: bigint,
): Promise<{ repo: Repo; pr: PullRequest; stale: boolean }> {
  return prisma.$transaction(async (tx) => {
    const repoData = {
      full_name: meta.repo.full_name,
      owner: meta.repo.owner,
      name: meta.repo.name,
      installation_id: installationId,
      private: meta.repo.private,
      visibility: meta.repo.visibility,
      // A successful installation-scoped fetch proves current access.
      access_status: 'active',
      access_revoked_at: null,
    };
    const repo = await tx.repo.upsert({
      where: { github_repo_id: meta.repo.github_id },
      update: repoData,
      create: { github_repo_id: meta.repo.github_id, ...repoData },
    });

    const existing = await tx.pullRequest.findUnique({
      where: { repo_id_number: { repo_id: repo.id, number: meta.number } },
    });
    if (existing?.github_updated_at && existing.github_updated_at > meta.updated_at) {
      return { repo, pr: existing, stale: true };
    }

    const prData = {
      github_id: meta.github_id,
      identity_status: 'verified',
      title: meta.title,
      state: meta.state,
      draft: meta.draft,
      author: meta.author,
      head_sha: meta.head_sha,
      base_ref: meta.base_ref,
      head_ref: meta.head_ref,
      additions: meta.additions,
      deletions: meta.deletions,
      changed_files: meta.changed_files,
      github_created_at: meta.created_at,
      github_updated_at: meta.updated_at,
      closed_at: meta.closed_at,
      merged_at: meta.merged_at,
    };
    const pr = existing
      ? await tx.pullRequest.update({ where: { id: existing.id }, data: prData })
      : await tx.pullRequest.create({ data: { repo_id: repo.id, number: meta.number, ...prData } });
    return { repo, pr, stale: false };
  });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(stableStringify(value)) as Prisma.InputJsonValue;
}

/** Create (or find) the run for this exact input set. Idempotent across replays and retries. */
async function ensureRun(
  deps: AnalysisDeps,
  pr: PullRequest,
  snapshot: PrSnapshot,
  scoring: ScoringResult,
  fingerprint: string,
  deliveryId: string | null,
): Promise<{ run: AnalysisRun; created: boolean }> {
  const { prisma, config } = deps;
  const existing = await prisma.analysisRun.findUnique({
    where: { pull_request_id_input_fingerprint: { pull_request_id: pr.id, input_fingerprint: fingerprint } },
  });
  if (existing) return { run: existing, created: false };

  const aiStatus = config.ai.enabled ? 'pending' : 'disabled';
  const commentStatus = !config.github.postComments ? 'disabled' : config.ai.enabled ? 'pending' : 'skipped';
  try {
    const run = await prisma.$transaction(async (tx) => {
      const created = await tx.analysisRun.create({
        data: {
          pull_request_id: pr.id,
          head_sha: snapshot.meta.head_sha,
          input_fingerprint: fingerprint,
          scoring_version: SCORING_VERSION,
          ci_status: snapshot.ci.status,
          trigger_delivery_id: deliveryId,
          ai_status: aiStatus,
          comment_status: commentStatus,
          completed_at: aiStatus === 'disabled' ? new Date() : null,
        },
      });
      await tx.prScore.create({
        data: {
          pull_request_id: pr.id,
          run_id: created.id,
          score: scoring.score,
          level: levelToApi(scoring.level),
          reasons: scoring.reasons,
          features: toJson(scoring.features),
          contributions: toJson(scoring.contributions),
          coverage: toJson({ ...snapshot.coverage, uncertainties: scoring.uncertainties, ci: snapshot.ci }),
          head_sha: snapshot.meta.head_sha,
          scoring_version: SCORING_VERSION,
          ci_status: snapshot.ci.status,
          input_fingerprint: fingerprint,
        },
      });
      await tx.pullRequest.update({
        where: { id: pr.id },
        data: { changed_files_list: snapshot.files.map((f) => f.filename) },
      });
      return created;
    });
    return { run, created: true };
  } catch (err) {
    // Unique violation: a concurrent attempt created the same run first.
    if ((err as { code?: string }).code === 'P2002') {
      const run = await prisma.analysisRun.findUniqueOrThrow({
        where: { pull_request_id_input_fingerprint: { pull_request_id: pr.id, input_fingerprint: fingerprint } },
      });
      return { run, created: false };
    }
    throw err;
  }
}

/** Runs for earlier heads can never become current: mark unfinished enrichment superseded. */
async function supersedeOlderRuns(prisma: PrismaClient, pr: PullRequest, currentHead: string) {
  await prisma.analysisRun.updateMany({
    where: { pull_request_id: pr.id, head_sha: { not: currentHead }, ai_status: { in: [...RETRYABLE_AI_STATUSES] } },
    data: { ai_status: 'superseded' },
  });
  await prisma.analysisRun.updateMany({
    where: { pull_request_id: pr.id, head_sha: { not: currentHead }, comment_status: { in: [...RETRYABLE_COMMENT_STATUSES] } },
    data: { comment_status: 'superseded' },
  });
}

async function currentHead(prisma: PrismaClient, prId: string): Promise<string | null> {
  const row = await prisma.pullRequest.findUnique({ where: { id: prId }, select: { head_sha: true } });
  return row?.head_sha ?? null;
}

function buildAiInput(snapshot: PrSnapshot, scoring: ScoringResult): AiInput {
  const churn = new Map(snapshot.files.map((f) => [f.filename, { additions: f.additions, deletions: f.deletions }]));
  const names = snapshot.files.map((f) => f.filename);
  const byName = new Map(snapshot.files.map((f) => [f.filename, f]));
  const selected = selectRiskyFiles(names, churn);
  return {
    score: scoring.score,
    level: scoring.level,
    reasons: scoring.reasons,
    uncertainties: scoring.uncertainties,
    changed_files: names,
    file_list_incomplete: snapshot.coverage.complete
      ? undefined
      : { listed: snapshot.coverage.listed_files, expected: snapshot.coverage.expected_files },
    // Reuse the patches already fetched with the file list: no extra GitHub calls.
    file_diffs: selected.map((s) => {
      const f = byName.get(s.filename)!;
      return { filename: f.filename, patch: f.patch, additions: f.additions, deletions: f.deletions };
    }),
  };
}

async function runAiStage(
  deps: AnalysisDeps,
  pr: PullRequest,
  run: AnalysisRun,
  snapshot: PrSnapshot,
  scoring: ScoringResult,
): Promise<AnalysisRun> {
  const { prisma, config, logger } = deps;
  if (!config.ai.enabled || !RETRYABLE_AI_STATUSES.has(run.ai_status)) return run;
  if (run.ai_attempts >= MAX_AI_ATTEMPTS_PER_RUN) return run;

  if ((await currentHead(prisma, pr.id)) !== run.head_sha) {
    return prisma.analysisRun.update({ where: { id: run.id }, data: { ai_status: 'superseded', comment_status: 'superseded' } });
  }

  const prompt = buildPromptParts(buildAiInput(snapshot, scoring));
  const aiFingerprint = sha256(
    stableStringify({ prompt_version: PROMPT_VERSION, model: config.ai.model, system: prompt.system, user: prompt.user }),
  );

  // Reuse a previous result only when every input and version is identical.
  const cached = await prisma.prAiAnalysis.findFirst({
    where: { pull_request_id: pr.id, input_fingerprint: aiFingerprint, model: config.ai.model, prompt_version: PROMPT_VERSION },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  });

  let result: AiResult;
  if (cached) {
    result = { ok: true, output: cached.analysis_json as unknown as AiOutput, attempts: 0 };
    logger.info({ runId: run.id }, 'Reusing AI analysis with identical inputs');
  } else {
    await prisma.analysisRun.update({ where: { id: run.id }, data: { ai_attempts: { increment: 1 } } });
    result = await deps.generateAi({ system: prompt.system, user: prompt.user });
  }

  if (!result.ok) {
    const status = result.kind === 'unavailable' ? 'unavailable' : 'failed';
    logger.warn({ runId: run.id, kind: result.kind }, 'AI analysis did not produce a result');
    return prisma.analysisRun.update({
      where: { id: run.id },
      data: {
        ai_status: status,
        ai_error: sanitizeErrorForStorage(result.error),
        // Never publish an older analysis when the current one failed.
        comment_status: run.comment_status === 'disabled' ? 'disabled' : 'skipped',
        completed_at: new Date(),
      },
    });
  }

  return prisma.$transaction(async (tx) => {
    await tx.prAiAnalysis.upsert({
      where: { run_id: run.id },
      update: {},
      create: {
        pull_request_id: pr.id,
        run_id: run.id,
        analysis_json: toJson(result.output),
        model: config.ai.model,
        prompt_version: PROMPT_VERSION,
        head_sha: run.head_sha,
        input_fingerprint: aiFingerprint,
        limitations: toJson(prompt.limitations),
      },
    });
    return tx.analysisRun.update({
      where: { id: run.id },
      data: {
        ai_status: 'succeeded',
        ai_error: null,
        completed_at: run.comment_status === 'pending' ? null : new Date(),
      },
    });
  });
}

async function runCommentStage(
  deps: AnalysisDeps,
  gh: Octokit,
  repoRef: RepoRef,
  pr: PullRequest,
  run: AnalysisRun,
  scoring: ScoringResult,
): Promise<AnalysisRun> {
  const { prisma, config, logger } = deps;
  if (!config.github.postComments || run.ai_status !== 'succeeded' || !RETRYABLE_COMMENT_STATUSES.has(run.comment_status)) {
    return run;
  }
  const analysis = await prisma.prAiAnalysis.findUnique({ where: { run_id: run.id } });
  if (!analysis) return run; // Only this run's own analysis may be published.

  try {
    // Revalidate against GitHub right before publishing: never post a stale head.
    const live = await fetchPullRequestMeta(gh, repoRef.owner, repoRef.name, pr.number!);
    if (live.head_sha !== run.head_sha || (await currentHead(prisma, pr.id)) !== run.head_sha) {
      return prisma.analysisRun.update({ where: { id: run.id }, data: { comment_status: 'superseded', completed_at: new Date() } });
    }
    const fresh = await prisma.pullRequest.findUniqueOrThrow({ where: { id: pr.id } });
    const body = formatAnalysisComment({
      headSha: run.head_sha,
      score: scoring.score,
      level: levelToApi(scoring.level),
      ciStatus: run.ci_status,
      uncertainties: scoring.uncertainties,
      analysis: analysis.analysis_json as unknown as AiOutput,
      limitations: analysis.limitations as unknown as AiLimitations | null,
      model: analysis.model,
    });
    const { commentId } = await upsertAnalysisComment(gh, {
      owner: repoRef.owner,
      repo: repoRef.name,
      number: pr.number!,
      appId: deps.appId,
      storedCommentId: fresh.bot_comment_id,
      body,
    });
    await prisma.pullRequest.updateMany({
      where: { id: pr.id, head_sha: run.head_sha },
      data: { bot_comment_id: BigInt(commentId), bot_comment_sha: run.head_sha },
    });
    return prisma.analysisRun.update({
      where: { id: run.id },
      data: { comment_status: 'succeeded', comment_error: null, completed_at: new Date() },
    });
  } catch (err) {
    logger.warn({ runId: run.id, err: sanitizeErrorForStorage(err) }, 'Posting the PR comment failed');
    return prisma.analysisRun.update({
      where: { id: run.id },
      data: { comment_status: 'failed', comment_error: sanitizeErrorForStorage(err), completed_at: new Date() },
    });
  }
}

/**
 * Analyse (mode "full") or refresh metadata for (mode "metadata") one PR.
 * Holds a per-PR lease for the duration so concurrent or out-of-order jobs
 * for the same PR, in any worker process, are serialised. The event that
 * triggered the job is only a hint: current state is always read from GitHub.
 */
export async function analyzePullRequest(
  deps: AnalysisDeps,
  repoRef: RepoRef,
  number: number,
  options: { mode: AnalysisMode; deliveryId?: string | null },
): Promise<AnalysisOutcome> {
  const { prisma, logger } = deps;
  const leaseKey = `${repoRef.githubRepoId}:${number}`;
  const owner = `${deps.workerId ?? 'worker'}:${randomUUID()}`;
  if (!(await acquireLease(prisma, leaseKey, owner, LEASE_TTL_MS))) {
    throw new RetryableError(`PR ${leaseKey} is being processed by another job`, new Date(Date.now() + 10_000), 'pr_locked');
  }
  try {
    const gh = deps.github(repoRef.installationId);

    if (options.mode === 'metadata') {
      const meta = await fetchPullRequestMeta(gh, repoRef.owner, repoRef.name, number);
      const { pr, stale } = await upsertRepoAndPullRequest(prisma, meta, repoRef.installationId);
      if (!stale) await supersedeOlderRuns(prisma, pr, pr.head_sha);
      return {
        pullRequestId: pr.id,
        headSha: pr.head_sha,
        mode: 'metadata',
        runId: null,
        newRun: false,
        score: null,
        aiStatus: null,
        commentStatus: null,
        staleMetadataIgnored: stale,
      };
    }

    const snapshot = await fetchPrSnapshot(gh, { owner: repoRef.owner, repo: repoRef.name, number, ownAppId: deps.appId });
    const { pr, stale } = await upsertRepoAndPullRequest(prisma, snapshot.meta, repoRef.installationId);
    if (stale || pr.head_sha !== snapshot.meta.head_sha) {
      logger.info({ pr: pr.id }, 'Newer PR state already stored; skipping stale snapshot');
      return {
        pullRequestId: pr.id,
        headSha: pr.head_sha,
        mode: 'full',
        runId: null,
        newRun: false,
        score: null,
        aiStatus: null,
        commentStatus: null,
        staleMetadataIgnored: true,
      };
    }

    const scoring = computeScore({
      changed_files: snapshot.meta.changed_files,
      additions: snapshot.meta.additions,
      deletions: snapshot.meta.deletions,
      changed_files_list: snapshot.files.map((f) => f.filename),
      ci_status: snapshot.ci.status,
      ci_reason: snapshot.ci.reason ?? undefined,
      coverage: snapshot.coverage,
    });
    const fingerprint = runFingerprint({
      scoringVersion: SCORING_VERSION,
      headSha: snapshot.meta.head_sha,
      baseRef: snapshot.meta.base_ref,
      changedFiles: snapshot.meta.changed_files,
      additions: snapshot.meta.additions,
      deletions: snapshot.meta.deletions,
      files: snapshot.files,
      fileListComplete: snapshot.coverage.complete,
      ciStatus: snapshot.ci.status,
    });

    const { run: initialRun, created } = await ensureRun(deps, pr, snapshot, scoring, fingerprint, options.deliveryId ?? null);
    await supersedeOlderRuns(prisma, pr, snapshot.meta.head_sha);

    let run = await runAiStage(deps, pr, initialRun, snapshot, scoring);
    run = await runCommentStage(deps, gh, repoRef, pr, run, scoring);

    logger.info(
      { pr: pr.id, runId: run.id, newRun: created, score: scoring.score, ai: run.ai_status, comment: run.comment_status },
      'PR analysis complete',
    );
    return {
      pullRequestId: pr.id,
      headSha: run.head_sha,
      mode: 'full',
      runId: run.id,
      newRun: created,
      score: scoring.score,
      aiStatus: run.ai_status,
      commentStatus: run.comment_status,
      staleMetadataIgnored: false,
    };
  } finally {
    await releaseLease(prisma, leaseKey, owner).catch((err) =>
      logger.warn({ err: sanitizeErrorForStorage(err) }, 'Failed to release PR lease (it will expire)'),
    );
  }
}
