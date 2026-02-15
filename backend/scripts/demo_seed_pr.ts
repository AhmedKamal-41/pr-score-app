import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { computeScore } from '../src/scoring/rules.js';
import { savePrScore } from '../src/services/score-service.js';

const prisma = new PrismaClient();

interface DemoPRData {
  title: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  additions: number;
  deletions: number;
  changed_files: number;
  changed_files_list: string[];
  base_ref: string;
  head_ref: string;
  merged_at?: Date;
}

/**
 * Generate demo PRs with varied risk levels
 */
export async function seedDemoPRs(): Promise<number> {
  // Create demo repositories
  const repos = [
    {
      github_repo_id: BigInt(1000001),
      full_name: 'acme/webapp',
      owner: 'acme',
      name: 'webapp',
      installation_id: BigInt(2000001),
    },
    {
      github_repo_id: BigInt(1000002),
      full_name: 'acme/api',
      owner: 'acme',
      name: 'api',
      installation_id: BigInt(2000002),
    },
    {
      github_repo_id: BigInt(1000003),
      full_name: 'acme/infrastructure',
      owner: 'acme',
      name: 'infrastructure',
      installation_id: BigInt(2000003),
    },
  ];

  // Upsert repositories
  const createdRepos = [];
  for (const repoData of repos) {
    const repo = await prisma.repo.upsert({
      where: { github_repo_id: repoData.github_repo_id },
      update: {},
      create: repoData,
    });
    createdRepos.push(repo);
  }

  // Define 10 diverse PR scenarios
  const prScenarios: DemoPRData[] = [
    // LOW RISK PRs (3-4)
    {
      title: 'Add unit tests for user service',
      author: 'alice-dev',
      state: 'open',
      additions: 120,
      deletions: 5,
      changed_files: 3,
      changed_files_list: [
        'src/services/user.test.ts',
        'src/services/user.ts',
        'src/utils/helpers.test.ts',
      ],
      base_ref: 'main',
      head_ref: 'feature/add-user-tests',
    },
    {
      title: 'Fix typo in README',
      author: 'bob-contributor',
      state: 'merged',
      additions: 2,
      deletions: 2,
      changed_files: 1,
      changed_files_list: ['README.md'],
      base_ref: 'main',
      head_ref: 'fix/readme-typo',
      merged_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
    {
      title: 'Update dependencies',
      author: 'charlie-maintainer',
      state: 'open',
      additions: 15,
      deletions: 10,
      changed_files: 2,
      changed_files_list: ['package.json', 'package-lock.json'],
      base_ref: 'main',
      head_ref: 'chore/update-deps',
    },
    {
      title: 'Add loading spinner component',
      author: 'diana-frontend',
      state: 'merged',
      additions: 85,
      deletions: 0,
      changed_files: 2,
      changed_files_list: [
        'src/components/LoadingSpinner.tsx',
        'src/components/LoadingSpinner.test.tsx',
      ],
      base_ref: 'main',
      head_ref: 'feature/loading-spinner',
      merged_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    },

    // MEDIUM RISK PRs (4-5)
    {
      title: 'Refactor authentication middleware',
      author: 'eve-backend',
      state: 'open',
      additions: 250,
      deletions: 180,
      changed_files: 8,
      changed_files_list: [
        'src/middleware/auth.ts',
        'src/middleware/auth.test.ts',
        'src/utils/jwt.ts',
        'src/config/auth.ts',
        'src/types/auth.ts',
      ],
      base_ref: 'main',
      head_ref: 'refactor/auth-middleware',
    },
    {
      title: 'Add payment processing endpoint',
      author: 'frank-api',
      state: 'open',
      additions: 320,
      deletions: 50,
      changed_files: 12,
      changed_files_list: [
        'src/routes/payments.ts',
        'src/services/payment.ts',
        'src/services/payment.test.ts',
        'src/types/payment.ts',
        'src/utils/validation.ts',
      ],
      base_ref: 'main',
      head_ref: 'feature/payment-endpoint',
    },
    {
      title: 'Update CI/CD configuration',
      author: 'grace-devops',
      state: 'open',
      additions: 180,
      deletions: 120,
      changed_files: 6,
      changed_files_list: [
        '.github/workflows/ci.yml',
        '.github/workflows/deploy.yml',
        'Dockerfile',
        'docker-compose.yml',
      ],
      base_ref: 'main',
      head_ref: 'chore/update-ci',
    },
    {
      title: 'Migrate database schema',
      author: 'henry-db',
      state: 'open',
      additions: 400,
      deletions: 200,
      changed_files: 15,
      changed_files_list: [
        'prisma/migrations/20240115_add_users/migration.sql',
        'prisma/schema.prisma',
        'src/lib/db.ts',
        'src/models/user.ts',
      ],
      base_ref: 'main',
      head_ref: 'feature/db-migration',
    },
    {
      title: 'Add feature flags system',
      author: 'ivy-platform',
      state: 'merged',
      additions: 280,
      deletions: 30,
      changed_files: 10,
      changed_files_list: [
        'src/services/feature-flags.ts',
        'src/services/feature-flags.test.ts',
        'src/config/flags.ts',
        'src/middleware/flags.ts',
      ],
      base_ref: 'main',
      head_ref: 'feature/feature-flags',
      merged_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    },

    // HIGH RISK PRs (2-3)
    {
      title: 'Major refactor: Rewrite authentication system',
      author: 'jack-senior',
      state: 'open',
      additions: 1200,
      deletions: 800,
      changed_files: 45,
      changed_files_list: [
        'src/auth/login.ts',
        'src/auth/session.ts',
        'src/auth/middleware.ts',
        'src/auth/utils.ts',
        'src/auth/types.ts',
        'src/services/user.ts',
        'src/config/auth.ts',
        // ... many more files
        ...Array.from({ length: 38 }, (_, i) => `src/auth/file${i}.ts`),
      ],
      base_ref: 'main',
      head_ref: 'refactor/auth-system',
    },
    {
      title: 'Implement payment gateway integration',
      author: 'karen-payments',
      state: 'open',
      additions: 1500,
      deletions: 200,
      changed_files: 55,
      changed_files_list: [
        'src/payments/stripe.ts',
        'src/payments/paypal.ts',
        'src/payments/billing.ts',
        'src/payments/invoice.ts',
        'src/services/payment.ts',
        'src/config/payments.ts',
        // ... many more files
        ...Array.from({ length: 49 }, (_, i) => `src/payments/module${i}.ts`),
      ],
      base_ref: 'main',
      head_ref: 'feature/payment-gateway',
    },
  ];

  let prsCreated = 0;

  // Create PRs and scores
  for (let i = 0; i < prScenarios.length; i++) {
    const scenario = prScenarios[i];
    const repo = createdRepos[i % createdRepos.length];
    const githubPrId = BigInt(1000 + i + 1);

    // Generate a unique SHA
    const headSha = randomBytes(20).toString('hex');

    // Create PR
    const pr = await prisma.pullRequest.upsert({
      where: { github_pr_id: githubPrId },
      update: {
        title: scenario.title,
        state: scenario.state,
        author: scenario.author,
        additions: scenario.additions,
        deletions: scenario.deletions,
        changed_files: scenario.changed_files,
        changed_files_list: scenario.changed_files_list,
        head_sha: headSha,
        base_ref: scenario.base_ref,
        head_ref: scenario.head_ref,
        merged_at: scenario.merged_at,
      },
      create: {
        repo_id: repo.id,
        github_pr_id: githubPrId,
        title: scenario.title,
        state: scenario.state,
        author: scenario.author,
        additions: scenario.additions,
        deletions: scenario.deletions,
        changed_files: scenario.changed_files,
        changed_files_list: scenario.changed_files_list,
        head_sha: headSha,
        base_ref: scenario.base_ref,
        head_ref: scenario.head_ref,
        merged_at: scenario.merged_at,
      },
    });

    // Compute score
    const scoreResult = computeScore({
      changed_files: scenario.changed_files,
      additions: scenario.additions,
      deletions: scenario.deletions,
      changed_files_list: scenario.changed_files_list,
      ci_status: 'unknown',
    });

    // Save score
    await savePrScore({
      pullRequestId: pr.id,
      scoreResult,
    });

    prsCreated++;
  }

  return prsCreated;
}

// If run directly (not imported), execute seed
if (import.meta.url === `file://${process.argv[1]}`) {
  seedDemoPRs()
    .then((count) => {
      console.log(`✅ Created ${count} demo PRs`);
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Failed to seed demo PRs:', error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

