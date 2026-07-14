'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getCultFitOrders } from '@/lib/api';
import { fetchCurrentUser, isInBodyStaff, logout } from '@/lib/auth';
import { STAGE_LABELS, STAGE_KEYS, STAGE_VARIANT, DELIVERY_VARIANT, INVOICE_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { CultFitOrder, User } from '@/types';

// ── Config ────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

type SortKey = 'updated_desc' | 'updated_asc' | 'amount_desc' | 'deadline_asc';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'updated_desc', label: 'Latest updated' },
  { value: 'updated_asc', label: 'Oldest updated' },
  { value: 'amount_desc', label: 'Amount (high to low)' },
  { value: 'deadline_asc', label: 'Payment deadline' },
];

const PAYMENT_FILTERS = [
  { value: '', label: 'All Payments' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'pending', label: 'Pending' },
  { value: 'collected', label: 'Collected' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmount(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return '—';
  return '₹' + amount.toLocaleString('en-IN');
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

function paymentBucket(o: CultFitOrder): 'overdue' | 'collected' | 'pending' {
  if (o.payment_overdue) return 'overdue';
  if (o.payment_status === 'collected') return 'collected';
  return 'pending';
}

function sortOrders(orders: CultFitOrder[], sort: SortKey): CultFitOrder[] {
  const copy = [...orders];
  switch (sort) {
    case 'updated_asc':
      return copy.sort((a, b) => (a.last_updated ?? '').localeCompare(b.last_updated ?? ''));
    case 'amount_desc':
      return copy.sort((a, b) => (b.amount_total ?? 0) - (a.amount_total ?? 0));
    case 'deadline_asc':
      return copy.sort((a, b) => {
        if (!a.payment_due_date) return 1;
        if (!b.payment_due_date) return -1;
        return a.payment_due_date.localeCompare(b.payment_due_date);
      });
    case 'updated_desc':
    default:
      return copy.sort((a, b) => (b.last_updated ?? '').localeCompare(a.last_updated ?? ''));
  }
}

function PaymentCell({ order }: { order: CultFitOrder }) {
  if (order.payment_overdue)
    return <span className="text-xs font-semibold text-red-600">Overdue</span>;
  if (order.payment_status === 'collected')
    return <span className="text-xs font-semibold text-green-600">Collected</span>;
  if (order.payment_due_date)
    return <span className="text-xs font-medium text-amber-600">{order.days_to_payment}d left</span>;
  return <span className="text-xs text-slate-400">Pending</span>;
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="px-5 py-4 flex items-center gap-6 animate-pulse">
          <div className="h-4 bg-slate-100 rounded w-24" />
          <div className="h-4 bg-slate-100 rounded w-28 hidden sm:block" />
          <div className="h-4 bg-slate-100 rounded w-20 hidden md:block" />
          <div className="h-4 bg-slate-100 rounded w-16 ml-auto" />
          <div className="h-5 bg-slate-100 rounded-full w-24" />
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [orders, setOrders]             = useState<CultFitOrder[]>([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [search, setSearch]             = useState('');
  const [stageFilter, setStageFilter]   = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [sort, setSort]                 = useState<SortKey>('updated_desc');
  const [page, setPage]                 = useState(1);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [user, setUser]                 = useState<User | null>(null);

  // Middleware already gates page access server-side; this fetch is purely
  // to get the user's name/role for display.
  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      setUser(u);
      if (isInBodyStaff(u.role)) router.replace('/admin');
    });
  }, [router]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getCultFitOrders();
      setOrders(res.orders);
      setLastRefreshed(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load orders.');
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; loading already starts true
  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  const filtered = sortOrders(
    orders.filter(o => {
      const q = search.toLowerCase();
      const matchSearch =
        !q ||
        o.order_no.toLowerCase().includes(q) ||
        (o.location ?? '').toLowerCase().includes(q) ||
        (o.customer ?? '').toLowerCase().includes(q) ||
        o.model_names.some(m => m.toLowerCase().includes(q)) ||
        (o.portal_stage_label ?? '').toLowerCase().includes(q);
      const matchStage = !stageFilter || o.portal_stage === stageFilter;
      const matchPayment = !paymentFilter || paymentBucket(o) === paymentFilter;
      return matchSearch && matchStage && matchPayment;
    }),
    sort,
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageItems = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const overdue   = orders.filter(o => o.payment_overdue).length;
  const pending   = orders.filter(o => o.payment_status !== 'collected').length;
  const collected = orders.filter(o => o.payment_status === 'collected').length;

  const hasFilters = Boolean(search || stageFilter || paymentFilter);

  const stats = [
    {
      label: 'Total Orders', value: orders.length,
      valueColor: 'text-slate-900', sub: 'All your orders',
      icon: <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>,
    },
    {
      label: 'Payment Pending', value: pending,
      valueColor: 'text-amber-600', sub: 'Awaiting collection',
      icon: <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    },
    {
      label: 'Overdue', value: overdue,
      valueColor: overdue > 0 ? 'text-red-600' : 'text-slate-900', sub: 'Past due date',
      icon: <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
    },
    {
      label: 'Collected', value: collected,
      valueColor: 'text-green-600', sub: 'Payment received',
      icon: <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50">

      <PortalHeader
        role="CUSTOMER"
        userName={user?.name ?? user?.company ?? undefined}
        search={search}
        onSearchChange={v => { setSearch(v); setPage(1); }}
        onLogout={handleLogout}
      />

      <div className="max-w-screen-2xl mx-auto px-6 py-8">

        {/* Page title */}
        <div className="mb-7">
          <h1 className="text-xl font-semibold text-slate-900">My Orders</h1>
          <p className="text-sm text-slate-500 mt-0.5">Track your InBody device orders and current delivery status</p>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-7">
          {stats.map(s => (
            <div key={s.label} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <div className="flex items-start justify-between mb-3">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{s.label}</p>
                <span className="p-1.5 bg-slate-50 rounded-lg">{s.icon}</span>
              </div>
              <p className={`text-3xl font-bold ${s.valueColor}`}>{s.value}</p>
              <p className="text-xs text-slate-400 mt-1">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <select
            value={stageFilter}
            onChange={e => { setStageFilter(e.target.value); setPage(1); }}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[160px]"
          >
            <option value="">All Stages</option>
            {STAGE_KEYS.map(k => (
              <option key={k} value={k}>{STAGE_LABELS[k]}</option>
            ))}
          </select>
          <select
            value={paymentFilter}
            onChange={e => { setPaymentFilter(e.target.value); setPage(1); }}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]"
          >
            {PAYMENT_FILTERS.map(f => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <select
            value={sort}
            onChange={e => { setSort(e.target.value as SortKey); setPage(1); }}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[170px]"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>Sort: {o.label}</option>
            ))}
          </select>
          {hasFilters && (
            <button
              onClick={() => { setSearch(''); setStageFilter(''); setPaymentFilter(''); setPage(1); }}
              className="text-xs text-blue-600 hover:text-blue-700 underline"
            >
              Clear filters
            </button>
          )}
          {!loading && (
            <p className="text-xs text-slate-400 sm:ml-auto">
              {filtered.length} of {orders.length} orders
            </p>
          )}
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <SkeletonRows />
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="text-sm text-red-700 font-medium mb-2">{error}</p>
            <button onClick={fetchOrders} className="text-sm text-blue-600 hover:underline">Try again</button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && filtered.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-16 text-center shadow-sm">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <p className="text-slate-700 font-medium">No orders found</p>
            <p className="text-sm text-slate-400 mt-1">
              {hasFilters ? 'Try adjusting your filters.' : 'No orders are linked to your account yet.'}
            </p>
          </div>
        )}

        {/* Table */}
        {!loading && !error && filtered.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '1000px' }}>
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left">
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Order</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Location</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Model</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Date</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Amount</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Stage</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Delivery</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Invoice</th>
                    <th className="px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pageItems.map(order => (
                    <tr
                      key={order.id}
                      onClick={() => router.push(`/orders/${order.id}`)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer group"
                    >
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <p className="font-mono text-sm font-semibold text-blue-700 group-hover:text-blue-800">
                          {order.order_no}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5">{order.order_status}</p>
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {order.location
                          ? <span className="text-slate-700">{order.location}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>

                      <td className="px-5 py-3.5 text-slate-600" style={{ maxWidth: '160px' }}>
                        <span className="line-clamp-2">
                          {order.model_names.length > 0 ? order.model_names.join(', ') : '—'}
                        </span>
                      </td>

                      <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap text-xs">
                        {fmtDate(order.order_date)}
                      </td>

                      <td className="px-5 py-3.5 font-semibold text-slate-900 whitespace-nowrap">
                        {fmtAmount(order.amount_total)}
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <StatusChip
                          label={order.portal_stage_label}
                          variant={STAGE_VARIANT[order.portal_stage] ?? 'neutral'}
                        />
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <StatusChip
                          label={order.delivery_status}
                          variant={DELIVERY_VARIANT[order.delivery_status] ?? 'neutral'}
                        />
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <StatusChip
                          label={order.invoice_status}
                          variant={INVOICE_VARIANT[order.invoice_status] ?? 'neutral'}
                        />
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <PaymentCell order={order} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-3 border-t border-slate-100 flex flex-wrap items-center gap-3 justify-between bg-slate-50/50">
              <p className="text-xs text-slate-400">
                Showing {(pageSafe - 1) * PAGE_SIZE + 1}–{Math.min(pageSafe * PAGE_SIZE, filtered.length)} of {filtered.length}
                {' '}· Last refreshed {fmtTime(lastRefreshed)}
              </p>
              <div className="flex items-center gap-2">
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={pageSafe === 1}
                      className="text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100"
                    >
                      Prev
                    </button>
                    <span className="text-xs text-slate-500 px-1">{pageSafe} / {totalPages}</span>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={pageSafe === totalPages}
                      className="text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100"
                    >
                      Next
                    </button>
                  </div>
                )}
                <button onClick={fetchOrders} className="text-xs text-blue-600 hover:underline">
                  Refresh
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
