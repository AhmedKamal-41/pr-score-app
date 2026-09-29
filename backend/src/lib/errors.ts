/**
 * A transient failure: the work should be retried later, not before `retryAt`
 * when provided (for example a GitHub rate-limit reset time).
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAt?: Date,
    public readonly kind: string = 'transient',
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** A permanent failure: retrying the same work cannot succeed. */
export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly kind: string = 'permanent',
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}
