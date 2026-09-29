/**
 * Connection settings for the disposable test services
 * (docker-compose.test.yml, or the CI service containers).
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55432/pr_risk_scorer_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/1';

/** Refuse to touch anything that is not clearly a disposable test service. */
export function assertDisposable(url: string, kind: 'database' | 'redis'): void {
  const u = new URL(url);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  if (!loopback && process.env.CI !== 'true') {
    throw new Error(`Refusing to use non-loopback ${kind} ${u.hostname} for tests outside CI`);
  }
  if (kind === 'database' && !u.pathname.replace('/', '').endsWith('_test') && !u.pathname.includes('_test_')) {
    throw new Error(`Refusing to use database "${u.pathname}" for tests: its name must end with _test`);
  }
}
