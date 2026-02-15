import { Octokit } from '@octokit/rest';
import { createAuthenticatedOctokit } from '../lib/github-auth.js';
import { AiOutput } from '../ai/types.js';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if error is a rate limit error
 */
function isRateLimitError(error: any): boolean {
  return (
    error?.status === 403 ||
    error?.status === 429 ||
    error?.response?.status === 403 ||
    error?.response?.status === 429
  );
}

/**
 * Get retry delay from error or use exponential backoff
 */
function getRetryDelay(error: any, attempt: number): number {
  const retryAfter = error?.response?.headers?.['retry-after'];
  if (retryAfter) {
    return parseInt(retryAfter, 10) * 1000;
  }
  return INITIAL_RETRY_DELAY * Math.pow(2, attempt);
}

/**
 * Format AI output as markdown comment
 */
function formatAiComment(aiOutput: AiOutput): string {
  const reviewFocus = aiOutput.review_focus.slice(0, 3);
  const testSuggestions = aiOutput.test_suggestions.slice(0, 3);

  return `## 🤖 AI Risk Analysis

**Summary:** ${aiOutput.summary}

### 🔍 Review Focus
${reviewFocus.map((item) => `- ${item}`).join('\n')}

### 🧪 Test Suggestions
${testSuggestions.map((item) => `- ${item}`).join('\n')}

**Rollback Risk:** ${aiOutput.rollback_risk}  
**Confidence:** ${(aiOutput.confidence * 100).toFixed(0)}%

${aiOutput.warnings && aiOutput.warnings.length > 0 ? `**⚠️ Warnings:**\n${aiOutput.warnings.map((w) => `- ${w}`).join('\n')}` : ''}
`;
}

/**
 * Post PR comment with AI analysis
 */
export async function postPrComment(
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number,
  aiOutput: AiOutput
): Promise<void> {
  let lastError: any;
  let octokit: Octokit | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (!octokit) {
        octokit = await createAuthenticatedOctokit(installationId);
      }

      const commentBody = formatAiComment(aiOutput);

      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: commentBody,
      });

      return; // Success
    } catch (error: any) {
      lastError = error;

      if (isRateLimitError(error) && attempt < MAX_RETRIES - 1) {
        const delay = getRetryDelay(error, attempt);
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

