import { redactSecrets } from '../ai/redaction.js';

const MAX_STORED_ERROR = 500;

/**
 * Produce an error string safe to persist or return: secrets redacted, no
 * stack traces, bounded length.
 */
export function sanitizeErrorForStorage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const firstLine = raw.split('\n')[0] ?? '';
  const redacted = redactSecrets(firstLine);
  return redacted.length > MAX_STORED_ERROR ? `${redacted.slice(0, MAX_STORED_ERROR)}…` : redacted;
}
