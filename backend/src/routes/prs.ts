import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { schemas, safeValidate } from '../utils/validation.js';
import requestContext from '@fastify/request-context';

export async function prsRoute(fastify: FastifyInstance) {
  // GET /api/prs - List PRs with latest score
  fastify.get(
    '/api/prs',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = requestContext.get('requestId') || 'unknown';

      // Validate query parameters
      const queryValidation = safeValidate(schemas.pagination, request.query);
      if (!queryValidation.success) {
        return reply.status(400).send({
          error: {
            message: 'Invalid query parameters',
            code: 'VALIDATION_ERROR',
            requestId,
            details: queryValidation.error.errors.map((err) => ({
              field: err.path.join('.'),
              message: err.message,
            })),
          },
        });
      }

      const { limit, offset } = queryValidation.data;

      try {
        // Get total count
        const total = await prisma.pullRequest.count();

        // Get PRs with their latest score
        // We need to join with pr_scores and get the most recent score for each PR
        const prs = await prisma.pullRequest.findMany({
          take: limit,
          skip: offset,
          orderBy: { created_at: 'desc' },
          include: {
            repo: {
              select: {
                full_name: true,
              },
            },
            scores: {
              orderBy: { created_at: 'desc' },
              take: 1,
              select: {
                score: true,
                level: true,
                reasons: true,
                created_at: true,
              },
            },
          },
        });

        // Format response
        const data = prs.map((pr) => {
          const latestScore = pr.scores[0] || null;
          return {
            id: pr.id,
            github_pr_id: Number(pr.github_pr_id),
            title: pr.title,
            author: pr.author,
            state: pr.state,
            repository: pr.repo.full_name,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
            created_at: pr.created_at.toISOString(),
            latest_score: latestScore
              ? {
                  score: latestScore.score,
                  level: latestScore.level,
                  reasons: latestScore.reasons,
                  created_at: latestScore.created_at.toISOString(),
                }
              : null,
          };
        });

        return reply.send({
          data,
          pagination: {
            limit,
            offset,
            total,
            has_more: offset + limit < total,
          },
        });
      } catch (error: any) {
        fastify.log.error(
          {
            requestId,
            error: error.message,
            stack: error.stack,
          },
          'Failed to fetch PRs'
        );
        return reply.status(500).send({
          error: {
            message: 'Internal server error',
            code: 'INTERNAL_ERROR',
            requestId,
          },
        });
      }
    }
  );

  // GET /api/prs/:id - Get PR details with score history
  fastify.get(
    '/api/prs/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const requestId = requestContext.get('requestId') || 'unknown';

      // Validate path parameter
      const paramsValidation = safeValidate(schemas.idParam, request.params);
      if (!paramsValidation.success) {
        return reply.status(400).send({
          error: {
            message: 'Invalid PR ID',
            code: 'VALIDATION_ERROR',
            requestId,
            details: paramsValidation.error.errors.map((err) => ({
              field: err.path.join('.'),
              message: err.message,
            })),
          },
        });
      }

      const { id } = paramsValidation.data;

      try {
        const pr = await prisma.pullRequest.findUnique({
          where: { id },
          include: {
            repo: {
              select: {
                full_name: true,
              },
            },
            scores: {
              orderBy: { created_at: 'desc' },
              select: {
                score: true,
                level: true,
                reasons: true,
                features: true,
                created_at: true,
              },
            },
            ai_analyses: {
              orderBy: { created_at: 'desc' },
              take: 1,
              select: {
                analysis_json: true,
                model: true,
                prompt_version: true,
                created_at: true,
              },
            },
          },
        });

        if (!pr) {
          return reply.status(404).send({
            error: {
              message: `PR with ID ${id} not found`,
              code: 'NOT_FOUND',
              requestId,
            },
          });
        }

        const latestScore = pr.scores[0] || null;
        const scoreHistory = pr.scores.map((score) => ({
          score: score.score,
          level: score.level,
          created_at: score.created_at.toISOString(),
        }));

        const latestAiAnalysis = pr.ai_analyses[0] || null;

        return reply.send({
          id: pr.id,
          github_pr_id: Number(pr.github_pr_id),
          title: pr.title,
          author: pr.author,
          state: pr.state,
          repository: pr.repo.full_name,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files,
          changed_files_list: pr.changed_files_list,
          head_sha: pr.head_sha,
          base_ref: pr.base_ref,
          head_ref: pr.head_ref,
          created_at: pr.created_at.toISOString(),
          updated_at: pr.updated_at.toISOString(),
          merged_at: pr.merged_at?.toISOString() || null,
          latest_score: latestScore
            ? {
                score: latestScore.score,
                level: latestScore.level,
                reasons: latestScore.reasons,
                features: latestScore.features,
                created_at: latestScore.created_at.toISOString(),
              }
            : null,
          score_history: scoreHistory,
          ai_analysis: latestAiAnalysis
            ? {
                analysis: latestAiAnalysis.analysis_json,
                model: latestAiAnalysis.model,
                prompt_version: latestAiAnalysis.prompt_version,
                created_at: latestAiAnalysis.created_at.toISOString(),
              }
            : null,
        });
      } catch (error: any) {
        fastify.log.error(
          {
            requestId,
            error: error.message,
            stack: error.stack,
          },
          'Failed to fetch PR details'
        );
        return reply.status(500).send({
          error: {
            message: 'Internal server error',
            code: 'INTERNAL_ERROR',
            requestId,
          },
        });
      }
    }
  );
}

