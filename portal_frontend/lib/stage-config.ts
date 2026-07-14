// stage-config.ts — Single source of truth for the portal's stage labels and
// display config. Client-safe (no server-only import), so both API routes
// (via lib/odoo-server.ts, which imports STAGE_LABELS/STAGE_KEYS from here)
// and 'use client' pages import the same constants — no more copy-pasted
// STAGE_LABELS/variant maps drifting apart across dashboard/admin/order-detail.
//
// This intentionally does NOT invent a fictional business-stage sequence.
// The portal stage below is derived from two real, live Odoo concepts:
//   - `deal_status_id` on crm.lead (an Odoo `deal.status` record) drives
//     everything except the final stage.
//   - `stage_id` reaching the CRM "won" stage forces `deal_closed`,
//     regardless of `deal_status_id` — see buildLead()/DEAL_STATUS_MAP in
//     lib/odoo-server.ts, which is the only place that maps raw Odoo values
//     onto these keys.

export const STAGE_LABELS: Record<string, string> = {
  new: 'New',
  po_received: 'PO Received',
  pi_shared: 'PI Shared',
  dispatch_requested: 'Dispatch Requested',
  dispatched: 'Dispatched',
  delivered: 'Delivered (Not Installed)',
  server_updated: 'Server Updated',
  deal_closed: 'Deal Closed',
};

// Order matters here — it's the sequence Next/Previous stepping and the
// dashboard/admin stage filter dropdowns walk through.
export const STAGE_KEYS = Object.keys(STAGE_LABELS);

export type ChipVariant =
  | 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'indigo' | 'orange' | 'purple';

export const STAGE_VARIANT: Record<string, ChipVariant> = {
  new: 'neutral',
  po_received: 'indigo',
  pi_shared: 'info',
  dispatch_requested: 'warning',
  dispatched: 'warning',
  delivered: 'orange',
  server_updated: 'teal',
  deal_closed: 'success',
};

export const DELIVERY_VARIANT: Record<string, ChipVariant> = {
  'No Delivery': 'neutral',
  'Pending': 'warning',
  'Ready to Dispatch': 'info',
  'Partially Dispatched': 'orange',
  'Delivered': 'success',
};

export const INVOICE_VARIANT: Record<string, ChipVariant> = {
  'Nothing to Invoice': 'neutral',
  'To Invoice': 'info',
  'Invoiced': 'success',
  'Upselling Opportunity': 'purple',
};

// The 9-step visual timeline on the order-detail page. This is a display-only
// grouping of the same STAGE_KEYS above (deal_closed always renders as the
// final step, stage 9) — it does not introduce any new business states.
export const STAGE_DEFS: Array<{ key: string; label: string; icon: string }> = [
  { key: 'stage_1_order_received', label: 'Order Received', icon: 'shopping-cart' },
  { key: 'stage_2_pi_issued', label: 'PI Issued', icon: 'file-text' },
  { key: 'stage_3_po_received', label: 'PO Received', icon: 'inbox' },
  { key: 'stage_4_md_approved', label: 'MD Approved', icon: 'check-square' },
  { key: 'stage_5_dispatched', label: 'Dispatched', icon: 'truck' },
  { key: 'stage_6_installation_confirmed', label: 'Installation Confirmed', icon: 'tool' },
  { key: 'stage_7_vendor_uploaded', label: 'Vendor Portal Uploaded', icon: 'upload-cloud' },
  { key: 'stage_8_confirmation_sent', label: 'Confirmation Mail Sent', icon: 'mail' },
  { key: 'stage_9_payment_collected', label: 'Payment Collected', icon: 'check-circle' },
];

// Fallback mapping from a portal_stage key straight to a timeline step
// number, used only if a stage key doesn't match any STAGE_DEFS key.
export const CULTFIT_STAGE_MAP: Record<string, number> = {
  new: 1,
  pi_shared: 2,
  po_received: 3,
  dispatch_requested: 4,
  dispatched: 5,
  delivered: 6,
  server_updated: 7,
  deal_closed: 9,
};
