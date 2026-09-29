import { describe, it, expect } from 'vitest';
import { containsSecret, redactSecrets, redactSecretsDetailed } from './redaction.js';

// Synthetic fixtures are assembled at runtime so that no secret-shaped literal
// is committed (and repository secret scanners are not triggered).
const j = (...parts: string[]) => parts.join('');
const FAKE = {
  stripe: j('sk', '_live_', 'a1B2c3D4e5F6g7H8i9J0k1L2'),
  aws: j('AKIA', 'IOSFODNN7EXAMPLE'),
  google: j('AIza', 'SyDaGmWKaVPJsA5j5q9K7Z7Z7Z7Z7Z7Z7Z7'),
  github: j('ghp', '_', 'A'.repeat(18), 'b'.repeat(18)),
  openai: j('sk', '-proj-', 'Xy12'.repeat(8)),
  slack: j('xox', 'b-', '1234567890-abcdefghij'),
  jwt: j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
  pemBody: 'MIIEpAIBAAKCAQEA1234567890abcdefghij',
};
const pem = (kind: string, prefix = '') =>
  [`${prefix}-----BEGIN ${kind}PRIVATE KEY-----`, `${prefix}${FAKE.pemBody}`, `${prefix}abcdefghijklmnopqrstuvwxyz`, `${prefix}-----END ${kind}PRIVATE KEY-----`].join('\n');

describe('redactSecrets', () => {
  it('should redact API keys', () => {
    const text = 'api_key: sk_live_EXAMPLE_KEY_NOT_REAL_123456789012';
    const result = redactSecrets(text);
    expect(result).toBe('api_key: [REDACTED]');
  });

  it('should redact JWT tokens', () => {
    const result = redactSecrets(`token: ${FAKE.jwt}`);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('should redact passwords', () => {
    const result = redactSecrets('password: mySecretPassword123');
    expect(result).toBe('password: [REDACTED]');
  });

  it('should redact private keys (PEM format)', () => {
    expect(redactSecrets(pem('RSA '))).toBe('[REDACTED]');
  });

  it('should redact EC private keys', () => {
    expect(redactSecrets(pem('EC '))).toBe('[REDACTED]');
  });

  it('should redact database connection strings with passwords', () => {
    const result = redactSecrets('postgresql://user:secretpassword@localhost:5432/db');
    expect(result).toBe('postgresql://user:[REDACTED]@localhost:5432/db');
  });

  it('should redact OAuth secrets', () => {
    const result = redactSecrets('client_secret: abc123def456ghi789jkl012mno345pqr678');
    expect(result).toBe('client_secret: [REDACTED]');
  });

  it('should handle multiline secrets in the middle of text', () => {
    const text = `Some code here\n${pem('RSA ')}\nMore code here`;
    const result = redactSecrets(text);
    expect(result).toBe('Some code here\n[REDACTED]\nMore code here');
    expect(result).not.toContain(FAKE.pemBody);
  });

  it('should not redact normal code', () => {
    const text = `function authenticate(user, password) {
  return user === 'admin' && password === 'admin';
}`;
    expect(redactSecrets(text)).toBe(text);
  });

  it('should handle empty strings', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('should return non-string input unchanged', () => {
    expect(redactSecrets(null as unknown as string)).toBe(null);
    expect(redactSecrets(undefined as unknown as string)).toBe(undefined);
  });

  it('should redact AWS access keys that are not at the start of the text', () => {
    const result = redactSecrets(`AWS_ACCESS_KEY_ID=${FAKE.aws}`);
    expect(result).toBe('AWS_ACCESS_KEY_ID=[REDACTED]');
  });

  it('should redact Google API keys', () => {
    expect(redactSecrets(`key = "${FAKE.google}"`)).not.toContain(FAKE.google);
  });

  describe('position independence (regression: offset mistaken for a capture)', () => {
    it.each([
      ['start', `${FAKE.aws} is the key`],
      ['middle', `the key ${FAKE.aws} is here`],
      ['end', `the key is ${FAKE.aws}`],
    ])('redacts a full-match secret at the %s', (_where, text) => {
      const out = redactSecrets(text);
      expect(out).not.toContain(FAKE.aws);
      expect(out).toContain('[REDACTED]');
    });

    it('redacts repeated matches and counts them', () => {
      const { text, count } = redactSecretsDetailed(`${FAKE.stripe} and ${FAKE.stripe} and ${FAKE.github}`);
      expect(text).toBe('[REDACTED] and [REDACTED] and [REDACTED]');
      expect(count).toBe(3);
    });
  });

  it('redacts diff-prefixed lines and multiline PEM blocks inside a patch', () => {
    const patch = [
      '@@ -1,3 +1,8 @@',
      ' const config = {',
      `+  apiKey: '${FAKE.openai}',`,
      `+  stripe: "${FAKE.stripe}",`,
      pem('', '+'),
      '   region: "eu-west-1",',
      ' };',
    ].join('\n');
    const out = redactSecrets(patch);
    for (const secret of [FAKE.openai, FAKE.stripe, FAKE.pemBody]) expect(out).not.toContain(secret);
    expect(out).toContain('region: "eu-west-1"');
    expect(out).toContain('@@ -1,3 +1,8 @@');
  });

  it('redacts an unterminated private key block to the end of the text', () => {
    const out = redactSecrets(`ok line\n-----BEGIN PRIVATE KEY-----\n${FAKE.pemBody}\n... [truncated]`);
    expect(out).toBe('ok line\n[REDACTED]');
  });

  it.each([
    ['GitHub token', `GITHUB_TOKEN=${FAKE.github}`],
    ['Slack token', `slack: ${FAKE.slack}`],
    ['OpenAI key', `OPENAI_API_KEY=${FAKE.openai}`],
    ['bearer header', `Authorization: Bearer ${'abcDEF123456'.repeat(3)}`],
    ['JSON password', `{"db_password": "hunter2-hunter2"}`],
    ['credential URL', 'redis://default:s3cr3tPassw0rd@cache.internal:6379'],
    ['https userinfo', 'https://deploy:tok3n-value-12345@git.example.com/repo.git'],
  ])('redacts %s', (_name, text) => {
    const out = redactSecrets(text);
    expect(out).toContain('[REDACTED]');
    expect(containsSecret(out)).toBe(false);
  });

  it.each([
    'const password = process.env.DB_PASSWORD;',
    'token: ${{ secrets.GITHUB_TOKEN }}',
    'if (!apiKey) throw new Error("missing api key");',
    'const tokenizer = new Tokenizer();',
    'password_min_length: 12',
    'https://github.com/org/repo/pull/1',
    'postgres://localhost:5432/db',
  ])('preserves ordinary code: %s', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('containsSecret', () => {
  it('is stateless across repeated calls (no global lastIndex leakage)', () => {
    const text = `leaked ${FAKE.stripe}`;
    for (let i = 0; i < 5; i += 1) expect(containsSecret(text)).toBe(true);
  });

  it('returns false for redacted or ordinary text', () => {
    expect(containsSecret('api_key: [REDACTED]')).toBe(false);
    expect(containsSecret('Review the session expiry logic')).toBe(false);
  });
});
