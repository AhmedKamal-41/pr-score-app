import { z } from 'zod';
import type { AiOutput } from './types.js';
import { containsSecret } from './redaction.js';

const boundedString = (min: number, max: number) => z.string().trim().min(min).max(max);

export const aiOutputSchema = z.object({
  summary: boundedString(10, 500),
  review_focus: z.array(boundedString(5, 200)).min(3).max(5),
  test_suggestions: z.array(boundedString(5, 200)).min(3).max(6),
  rollback_risk: z.enum(['LOW', 'MED', 'HIGH']),
  confidence: z.number().finite().min(0).max(1),
  warnings: z.array(boundedString(1, 300)).max(5).optional(),
});

export type ValidationResult = { valid: true; data: AiOutput } | { valid: false; error: string };

/**
 * Validate AI output against the schema and reject anything containing
 * secret-shaped content. Stateless: repeated calls give identical results.
 */
export function validateAiOutput(output: unknown): ValidationResult {
  const parsed = aiOutputSchema.safeParse(output);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    return {
      valid: false,
      error: `Invalid output schema: ${first ? `${first.path.join('.') || '(root)'} ${first.message}` : 'unknown'}`,
    };
  }
  if (containsSecret(JSON.stringify(parsed.data))) {
    return { valid: false, error: 'Output contains suspicious secret patterns' };
  }
  return { valid: true, data: parsed.data };
}
