import 'dotenv/config';
import { createPrisma } from '../lib/prisma.js';

/**
 * Report pre-migration PR rows whose identity and history cannot be verified.
 *
 * Before migration 20260929000000 the PR number was stored as a globally
 * unique id. When two repositories had the same PR number, the second one
 * overwrote the first row's metadata and appended scores/AI analyses to it.
 * The database does not record which repository each overwritten value or
 * score came from, so such damage cannot be repaired automatically; this
 * report lists what is potentially affected so a person can decide.
 *
 *   pnpm --filter backend report:legacy-identity
 */
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const prisma = createPrisma(process.env.DATABASE_URL);
try {
  const repoCount = await prisma.repo.count({ where: { is_demo: false } });
  const legacy = await prisma.pullRequest.findMany({
    where: { OR: [{ identity_status: { not: 'verified' } }, { scores: { some: { scoring_version: 'legacy' } } }] },
    include: {
      repo: { select: { full_name: true } },
      _count: { select: { scores: true, ai_analyses: true } },
      scores: { where: { scoring_version: 'legacy' }, select: { id: true } },
    },
    orderBy: [{ number: 'asc' }, { id: 'asc' }],
  });

  console.log(`Non-demo repositories: ${repoCount}`);
  console.log(`PRs with legacy identity or legacy history: ${legacy.length}`);
  if (repoCount > 1 && legacy.length > 0) {
    console.log(
      'More than one repository exists, so any legacy row may have been overwritten by a same-numbered PR from another repository. ' +
        'Treat legacy scores/analyses on these rows as unverified.',
    );
  }
  console.log(['pr_uuid', 'repository', 'number', 'legacy_github_pr_id', 'identity_status', 'legacy_scores', 'total_scores', 'ai_analyses', 'potential_cross_repo_collision'].join('\t'));
  for (const pr of legacy) {
    console.log(
      [
        pr.id,
        pr.repo.full_name,
        pr.number ?? '-',
        pr.github_pr_id ?? '-',
        pr.identity_status,
        pr.scores.length,
        pr._count.scores,
        pr._count.ai_analyses,
        repoCount > 1 ? 'yes' : 'no',
      ].join('\t'),
    );
  }
} finally {
  await prisma.$disconnect();
}
