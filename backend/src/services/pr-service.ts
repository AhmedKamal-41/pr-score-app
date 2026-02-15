import { prisma } from '../lib/prisma.js';
import { PrDetails } from './github-api.js';

export interface UpsertPrParams {
  owner: string;
  name: string;
  fullName: string;
  githubRepoId: bigint;
  installationId: bigint;
  githubPrId: bigint;
  prDetails: PrDetails;
}

/**
 * Upsert PR record by repo + PR number
 * First upserts Repo if needed, then upserts PullRequest
 */
export async function upsertPullRequest(
  params: UpsertPrParams
): Promise<void> {
  const {
    owner,
    name,
    fullName,
    githubRepoId,
    installationId,
    githubPrId,
    prDetails,
  } = params;

  await prisma.$transaction(async (tx) => {
    // Upsert Repo first
    const repo = await tx.repo.upsert({
      where: { github_repo_id: githubRepoId },
      update: {
        full_name: fullName,
        owner,
        name,
        installation_id: installationId,
        updated_at: new Date(),
      },
      create: {
        github_repo_id: githubRepoId,
        full_name: fullName,
        owner,
        name,
        installation_id: installationId,
        private: false, // Default, can be updated later if needed
      },
    });

    // Upsert PullRequest
    await tx.pullRequest.upsert({
      where: { github_pr_id: githubPrId },
      update: {
        title: prDetails.title,
        state: prDetails.state,
        author: prDetails.author,
        head_sha: prDetails.head_sha,
        base_ref: prDetails.base_ref,
        head_ref: prDetails.head_ref,
        additions: prDetails.additions,
        deletions: prDetails.deletions,
        changed_files: prDetails.changed_files,
        changed_files_list: prDetails.changed_files_list,
        merged_at: prDetails.merged_at ? new Date(prDetails.merged_at) : null,
        updated_at: new Date(),
      },
      create: {
        repo_id: repo.id,
        github_pr_id: githubPrId,
        title: prDetails.title,
        state: prDetails.state,
        author: prDetails.author,
        head_sha: prDetails.head_sha,
        base_ref: prDetails.base_ref,
        head_ref: prDetails.head_ref,
        additions: prDetails.additions,
        deletions: prDetails.deletions,
        changed_files: prDetails.changed_files,
        changed_files_list: prDetails.changed_files_list,
        merged_at: prDetails.merged_at ? new Date(prDetails.merged_at) : null,
      },
    });
  });
}

