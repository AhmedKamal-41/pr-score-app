import type { Octokit } from '@octokit/rest';
import { PermanentError } from '../lib/errors.js';
import type { CiStatus } from '../scoring/rules.js';
import { withGitHubRetry } from './retry.js';

/**
 * CI normalisation for one exact commit SHA, from both the Checks API and the
 * legacy commit-status API.
 *
 *  failure  – any check run concluded failure / timed_out / action_required /
 *             startup_failure, or any commit status is failure / error.
 *  pending  – otherwise, any check run not completed or any status pending.
 *  success  – otherwise, at least one success and everything else is
 *             success / neutral / skipped.
 *  unknown  – otherwise: no CI configured, only neutral/skipped results,
 *             only cancelled/stale runs, or the data could not be read
 *             (missing Checks/Statuses permission). `reason` says which.
 * Check runs created by this app itself are ignored (no feedback loops).
 */

export interface CheckRunLike {
  name?: string;
  status: string; // queued | in_progress | completed | waiting | requested | pending
  conclusion: string | null;
  app?: { id?: number } | null;
}

export interface CommitStatusLike {
  context?: string;
  state: string; // success | failure | error | pending
}

export interface CiResult {
  status: CiStatus;
  reason: string | null;
  details: {
    check_runs: Record<string, number> | 'unavailable';
    statuses: Record<string, number> | 'unavailable';
  };
}

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const PASSING_CONCLUSIONS = new Set(['success']);
const NEUTRAL_CONCLUSIONS = new Set(['neutral', 'skipped']);
const INCONCLUSIVE_CONCLUSIONS = new Set(['cancelled', 'stale']);

function bucket(counter: Record<string, number>, key: string) {
  counter[key] = (counter[key] ?? 0) + 1;
}

export function normalizeCi(
  checkRuns: CheckRunLike[] | 'unavailable',
  statuses: CommitStatusLike[] | 'unavailable',
  ownAppId?: number,
): CiResult {
  let failure = false;
  let pending = false;
  let success = false;
  let inconclusive = false;
  let neutral = false;

  const runCounts: Record<string, number> = {};
  if (checkRuns !== 'unavailable') {
    for (const run of checkRuns) {
      if (ownAppId !== undefined && run.app?.id === ownAppId) continue;
      if (run.status !== 'completed') {
        pending = true;
        bucket(runCounts, 'pending');
        continue;
      }
      const c = run.conclusion ?? 'unknown';
      if (FAILING_CONCLUSIONS.has(c)) {
        failure = true;
        bucket(runCounts, 'failure');
      } else if (PASSING_CONCLUSIONS.has(c)) {
        success = true;
        bucket(runCounts, 'success');
      } else if (NEUTRAL_CONCLUSIONS.has(c)) {
        neutral = true;
        bucket(runCounts, 'neutral_or_skipped');
      } else if (INCONCLUSIVE_CONCLUSIONS.has(c)) {
        inconclusive = true;
        bucket(runCounts, 'cancelled_or_stale');
      } else {
        inconclusive = true;
        bucket(runCounts, 'other');
      }
    }
  }

  const statusCounts: Record<string, number> = {};
  if (statuses !== 'unavailable') {
    for (const s of statuses) {
      if (s.state === 'failure' || s.state === 'error') {
        failure = true;
        bucket(statusCounts, 'failure');
      } else if (s.state === 'pending') {
        pending = true;
        bucket(statusCounts, 'pending');
      } else if (s.state === 'success') {
        success = true;
        bucket(statusCounts, 'success');
      } else {
        inconclusive = true;
        bucket(statusCounts, 'other');
      }
    }
  }

  const details = {
    check_runs: checkRuns === 'unavailable' ? ('unavailable' as const) : runCounts,
    statuses: statuses === 'unavailable' ? ('unavailable' as const) : statusCounts,
  };
  const unavailable = checkRuns === 'unavailable' || statuses === 'unavailable';

  if (failure) return { status: 'failure', reason: null, details };
  if (pending) return { status: 'pending', reason: 'checks still running', details };
  if (unavailable) {
    // A partial view cannot prove success: the unreadable source might be failing.
    return { status: 'unknown', reason: 'CI data unavailable (missing Checks or Commit statuses permission)', details };
  }
  if (success) return { status: 'success', reason: null, details };
  if (inconclusive) return { status: 'unknown', reason: 'CI runs were cancelled or inconclusive', details };
  if (neutral) return { status: 'unknown', reason: 'only neutral or skipped checks', details };
  return { status: 'unknown', reason: 'no CI checks reported for this commit', details };
}

async function readOrUnavailable<T>(fn: () => Promise<T>): Promise<T | 'unavailable'> {
  try {
    return await fn();
  } catch (err) {
    // Missing permission (403) or unsupported endpoint (404) → report, don't fail the analysis.
    if (err instanceof PermanentError && (err.kind === 'github_permission' || err.kind === 'github_not_found')) {
      return 'unavailable';
    }
    throw err;
  }
}

export async function fetchCiStatus(
  gh: Octokit,
  owner: string,
  repo: string,
  sha: string,
  ownAppId?: number,
): Promise<CiResult> {
  const checkRuns = await readOrUnavailable(() =>
    withGitHubRetry('checks.listForRef', () =>
      gh.paginate(gh.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100, filter: 'latest' }),
    ),
  );
  const statuses = await readOrUnavailable(async () => {
    const combined = await withGitHubRetry('repos.getCombinedStatusForRef', () =>
      gh.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 }),
    );
    return combined.data.statuses as CommitStatusLike[];
  });
  return normalizeCi(checkRuns as CheckRunLike[] | 'unavailable', statuses, ownAppId);
}
