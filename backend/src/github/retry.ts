import { PermanentError, RetryableError } from '../lib/errors.js';

/**
 * One retry policy for GitHub REST calls:
 *  - rate limits (primary: 403/429 with x-ratelimit-remaining=0; secondary:
 *    Retry-After or "secondary rate limit") wait until the reset/Retry-After
 *    time. Short waits (≤ maxInlineWaitMs) are slept in-process; longer ones
 *    throw RetryableError(retryAt) so the durable delivery is rescheduled
 *    instead of holding a worker slot;
 *  - transient failures (5xx, network) retry with 1 s, 2 s backoff;
 *  - permission failures (other 403s) and 404s are permanent — no retry.
 * No other layer retries GitHub calls in-process.
 */

export type GitHubFailure =
  | { kind: 'rate_limit'; retryAt: Date }
  | { kind: 'permission' }
  | { kind: 'not_found' }
  | { kind: 'transient' }
  | { kind: 'client_error'; status: number };

interface ErrorLike {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | number | undefined> };
}

function header(err: ErrorLike, name: string): string | undefined {
  const value = err.response?.headers?.[name];
  return value === undefined ? undefined : String(value);
}

export function classifyGitHubError(err: unknown, now: Date = new Date()): GitHubFailure {
  const e = (err ?? {}) as ErrorLike;
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status === undefined || status >= 500) return { kind: 'transient' };

  if (status === 403 || status === 429) {
    const retryAfter = header(e, 'retry-after');
    if (retryAfter !== undefined && Number.isFinite(Number(retryAfter))) {
      return { kind: 'rate_limit', retryAt: new Date(now.getTime() + Number(retryAfter) * 1000) };
    }
    if (header(e, 'x-ratelimit-remaining') === '0') {
      const reset = Number(header(e, 'x-ratelimit-reset'));
      const retryAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : new Date(now.getTime() + 60_000);
      return { kind: 'rate_limit', retryAt };
    }
    if (status === 429 || /rate limit/i.test(e.message ?? '')) {
      return { kind: 'rate_limit', retryAt: new Date(now.getTime() + 60_000) };
    }
    return { kind: 'permission' };
  }
  if (status === 404) return { kind: 'not_found' };
  return { kind: 'client_error', status };
}

export interface RetryOptions {
  maxAttempts?: number;
  maxInlineWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withGitHubRetry<T>(label: string, fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const maxInlineWaitMs = options.maxInlineWaitMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const failure = classifyGitHubError(err, now());
      const status = (err as ErrorLike)?.status;
      switch (failure.kind) {
        case 'permission':
          throw new PermanentError(`GitHub denied ${label} (403): check the GitHub App permissions`, 'github_permission');
        case 'not_found':
          throw new PermanentError(`GitHub resource not found for ${label} (404)`, 'github_not_found');
        case 'client_error':
          throw new PermanentError(`GitHub rejected ${label} (${failure.status})`, 'github_client_error');
        case 'rate_limit': {
          const waitMs = Math.max(0, failure.retryAt.getTime() - now().getTime());
          if (attempt < maxAttempts && waitMs <= maxInlineWaitMs) {
            await sleep(waitMs);
            continue;
          }
          throw new RetryableError(`GitHub rate limit reached during ${label}`, failure.retryAt, 'github_rate_limit');
        }
        case 'transient':
          if (attempt < maxAttempts) {
            await sleep(1000 * 2 ** (attempt - 1));
            continue;
          }
          throw new RetryableError(
            `GitHub request failed during ${label}${status ? ` (${status})` : ''}`,
            undefined,
            'github_transient',
          );
      }
    }
  }
}
