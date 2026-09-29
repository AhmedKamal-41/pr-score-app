import { describe, it, expect } from 'vitest';
import { signPayload, verifyWebhookSignature } from './signature.js';

const secret = 'test-webhook-secret-0123456789';
const body = Buffer.from('{"action":"opened","number":1}');

describe('verifyWebhookSignature', () => {
  it('accepts the exact signature over the raw bytes', () => {
    expect(verifyWebhookSignature(secret, body, signPayload(secret, body))).toBe('valid');
  });

  it('reports a missing header', () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe('missing');
    expect(verifyWebhookSignature(secret, body, '')).toBe('missing');
  });

  it.each(['deadbeef', 'sha1=abc', `sha256=${'z'.repeat(64)}`, `sha256=${'a'.repeat(63)}`, signPayload(secret, body).replace('sha256=', '')])(
    'rejects malformed header %s',
    (header) => {
      expect(verifyWebhookSignature(secret, body, header)).toBe('malformed');
    },
  );

  it('rejects a wrong secret', () => {
    expect(verifyWebhookSignature(secret, body, signPayload('another-secret-value-000', body))).toBe('invalid');
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from('{"action":"opened","number":2}');
    expect(verifyWebhookSignature(secret, tampered, signPayload(secret, body))).toBe('invalid');
  });

  it('verifies original bytes, not re-serialized JSON', () => {
    const spaced = Buffer.from('{ "action" : "opened",  "number" : 1 }');
    const sig = signPayload(secret, spaced);
    expect(verifyWebhookSignature(secret, spaced, sig)).toBe('valid');
    expect(verifyWebhookSignature(secret, Buffer.from(JSON.stringify(JSON.parse(spaced.toString()))), sig)).toBe('invalid');
  });

  it('verifies non-UTF-8 bytes exactly', () => {
    const raw = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    expect(verifyWebhookSignature(secret, raw, signPayload(secret, raw))).toBe('valid');
    expect(verifyWebhookSignature(secret, Buffer.from(raw.toString('utf8')), signPayload(secret, raw))).toBe('invalid');
  });
});
