'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { getLogisticsOrderDetail, selectLogisticsInvoice, updateLogisticsDispatch } from '@/lib/api';
import { fetchCurrentUser, logout } from '@/lib/auth';
import { DELIVERY_STATUS_LABELS, DELIVERY_STATUS_VARIANT, PO_STATUS_LABELS, PO_STATUS_VARIANT } from '@/lib/stage-config';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { LogisticsOrderDetail, DeliveryStatus, User } from '@/types';

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

const DELIVERY_STATUS_OPTIONS: DeliveryStatus[] = [
  'not_started', 'logistics_processing', 'ready_to_dispatch', 'dispatched', 'in_transit', 'delivered', 'delivery_issue',
];

const inputCls = 'w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500';
const labelCls = 'text-xs font-medium text-slate-600 block mb-1';

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

  const [dispatchForm, setDispatchForm] = useState({
    dispatchDate: '', courier: '', awb: '', trackingUrl: '',
    expectedDeliveryDate: '', actualDeliveryDate: '', deliveryStatus: 'not_started' as DeliveryStatus, logisticsNote: '',
  });
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState('');
  const [dispatchSaved, setDispatchSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const detail = await getLogisticsOrderDetail(orderId);
      setOrder(detail);
      setDispatchForm({
        dispatchDate: detail.dispatch.dispatchDate ?? '',
        courier: detail.dispatch.courier ?? '',
        awb: detail.dispatch.awb ?? '',
        trackingUrl: detail.dispatch.trackingUrl ?? '',
        expectedDeliveryDate: detail.dispatch.expectedDeliveryDate ?? '',
        actualDeliveryDate: detail.dispatch.actualDeliveryDate ?? '',
        deliveryStatus: detail.dispatch.deliveryStatus,
        logisticsNote: detail.dispatch.logisticsNote ?? '',
      });
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

  async function handleSaveDispatch() {
    setDispatchBusy(true);
    setDispatchError('');
    setDispatchSaved(false);
    try {
      await updateLogisticsDispatch(orderId, {
        dispatchDate: dispatchForm.dispatchDate || null,
        courier: dispatchForm.courier || null,
        awb: dispatchForm.awb || null,
        trackingUrl: dispatchForm.trackingUrl || null,
        expectedDeliveryDate: dispatchForm.expectedDeliveryDate || null,
        actualDeliveryDate: dispatchForm.actualDeliveryDate || null,
        deliveryStatus: dispatchForm.deliveryStatus,
        logisticsNote: dispatchForm.logisticsNote || null,
      });
      setDispatchSaved(true);
      await load();
    } catch (err: unknown) {
      setDispatchError(err instanceof Error ? err.message : 'Failed to save dispatch info.');
    } finally {
      setDispatchBusy(false);
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

            {/* Dispatch */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Dispatch</h2>
                {order.dispatch.pickingId && (
                  <span className="text-xs text-slate-400">Linked picking: <span className="font-mono">{order.dispatch.pickingName}</span> ({order.dispatch.pickingState})</span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label className={labelCls}>Dispatch Date</label><input type="date" className={inputCls} value={dispatchForm.dispatchDate} onChange={e => setDispatchForm(f => ({ ...f, dispatchDate: e.target.value }))} /></div>
                <div><label className={labelCls}>Courier / Transporter</label><input type="text" maxLength={120} className={inputCls} value={dispatchForm.courier} onChange={e => setDispatchForm(f => ({ ...f, courier: e.target.value }))} /></div>
                <div><label className={labelCls}>AWB / Tracking Number</label><input type="text" maxLength={60} className={inputCls} value={dispatchForm.awb} onChange={e => setDispatchForm(f => ({ ...f, awb: e.target.value }))} /></div>
                <div><label className={labelCls}>Tracking URL</label><input type="url" placeholder="https://..." className={inputCls} value={dispatchForm.trackingUrl} onChange={e => setDispatchForm(f => ({ ...f, trackingUrl: e.target.value }))} /></div>
                <div><label className={labelCls}>Expected Delivery Date</label><input type="date" className={inputCls} value={dispatchForm.expectedDeliveryDate} onChange={e => setDispatchForm(f => ({ ...f, expectedDeliveryDate: e.target.value }))} /></div>
                <div><label className={labelCls}>Actual Delivery Date</label><input type="date" className={inputCls} value={dispatchForm.actualDeliveryDate} onChange={e => setDispatchForm(f => ({ ...f, actualDeliveryDate: e.target.value }))} /></div>
                <div>
                  <label className={labelCls}>Delivery Status</label>
                  <select className={inputCls + ' bg-white'} value={dispatchForm.deliveryStatus} onChange={e => setDispatchForm(f => ({ ...f, deliveryStatus: e.target.value as DeliveryStatus }))}>
                    {DELIVERY_STATUS_OPTIONS.map(s => <option key={s} value={s}>{DELIVERY_STATUS_LABELS[s]}</option>)}
                  </select>
                </div>
              </div>
              <div className="mt-4">
                <label className={labelCls}>Logistics Note (visible to customer)</label>
                <textarea rows={3} maxLength={1000} className={inputCls + ' resize-none'} value={dispatchForm.logisticsNote} onChange={e => setDispatchForm(f => ({ ...f, logisticsNote: e.target.value }))} />
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button onClick={handleSaveDispatch} disabled={dispatchBusy} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
                  {dispatchBusy ? 'Saving...' : 'Save Dispatch Info'}
                </button>
                {dispatchSaved && <span className="text-sm text-green-700">Saved.</span>}
              </div>
              {dispatchError && <p className="text-sm text-red-700 mt-2">{dispatchError}</p>}
              {!order.dispatch.pickingId && (
                <p className="text-xs text-slate-400 mt-3">No linked Odoo delivery yet — these details are stored as portal logistics data and will be preferred alongside native fields once a delivery exists.</p>
              )}
            </div>

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
