import { describe, it, expect } from 'vitest';
import { validateAiOutput } from './validator.js';
import type { AiOutput } from './types.js';

describe('validateAiOutput', () => {
  const validOutput: AiOutput = {
    summary: 'This PR touches authentication code and has no tests.',
    review_focus: ['Review authentication changes carefully', 'Check for security vulnerabilities', 'Verify session handling'],
    test_suggestions: ['Add unit tests for authentication flow', 'Add integration tests for login', 'Test session expiration'],
    rollback_risk: 'MED',
    confidence: 0.85,
    warnings: ['No test files found'],
  };

  it('should validate correct output', () => {
    const result = validateAiOutput(validOutput);
    expect(result).toEqual({ valid: true, data: validOutput });
  });

  it('should reject output with too few review_focus items', () => {
    expect(validateAiOutput({ ...validOutput, review_focus: ['Only one item'] }).valid).toBe(false);
  });

  it('should reject output with too many review_focus items', () => {
    expect(validateAiOutput({ ...validOutput, review_focus: Array(6).fill('Review item text') }).valid).toBe(false);
  });

  it('should reject output with too few test_suggestions', () => {
    expect(validateAiOutput({ ...validOutput, test_suggestions: ['Only one test'] }).valid).toBe(false);
  });

  it('should reject output with too many test_suggestions', () => {
    expect(validateAiOutput({ ...validOutput, test_suggestions: Array(7).fill('Test suggestion') }).valid).toBe(false);
  });

  it('should reject invalid rollback_risk', () => {
    expect(validateAiOutput({ ...validOutput, rollback_risk: 'VERY_HIGH' }).valid).toBe(false);
  });

  it('should reject confidence outside 0-1 range', () => {
    expect(validateAiOutput({ ...validOutput, confidence: 1.5 }).valid).toBe(false);
    expect(validateAiOutput({ ...validOutput, confidence: -0.1 }).valid).toBe(false);
    expect(validateAiOutput({ ...validOutput, confidence: Number.NaN }).valid).toBe(false);
  });

  it('should reject output with secrets, consistently across repeated calls', () => {
    // Realistic key shape, assembled at runtime so no key-shaped literal is committed.
    const key = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const invalid = { ...validOutput, summary: `The diff hard-codes the API key ${key} in config.` };
    for (let i = 0; i < 3; i += 1) {
      const result = validateAiOutput(invalid);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('secret');
    }
  });

  it('should reject output with missing required fields', () => {
    expect(validateAiOutput({ summary: 'Test' }).valid).toBe(false);
  });

  it('should reject summary that is too short', () => {
    expect(validateAiOutput({ ...validOutput, summary: 'Short' }).valid).toBe(false);
  });

  it('should accept valid output without warnings', () => {
    expect(validateAiOutput({ ...validOutput, warnings: undefined }).valid).toBe(true);
  });

  it('bounds every string and array', () => {
    expect(validateAiOutput({ ...validOutput, summary: 'x'.repeat(501) }).valid).toBe(false);
    expect(validateAiOutput({ ...validOutput, review_focus: ['ok item', 'x'.repeat(201), 'ok item'] }).valid).toBe(false);
    expect(validateAiOutput({ ...validOutput, warnings: Array(6).fill('warning') }).valid).toBe(false);
    expect(validateAiOutput({ ...validOutput, warnings: ['w'.repeat(301)] }).valid).toBe(false);
  });

  it('rejects non-object input', () => {
    for (const bad of [null, 'text', 42, []]) expect(validateAiOutput(bad).valid).toBe(false);
  });
});
