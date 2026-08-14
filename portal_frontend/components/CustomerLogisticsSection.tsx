'use client';

import { useEffect, useState } from 'react';
import { getCustomerLogisticsView, getInvoiceDownloadUrl } from '@/lib/api';
import { DELIVERY_STATUS_LABELS, DELIVERY_STATUS_VARIANT } from '@/lib/stage-config';
import StatusChip from '@/components/StatusChip';
import type { CustomerLogisticsView } from '@/types';

function fmtInr(n: number | null): string {
  if (n == null) return '—';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isSafeTrackingUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function CustomerLogisticsSection({ requestId }: { requestId: number }) {
  const [view, setView] = useState<CustomerLogisticsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getCustomerLogisticsView(requestId)
      .then(setView)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load logistics info.'))
      .finally(() => setLoading(false));
  }, [requestId]);

  if (loading) return null;
  if (error) return null; // non-critical section — fails quietly rather than breaking the whole request detail page
  if (!view) return null;

  const { invoice, invoiceStatus, dispatch } = view;
  const hasDispatchInfo = dispatch.deliveryStatus !== 'not_started' || dispatch.courier || dispatch.awb || dispatch.trackingUrl;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Logistics &amp; Delivery</h2>

      <div className="space-y-5">
        {/* Invoice */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Billing Invoice</p>
          {invoiceStatus === 'not_created' && (
            <p className="text-sm text-slate-500">Billing invoice has not been created in Odoo yet.</p>
          )}
          {invoiceStatus === 'needs_selection' && (
            <p className="text-sm text-slate-500">Invoice is being prepared.</p>
          )}
          {invoiceStatus === 'available' && invoice && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Invoice Number</p><p className="font-mono text-slate-800 mt-0.5">{invoice.name}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Invoice Date</p><p className="text-slate-700 mt-0.5">{fmtDate(invoice.invoiceDate)}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Total</p><p className="text-slate-700 mt-0.5">{fmtInr(invoice.totalAmount)}</p></div>
                <div><p className="text-xs text-slate-400 uppercase tracking-wide">Payment Status</p><p className="text-slate-700 mt-0.5 capitalize">{invoice.paymentState.replace(/_/g, ' ')}</p></div>
              </div>
              <div className="flex flex-wrap gap-6 text-sm">
                <p className="text-slate-500">Untaxed: <span className="text-slate-800 font-medium">{fmtInr(invoice.untaxedAmount)}</span></p>
                <p className="text-slate-500">Tax: <span className="text-slate-800 font-medium">{fmtInr(invoice.taxAmount)}</span></p>
              </div>
              <a
                href={getInvoiceDownloadUrl(requestId)}
                className="inline-block text-sm text-blue-600 hover:text-blue-700 border border-blue-200 hover:border-blue-300 bg-blue-50 px-4 py-2 rounded-lg transition-all"
              >
                Download Invoice
              </a>
            </div>
          )}
        </div>

        {/* Delivery Tracking */}
        <div className="border-t border-slate-100 pt-5">
          <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Delivery Tracking</p>
          {!hasDispatchInfo ? (
            <p className="text-sm text-slate-500">Tracking details are not available yet.</p>
          ) : (
            <div className="space-y-3">
              <StatusChip label={DELIVERY_STATUS_LABELS[dispatch.deliveryStatus]} variant={DELIVERY_STATUS_VARIANT[dispatch.deliveryStatus]} />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                {dispatch.courier && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Courier</p><p className="text-slate-700 mt-0.5">{dispatch.courier}</p></div>}
                {dispatch.awb && <div><p className="text-xs text-slate-400 uppercase tracking-wide">AWB / Tracking No.</p><p className="text-slate-700 mt-0.5 font-mono">{dispatch.awb}</p></div>}
                {dispatch.dispatchDate && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Dispatch Date</p><p className="text-slate-700 mt-0.5">{fmtDate(dispatch.dispatchDate)}</p></div>}
                {dispatch.expectedDeliveryDate && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Expected Delivery</p><p className="text-slate-700 mt-0.5">{fmtDate(dispatch.expectedDeliveryDate)}</p></div>}
                {dispatch.actualDeliveryDate && <div><p className="text-xs text-slate-400 uppercase tracking-wide">Delivered On</p><p className="text-slate-700 mt-0.5">{fmtDate(dispatch.actualDeliveryDate)}</p></div>}
              </div>
              {isSafeTrackingUrl(dispatch.trackingUrl) && (
                <a
                  href={dispatch.trackingUrl!} target="_blank" rel="noopener noreferrer"
                  className="inline-block text-sm text-blue-600 hover:text-blue-700 border border-blue-200 hover:border-blue-300 bg-blue-50 px-4 py-2 rounded-lg transition-all"
                >
                  Track Shipment
                </a>
              )}
              {dispatch.logisticsNote && (
                <div>
                  <p className="text-xs text-slate-400 uppercase tracking-wide">Delivery Notes</p>
                  <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{dispatch.logisticsNote}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
