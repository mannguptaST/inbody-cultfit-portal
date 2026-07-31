'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getCsOrders } from '@/lib/api';
import { fetchCurrentUser, logout } from '@/lib/auth';
import { DELIVERY_STATUS_LABELS, DELIVERY_STATUS_VARIANT, INSTALLATION_STATUS_LABELS, INSTALLATION_STATUS_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { CsOrderSummary, User } from '@/types';

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface SummaryCard { key: string; label: string; count: number }

function computeSummary(orders: CsOrderSummary[]): SummaryCard[] {
  const delivered = orders.filter(o => o.deliveryStatus === 'delivered');
  return [
    { key: 'total', label: 'Total Orders', count: orders.length },
    { key: 'awaiting_delivery', label: 'Awaiting Delivery', count: orders.filter(o => o.deliveryStatus !== 'delivered').length },
    { key: 'ready', label: 'Ready for Installation', count: delivered.filter(o => o.installationStatus === 'not_scheduled').length },
    { key: 'scheduled', label: 'Scheduled', count: orders.filter(o => o.installationStatus === 'scheduled').length },
    { key: 'in_progress', label: 'In Progress', count: orders.filter(o => o.installationStatus === 'in_progress').length },
    { key: 'installed', label: 'Installed', count: orders.filter(o => o.installationStatus === 'installed').length },
    { key: 'completed', label: 'Completed', count: orders.filter(o => o.installationStatus === 'completed').length },
  ];
}

type SortOrder = 'newest' | 'oldest';

export default function CsDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [orders, setOrders] = useState<CsOrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [salespersonFilter, setSalespersonFilter] = useState('');
  const [installationFilter, setInstallationFilter] = useState('');
  const [deliveryFilter, setDeliveryFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (u.role !== 'cs' && u.role !== 'admin') { router.replace('/dashboard'); return; }
      setUser(u);
    });
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getCsOrders();
      setOrders(res.orders);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load orders.');
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; loading already starts true
  useEffect(() => { load(); }, [load]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  const salespeople = useMemo(() => [...new Set(orders.map(o => o.salesperson).filter((s): s is string => !!s))].sort(), [orders]);
  const summary = useMemo(() => computeSummary(orders), [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let result = orders.filter(o => {
      if (q && !`${o.name} ${o.customer ?? ''} ${o.mainProduct ?? ''}`.toLowerCase().includes(q)) return false;
      if (salespersonFilter && o.salesperson !== salespersonFilter) return false;
      if (installationFilter && o.installationStatus !== installationFilter) return false;
      if (deliveryFilter && o.deliveryStatus !== deliveryFilter) return false;
      return true;
    });
    result = [...result].sort((a, b) => {
      const diff = new Date(b.lastUpdated ?? 0).getTime() - new Date(a.lastUpdated ?? 0).getTime();
      return sortOrder === 'newest' ? diff : -diff;
    });
    return result;
  }, [orders, search, salespersonFilter, installationFilter, deliveryFilter, sortOrder]);

  const selectCls = 'text-sm border border-slate-300 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="CS" userName={user?.name} onRefresh={load} onLogout={handleLogout} />

      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">CS Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">All CultFit orders — installation scheduling and tracking</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
          {summary.map(c => (
            <div key={c.key} className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">{c.label}</p>
              <p className="text-xl font-bold text-slate-900 mt-1">{c.count}</p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4 shadow-sm">
          <div className="flex flex-wrap gap-3">
            <input
              type="text" placeholder="Search order, customer, product..."
              value={search} onChange={e => setSearch(e.target.value)}
              className="flex-1 min-w-[220px] text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select className={selectCls} value={salespersonFilter} onChange={e => setSalespersonFilter(e.target.value)}>
              <option value="">All Salespeople</option>
              {salespeople.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className={selectCls} value={deliveryFilter} onChange={e => setDeliveryFilter(e.target.value)}>
              <option value="">All Delivery Status</option>
              {Object.entries(DELIVERY_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className={selectCls} value={installationFilter} onChange={e => setInstallationFilter(e.target.value)}>
              <option value="">All Installation Status</option>
              {Object.entries(INSTALLATION_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className={selectCls} value={sortOrder} onChange={e => setSortOrder(e.target.value as SortOrder)}>
              <option value="newest">Latest First</option>
              <option value="oldest">Oldest First</option>
            </select>
          </div>
        </div>

        {!loading && !error && (
          <p className="text-xs text-slate-400 mb-3">{filtered.length} of {orders.length} order{orders.length === 1 ? '' : 's'}</p>
        )}

        {loading && (
          <div className="bg-white border border-slate-200 rounded-xl p-16 text-center shadow-sm">
            <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto" />
          </div>
        )}

        {!loading && error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="text-sm text-red-700 font-medium mb-2">{error}</p>
            <button onClick={load} className="text-sm text-blue-600 hover:underline">Try again</button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-16 text-center shadow-sm">
            <p className="text-slate-700 font-medium">No orders match these filters</p>
          </div>
        )}

        {/* Desktop table */}
        {!loading && !error && filtered.length > 0 && (
          <div className="hidden lg:block bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '1100px' }}>
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left">
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Reference</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Customer / Location</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Product</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Salesperson</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Delivery</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Installation</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Scheduled</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Updated</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map(o => (
                    <tr key={o.id} onClick={() => router.push(`/cs/orders/${o.id}`)} className="hover:bg-slate-50 transition-colors cursor-pointer group">
                      <td className="px-4 py-3 whitespace-nowrap"><span className="font-mono text-sm font-semibold text-blue-700">REQ-{o.id}</span></td>
                      <td className="px-4 py-3 text-slate-700" style={{ maxWidth: '200px' }}><span className="line-clamp-1">{o.customer ?? '—'}</span></td>
                      <td className="px-4 py-3 text-slate-600" style={{ maxWidth: '200px' }}><span className="line-clamp-1">{o.mainProduct ?? '—'}</span></td>
                      <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{o.salesperson ?? 'Not assigned'}</td>
                      <td className="px-4 py-3 whitespace-nowrap"><StatusChip label={DELIVERY_STATUS_LABELS[o.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[o.deliveryStatus]} /></td>
                      <td className="px-4 py-3 whitespace-nowrap"><StatusChip label={INSTALLATION_STATUS_LABELS[o.installationStatus]} variant={INSTALLATION_STATUS_VARIANT[o.installationStatus]} /></td>
                      <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{fmtDate(o.scheduledDate)}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">{fmtDate(o.lastUpdated)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap"><span className="text-xs text-blue-600 group-hover:underline">View</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Mobile cards */}
        {!loading && !error && filtered.length > 0 && (
          <div className="lg:hidden space-y-3">
            {filtered.map(o => (
              <div
                key={o.id}
                onClick={() => router.push(`/cs/orders/${o.id}`)}
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm active:bg-slate-50"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-semibold text-blue-700">REQ-{o.id}</span>
                  <StatusChip label={INSTALLATION_STATUS_LABELS[o.installationStatus]} variant={INSTALLATION_STATUS_VARIANT[o.installationStatus]} />
                </div>
                <p className="text-sm text-slate-700 font-medium">{o.customer ?? '—'}</p>
                <p className="text-xs text-slate-500 mt-0.5">{o.mainProduct ?? '—'}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <StatusChip label={DELIVERY_STATUS_LABELS[o.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[o.deliveryStatus]} />
                </div>
                <div className="flex items-center justify-between mt-3 text-xs text-slate-400">
                  <span>{o.salesperson ?? 'Not assigned'}</span>
                  <span>Sched. {fmtDate(o.scheduledDate)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
