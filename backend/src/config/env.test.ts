import { describe, it, expect } from 'vitest';
import { ConfigError, EXAMPLE_ADMIN_PASSWORD_HASH, isInWorkspace, loadConfig } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  ADMIN_PASSWORD_HASH: EXAMPLE_ADMIN_PASSWORD_HASH,
};
const PEM = '-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJBAK\\n-----END RSA PRIVATE KEY-----';
const live = {
  ...base,
  GITHUB_ENABLED: 'true',
  GITHUB_APP_ID: '123',
  GITHUB_PRIVATE_KEY: PEM,
  GITHUB_WEBHOOK_SECRET: 'a-long-webhook-secret',
  WORKSPACE_INSTALLATION_IDS: '42, 43',
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe('loadConfig', () => {
  it('works in local mode without GitHub or OpenAI credentials', () => {
    const config = loadConfig(base);
    expect(config.github.enabled).toBe(false);
    expect(config.ai.enabled).toBe(false);
    expect(config.github.postComments).toBe(false);
    expect(config.demoEnabled).toBe(false);
  });

  it('treats blank values as unset (as written by .env.example)', () => {
    const config = loadConfig({ ...base, OPENAI_BASE_URL: '', GITHUB_APP_ID: '', WORKSPACE_INSTALLATION_IDS: ' ', PORT: '' });
    expect(config.ai.baseUrl).toBeNull();
    expect(config.port).toBe(4000);
    expect(config.github.installationIds).toEqual([]);
  });

  it('accepts the shipped backend/.env.example as-is', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('dotenv');
    const env = parse(readFileSync(new URL('../../.env.example', import.meta.url)));
    const config = loadConfig(env);
    expect(config.github.enabled).toBe(false);
    expect(config.demoEnabled).toBe(true);
    expect(config.auth.passwordHash).toBe(EXAMPLE_ADMIN_PASSWORD_HASH);
  });

  it('requires an admin password hash', () => {
    expect(problems({ DATABASE_URL: base.DATABASE_URL })).toEqual([expect.stringContaining('ADMIN_PASSWORD_HASH is required')]);
    expect(problems({ ...base, ADMIN_PASSWORD_HASH: 'plaintext' })[0]).toContain('auth:hash-password');
  });

  it('lists every missing live GitHub setting clearly', () => {
    const list = problems({ ...base, GITHUB_ENABLED: 'true' });
    expect(list.join('\n')).toMatch(/GITHUB_APP_ID/);
    expect(list.join('\n')).toMatch(/GITHUB_PRIVATE_KEY/);
    expect(list.join('\n')).toMatch(/GITHUB_WEBHOOK_SECRET/);
    expect(list.join('\n')).toMatch(/WORKSPACE_INSTALLATION_IDS/);
  });

  it('parses live configuration and unescapes PEM newlines', () => {
    const config = loadConfig(live);
    expect(config.github.enabled).toBe(true);
    expect(config.github.privateKey).toContain('\nMIIBOgIBAAJBAK\n');
    expect(config.github.installationIds).toEqual([42n, 43n]);
  });

  it('rejects AI or comments without their prerequisites', () => {
    expect(problems({ ...base, AI_ENABLED: 'true' })).toEqual([expect.stringContaining('OPENAI_API_KEY')]);
    expect(problems({ ...base, GITHUB_POST_COMMENTS: 'true' })[0]).toContain('GITHUB_POST_COMMENTS=true requires');
  });

  it('enforces production safety', () => {
    const list = problems({ ...live, NODE_ENV: 'production', DEMO_ENABLED: 'true', FRONTEND_URL: 'http://dash.example.com' });
    expect(list.join('\n')).toMatch(/published example hash/);
    expect(list.join('\n')).toMatch(/DEMO_ENABLED/);
    expect(list.join('\n')).toMatch(/https:\/\//);
  });

  it('defaults GitHub to enabled in production', () => {
    expect(problems({ ...base, NODE_ENV: 'production', FRONTEND_URL: 'https://dash.example.com' }).join('\n')).toMatch(/GITHUB_APP_ID/);
  });

  it('rejects malformed installation ids', () => {
    expect(problems({ ...live, WORKSPACE_INSTALLATION_IDS: '42,abc' })[0]).toContain('invalid installation id');
  });
});

describe('isInWorkspace', () => {
  it('requires an allowed installation and, if configured, an allowed repository', () => {
    const config = loadConfig({ ...live, WORKSPACE_REPOSITORIES: 'Org/App' });
    expect(isInWorkspace(config, 42, 'org/app')).toBe(true);
    expect(isInWorkspace(config, 42, 'org/other')).toBe(false);
    expect(isInWorkspace(config, 99, 'org/app')).toBe(false);
    expect(isInWorkspace(config, null)).toBe(false);
  });
});
