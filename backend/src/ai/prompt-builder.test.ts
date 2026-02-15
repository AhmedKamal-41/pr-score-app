import { describe, it, expect } from 'vitest';
import { buildPrompt } from './prompt-builder.js';
import { AiInput } from './types.js';

describe('buildPrompt', () => {
  const baseInput: AiInput = {
    score: 75,
    level: 'HIGH',
    reasons: ['Large PR: 100 files changed', 'Touches critical path: Authentication'],
    changed_files: ['src/auth/login.ts', 'src/utils/helpers.ts'],
    file_diffs: [
      {
        filename: 'src/auth/login.ts',
        patch: '+function login() {\n+  return true;\n+}',
        additions: 3,
        deletions: 0,
      },
    ],
  };

  it('should include score and level', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('Score: 75/100');
    expect(prompt).toContain('Level: HIGH');
  });

  it('should include reasons', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('Large PR: 100 files changed');
    expect(prompt).toContain('Touches critical path: Authentication');
  });

  it('should include changed files list', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('src/auth/login.ts');
    expect(prompt).toContain('src/utils/helpers.ts');
  });

  it('should include file diffs', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('src/auth/login.ts');
    expect(prompt).toContain('+function login()');
  });

  it('should truncate diffs to 6000 chars total', () => {
    const largeDiff = {
      filename: 'src/large.ts',
      patch: 'a'.repeat(7000), // 7000 chars
      additions: 100,
      deletions: 0,
    };
    const input: AiInput = {
      ...baseInput,
      file_diffs: [largeDiff],
    };

    const prompt = buildPrompt(input);
    expect(prompt.length).toBeLessThan(10000); // Should be truncated
    expect(prompt).toContain('[truncated]');
  });

  it('should handle multiple diffs within limit', () => {
    const input: AiInput = {
      ...baseInput,
      file_diffs: [
        {
          filename: 'src/file1.ts',
          patch: 'diff1',
          additions: 10,
          deletions: 5,
        },
        {
          filename: 'src/file2.ts',
          patch: 'diff2',
          additions: 20,
          deletions: 10,
        },
      ],
    };

    const prompt = buildPrompt(input);
    expect(prompt).toContain('src/file1.ts');
    expect(prompt).toContain('src/file2.ts');
  });

  it('should handle null patch (binary or too large)', () => {
    const input: AiInput = {
      ...baseInput,
      file_diffs: [
        {
          filename: 'src/binary.png',
          patch: null,
          additions: 0,
          deletions: 0,
        },
      ],
    };

    const prompt = buildPrompt(input);
    expect(prompt).toContain('No diff content available');
  });

  it('should include grounding instructions', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('Ground your analysis');
    expect(prompt).toContain('Do NOT invent');
  });

  it('should request JSON output', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('summary');
    expect(prompt).toContain('review_focus');
    expect(prompt).toContain('test_suggestions');
  });
});

