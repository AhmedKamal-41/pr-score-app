import { Worker } from 'bullmq';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const isDevelopment = process.env.NODE_ENV === 'development';

// Configure logger
const logger = isDevelopment
  ? pino({
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          colorize: true,
        },
      },
    })
  : pino({
      level: process.env.LOG_LEVEL || 'info',
    });

// Create Redis connection
const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Import job data type and services
import { ScorePrJobData } from './lib/queue.js';
import { fetchPrDetails } from './services/github-api.js';
import { upsertPullRequest } from './services/pr-service.js';
import { savePrScore } from './services/score-service.js';
import { createAuthenticatedOctokit } from './lib/github-auth.js';
import { computeScore } from './scoring/rules.js';
import { prisma } from './lib/prisma.js';
import { generateAndSaveAnalysisWithContext } from './services/ai-service.js';
import { postPrComment } from './services/github-comments.js';

// Create worker
const worker = new Worker<ScorePrJobData>(
  'score_pr',
  async (job) => {
    const { owner, name, pr_number, installation_id, delivery_id } = job.data;

    logger.info(
      {
        jobId: job.id,
        owner,
        name,
        pr_number,
        installation_id,
        delivery_id,
        attempt: job.attemptsMade + 1,
      },
      'Processing score_pr job'
    );

    // Check if installation_id is present (required for GitHub App auth)
    if (!installation_id) {
      throw new Error(
        `Installation ID is required but missing for ${owner}/${name}#${pr_number}`
      );
    }

    try {
      // Fetch repository details to get github_repo_id
      const octokit = await createAuthenticatedOctokit(installation_id);
      const { data: repo } = await octokit.rest.repos.get({
        owner,
        repo: name,
      });

      const githubRepoId = BigInt(repo.id);
      const fullName = repo.full_name;

      // Fetch PR details from GitHub API
      logger.info(
        {
          jobId: job.id,
          owner,
          name,
          pr_number,
        },
        'Fetching PR details from GitHub API'
      );

      const prDetails = await fetchPrDetails(
        owner,
        name,
        pr_number,
        installation_id
      );

      logger.info(
        {
          jobId: job.id,
          title: prDetails.title,
          additions: prDetails.additions,
          deletions: prDetails.deletions,
          changed_files: prDetails.changed_files,
        },
        'PR details fetched successfully'
      );

      // Store PR record in database
      await upsertPullRequest({
        owner,
        name,
        fullName,
        githubRepoId,
        installationId: BigInt(installation_id),
        githubPrId: BigInt(pr_number),
        prDetails,
      });

      logger.info(
        {
          jobId: job.id,
          owner,
          name,
          pr_number,
        },
        'PR record stored in database'
      );

      // Get the stored PR to get its ID
      const storedPr = await prisma.pullRequest.findUnique({
        where: { github_pr_id: BigInt(pr_number) },
      });

      if (!storedPr) {
        throw new Error(`Failed to retrieve stored PR ${owner}/${name}#${pr_number}`);
      }

      // Compute PR risk score
      logger.info(
        {
          jobId: job.id,
          owner,
          name,
          pr_number,
        },
        'Computing PR risk score'
      );

      const scoreResult = computeScore({
        changed_files: prDetails.changed_files,
        additions: prDetails.additions,
        deletions: prDetails.deletions,
        changed_files_list: prDetails.changed_files_list,
        ci_status: 'unknown', // TODO: Fetch CI status from GitHub API in future
      });

      logger.info(
        {
          jobId: job.id,
          score: scoreResult.score,
          level: scoreResult.level,
          reasons: scoreResult.reasons,
        },
        'PR score computed'
      );

      // Save score to database
      await savePrScore({
        pullRequestId: storedPr.id,
        scoreResult,
      });

      logger.info(
        {
          jobId: job.id,
          owner,
          name,
          pr_number,
          score: scoreResult.score,
          level: scoreResult.level,
        },
        'PR score saved to database'
      );

      // Generate AI analysis if enabled
      if (process.env.AI_ENABLED === 'true') {
        try {
          await generateAndSaveAnalysisWithContext(
            storedPr.id,
            scoreResult,
            prDetails,
            owner,
            name,
            pr_number,
            installation_id
          );
          logger.info(
            {
              jobId: job.id,
              owner,
              name,
              pr_number,
            },
            'AI analysis completed'
          );

          // Post PR comment if enabled
          if (process.env.GITHUB_POST_COMMENTS === 'true') {
            try {
              // Get latest AI analysis
              const latestAnalysis = await prisma.prAiAnalysis.findFirst({
                where: { pull_request_id: storedPr.id },
                orderBy: { created_at: 'desc' },
              });

              if (latestAnalysis) {
                const aiOutput = latestAnalysis.analysis_json as any;
                await postPrComment(owner, name, pr_number, installation_id, aiOutput);
                logger.info(
                  {
                    jobId: job.id,
                    owner,
                    name,
                    pr_number,
                  },
                  'PR comment posted'
                );
              }
            } catch (error: any) {
              // Don't fail the job on comment errors
              logger.error(
                {
                  jobId: job.id,
                  owner,
                  name,
                  pr_number,
                  error: error.message,
                  stack: error.stack,
                },
                'Failed to post PR comment (non-fatal)'
              );
            }
          }
        } catch (error: any) {
          // Don't fail the job on AI errors
          logger.error(
            {
              jobId: job.id,
              owner,
              name,
              pr_number,
              error: error.message,
              stack: error.stack,
            },
            'AI analysis failed (non-fatal)'
          );
        }
      }

      return {
        processed: true,
        owner,
        name,
        pr_number,
        stored: true,
        scored: true,
        score: scoreResult.score,
        level: scoreResult.level,
      };
    } catch (error: any) {
      logger.error(
        {
          jobId: job.id,
          owner,
          name,
          pr_number,
          error: error.message,
          stack: error.stack,
        },
        'Failed to process PR'
      );
      throw error; // Re-throw to trigger retry mechanism
    }
  },
  {
    connection,
    concurrency: 5, // Process up to 5 jobs concurrently
    limiter: {
      max: 10, // Max 10 jobs
      duration: 1000, // Per second
    },
  }
);

// Worker event handlers
worker.on('completed', (job) => {
  logger.info(
    {
      jobId: job.id,
      duration: Date.now() - job.timestamp,
    },
    'Job completed'
  );
});

worker.on('failed', (job, err) => {
  logger.error(
    {
      jobId: job?.id,
      error: err.message,
      stack: err.stack,
      attempts: job?.attemptsMade,
    },
    'Job failed'
  );
});

worker.on('error', (err) => {
  logger.error(
    {
      error: err.message,
      stack: err.stack,
    },
    'Worker error'
  );
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down worker...');
  await worker.close();
  await connection.quit();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('🚀 Worker started and listening for score_pr jobs');

