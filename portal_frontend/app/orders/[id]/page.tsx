'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  getCultFitOrderDetail, getDocuments, getOdooAttachments,
  updateDealStatus, setCultFitPortalStage,
  type DealStatusUpdate, type OdooAttachment,
} from '@/lib/api';
import { isLoggedIn, getToken, isInBodyStaff, getUser, clearSession } from '@/lib/auth';
import OrderTimeline from '@/components/OrderTimeline';
import PaymentCountdown from '@/components/PaymentCountdown';
import PortalHeader from '@/components/PortalHeader';
import StatusChip from '@/components/StatusChip';
import type { CultFitOrder, DocumentsResponse, TimelineStage } from '@/types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// ── Stage definitions ─────────────────────────────────────────────────────────

const STAGE_DEFS: Array<{ key: string; label: string; icon: string }> = [
  { key: 'stage_1_order_received',         label: 'Order Received',           icon: 'shopping-cart'  },
  { key: 'stage_2_pi_issued',              label: 'PI Issued',                icon: 'file-text'      },
  { key: 'stage_3_po_received',            label: 'PO Received',              icon: 'inbox'          },
  { key: 'stage_4_md_approved',            label: 'MD Approved',              icon: 'check-square'   },
  { key: 'stage_5_dispatched',             label: 'Dispatched',               icon: 'truck'          },
  { key: 'stage_6_installation_confirmed', label: 'Installation Confirmed',   icon: 'tool'           },
  { key: 'stage_7_vendor_uploaded',        label: 'Vendor Portal Uploaded',   icon: 'upload-cloud'   },
  { key: 'stage_8_confirmation_sent',      label: 'Confirmation Mail Sent',   icon: 'mail'           },
  { key: 'stage_9_payment_collected',      label: 'Payment Collected',        icon: 'check-circle'   },
];

const CULTFIT_STAGE_MAP: Record<string, number> = {
  new:                1,
  pi_shared:          2,
  po_received:        3,
  dispatch_requested: 4,
  dispatched:         5,
  delivered:          6,
  server_updated:     7,
  deal_closed:        9,
};

function buildTimeline(order: CultFitOrder): { stages: TimelineStage[]; currentStage: number } {
  const stageDefIdx = STAGE_DEFS.findIndex(s => s.key === order.portal_stage);
  const currentStage = stageDefIdx >= 0
    ? stageDefIdx + 1
    : (CULTFIT_STAGE_MAP[order.portal_stage] ?? 1);

  const stageDates: Record<number, string | null> = {
    1: order.order_date,
    2: order.pi_issued_date,
    3: order.po_received_date,
  };

  const stages: TimelineStage[] = STAGE_DEFS.map((def, i) => {
    const stageNum = i + 1;
    const isDone    = stageNum < currentStage;
    const isCurrent = stageNum === currentStage;
    return {
      stage:  stageNum,
      label:  def.label,
      icon:   def.icon,
      date:   isDone || isCurrent ? (stageDates[stageNum] ?? null) : null,
      status: isDone ? 'done' : isCurrent ? 'pending' : 'pending',
    };
  });

  return { stages, currentStage };
}

// ── Label normalizers (handles both raw Odoo strings and human-readable) ──────

const INSTALL_LABELS: Record<string, string> = {
  not_started:   'Not Started',
  in_progress:   'In Progress',
  confirmed:     'Confirmed',
  'Not Started': 'Not Started',
  'In Progress': 'In Progress',
  'Confirmed':   'Confirmed',
};

const VENDOR_LABELS: Record<string, string> = {
  not_uploaded:   'Not Uploaded',
  uploaded:       'Uploaded',
  'Not Uploaded': 'Not Uploaded',
  'Uploaded':     'Uploaded',
};

// ── Badge variant maps ────────────────────────────────────────────────────────

type ChipVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'indigo' | 'orange' | 'purple';

const DELIVERY_VARIANT: Record<string, ChipVariant> = {
  'No Delivery':          'neutral',
  'Pending':              'warning',
  'Ready to Dispatch':    'info',
  'Partially Dispatched': 'orange',
  'Delivered':            'success',
};

const INVOICE_VARIANT: Record<string, ChipVariant> = {
  'Nothing to Invoice':    'neutral',
  'To Invoice':            'info',
  'Invoiced':              'success',
  'Upselling Opportunity': 'purple',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function fmtAmount(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return '—';
  return '₹' + amount.toLocaleString('en-IN');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FiletypeIcon({ mimetype }: { mimetype: string }) {
  if (mimetype.includes('pdf'))
    return (
      <span className="w-8 h-8 rounded-lg bg-red-50 border border-red-100 flex items-center justify-center text-xs font-bold text-red-500 flex-shrink-0">
        PDF
      </span>
    );
  if (mimetype.includes('image'))
    return (
      <span className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
        <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </span>
    );
  return (
    <span className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center flex-shrink-0">
      <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrderDetailPage() {
  const router  = useRouter();
  const params  = useParams();
  const orderId = Number(params.id);

  const [order, setOrder]       = useState<CultFitOrder | null>(null);
  const [docs, setDocs]         = useState<DocumentsResponse | null>(null);
  const [odooDocs, setOdooDocs] = useState<OdooAttachment[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [downloading, setDownloading] = useState<number | null>(null);
  const [isStaff, setIsStaff]   = useState(false);
  const [userName, setUserName] = useState('');

  // Deal status form (staff only)
  const [dealForm, setDealForm]   = useState<DealStatusUpdate>({});
  const [dealReason, setDealReason] = useState('');
  const [saving, setSaving]       = useState(false);
  const [saveMsg, setSaveMsg]     = useState<{ ok: boolean; text: string } | null>(null);

  // Portal stage update (staff only)
  const [stageKey, setStageKey]         = useState('');
  const [stageReason, setStageReason]   = useState('');
  const [stageSaving, setStageSaving]   = useState(false);
  const [stageSaveMsg, setStageSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!isLoggedIn()) { router.replace('/login'); return; }
    const staff = isInBodyStaff();
    setIsStaff(staff);
    const u = getUser();
    setUserName(u?.name ?? '');
    if (!orderId) return;

    Promise.all([
      getCultFitOrderDetail(orderId),
      getDocuments(orderId).catch(() => null),
      getOdooAttachments(orderId).catch(() => ({ attachments: [], count: 0 })),
    ])
      .then(([o, d, odoo]) => {
        setOrder(o);
        setDocs(d);
        setOdooDocs(odoo?.attachments ?? []);
        const instMap: Record<string, string> = {
          'Not Started': 'not_started', 'In Progress': 'in_progress', 'Confirmed': 'confirmed',
        };
        const vendMap: Record<string, string> = {
          'Not Uploaded': 'not_uploaded', 'Uploaded': 'uploaded',
        };
        setDealForm({
          payment_status:         o.payment_status,
          installation_status:    instMap[o.installation_status] ?? 'not_started',
          vendor_portal_status:   vendMap[o.vendor_portal_status] ?? 'not_uploaded',
          confirmation_mail_sent: o.confirmation_mail_sent,
          md_approval_status:     o.md_approval_status,
        });
        setStageKey(o.portal_stage || 'new');
      })
      .catch(err => setError(err.message ?? 'Failed to load order.'))
      .finally(() => setLoading(false));
  }, [orderId, router]);

  async function handleDownload(docId: number, filename: string) {
    setDownloading(docId);
    try {
      const token = getToken();
      const resp = await fetch(`${API_BASE}/api/v1/portal/documents/${docId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch { alert('Download failed. Please try again.'); }
    finally { setDownloading(null); }
  }

  async function handleOdooDownload(attachmentId: number, filename: string) {
    setDownloading(attachmentId);
    try {
      const token = getToken();
      const resp = await fetch(
        `${API_BASE}/portal/cultfit/orders/${orderId}/attachments/${attachmentId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch { alert('Download failed. Please try again.'); }
    finally { setDownloading(null); }
  }

  async function handleSaveDealStatus() {
    if (!order) return;
    if (!dealReason.trim()) {
      setSaveMsg({ ok: false, text: 'Reason / Note is required before saving.' });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      await updateDealStatus(order.id, { ...dealForm, reason: dealReason });
      const updated = await getCultFitOrderDetail(order.id);
      setOrder(updated);
      const instMap: Record<string, string> = {
        'Not Started': 'not_started', 'In Progress': 'in_progress', 'Confirmed': 'confirmed',
      };
      const vendMap: Record<string, string> = {
        'Not Uploaded': 'not_uploaded', 'Uploaded': 'uploaded',
      };
      setDealForm({
        payment_status:         updated.payment_status,
        installation_status:    instMap[updated.installation_status] ?? 'not_started',
        vendor_portal_status:   vendMap[updated.vendor_portal_status] ?? 'not_uploaded',
        confirmation_mail_sent: updated.confirmation_mail_sent,
        md_approval_status:     updated.md_approval_status,
      });
      setDealReason('');
      setSaveMsg({ ok: true, text: 'Deal status updated and logged.' });
    } catch (err: unknown) {
      setSaveMsg({ ok: false, text: err instanceof Error ? err.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  async function handleSavePortalStage() {
    if (!order) return;
    if (!stageReason.trim()) {
      setStageSaveMsg({ ok: false, text: 'Reason / Note is required before updating stage.' });
      return;
    }
    setStageSaving(true);
    setStageSaveMsg(null);
    try {
      await setCultFitPortalStage(order.id, stageKey, stageReason);
      const updated = await getCultFitOrderDetail(order.id);
      setOrder(updated);
      setStageKey(updated.portal_stage || 'new');
      setStageReason('');
      setStageSaveMsg({ ok: true, text: `Stage updated to "${updated.portal_stage_label}".` });
    } catch (err: unknown) {
      setStageSaveMsg({ ok: false, text: err instanceof Error ? err.message : 'Stage update failed.' });
    } finally { setStageSaving(false); }
  }

  function handleLogout() {
    clearSession();
    router.replace('/login');
  }

  const backHref  = isStaff ? '/admin' : '/dashboard';
  const backLabel = isStaff ? 'Admin' : 'My Orders';

  // Loading state
  if (loading) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader
        role={isStaff ? 'STAFF' : 'CUSTOMER'}
        userName={userName}
        onLogout={handleLogout}
        backHref={backHref}
        backLabel={backLabel}
      />
      <div className="flex items-center justify-center py-32">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-sm text-slate-500">Loading order details...</p>
        </div>
      </div>
    </div>
  );

  // Error state
  if (error) return (
    <div className="min-h-screen bg-slate-50">
      <PortalHeader
        role={isStaff ? 'STAFF' : 'CUSTOMER'}
        userName={userName}
        onLogout={handleLogout}
        backHref={backHref}
        backLabel={backLabel}
      />
      <div className="flex items-center justify-center py-32 px-4">
        <div className="bg-white border border-red-200 rounded-xl p-8 text-center max-w-sm">
          <div className="w-12 h-12 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <p className="text-red-700 font-medium mb-4">{error}</p>
          <button onClick={() => router.back()} className="text-blue-600 text-sm hover:underline">
            Go back
          </button>
        </div>
      </div>
    </div>
  );

  if (!order) return null;

  const { stages, currentStage } = buildTimeline(order);

  const installLabel = INSTALL_LABELS[order.installation_status] ?? order.installation_status;
  const vendorLabel  = VENDOR_LABELS[order.vendor_portal_status]  ?? order.vendor_portal_status;
  const isInstallDone = order.installation_status === 'confirmed' || order.installation_status === 'Confirmed';
  const isVendorDone  = order.vendor_portal_status === 'uploaded' || order.vendor_portal_status === 'Uploaded';

  return (
    <div className="min-h-screen bg-slate-50">

      <PortalHeader
        role={isStaff ? 'STAFF' : 'CUSTOMER'}
        userName={userName}
        onLogout={handleLogout}
        backHref={backHref}
        backLabel={backLabel}
        crumb={order.order_no}
      />

      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">

        {/* ── Hero card ────────────────────────────────────────────── */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 mb-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-6">

            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-slate-900 font-mono">{order.order_no}</h1>
                <span className="text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-1 rounded-md">
                  Stage {currentStage} of 9
                </span>
                {order.payment_overdue && (
                  <span className="text-xs font-semibold bg-red-50 text-red-700 border border-red-200 px-2.5 py-1 rounded-md">
                    Payment Overdue
                  </span>
                )}
              </div>

              {order.customer && (
                <p className="text-slate-700 font-medium mt-2">{order.customer}</p>
              )}
              {order.location && (
                <p className="text-slate-500 text-sm mt-0.5">{order.location}</p>
              )}
              {order.model_names.length > 0 && (
                <p className="text-slate-500 text-sm mt-1">
                  <span className="font-medium text-slate-600">Models: </span>
                  {order.model_names.join(', ')}
                </p>
              )}

              <div className="flex flex-wrap gap-2 mt-4">
                <StatusChip label={order.delivery_status} variant={DELIVERY_VARIANT[order.delivery_status] ?? 'neutral'} />
                <StatusChip label={order.invoice_status}  variant={INVOICE_VARIANT[order.invoice_status]  ?? 'neutral'} />
              </div>
            </div>

            <div className="text-right flex-shrink-0">
              <p className="text-3xl font-bold text-slate-900">{fmtAmount(order.amount_total)}</p>
              {order.amount_untaxed > 0 && order.amount_tax > 0 && (
                <p className="text-xs text-slate-400 mt-1">
                  {fmtAmount(order.amount_untaxed)} + {fmtAmount(order.amount_tax)} GST
                </p>
              )}
              {order.payment_terms && (
                <p className="text-xs text-slate-400 mt-0.5">{order.payment_terms}</p>
              )}
              {order.order_date && (
                <p className="text-xs text-slate-400 mt-2">Ordered {fmtDate(order.order_date)}</p>
              )}
            </div>
          </div>

          {/* PO / PI / MD grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t border-slate-100">
            {[
              { label: 'PO Number',   value: order.po_number || '—' },
              { label: 'PO Received', value: fmtDate(order.po_received_date) },
              { label: 'PI Issued',   value: fmtDate(order.pi_issued_date) },
              {
                label: 'MD Approval',
                value: order.md_approval_status
                  ? order.md_approval_status.charAt(0).toUpperCase() + order.md_approval_status.slice(1)
                  : '—',
              },
            ].map(item => (
              <div key={item.label}>
                <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">{item.label}</p>
                <p className="text-sm font-semibold text-slate-700 mt-0.5">{item.value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Two-column layout ─────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

          {/* Left: Timeline */}
          <div className="lg:col-span-2">
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-6">Order Timeline</h2>
              <OrderTimeline stages={stages} currentStage={currentStage} />
            </div>
          </div>

          {/* Right: sidebar — sticky on desktop */}
          <div className="space-y-5 lg:sticky lg:top-20">

            {/* Payment */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Payment</h2>
              <PaymentCountdown
                dueDate={order.payment_due_date}
                daysToPayment={order.days_to_payment}
                paymentOverdue={order.payment_overdue}
                paymentStatus={order.payment_status}
              />
            </div>

            {/* Quick status */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Quick Status</h2>
              <div className="space-y-3">
                {[
                  {
                    label: 'Installation',
                    value: installLabel,
                    done:  isInstallDone,
                  },
                  {
                    label: 'Vendor Portal',
                    value: vendorLabel,
                    done:  isVendorDone,
                  },
                  {
                    label: 'Confirmation Mail',
                    value: order.confirmation_mail_sent ? 'Sent' : 'Pending',
                    done:  order.confirmation_mail_sent,
                  },
                ].map(item => (
                  <div key={item.label} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-slate-500">{item.label}</span>
                    <span className={`text-sm font-medium ${item.done ? 'text-green-600' : 'text-slate-400'}`}>
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Update Portal Stage — staff only */}
            {isStaff && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Update Portal Stage</h2>
                <div className="space-y-3">
                  <select
                    value={stageKey}
                    onChange={e => setStageKey(e.target.value)}
                    className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  >
                    <option value="new">New</option>
                    <option value="pi_shared">PI Shared</option>
                    <option value="po_received">PO Received</option>
                    <option value="dispatch_requested">Dispatch Requested</option>
                    <option value="dispatched">Dispatched</option>
                    <option value="delivered">Delivered (Not Installed)</option>
                    <option value="server_updated">Server Updated</option>
                    <option value="deal_closed">Deal Closed</option>
                  </select>

                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">
                      Reason / Note <span className="text-red-500">*</span>
                      <span className="font-normal text-slate-400 ml-1">— logged in Odoo</span>
                    </label>
                    <textarea
                      rows={2}
                      value={stageReason}
                      onChange={e => setStageReason(e.target.value)}
                      placeholder="e.g. Units dispatched via Blue Dart on 23 Jun"
                      className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 resize-none ${
                        !stageReason.trim()
                          ? 'border-red-300 focus:ring-red-400'
                          : 'border-slate-300 focus:ring-indigo-500'
                      }`}
                    />
                  </div>

                  {stageSaveMsg && (
                    <p className={`text-xs font-medium ${stageSaveMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                      {stageSaveMsg.text}
                    </p>
                  )}

                  <button
                    onClick={handleSavePortalStage}
                    disabled={stageSaving}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors"
                  >
                    {stageSaving ? 'Updating...' : 'Update Stage'}
                  </button>
                </div>
              </div>
            )}

            {/* Update Deal Status — staff only */}
            {isStaff && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Update Deal Status</h2>
                <div className="space-y-3">

                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">Payment Status</label>
                    <select
                      value={dealForm.payment_status ?? ''}
                      onChange={e => setDealForm(f => ({ ...f, payment_status: e.target.value }))}
                      className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="pending">Pending</option>
                      <option value="overdue">Overdue</option>
                      <option value="collected">Collected</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">Installation Status</label>
                    <select
                      value={dealForm.installation_status ?? ''}
                      onChange={e => setDealForm(f => ({ ...f, installation_status: e.target.value }))}
                      className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="not_started">Not Started</option>
                      <option value="in_progress">In Progress</option>
                      <option value="confirmed">Confirmed</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">Vendor Portal Status</label>
                    <select
                      value={dealForm.vendor_portal_status ?? ''}
                      onChange={e => setDealForm(f => ({ ...f, vendor_portal_status: e.target.value }))}
                      className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="not_uploaded">Not Uploaded</option>
                      <option value="uploaded">Uploaded</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">MD Approval</label>
                    <select
                      value={dealForm.md_approval_status ?? ''}
                      onChange={e => setDealForm(f => ({ ...f, md_approval_status: e.target.value }))}
                      className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="pending">Pending</option>
                      <option value="approved">Approved</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-2.5 pt-0.5">
                    <input
                      type="checkbox"
                      id="conf-mail"
                      checked={dealForm.confirmation_mail_sent ?? false}
                      onChange={e => setDealForm(f => ({ ...f, confirmation_mail_sent: e.target.checked }))}
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <label htmlFor="conf-mail" className="text-sm text-slate-700">Confirmation Mail Sent</label>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">
                      Reason / Note <span className="text-red-500">*</span>
                      <span className="font-normal text-slate-400 ml-1">— logged in Odoo</span>
                    </label>
                    <textarea
                      rows={3}
                      value={dealReason}
                      onChange={e => setDealReason(e.target.value)}
                      placeholder="e.g. Payment received via NEFT on 16 Jun 2026"
                      className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 resize-none ${
                        !dealReason.trim()
                          ? 'border-red-300 focus:ring-red-400'
                          : 'border-slate-300 focus:ring-blue-500'
                      }`}
                    />
                  </div>

                  {saveMsg && (
                    <p className={`text-xs font-medium ${saveMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                      {saveMsg.text}
                    </p>
                  )}

                  <button
                    onClick={handleSaveDealStatus}
                    disabled={saving}
                    className="w-full bg-blue-700 hover:bg-blue-800 disabled:bg-blue-300 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors"
                  >
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            )}

            {/* Notes */}
            {order.portal_notes && (
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1.5">Notes from InBody</p>
                <p className="text-sm text-blue-700">{order.portal_notes}</p>
              </div>
            )}

            {order.last_updated && (
              <p className="text-xs text-slate-400 text-right">
                Last updated: {fmtDate(order.last_updated)}
              </p>
            )}
          </div>
        </div>

        {/* ── Documents ────────────────────────────────────────────── */}
        <div className="mt-6 bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-5">Documents</h2>

          {/* Odoo-sourced documents */}
          {odooDocs.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">From Odoo</p>
              <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg overflow-hidden">
                {odooDocs.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-blue-50 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <FiletypeIcon mimetype="pdf" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{doc.label}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {doc.type === 'quotation' ? 'Quotation PDF' : 'Tax Invoice PDF'}
                          {doc.size ? ` · ${formatBytes(doc.size)}` : ''}
                          {doc.date ? ` · ${new Date(doc.date).toLocaleDateString('en-IN')}` : ''}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleOdooDownload(doc.id, doc.name)}
                      disabled={downloading === doc.id}
                      className="ml-4 flex-shrink-0 inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition"
                    >
                      {downloading === doc.id ? (
                        <>
                          <span className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                          Downloading...
                        </>
                      ) : (
                        <>
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Manually uploaded documents */}
          {docs && docs.count > 0 ? (
            <div>
              {odooDocs.length > 0 && (
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Uploaded by InBody</p>
              )}
              <div className="divide-y divide-slate-100">
                {docs.documents.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <FiletypeIcon mimetype={doc.mimetype} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{doc.name}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {formatBytes(doc.size)}
                          {doc.date && ` · ${new Date(doc.date).toLocaleDateString('en-IN')}`}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDownload(doc.id, doc.name)}
                      disabled={downloading === doc.id}
                      className="ml-4 flex-shrink-0 inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium disabled:text-slate-400 transition"
                    >
                      {downloading === doc.id ? (
                        <>
                          <span className="animate-spin w-3.5 h-3.5 border-2 border-blue-400 border-t-transparent rounded-full" />
                          Downloading...
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : odooDocs.length === 0 ? (
            <div className="text-center py-10">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-sm text-slate-500">No documents yet</p>
              <p className="text-xs text-slate-300 mt-1">Documents will appear here once uploaded by InBody</p>
            </div>
          ) : null}
        </div>

      </div>
    </div>
  );
}
