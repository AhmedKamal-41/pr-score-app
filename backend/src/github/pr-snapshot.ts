import type { Octokit } from '@octokit/rest';
import { RetryableError } from '../lib/errors.js';
import type { FileCoverage } from '../scoring/rules.js';
import { fetchCiStatus, type CiResult } from './ci-status.js';
import { withGitHubRetry } from './retry.js';

/** GitHub's documented maximum number of files returned by "list pull request files". */
export const GITHUB_MAX_LISTED_FILES = 3000;
const MAX_HEAD_REVALIDATIONS = 3;

export interface PullRequestMeta {
  github_id: bigint;
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  author: string;
  head_sha: string;
  base_ref: string;
  head_ref: string;
  additions: number;
  deletions: number;
  changed_files: number;
  repo: {
    github_id: bigint;
    full_name: string;
    owner: string;
    name: string;
    private: boolean;
    visibility: string | null;
  };
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** null when GitHub omits the patch (binary or very large file). */
  patch: string | null;
}

export interface SnapshotCoverage extends FileCoverage {
  files_without_patch: number;
  reason: string | null;
}

export interface PrSnapshot {
  meta: PullRequestMeta;
  files: ChangedFile[];
  coverage: SnapshotCoverage;
  ci: CiResult;
}

type PullsGet = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];

function toMeta(pr: PullsGet): PullRequestMeta {
  const baseRepo = pr.base.repo;
  return {
    github_id: BigInt(pr.id),
    number: pr.number,
    title: pr.title,
    state: pr.state === 'open' ? 'open' : 'closed',
    draft: Boolean(pr.draft),
    merged_at: pr.merged_at ? new Date(pr.merged_at) : null,
    closed_at: pr.closed_at ? new Date(pr.closed_at) : null,
    created_at: new Date(pr.created_at),
    updated_at: new Date(pr.updated_at),
    author: pr.user?.login ?? 'unknown',
    head_sha: pr.head.sha,
    base_ref: pr.base.ref,
    head_ref: pr.head.ref,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changed_files: pr.changed_files ?? 0,
    repo: {
      github_id: BigInt(baseRepo.id),
      full_name: baseRepo.full_name,
      owner: baseRepo.owner.login,
      name: baseRepo.name,
      private: baseRepo.private,
      visibility: (baseRepo as { visibility?: string }).visibility ?? (baseRepo.private ? 'private' : 'public'),
    },
  };
}

export async function fetchPullRequestMeta(gh: Octokit, owner: string, repo: string, number: number): Promise<PullRequestMeta> {
  const { data } = await withGitHubRetry('pulls.get', () => gh.rest.pulls.get({ owner, repo, pull_number: number }));
  return toMeta(data);
}

export async function fetchChangedFiles(
  gh: Octokit,
  owner: string,
  repo: string,
  number: number,
  expectedFiles: number,
): Promise<{ files: ChangedFile[]; coverage: SnapshotCoverage }> {
  const raw = await withGitHubRetry('pulls.listFiles', () =>
    gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
  );
  const files: ChangedFile[] = raw.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patch: typeof f.patch === 'string' ? f.patch : null,
  }));
  const complete = files.length >= expectedFiles;
  let reason: string | null = null;
  if (!complete) {
    reason =
      expectedFiles > GITHUB_MAX_LISTED_FILES
        ? `GitHub lists at most ${GITHUB_MAX_LISTED_FILES} files per pull request`
        : 'GitHub returned fewer files than the pull request reports';
  }
  return {
    files,
    coverage: {
      expected_files: expectedFiles,
      listed_files: files.length,
      complete,
      files_without_patch: files.filter((f) => f.patch === null).length,
      reason,
    },
  };
}

/**
 * Fetch metadata, the complete (paginated) file list with patches, and CI for
 * one consistent head revision. The head SHA is re-read after fetching; if it
 * moved, the snapshot is rebuilt so files and CI never mix revisions.
 */
export async function fetchPrSnapshot(
  gh: Octokit,
  params: { owner: string; repo: string; number: number; ownAppId?: number },
): Promise<PrSnapshot> {
  const { owner, repo, number } = params;
  for (let attempt = 1; attempt <= MAX_HEAD_REVALIDATIONS; attempt += 1) {
    const meta = await fetchPullRequestMeta(gh, owner, repo, number);
    const { files, coverage } = await fetchChangedFiles(gh, owner, repo, number, meta.changed_files);
    const ci = await fetchCiStatus(gh, owner, repo, meta.head_sha, params.ownAppId);
    const recheck = await fetchPullRequestMeta(gh, owner, repo, number);
    if (recheck.head_sha === meta.head_sha) {
      return { meta: recheck, files, coverage, ci };
    }
  }
  throw new RetryableError(
    `Head of ${owner}/${repo}#${number} kept changing while fetching; will retry`,
    new Date(Date.now() + 30_000),
    'head_moving',
  );
}
