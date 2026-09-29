import { PrismaClient } from '@prisma/client';
import { assertDisposable, TEST_DATABASE_URL } from './env.js';

assertDisposable(TEST_DATABASE_URL, 'database');

export function createTestPrisma(url: string = TEST_DATABASE_URL): PrismaClient {
  assertDisposable(url, 'database');
  return new PrismaClient({ datasourceUrl: url, log: ['error'] });
}

const TABLES = [
  'pr_ai_analyses',
  'pr_scores',
  'analysis_runs',
  'pull_requests',
  'repos',
  'webhook_deliveries',
  'processing_leases',
  'admin_sessions',
];

/** Empty every application table of the disposable test database. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
