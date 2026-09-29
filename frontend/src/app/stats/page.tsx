import ScoreBadge from '@/components/ScoreBadge';
import ErrorState from '@/components/ErrorState';
import { navigateForApiError, serverApi, settle } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

function Card({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-white p-5 shadow">
      <dt className="text-sm font-medium text-gray-500">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

export default async function StatsPage() {
  const result = await settle(serverApi.stats());
  if (!result.ok) {
    navigateForApiError(result.error, '/stats');
    return <ErrorState error={result.error} fallback="Failed to load statistics" />;
  }
  const stats = result.data;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Statistics</h1>
        <p className="mt-1 text-sm text-gray-600">Based on each pull request&apos;s latest score (current head preferred). Unscored pull requests are excluded from averages.</p>
      </div>
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Card label="Pull requests" value={stats.total_prs} />
        <Card label="Unscored" value={stats.unscored_prs} />
        <Card label="Average score" value={stats.average_score === null ? '—' : stats.average_score.toFixed(1)} />
        <Card label="Low (≤30)" value={stats.counts_by_level.low} />
        <Card label="Medium (31–70)" value={stats.counts_by_level.medium} />
        <Card label="High (>70)" value={stats.counts_by_level.high} />
      </dl>
      <section className="rounded-lg bg-white p-6 shadow">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">Riskiest folders</h2>
        <p className="mb-4 text-sm text-gray-500">First two directory levels; each pull request counts once per folder.</p>
        {stats.top_risky_folders.length === 0 ? (
          <p className="text-sm text-gray-600">No scored pull requests with changed files yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="text-left text-gray-900">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-semibold">Folder</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Pull requests</th>
                  <th scope="col" className="py-2 font-semibold">Average score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {stats.top_risky_folders.map((f) => (
                  <tr key={f.folder}>
                    <td className="py-2 pr-4"><code className="rounded bg-gray-100 px-2 py-0.5 text-xs">{f.folder}</code></td>
                    <td className="py-2 pr-4 text-gray-700">{f.pr_count}</td>
                    <td className="py-2"><ScoreBadge score={f.average_score} showScore /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
