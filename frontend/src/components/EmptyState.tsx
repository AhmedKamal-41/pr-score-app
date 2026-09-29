export default function EmptyState({ title = 'No data available', message = 'There are no items to display at this time.' }: { title?: string; message?: string }) {
  return (
    <div className="py-12 text-center">
      <h3 className="text-sm font-medium text-gray-900">{title}</h3>
      <p className="mt-1 text-sm text-gray-500">{message}</p>
    </div>
  );
}
