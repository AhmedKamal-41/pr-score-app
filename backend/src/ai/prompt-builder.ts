import { AiInput, FileDiff } from './types.js';
import { redactSecrets } from './redaction.js';

const MAX_DIFF_CHARS = 6000; // Total character limit across all diffs

/**
 * Truncate diff to fit within character limit
 */
function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) {
    return diff;
  }
  
  // Try to truncate at a line boundary
  const truncated = diff.substring(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  
  if (lastNewline > maxChars * 0.8) {
    // If we can find a newline in the last 20%, use it
    return truncated.substring(0, lastNewline) + '\n... [truncated]';
  }
  
  return truncated + '\n... [truncated]';
}

/**
 * Build AI prompt with strict token limits
 */
export function buildPrompt(input: AiInput): string {
  const { score, level, reasons, changed_files, file_diffs } = input;

  // Redact secrets from all diffs
  const redactedDiffs = file_diffs.map((diff) => ({
    ...diff,
    patch: diff.patch ? redactSecrets(diff.patch) : null,
  }));

  // Calculate total diff size and truncate if needed
  let totalChars = 0;
  const truncatedDiffs: FileDiff[] = [];
  
  for (const diff of redactedDiffs) {
    if (!diff.patch) continue;
    
    const remainingChars = MAX_DIFF_CHARS - totalChars;
    if (remainingChars <= 0) break;
    
    const truncated = truncateDiff(diff.patch, remainingChars);
    totalChars += truncated.length;
    
    truncatedDiffs.push({
      ...diff,
      patch: truncated,
    });
  }

  // Build prompt
  const prompt = `You are analyzing a Pull Request for risk assessment. Based on the computed risk score and file changes, provide actionable insights.

## PR Risk Score
- Score: ${score}/100
- Level: ${level}
- Top Risk Reasons:
${reasons.map((r) => `  - ${r}`).join('\n')}

## Changed Files
${changed_files.map((f) => `- ${f}`).join('\n')}

## Top Risky File Diffs
${truncatedDiffs.length === 0 
  ? '(No diff content available - files may be too large or binary)'
  : truncatedDiffs.map((diff) => `### ${diff.filename} (+${diff.additions}/-${diff.deletions})
\`\`\`diff
${diff.patch || '(No diff available)'}
\`\`\``).join('\n\n')}

## Instructions
1. Ground your analysis ONLY in the provided score, reasons, and file diffs above.
2. Do NOT invent file names, code patterns, or facts not present in the input.
3. Focus on actionable, specific recommendations.
4. Keep responses concise and practical.

## Output Format
Provide a JSON object with this exact structure:
{
  "summary": "1-2 sentences explaining why this PR is risky",
  "review_focus": ["3-5 specific items to review first"],
  "test_suggestions": ["3-6 concrete tests to add or run"],
  "rollback_risk": "LOW|MED|HIGH",
  "confidence": 0.0-1.0,
  "warnings": ["any uncertainty or missing information"]
}

Respond with ONLY the JSON object, no additional text.`;

  return prompt;
}

