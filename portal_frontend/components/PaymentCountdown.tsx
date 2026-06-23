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
  // Collected
  if (paymentStatus === 'collected') {
    return (
      <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-100 rounded-xl">
        <div className="w-9 h-9 rounded-full bg-green-600 flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-green-800">Payment Collected</p>
          <p className="text-xs text-green-600 mt-0.5">Order fully settled</p>
        </div>
      </div>
    );
  }

  // No due date
  if (!dueDate) {
    return (
      <div className="flex items-center gap-3 p-4 bg-slate-50 border border-slate-200 rounded-xl">
        <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-700">Payment Pending</p>
          <p className="text-xs text-slate-400 mt-0.5">Due date set after vendor portal upload</p>
        </div>
      </div>
    );
  }

  const fmtDate = new Date(dueDate).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  // Overdue
  const isOverdue = paymentOverdue || daysToPayment <= 0;
  if (isOverdue) {
    const overdueDays = Math.abs(daysToPayment);
    return (
      <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
        <div className="w-9 h-9 rounded-full bg-red-600 flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-red-800">Payment Overdue</p>
          <p className="text-xs text-red-500 mt-0.5">
            {overdueDays} day{overdueDays !== 1 ? 's' : ''} past due · was {fmtDate}
          </p>
        </div>
      </div>
    );
  }

  // Upcoming: show days remaining + a linear progress bar (elapsed / 90 days)
  const isWarning = daysToPayment <= 14;
  const totalDays = 90;
  const usedDays  = Math.max(0, totalDays - daysToPayment);
  const pct       = Math.min(100, Math.round((usedDays / totalDays) * 100));

  return (
    <div className={`p-4 rounded-xl border ${isWarning ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-100'}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className={`text-sm font-semibold ${isWarning ? 'text-amber-800' : 'text-blue-800'}`}>
            {daysToPayment} day{daysToPayment !== 1 ? 's' : ''} remaining
          </p>
          <p className={`text-xs mt-0.5 ${isWarning ? 'text-amber-500' : 'text-blue-500'}`}>Due {fmtDate}</p>
        </div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${isWarning ? 'bg-amber-200 text-amber-800' : 'bg-blue-100 text-blue-700'}`}>
          {pct}% elapsed
        </span>
      </div>
      <div className="h-1.5 bg-white/60 rounded-full overflow-hidden border border-white/30">
        <div
          className={`h-full rounded-full transition-all ${isWarning ? 'bg-amber-400' : 'bg-blue-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
