import { Suspense } from 'react';
import { fetchStats } from '../../lib/api';
import StatsCards from '../../components/StatsCards';
import { CardSkeleton } from '../../components/LoadingSkeleton';
import ErrorState from '../../components/ErrorState';

async function StatsContent() {
  try {
    const stats = await fetchStats();

    return (
      <div className="space-y-6">
        <StatsCards stats={stats} />

        {/* Top Risky Folders */}
        {stats.top_risky_folders.length > 0 && (
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              Top Risky Folders
            </h2>
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th
                      scope="col"
                      className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6"
                    >
                      Folder
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900"
                    >
                      PR Count
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900"
                    >
                      Average Score
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {stats.top_risky_folders.map((folder, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-6">
                        <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                          {folder.folder}
                        </code>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                        {folder.pr_count}
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            folder.average_score >= 70
                              ? 'bg-red-100 text-red-800'
                              : folder.average_score >= 30
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-green-100 text-green-800'
                          }`}
                        >
                          {folder.average_score.toFixed(1)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  } catch (error: any) {
    return (
      <ErrorState message={error.message || 'Failed to load statistics'} />
    );
  }
}

export default async function StatsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Statistics</h1>
          <p className="mt-2 text-sm text-gray-600">
            Overview of pull request risk scores and trends
          </p>
        </div>

        <Suspense fallback={<CardSkeleton />}>
          <StatsContent />
        </Suspense>
      </div>
    </div>
  );
}

