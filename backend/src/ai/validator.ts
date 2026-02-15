import { z } from 'zod';
import { AiOutput } from './types.js';
import { redactSecrets } from './redaction.js';

// Zod schema for AI output validation
const aiOutputSchema = z.object({
  summary: z.string().min(10).max(500),
  review_focus: z.array(z.string().min(5).max(200)).min(3).max(5),
  test_suggestions: z.array(z.string().min(5).max(200)).min(3).max(6),
  rollback_risk: z.enum(['LOW', 'MED', 'HIGH']),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()).optional(),
});

// Patterns to detect secrets in output
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret[_-]?key|token|password)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{20,}['"]?/gi,
  /sk_(?:live|test)_[a-zA-Z0-9]{24,}/gi,
  /AIza[0-9A-Za-z\-_]{35}/gi,
  /AKIA[0-9A-Z]{16}/gi,
  /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.?[A-Za-z0-9\-_.]*/g,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
];

/**
 * Check if output contains suspicious secret patterns
 */
function containsSecrets(output: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * Validate AI output against schema and safety checks
 */
export function validateAiOutput(output: unknown): {
  valid: boolean;
  data?: AiOutput;
  error?: string;
} {
  try {
    // Schema validation
    const parsed = aiOutputSchema.parse(output);
    
    // Check for secrets in the output string
    const outputString = JSON.stringify(output);
    if (containsSecrets(outputString)) {
      return {
        valid: false,
        error: 'Output contains suspicious secret patterns',
      };
    }
    
    // Additional checks
    if (parsed.confidence < 0 || parsed.confidence > 1) {
      return {
        valid: false,
        error: 'Confidence must be between 0.0 and 1.0',
      };
    }
    
    // Check array lengths
    if (parsed.review_focus.length < 3 || parsed.review_focus.length > 5) {
      return {
        valid: false,
        error: 'review_focus must have 3-5 items',
      };
    }
    
    if (parsed.test_suggestions.length < 3 || parsed.test_suggestions.length > 6) {
      return {
        valid: false,
        error: 'test_suggestions must have 3-6 items',
      };
    }
    
    return {
      valid: true,
      data: parsed,
    };
  } catch (error: any) {
    return {
      valid: false,
      error: error.message || 'Invalid output schema',
    };
  }
}

