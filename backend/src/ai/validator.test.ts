import { describe, it, expect } from 'vitest';
import { validateAiOutput } from './validator.js';
import { AiOutput } from './types.js';

describe('validateAiOutput', () => {
  const validOutput: AiOutput = {
    summary: 'This PR touches authentication code and has no tests.',
    review_focus: [
      'Review authentication changes carefully',
      'Check for security vulnerabilities',
      'Verify session handling',
    ],
    test_suggestions: [
      'Add unit tests for authentication flow',
      'Add integration tests for login',
      'Test session expiration',
    ],
    rollback_risk: 'MED',
    confidence: 0.85,
    warnings: ['No test files found'],
  };

  it('should validate correct output', () => {
    const result = validateAiOutput(validOutput);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(validOutput);
  });

  it('should reject output with too few review_focus items', () => {
    const invalid = {
      ...validOutput,
      review_focus: ['Only one item'],
    };
    const result = validateAiOutput(invalid);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('review_focus');
  });

  it('should reject output with too many review_focus items', () => {
    const invalid = {
      ...validOutput,
      review_focus: ['1', '2', '3', '4', '5', '6'], // 6 items
    };
    const result = validateAiOutput(invalid);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('review_focus');
  });

  it('should reject output with too few test_suggestions', () => {
    const invalid = {
      ...validOutput,
      test_suggestions: ['Only one test'],
    };
    const result = validateAiOutput(invalid);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('test_suggestions');
  });

  it('should reject output with too many test_suggestions', () => {
    const invalid = {
      ...validOutput,
      test_suggestions: ['1', '2', '3', '4', '5', '6', '7'], // 7 items
    };
    const result = validateAiOutput(invalid);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('test_suggestions');
  });

  it('should reject invalid rollback_risk', () => {
    const invalid = {
      ...validOutput,
      rollback_risk: 'INVALID' as any,
    };
    const result = validateAiOutput(invalid);
    expect(result.valid).toBe(false);
  });

  it('should reject confidence outside 0-1 range', () => {
    const invalid1 = {
      ...validOutput,
      confidence: -0.1,
    };
    const invalid2 = {
      ...validOutput,
      confidence: 1.1,
    };
    expect(validateAiOutput(invalid1).valid).toBe(false);
    expect(validateAiOutput(invalid2).valid).toBe(false);
  });

  it('should reject output with secrets', () => {
    const invalid = {
      ...validOutput,
      summary: 'API key: sk_live_EXAMPLE_KEY_NOT_REAL_123456789012',
    };
    const result = validateAiOutput(invalid);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('secret');
  });

  it('should reject output with missing required fields', () => {
    const invalid = {
      summary: 'Test',
      // Missing other fields
    };
    const result = validateAiOutput(invalid);
    expect(result.valid).toBe(false);
  });

  it('should reject summary that is too short', () => {
    const invalid = {
      ...validOutput,
      summary: 'Short',
    };
    const result = validateAiOutput(invalid);
    expect(result.valid).toBe(false);
  });

  it('should accept valid output without warnings', () => {
    const outputWithoutWarnings = {
      ...validOutput,
      warnings: undefined,
    };
    const result = validateAiOutput(outputWithoutWarnings);
    expect(result.valid).toBe(true);
  });
});

