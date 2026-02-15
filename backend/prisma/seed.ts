import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create a sample repo
  const repo = await prisma.repo.upsert({
    where: { github_repo_id: BigInt(123456789) },
    update: {},
    create: {
      github_repo_id: BigInt(123456789),
      full_name: 'example-org/example-repo',
      owner: 'example-org',
      name: 'example-repo',
      installation_id: BigInt(987654321),
      private: false,
    },
  });

  console.log('✅ Created repo:', repo.full_name);

  // Create a sample pull request
  const pullRequest = await prisma.pullRequest.upsert({
    where: { github_pr_id: BigInt(1) },
    update: {},
    create: {
      repo_id: repo.id,
      github_pr_id: BigInt(1),
      title: 'Add new feature',
      state: 'open',
      author: 'octocat',
      head_sha: 'abc123def456',
      base_ref: 'main',
      head_ref: 'feature/new-feature',
    },
  });

  console.log('✅ Created pull request:', pullRequest.title);

  // Create a sample PR score
  const prScore = await prisma.prScore.create({
    data: {
      pull_request_id: pullRequest.id,
      score: 45.5,
      level: 'medium',
      reasons: [
        {
          type: 'large_pr',
          message: 'PR has 50+ changed files',
          severity: 'medium',
        },
        {
          type: 'new_contributor',
          message: 'Author has less than 5 contributions',
          severity: 'low',
        },
      ],
      features: {
        files_changed: 52,
        lines_added: 1234,
        lines_deleted: 567,
        commits_count: 8,
        reviewers_count: 2,
        is_draft: false,
        has_conflicts: false,
      },
    },
  });

  console.log('✅ Created PR score:', prScore.id);

  // Create another repo and PR for more sample data
  const repo2 = await prisma.repo.upsert({
    where: { github_repo_id: BigInt(987654321) },
    update: {},
    create: {
      github_repo_id: BigInt(987654321),
      full_name: 'another-org/another-repo',
      owner: 'another-org',
      name: 'another-repo',
      installation_id: BigInt(111222333),
      private: true,
    },
  });

  const pullRequest2 = await prisma.pullRequest.upsert({
    where: { github_pr_id: BigInt(2) },
    update: {},
    create: {
      repo_id: repo2.id,
      github_pr_id: BigInt(2),
      title: 'Fix critical bug',
      state: 'merged',
      author: 'developer',
      head_sha: 'def456ghi789',
      base_ref: 'main',
      head_ref: 'fix/critical-bug',
      merged_at: new Date(),
    },
  });

  const prScore2 = await prisma.prScore.create({
    data: {
      pull_request_id: pullRequest2.id,
      score: 15.2,
      level: 'low',
      reasons: [
        {
          type: 'small_pr',
          message: 'PR has less than 10 changed files',
          severity: 'low',
        },
        {
          type: 'experienced_contributor',
          message: 'Author has 100+ contributions',
          severity: 'low',
        },
      ],
      features: {
        files_changed: 3,
        lines_added: 45,
        lines_deleted: 12,
        commits_count: 1,
        reviewers_count: 3,
        is_draft: false,
        has_conflicts: false,
      },
    },
  });

  console.log('✅ Created additional sample data');
  console.log('🎉 Seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

