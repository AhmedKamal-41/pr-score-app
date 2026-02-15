import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redaction.js';

describe('redactSecrets', () => {
  it('should redact API keys', () => {
    const text = 'api_key: sk_live_EXAMPLE_KEY_NOT_REAL_123456789012';
    const result = redactSecrets(text);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('123456789012345678901234');
  });

  it('should redact JWT tokens', () => {
    const text = 'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redactSecrets(text);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('should redact passwords', () => {
    const text = 'password: mySecretPassword123';
    const result = redactSecrets(text);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('mySecretPassword123');
  });

  it('should redact private keys (PEM format)', () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890
-----END RSA PRIVATE KEY-----`;
    const result = redactSecrets(text);
    expect(result).toBe('[REDACTED]');
  });

  it('should redact EC private keys', () => {
    const text = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEI1234567890
-----END EC PRIVATE KEY-----`;
    const result = redactSecrets(text);
    expect(result).toBe('[REDACTED]');
  });

  it('should redact database connection strings with passwords', () => {
    const text = 'postgresql://user:secretpassword@localhost:5432/db';
    const result = redactSecrets(text);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('secretpassword');
  });

  it('should redact OAuth secrets', () => {
    const text = 'client_secret: abc123def456ghi789jkl012mno345pqr678';
    const result = redactSecrets(text);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('abc123def456ghi789jkl012mno345pqr678');
  });

  it('should handle multiline secrets', () => {
    const text = `Some code here
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890
abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----
More code here`;
    const result = redactSecrets(text);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('MIIEpAIBAAKCAQEA1234567890');
  });

  it('should not redact normal code', () => {
    const text = `function authenticate(user, password) {
  return user === 'admin' && password === 'admin';
}`;
    const result = redactSecrets(text);
    expect(result).toBe(text); // Should remain unchanged
  });

  it('should handle empty strings', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('should handle null/undefined', () => {
    expect(redactSecrets(null as any)).toBe(null);
    expect(redactSecrets(undefined as any)).toBe(undefined);
  });

  it('should redact AWS access keys', () => {
    const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(text);
    expect(result).toContain('[REDACTED]');
  });

  it('should redact Google API keys', () => {
    const text = 'AIzaSyDaGmWKaVPJsA5j5q9K7Z7Z7Z7Z7Z7Z7Z7Z7Z7';
    const result = redactSecrets(text);
    expect(result).toContain('[REDACTED]');
  });
});

