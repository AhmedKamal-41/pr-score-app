import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { assertDisposable, TEST_DATABASE_URL, TEST_REDIS_URL } from '../helpers/env.js';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Prepare the disposable test database and Redis. Guarded by assertDisposable:
 * only a loopback (or CI) database whose name ends in _test is ever touched.
 */
export default async function setup() {
  assertDisposable(TEST_DATABASE_URL, 'database');
  assertDisposable(TEST_REDIS_URL, 'redis');

  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const admin = new PrismaClient({ datasourceUrl: Object.assign(new URL(url.toString()), { pathname: '/postgres' }).toString() });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    throw new Error(
      `Cannot prepare the test database at ${url.host}. Start the test services with ` +
        '`pnpm test-services:up` (docker compose -f docker-compose.test.yml up -d --wait).\n' +
        String(err),
    );
  } finally {
    await admin.$disconnect();
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });

  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.flushdb();
  } catch (err) {
    throw new Error(`Cannot reach the test Redis at ${TEST_REDIS_URL}. Run \`pnpm test-services:up\`.\n${String(err)}`);
  } finally {
    redis.disconnect();
  }
}
