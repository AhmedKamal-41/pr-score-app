import { describe, it, expect, vi } from 'vitest';
import { classifyGitHubError, withGitHubRetry } from './retry.js';
import { PermanentError, RetryableError } from '../lib/errors.js';

const now = new Date('2026-09-29T00:00:00Z');
const err = (status: number | undefined, headers: Record<string, string> = {}, message = 'x') => ({ status, message, response: { headers } });

describe('classifyGitHubError', () => {
  it('distinguishes permission failures from rate limits', () => {
    expect(classifyGitHubError(err(403, {}, 'Resource not accessible by integration'), now)).toEqual({ kind: 'permission' });
  });

  it('uses x-ratelimit-reset for primary rate limits', () => {
    const reset = Math.floor(now.getTime() / 1000) + 120;
    expect(classifyGitHubError(err(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }), now)).toEqual({
      kind: 'rate_limit',
      retryAt: new Date(reset * 1000),
    });
  });

  it('honours Retry-After for secondary rate limits', () => {
    expect(classifyGitHubError(err(429, { 'retry-after': '30' }), now)).toEqual({ kind: 'rate_limit', retryAt: new Date(now.getTime() + 30_000) });
    expect(classifyGitHubError(err(403, {}, 'You have exceeded a secondary rate limit'), now)).toMatchObject({ kind: 'rate_limit' });
  });

  it('classifies 404, 5xx and network errors', () => {
    expect(classifyGitHubError(err(404), now)).toEqual({ kind: 'not_found' });
    expect(classifyGitHubError(err(502), now)).toEqual({ kind: 'transient' });
    expect(classifyGitHubError(new Error('fetch failed'), now)).toEqual({ kind: 'transient' });
    expect(classifyGitHubError(err(422), now)).toEqual({ kind: 'client_error', status: 422 });
  });
});

describe('withGitHubRetry', () => {
  const sleep = vi.fn(async () => {});

  it('does not retry permission errors', async () => {
    const fn = vi.fn().mockRejectedValue(err(403, {}, 'forbidden'));
    await expect(withGitHubRetry('op', fn, { sleep })).rejects.toBeInstanceOf(PermanentError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits out short rate limits in-process', async () => {
    const fn = vi.fn().mockRejectedValueOnce(err(429, { 'retry-after': '2' })).mockResolvedValue('ok');
    await expect(withGitHubRetry('op', fn, { sleep, now: () => now })).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('defers long rate limits to the durable retry with the reset time', async () => {
    const reset = Math.floor(now.getTime() / 1000) + 600;
    const fn = vi.fn().mockRejectedValue(err(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    const error = await withGitHubRetry('op', fn, { sleep, now: () => now }).catch((e) => e);
    expect(error).toBeInstanceOf(RetryableError);
    expect((error as RetryableError).retryAt).toEqual(new Date(reset * 1000));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures a bounded number of times', async () => {
    const fn = vi.fn().mockRejectedValue(err(503));
    await expect(withGitHubRetry('op', fn, { sleep, maxAttempts: 3 })).rejects.toBeInstanceOf(RetryableError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
