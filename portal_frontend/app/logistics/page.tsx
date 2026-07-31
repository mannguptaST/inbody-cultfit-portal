'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getLogisticsOrders } from '@/lib/api';
import { fetchCurrentUser, logout } from '@/lib/auth';
import { PO_STATUS_LABELS, PO_STATUS_VARIANT, DELIVERY_STATUS_LABELS, DELIVERY_STATUS_VARIANT, INVOICE_STATUS_LABELS, INVOICE_STATUS_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { LogisticsOrderSummary, User } from '@/types';

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface SummaryCard { key: string; label: string; count: number }

function computeSummary(orders: LogisticsOrderSummary[]): SummaryCard[] {
  return [
    { key: 'total', label: 'Total Orders', count: orders.length },
    { key: 'awaiting_po', label: 'Awaiting PO Approval', count: orders.filter(o => o.poStatus !== 'approved').length },
    { key: 'ready', label: 'Ready for Logistics', count: orders.filter(o => o.poStatus === 'approved' && o.deliveryStatus === 'not_started').length },
    { key: 'invoice_pending', label: 'Invoice Pending', count: orders.filter(o => o.invoiceStatus !== 'available').length },
    { key: 'dispatch_pending', label: 'Dispatch Pending', count: orders.filter(o => ['not_started', 'logistics_processing', 'ready_to_dispatch'].includes(o.deliveryStatus)).length },
    { key: 'dispatched', label: 'Dispatched', count: orders.filter(o => o.deliveryStatus === 'dispatched').length },
    { key: 'in_transit', label: 'In Transit', count: orders.filter(o => o.deliveryStatus === 'in_transit').length },
    { key: 'delivered', label: 'Delivered', count: orders.filter(o => o.deliveryStatus === 'delivered').length },
  ];
}

type SortOrder = 'newest' | 'oldest';

export default function LogisticsDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [orders, setOrders] = useState<LogisticsOrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [salespersonFilter, setSalespersonFilter] = useState('');
  const [poFilter, setPoFilter] = useState('');
  const [invoiceFilter, setInvoiceFilter] = useState('');
  const [deliveryFilter, setDeliveryFilter] = useState('');
  const [courierFilter, setCourierFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (u.role !== 'logistics' && u.role !== 'admin') { router.replace('/dashboard'); return; }
      setUser(u);
    });
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getLogisticsOrders();
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
  const couriers = useMemo(() => [...new Set(orders.map(o => o.courier).filter((c): c is string => !!c))].sort(), [orders]);
  const summary = useMemo(() => computeSummary(orders), [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let result = orders.filter(o => {
      if (q && !`${o.name} ${o.customer ?? ''} ${o.mainProduct ?? ''} ${o.awb ?? ''}`.toLowerCase().includes(q)) return false;
      if (salespersonFilter && o.salesperson !== salespersonFilter) return false;
      if (poFilter && o.poStatus !== poFilter) return false;
      if (invoiceFilter && o.invoiceStatus !== invoiceFilter) return false;
      if (deliveryFilter && o.deliveryStatus !== deliveryFilter) return false;
      if (courierFilter && o.courier !== courierFilter) return false;
      return true;
    });
    result = [...result].sort((a, b) => {
      const diff = new Date(b.lastUpdated ?? 0).getTime() - new Date(a.lastUpdated ?? 0).getTime();
      return sortOrder === 'newest' ? diff : -diff;
    });
    return result;
  }, [orders, search, salespersonFilter, poFilter, invoiceFilter, deliveryFilter, courierFilter, sortOrder]);

  const selectCls = 'text-sm border border-slate-300 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="LOGISTICS" userName={user?.name} onRefresh={load} onLogout={handleLogout} />

      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Logistics Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">All CultFit orders — invoice and dispatch tracking</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
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
              type="text" placeholder="Search order, customer, product, AWB..."
              value={search} onChange={e => setSearch(e.target.value)}
              className="flex-1 min-w-[220px] text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select className={selectCls} value={salespersonFilter} onChange={e => setSalespersonFilter(e.target.value)}>
              <option value="">All Salespeople</option>
              {salespeople.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className={selectCls} value={poFilter} onChange={e => setPoFilter(e.target.value)}>
              <option value="">All PO Status</option>
              {Object.entries(PO_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className={selectCls} value={invoiceFilter} onChange={e => setInvoiceFilter(e.target.value)}>
              <option value="">All Invoice Status</option>
              {Object.entries(INVOICE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className={selectCls} value={deliveryFilter} onChange={e => setDeliveryFilter(e.target.value)}>
              <option value="">All Delivery Status</option>
              {Object.entries(DELIVERY_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className={selectCls} value={courierFilter} onChange={e => setCourierFilter(e.target.value)}>
              <option value="">All Couriers</option>
              {couriers.map(c => <option key={c} value={c}>{c}</option>)}
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
              <table className="w-full text-sm" style={{ minWidth: '1400px' }}>
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left">
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Reference</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Customer / Location</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Product</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Salesperson</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">PO</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Invoice</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Dispatch</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Courier / AWB</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Expected Delivery</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Updated</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map(o => (
                    <tr key={o.id} onClick={() => router.push(`/logistics/orders/${o.id}`)} className="hover:bg-slate-50 transition-colors cursor-pointer group">
                      <td className="px-4 py-3 whitespace-nowrap"><span className="font-mono text-sm font-semibold text-blue-700">REQ-{o.id}</span></td>
                      <td className="px-4 py-3 text-slate-700" style={{ maxWidth: '200px' }}><span className="line-clamp-1">{o.customer ?? '—'}</span></td>
                      <td className="px-4 py-3 text-slate-600" style={{ maxWidth: '200px' }}><span className="line-clamp-1">{o.mainProduct ?? '—'}</span></td>
                      <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{o.salesperson ?? 'Not assigned'}</td>
                      <td className="px-4 py-3 whitespace-nowrap"><StatusChip label={PO_STATUS_LABELS[o.poStatus]} variant={PO_STATUS_VARIANT[o.poStatus]} /></td>
                      <td className="px-4 py-3 whitespace-nowrap"><StatusChip label={INVOICE_STATUS_LABELS[o.invoiceStatus]} variant={INVOICE_STATUS_VARIANT[o.invoiceStatus]} /></td>
                      <td className="px-4 py-3 whitespace-nowrap"><StatusChip label={DELIVERY_STATUS_LABELS[o.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[o.deliveryStatus]} /></td>
                      <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{[o.courier, o.awb].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{fmtDate(o.expectedDeliveryDate)}</td>
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
                onClick={() => router.push(`/logistics/orders/${o.id}`)}
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm active:bg-slate-50"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-semibold text-blue-700">REQ-{o.id}</span>
                  <StatusChip label={DELIVERY_STATUS_LABELS[o.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[o.deliveryStatus]} />
                </div>
                <p className="text-sm text-slate-700 font-medium">{o.customer ?? '—'}</p>
                <p className="text-xs text-slate-500 mt-0.5">{o.mainProduct ?? '—'}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <StatusChip label={PO_STATUS_LABELS[o.poStatus]} variant={PO_STATUS_VARIANT[o.poStatus]} />
                  <StatusChip label={INVOICE_STATUS_LABELS[o.invoiceStatus]} variant={INVOICE_STATUS_VARIANT[o.invoiceStatus]} />
                </div>
                <div className="flex items-center justify-between mt-3 text-xs text-slate-400">
                  <span>{o.salesperson ?? 'Not assigned'}</span>
                  <span>Exp. {fmtDate(o.expectedDeliveryDate)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
