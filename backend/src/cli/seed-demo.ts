import 'dotenv/config';
import { createPrisma } from '../lib/prisma.js';
import { seedDemoData } from '../demo/seed.js';

/**
 * Deterministic demo data: `pnpm --filter backend db:seed` (also `prisma db seed`).
 * Refuses to run with NODE_ENV=production. Safe to run repeatedly.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const prisma = createPrisma(process.env.DATABASE_URL);
try {
  const result = await seedDemoData(prisma);
  console.log(`Demo data ready: ${result.repositories} repositories, ${result.pull_requests} PRs, ${result.new_scores} new scores`);
} finally {
  await prisma.$disconnect();
}
