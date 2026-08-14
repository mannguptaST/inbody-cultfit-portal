'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { getLogisticsOrderDetail, selectLogisticsInvoice } from '@/lib/api';
import { fetchCurrentUser, logout } from '@/lib/auth';
import { DELIVERY_STATUS_LABELS, DELIVERY_STATUS_VARIANT, PO_STATUS_LABELS, PO_STATUS_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import DeliveryTrackingSection from '@/components/DeliveryTrackingSection';
import type { LogisticsOrderDetail, User } from '@/types';

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtInr(n: number | null | undefined): string {
  if (n == null) return '—';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// See the matching helper in app/logistics/page.tsx — an order with no
// requestDetails never went through the portal's own PO flow, so
// 'awaiting_upload' means "not tracked here", not "action needed".
function poDisplay(order: LogisticsOrderDetail): { label: string; variant: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'indigo' | 'orange' | 'purple' } {
  if (!order.requestDetails && order.poStatus === 'awaiting_upload') return { label: 'Not Tracked', variant: 'neutral' };
  return { label: PO_STATUS_LABELS[order.poStatus], variant: PO_STATUS_VARIANT[order.poStatus] };
}

const inputCls = 'w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function LogisticsOrderDetailPage() {
  const router = useRouter();
  const params = useParams();
  const orderId = Number(params.id);

  const [user, setUser] = useState<User | null>(null);
  const [order, setOrder] = useState<LogisticsOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceError, setInvoiceError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const detail = await getLogisticsOrderDetail(orderId);
      setOrder(detail);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load order.');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    fetchCurrentUser().then(u => {
      if (!u) { router.replace('/login'); return; }
      if (u.role !== 'logistics' && u.role !== 'admin') { router.replace('/dashboard'); return; }
      setUser(u);
    });
    if (!orderId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; loading already starts true
    load();
  }, [orderId, router, load]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  async function handleSelectInvoice() {
    if (!selectedInvoiceId) return;
    setInvoiceBusy(true);
    setInvoiceError('');
    try {
      await selectLogisticsInvoice(orderId, Number(selectedInvoiceId));
      await load();
    } catch (err: unknown) {
      setInvoiceError(err instanceof Error ? err.message : 'Failed to select invoice.');
    } finally {
      setInvoiceBusy(false);
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="LOGISTICS" userName={user?.name} backHref="/logistics" backLabel="Logistics" />
      <div className="flex items-center justify-center py-32">
        <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full" />
      </div>
    </div>
  );

  if (error || !order) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="LOGISTICS" userName={user?.name} backHref="/logistics" backLabel="Logistics" />
      <div className="flex items-center justify-center py-32 px-4">
        <div className="bg-white border border-red-200 rounded-xl p-8 text-center max-w-sm">
          <p className="text-red-700 font-medium mb-4">{error || 'Order not found.'}</p>
          <button onClick={() => router.back()} className="text-blue-600 text-sm hover:underline">Go back</button>
        </div>
      </div>
    </div>
  );

  const d = order.requestDetails;
  const poData = order.approvedPoSummary?.data;

  return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader role="LOGISTICS" userName={user?.name} onLogout={handleLogout} backHref="/logistics" backLabel="Logistics" crumb={`REQ-${order.id}`} />

      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">
        <div className="bg-white border border-slate-200 rounded-xl p-6 mb-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-slate-900 font-mono">REQ-{order.id}</h1>
                <StatusChip label={poDisplay(order).label} variant={poDisplay(order).variant} />
                <StatusChip label={DELIVERY_STATUS_LABELS[order.dispatch.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[order.dispatch.deliveryStatus]} />
              </div>
              <p className="text-slate-700 font-medium mt-2">{order.name}</p>
              <p className="text-slate-500 text-sm mt-0.5">{order.customer ?? '—'}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-6">

            {/* Read-only order info */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Order Details (Read-Only)</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Salesperson</p><p className="text-slate-700 mt-0.5">{order.salesperson ?? 'Not assigned'}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">CRM Stage</p><p className="text-slate-700 mt-0.5">{order.crmStage ?? '—'}</p></div>
                {d && (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-slate-400 uppercase tracking-wide">Product Bundle</p>
                    <p className="text-slate-700 mt-0.5">
                      {d.mainProduct.name} × {d.quantity}
                      {d.includedProducts.length > 0 && ` + ${d.includedProducts.map(p => p.name).join(', ')}`}
                    </p>
                  </div>
                )}
                {order.publishedPI && (
                  <>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Confirmed PI</p><p className="text-slate-700 mt-0.5 font-mono">{order.publishedPI.quotationNumber} (v{order.publishedPI.version})</p></div>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">PI Total</p><p className="text-slate-700 mt-0.5">{fmtInr(order.publishedPI.totalAmount)}</p></div>
                  </>
                )}
                {poData && (
                  <>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Approved PO</p><p className="text-slate-700 mt-0.5 font-mono">{poData.poNumber}</p></div>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Expected Delivery (PO)</p><p className="text-slate-700 mt-0.5">{fmtDate(poData.expectedDeliveryDate)}</p></div>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Billing Address</p><p className="text-slate-700 mt-0.5">{poData.billingAddress}</p></div>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Shipping Address</p><p className="text-slate-700 mt-0.5">{poData.shippingAddress}</p></div>
                  </>
                )}
                {!poData && d && (
                  <div className="sm:col-span-2"><p className="text-xs text-slate-400 uppercase tracking-wide">Delivery Address</p><p className="text-slate-700 mt-0.5">{d.deliveryAddress}</p></div>
                )}
              </div>
            </div>

            {/* Billing Invoice */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Billing Invoice</h2>
              {order.invoiceCandidates.length === 0 && (
                <p className="text-sm text-slate-500">Billing invoice has not been created in Odoo yet.</p>
              )}
              {order.invoiceCandidates.length > 1 && !order.selectedInvoice && (
                <div className="space-y-3 mb-4">
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Multiple valid invoices found for this order — select the correct one.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <select value={selectedInvoiceId} onChange={e => setSelectedInvoiceId(e.target.value)} className={inputCls + ' sm:w-64'}>
                      <option value="">Select invoice...</option>
                      {order.invoiceCandidates.map(inv => (
                        <option key={inv.id} value={inv.id}>{inv.name} — {fmtInr(inv.totalAmount)}</option>
                      ))}
                    </select>
                    <button
                      onClick={handleSelectInvoice} disabled={!selectedInvoiceId || invoiceBusy}
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                    >
                      {invoiceBusy ? 'Linking...' : 'Link Invoice'}
                    </button>
                  </div>
                  {invoiceError && <p className="text-sm text-red-700">{invoiceError}</p>}
                </div>
              )}
              {order.selectedInvoice && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Invoice Number</p><p className="font-mono text-slate-800 mt-0.5">{order.selectedInvoice.name}</p></div>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Invoice Date</p><p className="text-slate-700 mt-0.5">{fmtDate(order.selectedInvoice.invoiceDate)}</p></div>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Due Date</p><p className="text-slate-700 mt-0.5">{fmtDate(order.selectedInvoice.dueDate)}</p></div>
                    <div><p className="text-xs text-slate-400 uppercase tracking-wide">Payment Status</p><p className="text-slate-700 mt-0.5 capitalize">{order.selectedInvoice.paymentState.replace(/_/g, ' ')}</p></div>
                  </div>
                  <div className="flex flex-wrap gap-6 text-sm border-t border-slate-100 pt-3">
                    <p className="text-slate-500">Untaxed: <span className="text-slate-800 font-medium">{fmtInr(order.selectedInvoice.untaxedAmount)}</span></p>
                    <p className="text-slate-500">Tax: <span className="text-slate-800 font-medium">{fmtInr(order.selectedInvoice.taxAmount)}</span></p>
                    <p className="text-slate-500">Total: <span className="text-slate-900 font-semibold">{fmtInr(order.selectedInvoice.totalAmount)}</span></p>
                  </div>
                  <p className="text-xs text-slate-400">Invoice PDF download is available to the customer from their Request Detail page.</p>
                </div>
              )}
            </div>

            {/* Delivery Tracking */}
            <DeliveryTrackingSection orderId={order.id} dispatch={order.dispatch} editable onSaved={load} />

            {order.timeline.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Timeline</h2>
                <div className="space-y-4">
                  {order.timeline.map((entry, i) => (
                    <div key={i} className="flex gap-3 text-sm">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-slate-700">{entry.body}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{entry.author} · {fmtDate(entry.date)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-5 lg:sticky lg:top-20">
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Status</h2>
              <div className="space-y-2">
                <StatusChip label={poDisplay(order).label} variant={poDisplay(order).variant} />
                <br />
                <StatusChip label={DELIVERY_STATUS_LABELS[order.dispatch.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[order.dispatch.deliveryStatus]} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
