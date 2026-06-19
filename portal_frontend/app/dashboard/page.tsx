'use client';

import { useEffect, useState, useCallback } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { getCultFitOrders } from '@/lib/api';
import { isLoggedIn, getUser, clearSession } from '@/lib/auth';
import type { CultFitOrder } from '@/types';

// ── Color maps ────────────────────────────────────────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  new:                'bg-gray-100 text-gray-600',
  po_received:        'bg-indigo-100 text-indigo-700',
  pi_shared:          'bg-blue-100 text-blue-700',
  dispatch_requested: 'bg-amber-100 text-amber-700',
  dispatched:         'bg-yellow-100 text-yellow-700',
  delivered:          'bg-orange-100 text-orange-700',
  server_updated:     'bg-teal-100 text-teal-700',
  deal_closed:        'bg-green-100 text-green-700',
};

const DELIVERY_COLORS: Record<string, string> = {
  'No Delivery':          'bg-gray-100 text-gray-500',
  'Pending':              'bg-amber-100 text-amber-700',
  'Ready to Dispatch':    'bg-blue-100 text-blue-700',
  'Partially Dispatched': 'bg-orange-100 text-orange-700',
  'Delivered':            'bg-green-100 text-green-700',
};

const INVOICE_COLORS: Record<string, string> = {
  'Nothing to Invoice':    'bg-gray-100 text-gray-500',
  'To Invoice':            'bg-blue-100 text-blue-700',
  'Invoiced':              'bg-green-100 text-green-700',
  'Upselling Opportunity': 'bg-purple-100 text-purple-700',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmount(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return '—';
  return '₹' + amount.toLocaleString('en-IN');
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

interface BadgeProps { label: string; colorMap: Record<string, string> }
function Badge({ label, colorMap }: BadgeProps) {
  const cls = colorMap[label] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block text-xs px-2.5 py-1 rounded-full font-semibold whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [orders, setOrders]   = useState<CultFitOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const [user, setUser]       = useState<ReturnType<typeof getUser>>(null);

  // Auth guard + role redirect
  useEffect(() => {
    if (!isLoggedIn()) { router.replace('/login'); return; }
    const u = getUser();
    setUser(u);
    if (u?.role === 'admin' || u?.role === 'inbody_manager' || u?.role === 'inbody_user') {
      router.replace('/admin');
    }
  }, [router]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getCultFitOrders();
      setOrders(res.orders);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load orders.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  function handleLogout() {
    clearSession();
    router.replace('/login');
  }

  const filtered = orders.filter(o => {
    const q = search.toLowerCase();
    return (
      !q ||
      o.order_no.toLowerCase().includes(q) ||
      (o.location ?? '').toLowerCase().includes(q) ||
      (o.customer ?? '').toLowerCase().includes(q) ||
      o.model_names.some(m => m.toLowerCase().includes(q))
    );
  });

  const overdue   = orders.filter(o => o.payment_overdue).length;
  const pending   = orders.filter(o => o.payment_status === 'pending').length;
  const collected = orders.filter(o => o.payment_status === 'collected').length;

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Nav */}
      <nav className="bg-blue-700 text-white px-6 py-4 shadow-md">
        <div className="max-w-full mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-white rounded-lg px-2 py-1">
              <Image src="/inbody-logo.webp" alt="InBody" width={80} height={24} className="object-contain" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-blue-200 hidden sm:block">
              {user?.name}{user?.company ? ` · ${user.company}` : ''}
            </span>
            <button
              onClick={handleLogout}
              className="text-sm bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition"
            >
              Logout
            </button>
          </div>
        </div>
      </nav>

      <div className="max-w-full px-4 sm:px-6 py-8">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">My Orders</h1>
          <p className="text-gray-500 text-sm mt-1">
            Track your InBody device orders and current status.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Total Orders',    value: orders.length, color: 'text-blue-700',  bg: 'bg-blue-50 border-blue-200' },
            { label: 'Payment Pending', value: pending,        color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
            { label: 'Overdue',         value: overdue,        color: 'text-red-700',   bg: 'bg-red-50 border-red-200' },
            { label: 'Collected',       value: collected,      color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
          ].map(s => (
            <div key={s.label} className={`rounded-xl border p-4 ${s.bg}`}>
              <p className="text-xs text-gray-500 font-medium">{s.label}</p>
              <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Search */}
        <div className="mb-5">
          <input
            type="text"
            placeholder="Search by order number, centre, or model name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full max-w-lg px-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          />
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-24">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-gray-500 text-sm">Loading orders...</p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="text-red-700 font-medium">{error}</p>
            <button onClick={fetchOrders} className="mt-3 text-sm text-blue-600 hover:underline">
              Try again
            </button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-16">
            <p className="text-gray-400 text-4xl mb-4">📋</p>
            <p className="text-gray-600 font-medium">No orders found</p>
            <p className="text-gray-400 text-sm mt-1">
              {search ? 'Try a different search term.' : 'No orders are linked to your account yet.'}
            </p>
          </div>
        )}

        {/* Orders Table */}
        {!loading && !error && filtered.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '1100px' }}>
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-left">
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Order No</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Location</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Model</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Order Date</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Amount</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Portal Stage</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Delivery</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Invoice</th>
                    <th className="px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">Payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map(order => (
                    <tr
                      key={order.id}
                      onClick={() => router.push(`/orders/${order.id}`)}
                      className="hover:bg-blue-50 transition-colors cursor-pointer"
                    >
                      {/* Order No */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="font-mono font-semibold text-blue-700">{order.order_no}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{order.order_status}</p>
                      </td>

                      {/* Location */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        {order.location
                          ? <span className="text-gray-700">📍 {order.location}</span>
                          : <span className="text-gray-300">&mdash;</span>}
                      </td>

                      {/* Model */}
                      <td className="px-4 py-3 text-gray-700" style={{ maxWidth: '160px' }}>
                        {order.model_names.length > 0
                          ? order.model_names.join(', ')
                          : <span className="text-gray-300">&mdash;</span>}
                      </td>

                      {/* Order Date */}
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                        {fmtDate(order.order_date)}
                      </td>

                      {/* Amount */}
                      <td className="px-4 py-3 font-semibold text-gray-900 whitespace-nowrap">
                        {fmtAmount(order.amount_total)}
                      </td>

                      {/* Portal Stage */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-block text-xs px-2.5 py-1 rounded-full font-semibold whitespace-nowrap ${STAGE_COLORS[order.portal_stage] ?? 'bg-gray-100 text-gray-600'}`}>
                          {order.portal_stage_label}
                        </span>
                      </td>

                      {/* Delivery */}
                      <td className="px-4 py-3">
                        <Badge label={order.delivery_status} colorMap={DELIVERY_COLORS} />
                      </td>

                      {/* Invoice */}
                      <td className="px-4 py-3">
                        <Badge label={order.invoice_status} colorMap={INVOICE_COLORS} />
                      </td>

                      {/* Payment */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        {order.payment_overdue ? (
                          <span className="text-red-600 font-semibold text-xs">🔴 Overdue</span>
                        ) : order.payment_status === 'collected' ? (
                          <span className="text-green-600 font-semibold text-xs">✅ Collected</span>
                        ) : order.payment_due_date ? (
                          <span className="text-amber-600 font-semibold text-xs">
                            {order.days_to_payment}d left
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">Pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
              <p className="text-xs text-gray-400">
                Showing {filtered.length} of {orders.length} order{orders.length !== 1 ? 's' : ''}
                &nbsp;&middot;&nbsp;Click a row to view full details
              </p>
              <button onClick={fetchOrders} className="text-xs text-blue-600 hover:underline">
                Refresh
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
