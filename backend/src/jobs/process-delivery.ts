import type { WebhookDelivery } from '@prisma/client';
import { isInWorkspace } from '../config/env.js';
import { analyzePullRequest, type AnalysisDeps, type AnalysisMode, type RepoRef } from '../analysis/analyze.js';
import { PermanentError, RetryableError } from '../lib/errors.js';
import { sanitizeErrorForStorage } from '../lib/sanitize.js';
import { PROCESSING_STALE_MS } from './dispatch.js';

export interface DeliveryDeps extends Omit<AnalysisDeps, 'github' | 'appId'> {
  /** null when GitHub integration is disabled (local demo mode). */
  github: AnalysisDeps['github'] | null;
  appId: number | null;
}

export type DeliveryOutcome =
  | { outcome: 'skipped' }
  | { outcome: 'succeeded' | 'ignored'; detail: string }
  | { outcome: 'failed' | 'dead'; error: string; nextAttemptAt: Date | null };

interface RepoPayload {
  id: number;
  full_name: string;
  owner: string;
  name: string;
}

/** Durable retry schedule for failed deliveries: 30 s, 1 min, 2 min, … capped at 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

function modeForPullRequestAction(action: string, baseChanged: boolean): AnalysisMode {
  switch (action) {
    case 'opened':
    case 'synchronize':
    case 'reopened':
    case 'ready_for_review':
      return 'full';
    case 'edited':
      // Title/body edits do not change risk inputs; a base-branch change does.
      return baseChanged ? 'full' : 'metadata';
    default:
      // closed (incl. merged) and converted_to_draft: refresh metadata only, no AI rerun.
      return 'metadata';
  }
}

async function handle(deps: DeliveryDeps, delivery: WebhookDelivery): Promise<{ ignored: boolean; detail: string }> {
  const { prisma, config } = deps;
  const payload = delivery.payload as Record<string, unknown>;

  if (delivery.event === 'installation' || delivery.event === 'installation_repositories') {
    return handleAccessChange(deps, delivery, payload);
  }

  if (!deps.github || deps.appId === null) {
    throw new PermanentError('GitHub integration is disabled (GITHUB_ENABLED=false)', 'github_disabled');
  }
  const analysisDeps: AnalysisDeps = { ...deps, github: deps.github, appId: deps.appId };
  const repo = payload.repository as RepoPayload;
  if (!isInWorkspace(config, delivery.installation_id, repo.full_name)) {
    return { ignored: true, detail: 'installation or repository is no longer part of this workspace' };
  }
  const repoRef: RepoRef = {
    owner: repo.owner,
    name: repo.name,
    githubRepoId: BigInt(repo.id),
    installationId: delivery.installation_id!,
  };

  if (delivery.event === 'pull_request') {
    const mode = modeForPullRequestAction(String(payload.action), Boolean(payload.base_changed));
    const result = await analyzePullRequest(analysisDeps, repoRef, delivery.pr_number!, { mode, deliveryId: delivery.id });
    return { ignored: false, detail: `${mode} analysis of PR ${result.pullRequestId} at ${result.headSha.slice(0, 12)}` };
  }

  if (delivery.event === 'check_suite' || delivery.event === 'status') {
    // Resolve by repository + exact commit: CI for an obsolete head matches nothing.
    const prs = await prisma.pullRequest.findMany({
      where: {
        head_sha: delivery.head_sha!,
        state: 'open',
        number: { not: null },
        repo: { github_repo_id: repoRef.githubRepoId, access_status: 'active' },
      },
      select: { number: true },
      orderBy: { number: 'asc' },
    });
    if (prs.length === 0) {
      return { ignored: true, detail: 'no open PR currently has this head SHA (obsolete or unknown revision)' };
    }
    for (const pr of prs) {
      await analyzePullRequest(analysisDeps, repoRef, pr.number!, { mode: 'full', deliveryId: delivery.id });
    }
    return { ignored: false, detail: `re-scored ${prs.length} PR(s) after CI change` };
  }

  return { ignored: true, detail: `event ${delivery.event} has no handler` };
}

async function handleAccessChange(
  deps: DeliveryDeps,
  delivery: WebhookDelivery,
  payload: Record<string, unknown>,
): Promise<{ ignored: boolean; detail: string }> {
  const { prisma } = deps;
  const installationId = delivery.installation_id!;
  const revoke = { access_status: 'revoked', access_revoked_at: new Date() };
  const restore = { access_status: 'active', access_revoked_at: null };
  const ids = (list: unknown) => ((list as { id: number }[] | undefined) ?? []).map((r) => BigInt(r.id));

  if (delivery.event === 'installation') {
    const action = String(payload.action);
    if (action === 'deleted' || action === 'suspend') {
      const r = await prisma.repo.updateMany({ where: { installation_id: installationId }, data: revoke });
      return { ignored: false, detail: `revoked access to ${r.count} repositories (installation ${action})` };
    }
    const r = await prisma.repo.updateMany({ where: { installation_id: installationId }, data: restore });
    return { ignored: false, detail: `restored access to ${r.count} repositories (installation ${action})` };
  }

  const removed = ids(payload.removed);
  const added = ids(payload.added);
  const r1 = removed.length ? await prisma.repo.updateMany({ where: { github_repo_id: { in: removed } }, data: revoke }) : { count: 0 };
  const r2 = added.length
    ? await prisma.repo.updateMany({ where: { github_repo_id: { in: added } }, data: { ...restore, installation_id: installationId } })
    : { count: 0 };
  return { ignored: false, detail: `repositories revoked: ${r1.count}, restored: ${r2.count}` };
}

/**
 * Process one delivery. Claiming is a conditional UPDATE, so two jobs for the
 * same delivery (e.g. after a re-dispatch) can never run it concurrently.
 * Outcomes are recorded durably; the BullMQ job itself always completes.
 */
export async function processDelivery(deps: DeliveryDeps, deliveryId: string, now: Date = new Date()): Promise<DeliveryOutcome> {
  const { prisma, config, logger } = deps;
  const claim = await prisma.webhookDelivery.updateMany({
    where: {
      id: deliveryId,
      OR: [
        { status: { in: ['received', 'queued', 'failed'] } },
        { status: 'processing', updated_at: { lt: new Date(now.getTime() - PROCESSING_STALE_MS) } },
      ],
    },
    data: { status: 'processing', attempts: { increment: 1 } },
  });
  if (claim.count === 0) return { outcome: 'skipped' };

  const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
  try {
    const { ignored, detail } = await handle(deps, delivery);
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: ignored ? 'ignored' : 'succeeded',
        ignored_reason: ignored ? detail : null,
        last_error: null,
        next_attempt_at: null,
        processed_at: new Date(),
      },
    });
    logger.info({ deliveryId, event: delivery.event, detail }, ignored ? 'Delivery ignored' : 'Delivery processed');
    return { outcome: ignored ? 'ignored' : 'succeeded', detail };
  } catch (err) {
    const error = sanitizeErrorForStorage(err);
    // Waiting for another job's PR lease is contention, not failure: it does not use up an attempt.
    const contention = err instanceof RetryableError && err.kind === 'pr_locked';
    const exhausted = !contention && delivery.attempts >= config.worker.deliveryMaxAttempts;
    const dead = err instanceof PermanentError || exhausted;
    const retryAt = err instanceof RetryableError && err.retryAt ? err.retryAt : new Date(Date.now() + backoffMs(delivery.attempts));
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: dead ? 'dead' : 'failed',
        last_error: error,
        next_attempt_at: dead ? null : retryAt,
        ...(contention ? { attempts: { decrement: 1 } } : {}),
      },
    });
    logger.warn({ deliveryId, event: delivery.event, attempts: delivery.attempts, dead, error }, 'Delivery processing failed');
    return { outcome: dead ? 'dead' : 'failed', error, nextAttemptAt: dead ? null : retryAt };
  }
}
