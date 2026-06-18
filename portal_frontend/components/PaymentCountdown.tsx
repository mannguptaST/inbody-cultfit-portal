'use client';

interface Props {
  dueDate: string | null;
  daysToPayment: number;
  paymentOverdue: boolean;
  paymentStatus: string;
}

export default function PaymentCountdown({
  dueDate,
  daysToPayment,
  paymentOverdue,
  paymentStatus,
}: Props) {
  if (paymentStatus === 'collected') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-lg">
        <span className="text-green-600 text-lg">✅</span>
        <span className="text-green-700 font-semibold text-sm">Payment Collected</span>
      </div>
    );
  }

  if (!dueDate) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg">
        <span className="text-gray-400 text-lg">⏳</span>
        <span className="text-gray-500 text-sm">Payment due date will appear after vendor portal upload</span>
      </div>
    );
  }

  const isOverdue = paymentOverdue || daysToPayment < 0;
  const isWarning = !isOverdue && daysToPayment <= 15;
  const absDays = Math.abs(daysToPayment);

  const formattedDue = new Date(dueDate).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  return (
    <div
      className={`px-4 py-3 rounded-lg border ${
        isOverdue
          ? 'bg-red-50 border-red-300'
          : isWarning
          ? 'bg-amber-50 border-amber-300'
          : 'bg-blue-50 border-blue-200'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className={`text-xs font-medium uppercase tracking-wide ${
            isOverdue ? 'text-red-500' : isWarning ? 'text-amber-600' : 'text-blue-500'
          }`}>
            {isOverdue ? '🔴 Payment Overdue' : isWarning ? '🟠 Due Soon' : '💳 Payment Due'}
          </p>
          <p className={`text-2xl font-bold mt-1 ${
            isOverdue ? 'text-red-700' : isWarning ? 'text-amber-700' : 'text-blue-700'
          }`}>
            {isOverdue ? `${absDays} days overdue` : `${absDays} days left`}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">Due date: {formattedDue}</p>
        </div>

        {/* 90-day progress ring */}
        <div className="relative w-16 h-16">
          <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="26" fill="none" stroke="#e5e7eb" strokeWidth="6" />
            <circle
              cx="32" cy="32" r="26"
              fill="none"
              stroke={isOverdue ? '#ef4444' : isWarning ? '#f59e0b' : '#3b82f6'}
              strokeWidth="6"
              strokeDasharray={`${2 * Math.PI * 26}`}
              strokeDashoffset={`${2 * Math.PI * 26 * (1 - Math.max(0, Math.min(90, daysToPayment)) / 90)}`}
              strokeLinecap="round"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-600">
            {Math.max(0, Math.min(100, Math.round((daysToPayment / 90) * 100)))}%
          </span>
        </div>
      </div>
    </div>
  );
}
