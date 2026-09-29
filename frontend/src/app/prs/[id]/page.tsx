import Link from 'next/link';
import ScoreBadge from '@/components/ScoreBadge';
import StatusPill from '@/components/StatusPill';
import ErrorState from '@/components/ErrorState';
import AiAnalysisPanel from '@/components/AiAnalysisPanel';
import { navigateForApiError, serverApi, settle } from '@/lib/server-api';
import { formatDate, shortSha } from '@/lib/format';

export const dynamic = 'force-dynamic';

const REVISION_LABEL = { current: 'current head', previous_head: 'older revision', legacy_unknown: 'legacy (revision unknown)' } as const;

export default async function PRDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await settle(serverApi.pr(id));
  if (!result.ok) {
    navigateForApiError(result.error, `/prs/${id}`);
    return <ErrorState error={result.error} fallback="Failed to load the pull request" />;
  }
  const pr = result.data;
  const score = pr.latest_score;

  return (
    <div className="space-y-6">
      <Link href="/prs" className="text-sm font-medium text-blue-600 hover:text-blue-800">← Back to pull requests</Link>
      <header>
        <h1 className="text-2xl font-bold text-gray-900">{pr.title}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-600">
          <span>{pr.repository} #{pr.number ?? '?'}</span>
          <span>·</span>
          <span>by {pr.author}</span>
          <span>·</span>
          <StatusPill label={pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state} />
          {pr.repository_private !== null && <StatusPill label={pr.repository_private ? 'private' : 'public'} />}
          {pr.is_demo && <StatusPill label="demo data" />}
          {pr.processing && <StatusPill label="processing" />}
          <span className="font-mono text-xs">head {shortSha(pr.head_sha)}</span>
        </p>
        {pr.identity_status !== 'verified' && (
          <p className="mt-2 text-sm text-amber-700">This record predates PR identity verification; its older history may belong to a different repository.</p>
        )}
      </header>

      <section className="rounded-lg bg-white p-6 shadow" aria-labelledby="risk-heading">
        <h2 id="risk-heading" className="mb-4 text-lg font-semibold text-gray-900">Risk score</h2>
        {score ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <ScoreBadge score={score.score} showScore />
              <StatusPill label={REVISION_LABEL[score.revision_status]} tone={score.revision_status} />
              {score.ci_status && <StatusPill label={`CI: ${score.ci_status}`} tone={score.ci_status} />}
              <span className="text-xs text-gray-500">scoring {score.scoring_version} · {formatDate(score.created_at)}</span>
            </div>
            {score.revision_status !== 'current' && (
              <p className="text-sm text-amber-700">No score exists for the current head yet; this score belongs to {score.revision_status === 'legacy_unknown' ? 'an unknown older revision' : `revision ${shortSha(score.head_sha)}`}.</p>
            )}
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Top reasons</h3>
              {score.reasons.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
                  {score.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-gray-600">No rule added points.</p>
              )}
            </div>
            {score.contributions && score.contributions.length > 3 && (
              <details className="text-sm text-gray-700">
                <summary className="cursor-pointer font-medium">All rule contributions ({score.contributions.length})</summary>
                <ul className="mt-2 list-disc pl-5">
                  {score.contributions.map((c, i) => <li key={i}>+{c.points}: {c.reason}</li>)}
                </ul>
              </details>
            )}
            {score.uncertainties.length > 0 && (
              <div className="rounded-md bg-amber-50 p-3">
                <h3 className="text-sm font-semibold text-amber-900">Uncertainty</h3>
                <ul className="mt-1 list-disc pl-5 text-sm text-amber-800">
                  {score.uncertainties.map((u, i) => <li key={i}>{u}</li>)}
                </ul>
              </div>
            )}
            <p className="text-xs text-gray-500">The score prioritises review attention; it does not prove correctness, and changed test files do not prove coverage.</p>
          </div>
        ) : (
          <p className="text-sm text-gray-600">{pr.processing ? 'Scoring is in progress.' : 'This pull request has not been scored yet.'}</p>
        )}
      </section>

      <AiAnalysisPanel ai={pr.ai} processing={pr.processing} />

      <section className="rounded-lg bg-white p-6 shadow">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Details</h2>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-gray-500">Additions / deletions</dt><dd className="text-gray-900">+{pr.additions ?? '?'} / -{pr.deletions ?? '?'}</dd></div>
          <div><dt className="text-gray-500">Files changed</dt><dd className="text-gray-900">{pr.changed_files ?? '?'}</dd></div>
          <div><dt className="text-gray-500">Branches</dt><dd className="text-gray-900">{pr.head_ref} → {pr.base_ref}</dd></div>
          <div><dt className="text-gray-500">Opened on GitHub</dt><dd className="text-gray-900">{formatDate(pr.github_created_at)}</dd></div>
          <div><dt className="text-gray-500">Updated on GitHub</dt><dd className="text-gray-900">{formatDate(pr.github_updated_at)}</dd></div>
          <div><dt className="text-gray-500">{pr.merged ? 'Merged' : 'Closed'}</dt><dd className="text-gray-900">{formatDate(pr.merged_at ?? pr.closed_at)}</dd></div>
          <div><dt className="text-gray-500">First ingested</dt><dd className="text-gray-900">{formatDate(pr.created_at)}</dd></div>
          <div><dt className="text-gray-500">Last refreshed</dt><dd className="text-gray-900">{formatDate(pr.updated_at)}</dd></div>
        </dl>
      </section>

      <section className="rounded-lg bg-white p-6 shadow">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Score history</h2>
        {pr.score_history.length === 0 ? (
          <p className="text-sm text-gray-600">No scores yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100" aria-label="Score history">
            {pr.score_history.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <ScoreBadge score={s.score} showScore />
                <span className="font-mono text-xs text-gray-600">{shortSha(s.head_sha)}</span>
                {s.ci_status && <StatusPill label={`CI: ${s.ci_status}`} tone={s.ci_status} />}
                <StatusPill label={REVISION_LABEL[s.revision_status]} tone={s.revision_status} />
                <span className="text-gray-500">{formatDate(s.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pr.changed_files_list.length > 0 && (
        <section className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Changed files ({pr.changed_files_list.length}{pr.changed_files && pr.changed_files > pr.changed_files_list.length ? ` of ${pr.changed_files}` : ''})</h2>
          <ul className="max-h-96 space-y-1 overflow-y-auto">
            {pr.changed_files_list.map((f) => (
              <li key={f} className="rounded bg-gray-50 px-3 py-1.5 font-mono text-xs text-gray-700">{f}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
