type Variant = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'indigo' | 'orange' | 'purple';

const V: Record<Variant, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  info:    'bg-blue-50 text-blue-700 border border-blue-100',
  success: 'bg-green-50 text-green-700 border border-green-100',
  warning: 'bg-amber-50 text-amber-700 border border-amber-100',
  danger:  'bg-red-50 text-red-700 border border-red-100',
  teal:    'bg-teal-50 text-teal-700 border border-teal-100',
  indigo:  'bg-indigo-50 text-indigo-700 border border-indigo-100',
  orange:  'bg-orange-50 text-orange-700 border border-orange-100',
  purple:  'bg-purple-50 text-purple-700 border border-purple-100',
};

export default function StatusChip({
  label,
  variant = 'neutral',
}: {
  label: string;
  variant?: Variant;
}) {
  return (
    <span className={`inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-md whitespace-nowrap ${V[variant]}`}>
      {label}
    </span>
  );
}
