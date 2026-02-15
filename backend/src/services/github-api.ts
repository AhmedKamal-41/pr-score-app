import { Octokit } from '@octokit/rest';
import { createAuthenticatedOctokit } from '../lib/github-auth.js';

export interface PrDetails {
  title: string;
  author: string;
  additions: number;
  deletions: number;
  changed_files: number;
  changed_files_list: string[];
  head_sha: string;
  base_ref: string;
  head_ref: string;
  state: string;
  merged_at: string | null;
}

export interface FileDiff {
  filename: string;
  patch: string | null; // null if file is too large or binary
  additions: number;
  deletions: number;
}

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if error is a rate limit error
 */
function isRateLimitError(error: any): boolean {
  return (
    error?.status === 403 ||
    error?.status === 429 ||
    error?.response?.status === 403 ||
    error?.response?.status === 429
  );
}

/**
 * Get retry delay from error or use exponential backoff
 */
function getRetryDelay(error: any, attempt: number): number {
  // Check for Retry-After header
  const retryAfter = error?.response?.headers?.['retry-after'];
  if (retryAfter) {
    return parseInt(retryAfter, 10) * 1000; // Convert to milliseconds
  }

  // Use exponential backoff: 1s, 2s, 4s
  return INITIAL_RETRY_DELAY * Math.pow(2, attempt);
}

/**
 * Fetch PR details from GitHub API with rate limit handling
 */
export async function fetchPrDetails(
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number
): Promise<PrDetails> {
  let lastError: any;
  let octokit: Octokit | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Create authenticated Octokit instance
      if (!octokit) {
        octokit = await createAuthenticatedOctokit(installationId);
      }

      // Fetch PR details
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      // Fetch PR files
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
      });

      const changedFilesList = files.map((file) => file.filename);

      return {
        title: pr.title,
        author: pr.user?.login || 'unknown',
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changed_files: pr.changed_files || 0,
        changed_files_list: changedFilesList,
        head_sha: pr.head.sha,
        base_ref: pr.base.ref,
        head_ref: pr.head.ref,
        state: pr.state,
        merged_at: pr.merged_at,
      };
    } catch (error: any) {
      lastError = error;

      // If it's a rate limit error and we have retries left
      if (isRateLimitError(error) && attempt < MAX_RETRIES - 1) {
        const delay = getRetryDelay(error, attempt);
        const rateLimitInfo = error?.response?.headers?.['x-ratelimit-remaining']
          ? {
              remaining: error.response.headers['x-ratelimit-remaining'],
              reset: error.response.headers['x-ratelimit-reset'],
            }
          : null;

        console.warn(
          `Rate limit hit (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying in ${delay}ms...`,
          rateLimitInfo
        );

        await sleep(delay);
        continue;
      }

      // If it's not a rate limit error or we're out of retries, throw
      throw error;
    }
  }

  // If we exhausted all retries, throw the last error
  throw lastError;
}

/**
 * Fetch PR file diffs for specific files
 */
export async function fetchPrFileDiffs(
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number,
  filePaths: string[]
): Promise<FileDiff[]> {
  let lastError: any;
  let octokit: Octokit | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Create authenticated Octokit instance
      if (!octokit) {
        octokit = await createAuthenticatedOctokit(installationId);
      }

      // Fetch PR files
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
      });

      // Filter to requested file paths and map to FileDiff
      const fileDiffs: FileDiff[] = files
        .filter((file) => filePaths.includes(file.filename))
        .map((file) => ({
          filename: file.filename,
          patch: file.patch || null, // null if file is too large (>1MB) or binary
          additions: file.additions || 0,
          deletions: file.deletions || 0,
        }));

      return fileDiffs;
    } catch (error: any) {
      lastError = error;

      // If it's a rate limit error and we have retries left
      if (isRateLimitError(error) && attempt < MAX_RETRIES - 1) {
        const delay = getRetryDelay(error, attempt);
        const rateLimitInfo = error?.response?.headers?.['x-ratelimit-remaining']
          ? {
              remaining: error.response.headers['x-ratelimit-remaining'],
              reset: error.response.headers['x-ratelimit-reset'],
            }
          : null;

        console.warn(
          `Rate limit hit (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying in ${delay}ms...`,
          rateLimitInfo
        );

        await sleep(delay);
        continue;
      }

      // If it's not a rate limit error or we're out of retries, throw
      throw error;
    }
  }

  // If we exhausted all retries, throw the last error
  throw lastError;
}

