import { loadConfig, EXAMPLE_ADMIN_PASSWORD_HASH, type AppConfig } from '../../src/config/env.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './env.js';

export const TEST_ADMIN = { username: 'admin', password: 'local-dev-password-change-me' };
export const TEST_WEBHOOK_SECRET = 'integration-test-webhook-secret';
export const TEST_ORIGIN = 'http://localhost:3000';

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    FRONTEND_URL: TEST_ORIGIN,
    ADMIN_USERNAME: TEST_ADMIN.username,
    ADMIN_PASSWORD_HASH: EXAMPLE_ADMIN_PASSWORD_HASH,
    ...overrides,
  });
}

export function liveGithubEnv(opts: { apiUrl: string; privateKey: string; appId: number; installations: number[] }) {
  return {
    GITHUB_ENABLED: 'true',
    GITHUB_APP_ID: String(opts.appId),
    GITHUB_PRIVATE_KEY: opts.privateKey.replace(/\n/g, '\\n'),
    GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    GITHUB_API_URL: opts.apiUrl,
    WORKSPACE_INSTALLATION_IDS: opts.installations.join(','),
  };
}
