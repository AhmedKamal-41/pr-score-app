import { ApiError } from '@/lib/api-error';

export default function ErrorState({ error, fallback = 'Something went wrong' }: { error?: unknown; fallback?: string }) {
  const apiError = error instanceof ApiError ? error : null;
  const message =
    apiError?.status === 403
      ? 'You do not have access to this resource.'
      : apiError && apiError.status >= 500
        ? 'The server could not complete the request. Try again shortly.'
        : apiError?.message ?? fallback;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
      <h2 className="text-sm font-semibold text-red-800">Error{apiError ? ` (${apiError.status})` : ''}</h2>
      <p className="mt-1 text-sm text-red-700">{message}</p>
      {apiError?.requestId && <p className="mt-2 text-xs text-red-500">Request ID: {apiError.requestId}</p>}
    </div>
  );
}
