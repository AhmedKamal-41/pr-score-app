import { describe, it, expect } from 'vitest';
import { formatAnalysisComment } from './comments.js';
import { COMMENT_MARKER } from '../config/constants.js';

describe('formatAnalysisComment', () => {
  const ctx = {
    headSha: 'abcdef0123456789abcdef0123456789abcdef01',
    score: 60,
    level: 'medium' as const,
    ciStatus: 'pending',
    uncertainties: ['CI status is pending; not scored'],
    analysis: {
      summary: 'Ping @octocat and @org/team <!-- sneaky --> about auth.',
      review_focus: ['Check session expiry', 'Validate tokens', 'Error paths'],
      test_suggestions: ['Expired session test', 'Bad token test', 'Logout test'],
      rollback_risk: 'MED' as const,
      confidence: 0.42,
      warnings: ['Diff truncated'],
    },
    limitations: null,
    model: 'gpt-4o-mini',
  };

  it('starts with the hidden marker and names the analyzed revision', () => {
    const body = formatAnalysisComment(ctx);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('`abcdef012345`');
    expect(body).toContain('Model-reported confidence:** 42%');
    expect(body).toContain('CI status is pending');
  });

  it('neutralizes mentions and HTML comments in model text', () => {
    const body = formatAnalysisComment(ctx);
    expect(body).not.toMatch(/@octocat/);
    expect(body).toContain('@​octocat');
    expect(body.match(/<!--/g)).toHaveLength(1); // only the marker
  });
});
