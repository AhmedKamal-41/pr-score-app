import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import requestContext from '@fastify/request-context';

/**
 * Extract folder path from file path
 */
function extractFolder(filePath: string): string | null {
  const parts = filePath.split('/');
  if (parts.length < 2) return null;
  
  // Return first directory (e.g., "src" from "src/auth/login.ts")
  return parts[0];
}

/**
 * Extract top-level folder from file path
 */
function extractTopFolder(filePath: string): string | null {
  const parts = filePath.split('/');
  if (parts.length < 2) return null;
  
  // Return first two parts if available (e.g., "src/auth" from "src/auth/login.ts")
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

export async function statsRoute(fastify: FastifyInstance) {
  fastify.get('/api/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = requestContext.get('requestId') || 'unknown';

    try {
      // Get total PR count
      const totalPrs = await prisma.pullRequest.count();

      // Get all PRs with their latest scores
      const prsWithScores = await prisma.pullRequest.findMany({
        include: {
          scores: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: {
              score: true,
              level: true,
            },
          },
        },
      });

      // Calculate statistics
      const scoresWithLevels = prsWithScores
        .map((pr) => pr.scores[0])
        .filter((score) => score !== undefined && score !== null);

      // Average score
      const averageScore =
        scoresWithLevels.length > 0
          ? scoresWithLevels.reduce((sum, s) => sum + s.score, 0) /
            scoresWithLevels.length
          : 0;

      // Counts by level
      const countsByLevel: Record<string, number> = {
        low: 0,
        medium: 0,
        high: 0,
      };

      scoresWithLevels.forEach((score) => {
        const level = score.level.toLowerCase();
        if (level === 'low' || level === 'medium' || level === 'high') {
          countsByLevel[level] = (countsByLevel[level] || 0) + 1;
        }
      });

      // Calculate top risky folders
      // Extract folders from changed_files_list and aggregate scores
      const folderStats: Record<
        string,
        { prCount: number; totalScore: number; scores: number[] }
      > = {};

      prsWithScores.forEach((pr) => {
        const latestScore = pr.scores[0];
        if (!latestScore) return;

        const filesList = pr.changed_files_list;
        if (!filesList || !Array.isArray(filesList)) return;

        // Extract unique folders from file list
        const folders = new Set<string>();
        filesList.forEach((filePath: string) => {
          const folder = extractTopFolder(filePath);
          if (folder) {
            folders.add(folder);
          }
        });

        // Add score to each folder
        folders.forEach((folder) => {
          if (!folderStats[folder]) {
            folderStats[folder] = {
              prCount: 0,
              totalScore: 0,
              scores: [],
            };
          }
          folderStats[folder].prCount += 1;
          folderStats[folder].totalScore += latestScore.score;
          folderStats[folder].scores.push(latestScore.score);
        });
      });

      // Convert to array and calculate averages, sort by average score descending
      const topRiskyFolders = Object.entries(folderStats)
        .map(([folder, stats]) => ({
          folder,
          pr_count: stats.prCount,
          average_score:
            stats.scores.length > 0
              ? stats.totalScore / stats.scores.length
              : 0,
        }))
        .sort((a, b) => b.average_score - a.average_score)
        .slice(0, 10); // Top 10 risky folders

      return reply.send({
        total_prs: totalPrs,
        average_score: Math.round(averageScore * 100) / 100, // Round to 2 decimal places
        counts_by_level: countsByLevel,
        top_risky_folders: topRiskyFolders.map((f) => ({
          folder: f.folder,
          pr_count: f.pr_count,
          average_score: Math.round(f.average_score * 100) / 100,
        })),
      });
    } catch (error: any) {
      fastify.log.error(
        {
          requestId,
          error: error.message,
          stack: error.stack,
        },
        'Failed to fetch statistics'
      );
      return reply.status(500).send({
        error: {
          message: 'Internal server error',
          code: 'INTERNAL_ERROR',
          requestId,
        },
      });
    }
  });
}

