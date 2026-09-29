import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ScoreBadge from '@/components/ScoreBadge';
import Pagination from '@/components/Pagination';
import AiAnalysisPanel from '@/components/AiAnalysisPanel';
import ErrorState from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import type { AiState } from '@/lib/types';

describe('ScoreBadge', () => {
  it('derives the level from the score', () => {
    render(<ScoreBadge score={40} showScore />);
    const badge = screen.getByText('MED (40)');
    expect(badge.getAttribute('data-level')).toBe('medium');
  });

  it('shows "No score" when missing', () => {
    render(<ScoreBadge score={null} />);
    expect(screen.getByText('No score')).toBeTruthy();
  });
});

describe('Pagination', () => {
  it('links to previous and next pages with accurate counts', () => {
    render(<Pagination basePath="/prs" limit={10} offset={10} total={25} shown={10} />);
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 11–20 of 25 pull requests');
    expect(screen.getByText('Previous').getAttribute('href')).toBe('/prs?limit=10&offset=0');
    expect(screen.getByText('Next').getAttribute('href')).toBe('/prs?limit=10&offset=20');
  });

  it('disables navigation at the ends', () => {
    render(<Pagination basePath="/prs" limit={10} offset={20} total={25} shown={5} />);
    expect(screen.getByText('Next').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Previous').tagName).toBe('A');
  });
});

const analysis = {
  analysis: {
    summary: 'Session handling changed without tests.',
    review_focus: ['Expiry logic', 'Token checks', 'Logout path'],
    test_suggestions: ['Expired session test', 'Bad token test', 'Logout test'],
    rollback_risk: 'MED' as const,
    confidence: 0.64,
    warnings: ['Diff truncated'],
  },
  model: 'gpt-4o-mini',
  prompt_version: 'v2',
  head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
  revision_status: 'current' as const,
  limitations: { truncated_files: ['src/auth/session.ts'], missing_patch_files: ['logo.png'] },
  created_at: '2026-09-29T10:00:00.000Z',
};

const baseAi: AiState = {
  enabled: true,
  status: 'succeeded',
  error: null,
  comment_status: 'succeeded',
  analyzed_sha: analysis.head_sha,
  run_created_at: analysis.created_at,
  current: analysis,
  previous: null,
};

describe('AiAnalysisPanel', () => {
  it('renders the full analysis with revision, confidence and limitations', () => {
    render(<AiAnalysisPanel ai={baseAi} processing={false} />);
    expect(screen.getByText('Session handling changed without tests.')).toBeTruthy();
    expect(screen.getByText('Expiry logic')).toBeTruthy();
    expect(screen.getByText('Expired session test')).toBeTruthy();
    expect(screen.getByText('64%')).toBeTruthy();
    expect(screen.getByText('abcdef012345')).toBeTruthy();
    expect(screen.getByText('Diff truncated')).toBeTruthy();
    expect(screen.getByText(/Truncated diffs: src\/auth\/session.ts/)).toBeTruthy();
    expect(screen.getByText(/No diff available \(binary or too large\): logo.png/)).toBeTruthy();
    expect(screen.getByText('Sep 29, 2026, 10:00 AM UTC')).toBeTruthy();
  });

  it.each([
    ['disabled', /disabled on this server/],
    ['pending', /pending for this revision/],
    ['unavailable', /provider was unavailable/],
    ['failed', /rejected \(invalid or unsafe output\)/],
    ['superseded', /newer revision replaced/],
    ['missing', /not been analysed/],
  ] as const)('explains the %s state and keeps the score message', (status, text) => {
    render(<AiAnalysisPanel ai={{ ...baseAi, status, current: null, error: status === 'failed' ? 'Invalid output schema' : null }} processing={false} />);
    expect(screen.getByText(text)).toBeTruthy();
    if (status === 'failed') expect(screen.getByText('Last error: Invalid output schema')).toBeTruthy();
  });

  it('labels a previous-revision analysis as stale, never as current', () => {
    render(
      <AiAnalysisPanel
        ai={{ ...baseAi, status: 'stale', current: null, previous: { ...analysis, revision_status: 'previous_head' } }}
        processing
      />,
    );
    expect(screen.getByText(/No AI analysis exists for the current revision/)).toBeTruthy();
    const previous = screen.getByText(/Previous analysis — revision abcdef012345 \(not the current head\)/);
    expect(previous).toBeTruthy();
    expect(screen.getByText('processing')).toBeTruthy();
  });

  it('renders model text as inert text', () => {
    const hostile = { ...analysis, analysis: { ...analysis.analysis, summary: '<img src=x onerror=alert(1)> run `rm -rf /`' } };
    const { container } = render(<AiAnalysisPanel ai={{ ...baseAi, current: hostile }} processing={false} />);
    expect(container.querySelector('img')).toBeNull();
    expect(within(container).getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('shows status and request id for API errors without leaking server details', () => {
    render(<ErrorState error={new ApiError(500, 'INTERNAL_ERROR', 'stack trace here', 'req-123')} />);
    expect(screen.getByText('Error (500)')).toBeTruthy();
    expect(screen.getByText(/could not complete the request/)).toBeTruthy();
    expect(screen.getByText('Request ID: req-123')).toBeTruthy();
    expect(screen.queryByText(/stack trace/)).toBeNull();
  });

  it('explains 403 responses', () => {
    render(<ErrorState error={new ApiError(403, 'FORBIDDEN', 'nope')} />);
    expect(screen.getByText('You do not have access to this resource.')).toBeTruthy();
  });
});
