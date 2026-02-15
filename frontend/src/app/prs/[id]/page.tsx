import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { fetchPRDetails } from '../../../lib/api';
import PrDetail from '../../../components/PrDetail';
import { DetailSkeleton } from '../../../components/LoadingSkeleton';
import ErrorState from '../../../components/ErrorState';
import Link from 'next/link';

async function PRDetailContent({ id }: { id: string }) {
  try {
    const pr = await fetchPRDetails(id);
    return <PrDetail pr={pr} />;
  } catch (error: any) {
    if (error.message.includes('404') || error.message.includes('not found')) {
      notFound();
    }
    return (
      <ErrorState message={error.message || 'Failed to load PR details'} />
    );
  }
}

export default async function PRDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <Link
            href="/prs"
            className="text-blue-600 hover:text-blue-800 text-sm font-medium mb-4 inline-block"
          >
            ← Back to Pull Requests
          </Link>
        </div>

        <Suspense fallback={<DetailSkeleton />}>
          <PRDetailContent id={id} />
        </Suspense>
      </div>
    </div>
  );
}

