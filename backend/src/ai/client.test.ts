import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateAiAnalysis } from './client.js';
import { AiInput } from './types.js';

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

describe('generateAiAnalysis', () => {
  const mockInput: AiInput = {
    score: 75,
    level: 'HIGH',
    reasons: ['Large PR'],
    changed_files: ['src/file.ts'],
    file_diffs: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.AI_MODEL = 'gpt-4o-mini';
  });

  it('should return error if OPENAI_API_KEY not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await generateAiAnalysis(mockInput);
    expect(result.success).toBe(false);
    expect(result.error).toContain('OPENAI_API_KEY');
  });

  it('should return error for unsupported provider', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    const result = await generateAiAnalysis(mockInput);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported');
  });

  // Note: Full integration tests would require mocking OpenAI SDK properly
  // This is a basic structure - actual implementation would need more sophisticated mocking
});

