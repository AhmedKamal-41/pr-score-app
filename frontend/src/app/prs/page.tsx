import { Suspense } from 'react';
import { fetchPRs } from '../../lib/api';
import PrTable from '../../components/PrTable';
import { TableSkeleton } from '../../components/LoadingSkeleton';
import ErrorState from '../../components/ErrorState';
import EmptyState from '../../components/EmptyState';
import DemoSeedButton from '../../components/DemoSeedButton';

interface SearchParams {
  limit?: string;
  offset?: string;
}

async function PRList({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  try {
    const params = await searchParams;
    const limit = parseInt(params.limit || '50', 10);
    const offset = parseInt(params.offset || '0', 10);
    const response = await fetchPRs(limit, offset);

    if (response.data.length === 0) {
      const demoEnabled = process.env.NEXT_PUBLIC_DEMO_ENABLED === 'true';
      const demoSecret = process.env.NEXT_PUBLIC_DEMO_SECRET || '';
      
      return (
        <div className="space-y-6">
          <EmptyState 
            title="No Pull Requests" 
            message="No pull requests found. Load demo data to see the dashboard in action."
          />
          {demoEnabled && demoSecret && (
            <div className="flex justify-center">
              <DemoSeedButton demoSecret={demoSecret} />
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <PrTable prs={response.data} />
        {response.pagination.has_more && (
          <div className="text-center text-sm text-gray-500">
            Showing {response.pagination.offset + 1}-
            {response.pagination.offset + response.data.length} of{' '}
            {response.pagination.total} PRs
          </div>
        )}
      </div>
    );
  } catch (error: any) {
    return (
      <ErrorState
        message={error.message || 'Failed to load pull requests'}
      />
    );
  }
}

export default async function PRsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const demoEnabled = process.env.NEXT_PUBLIC_DEMO_ENABLED === 'true';
  const demoSecret = process.env.NEXT_PUBLIC_DEMO_SECRET || '';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">
                Pull Requests
              </h1>
              <p className="mt-2 text-sm text-gray-600">
                View and manage pull request risk scores
              </p>
            </div>
            {demoEnabled && demoSecret && (
              <DemoSeedButton demoSecret={demoSecret} />
            )}
          </div>
        </div>

        <Suspense fallback={<TableSkeleton />}>
          <PRList searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}

