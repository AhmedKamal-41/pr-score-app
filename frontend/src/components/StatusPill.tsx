const STYLES: Record<string, string> = {
  success: 'bg-green-50 text-green-700 ring-green-600/20',
  succeeded: 'bg-green-50 text-green-700 ring-green-600/20',
  current: 'bg-green-50 text-green-700 ring-green-600/20',
  failure: 'bg-red-50 text-red-700 ring-red-600/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/20',
  pending: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  processing: 'bg-blue-50 text-blue-700 ring-blue-600/20',
};

export default function StatusPill({ label, tone }: { label: string; tone?: string }) {
  const style = STYLES[tone ?? label] ?? 'bg-gray-50 text-gray-700 ring-gray-500/20';
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}>{label}</span>;
}
