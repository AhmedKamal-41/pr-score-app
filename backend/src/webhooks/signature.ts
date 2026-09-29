import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureCheck = 'valid' | 'missing' | 'malformed' | 'invalid';

const SIGNATURE_FORMAT = /^sha256=[0-9a-f]{64}$/;

/**
 * Verify GitHub's X-Hub-Signature-256 over the exact request bytes.
 * The full "sha256=<hex>" header value is compared in constant time.
 */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined): SignatureCheck {
  if (header === undefined || header === '') return 'missing';
  if (!SIGNATURE_FORMAT.test(header)) return 'malformed';
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`, 'utf8');
  const actual = Buffer.from(header, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? 'valid' : 'invalid';
}

export function signPayload(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
