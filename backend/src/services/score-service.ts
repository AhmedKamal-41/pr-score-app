import { prisma } from '../lib/prisma.js';
import { ScoringResult } from '../scoring/rules.js';

export interface SaveScoreParams {
  pullRequestId: string;
  scoreResult: ScoringResult;
}

/**
 * Save PR score to database
 */
export async function savePrScore(params: SaveScoreParams): Promise<void> {
  const { pullRequestId, scoreResult } = params;

  // Convert level to database format (low, medium, high)
  let level: string;
  if (scoreResult.level === 'LOW') {
    level = 'low';
  } else if (scoreResult.level === 'MED') {
    level = 'medium';
  } else {
    level = 'high';
  }

  await prisma.prScore.create({
    data: {
      pull_request_id: pullRequestId,
      score: scoreResult.score,
      level,
      reasons: scoreResult.reasons,
      features: scoreResult.features,
    },
  });
}

