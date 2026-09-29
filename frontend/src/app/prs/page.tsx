import Link from 'next/link';
import ScoreBadge from '@/components/ScoreBadge';
import StatusPill from '@/components/StatusPill';
import Pagination from '@/components/Pagination';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import DemoSeedButton from '@/components/DemoSeedButton';
import { navigateForApiError, serverApi, settle } from '@/lib/server-api';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export default async function PRsPage({ searchParams }: { searchParams: Promise<{ limit?: string; offset?: string }> }) {
  const params = await searchParams;
  const limit = clampInt(params.limit, 25, 1, 100);
  const offset = clampInt(params.offset, 0, 0, 1_000_000);

  const path = `/prs?limit=${limit}&offset=${offset}`;
  const result = await settle(serverApi.prs(limit, offset));
  if (!result.ok) {
    navigateForApiError(result.error, path);
    return <ErrorState error={result.error} fallback="Failed to load pull requests" />;
  }
  const data = result.data;
  let demoEnabled = false;
  if (data.pagination.total === 0) {
    const demo = await settle(serverApi.demoStatus());
    demoEnabled = demo.ok && demo.data.enabled;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Pull requests</h1>
        <p className="mt-1 text-sm text-gray-600">Most recently updated first. Scores apply to the revision shown; older-revision scores are labelled.</p>
      </div>
      {data.pagination.total === 0 ? (
        <div className="rounded-lg bg-white p-6 shadow">
          <EmptyState title="No pull requests yet" message="Install the GitHub App on a repository in this workspace, or load demo data locally." />
          {demoEnabled && <DemoSeedButton />}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg bg-white shadow">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-gray-900">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">Pull request</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Repository</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Risk</th>
                  <th scope="col" className="px-4 py-3 font-semibold">CI</th>
                  <th scope="col" className="px-4 py-3 font-semibold">AI</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Updated on GitHub</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.data.map((pr) => (
                  <tr key={pr.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/prs/${pr.id}`} className="font-medium text-blue-700 hover:underline">{pr.title}</Link>
                      <div className="text-gray-500">
                        #{pr.number ?? '?'} · {pr.merged ? 'merged' : pr.state}
                        {pr.draft ? ' · draft' : ''} · {pr.author}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {pr.repository}
                      {pr.is_demo && <span className="ml-2"><StatusPill label="demo" /></span>}
                    </td>
                    <td className="px-4 py-3">
                      <ScoreBadge score={pr.latest_score?.score ?? null} showScore />
                      {pr.latest_score && pr.latest_score.revision_status !== 'current' && (
                        <div className="mt-1 text-xs text-amber-700">{pr.latest_score.revision_status === 'legacy_unknown' ? 'legacy score' : 'older revision'}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">{pr.latest_score?.ci_status ? <StatusPill label={pr.latest_score.ci_status} /> : '—'}</td>
                    <td className="px-4 py-3">
                      <StatusPill label={pr.processing ? 'processing' : pr.ai_status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-600">{formatDate(pr.github_updated_at ?? pr.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination basePath="/prs" limit={limit} offset={offset} total={data.pagination.total} shown={data.data.length} />
        </>
      )}
    </div>
  );
}
