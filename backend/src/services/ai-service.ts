import pino from 'pino';
import { ScoringResult } from '../scoring/rules.js';
import { PrDetails } from './github-api.js';
import { generateAiAnalysis } from '../ai/client.js';
import { selectRiskyFiles } from '../ai/file-selector.js';
import { fetchPrFileDiffs } from './github-api.js';
import { prisma } from '../lib/prisma.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const PROMPT_VERSION = 'v1';

/**
 * Generate and save AI analysis for a PR
 */
export async function generateAndSaveAnalysis(
  pullRequestId: string,
  scoreResult: ScoringResult,
  prDetails: PrDetails,
  installationId: number
): Promise<void> {
  // Check if AI is enabled
  if (process.env.AI_ENABLED !== 'true') {
    logger.debug('AI analysis disabled (AI_ENABLED != true)');
    return;
  }

  try {
    const { owner, name } = extractOwnerAndRepo(prDetails.changed_files_list[0] || '');
    if (!owner || !name) {
      // Try to get from PR details if available
      logger.warn('Could not extract owner/repo for AI analysis');
      return;
    }

    // Get PR number from database
    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });

    if (!pr) {
      logger.warn({ pullRequestId }, 'PR not found for AI analysis');
      return;
    }

    const prNumber = Number(pr.github_pr_id);

    // Build file churn map
    const fileChurn = new Map<string, { additions: number; deletions: number }>();
    // We don't have per-file churn from PrDetails, so we'll fetch it from GitHub
    // For now, use equal distribution as fallback
    const avgChurn = {
      additions: Math.floor(prDetails.additions / prDetails.changed_files) || 0,
      deletions: Math.floor(prDetails.deletions / prDetails.changed_files) || 0,
    };
    prDetails.changed_files_list.forEach((file) => {
      fileChurn.set(file, avgChurn);
    });

    // Select top 3 risky files
    const riskyFiles = selectRiskyFiles(prDetails.changed_files_list, fileChurn);
    const riskyFilePaths = riskyFiles.map((f) => f.filename);

    if (riskyFilePaths.length === 0) {
      logger.debug('No risky files to analyze');
      return;
    }

    // Fetch file diffs
    logger.info(
      { pullRequestId, riskyFiles: riskyFilePaths },
      'Fetching diffs for risky files'
    );
    const fileDiffs = await fetchPrFileDiffs(
      owner,
      name,
      prNumber,
      installationId,
      riskyFilePaths
    );

    // Build AI input
    const aiInput = {
      score: scoreResult.score,
      level: scoreResult.level,
      reasons: scoreResult.reasons,
      changed_files: prDetails.changed_files_list,
      file_diffs: fileDiffs.map((diff) => ({
        filename: diff.filename,
        patch: diff.patch || '',
        additions: diff.additions,
        deletions: diff.deletions,
      })),
    };

    // Generate AI analysis
    logger.info({ pullRequestId }, 'Generating AI analysis');
    const result = await generateAiAnalysis(aiInput);

    if (!result.success || !result.output) {
      logger.warn(
        { pullRequestId, error: result.error },
        'AI analysis generation failed'
      );
      return;
    }

    // Save to database
    const model = process.env.AI_MODEL || 'gpt-4o-mini';
    await prisma.prAiAnalysis.create({
      data: {
        pull_request_id: pullRequestId,
        analysis_json: result.output,
        model,
        prompt_version: PROMPT_VERSION,
      },
    });

    logger.info(
      { pullRequestId, model, prompt_version: PROMPT_VERSION },
      'AI analysis saved to database'
    );
  } catch (error: any) {
    // Don't throw - log and continue
    logger.error(
      {
        pullRequestId,
        error: error.message,
        stack: error.stack,
      },
      'Error generating AI analysis'
    );
  }
}

/**
 * Extract owner and repo from full_name or file path
 * This is a fallback - ideally we'd have this from the PR context
 */
function extractOwnerAndRepo(fullNameOrPath: string): { owner: string; name: string } | null {
  // This is a simplified extractor - in practice, we should get this from the PR context
  // For now, return null and let the caller handle it
  return null;
}

/**
 * Generate and save AI analysis with explicit owner/repo
 */
export async function generateAndSaveAnalysisWithContext(
  pullRequestId: string,
  scoreResult: ScoringResult,
  prDetails: PrDetails,
  owner: string,
  name: string,
  prNumber: number,
  installationId: number
): Promise<void> {
  // Check if AI is enabled
  if (process.env.AI_ENABLED !== 'true') {
    logger.debug('AI analysis disabled (AI_ENABLED != true)');
    return;
  }

  try {
    // Build file churn map from GitHub API (fetch all files first to get churn)
    const allFileDiffs = await fetchPrFileDiffs(owner, name, prNumber, installationId, prDetails.changed_files_list);
    const fileChurn = new Map<string, { additions: number; deletions: number }>();
    allFileDiffs.forEach((diff) => {
      fileChurn.set(diff.filename, {
        additions: diff.additions,
        deletions: diff.deletions,
      });
    });

    // Select top 3 risky files
    const riskyFiles = selectRiskyFiles(prDetails.changed_files_list, fileChurn);
    const riskyFilePaths = riskyFiles.map((f) => f.filename);

    if (riskyFilePaths.length === 0) {
      logger.debug('No risky files to analyze');
      return;
    }

    // Fetch file diffs for risky files only
    logger.info(
      { pullRequestId, riskyFiles: riskyFilePaths },
      'Fetching diffs for risky files'
    );
    const riskyFileDiffs = await fetchPrFileDiffs(
      owner,
      name,
      prNumber,
      installationId,
      riskyFilePaths
    );

    // Build AI input
    const aiInput = {
      score: scoreResult.score,
      level: scoreResult.level,
      reasons: scoreResult.reasons,
      changed_files: prDetails.changed_files_list,
      file_diffs: riskyFileDiffs.map((diff) => ({
        filename: diff.filename,
        patch: diff.patch || '',
        additions: diff.additions,
        deletions: diff.deletions,
      })),
    };

    // Generate AI analysis
    logger.info({ pullRequestId }, 'Generating AI analysis');
    const result = await generateAiAnalysis(aiInput);

    if (!result.success || !result.output) {
      logger.warn(
        { pullRequestId, error: result.error },
        'AI analysis generation failed'
      );
      return;
    }

    // Save to database
    const model = process.env.AI_MODEL || 'gpt-4o-mini';
    await prisma.prAiAnalysis.create({
      data: {
        pull_request_id: pullRequestId,
        analysis_json: result.output,
        model,
        prompt_version: PROMPT_VERSION,
      },
    });

    logger.info(
      { pullRequestId, model, prompt_version: PROMPT_VERSION },
      'AI analysis saved to database'
    );
  } catch (error: any) {
    // Don't throw - log and continue
    logger.error(
      {
        pullRequestId,
        error: error.message,
        stack: error.stack,
      },
      'Error generating AI analysis'
    );
  }
}

