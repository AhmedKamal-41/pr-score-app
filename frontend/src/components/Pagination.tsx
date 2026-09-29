import Link from 'next/link';

interface PaginationProps {
  basePath: string;
  limit: number;
  offset: number;
  total: number;
  shown: number;
}

export default function Pagination({ basePath, limit, offset, total, shown }: PaginationProps) {
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const prevOffset = Math.max(0, offset - limit);
  const hasPrev = offset > 0;
  const hasNext = offset + shown < total;
  const href = (o: number) => `${basePath}?limit=${limit}&offset=${o}`;
  const linkClass = 'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50';
  const disabledClass = 'rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-300';
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-gray-600">
        Showing <span className="font-medium">{from}</span>–<span className="font-medium">{to}</span> of{' '}
        <span className="font-medium">{total}</span> pull requests
      </p>
      <div className="flex gap-2">
        {hasPrev ? <Link className={linkClass} href={href(prevOffset)}>Previous</Link> : <span className={disabledClass} aria-disabled="true">Previous</span>}
        {hasNext ? <Link className={linkClass} href={href(offset + limit)}>Next</Link> : <span className={disabledClass} aria-disabled="true">Next</span>}
      </div>
    </nav>
  );
}
