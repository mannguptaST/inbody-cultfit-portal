// TypeScript types for the InBody Customer Portal
// These mirror the JSON responses from FastAPI / Odoo

export interface User {
  name: string;
  email: string | false;
  role: 'admin' | 'inbody_manager' | 'inbody_user' | 'customer';
  company?: string;
}

export interface LoginResponse {
  // No token here by design — the session lives only in an httpOnly cookie
  // set directly by the login API route, never readable by client JS.
  user: User;
}

// FOFO/COCO masking is NOT implemented: no field on crm.lead or sale.order in
// production Odoo encodes it (confirmed via fields_get — see
// PORTAL_SECURITY_AND_TESTING.md). There used to be types here
// (CocoFofoType, plus the old sale.order-shaped Order/OrdersResponse/
// TimelineResponse from the deleted FastAPI backend) that referenced fields
// nothing in this app ever populates — removed rather than left dangling.

export type TimelineStatus = 'done' | 'pending' | 'rejected';

export interface TimelineStage {
  stage: number;
  label: string;
  status: TimelineStatus;
  date: string | null;
  icon: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// ── Phase 3+ CultFit orders (pulled via XML-RPC, full field coverage) ─────────

export interface CultFitOrder {
  id: number;
  order_no: string;
  customer: string | null;
  location: string | null;
  model_names: string[];
  order_date: string | null;
  last_updated: string | null;
  amount_untaxed: number;
  amount_tax: number;
  amount_total: number;
  currency: string;
  payment_terms: string | null;
  order_status: string;
  delivery_status: string;
  invoice_status: string;
  portal_stage: string;
  portal_stage_label: string;
  payment_status: string;
  payment_overdue: boolean;
  payment_due_date: string | null;
  days_to_payment: number;
  installation_status: string;
  vendor_portal_status: string;
  confirmation_mail_sent: boolean;
  portal_notes: string;
  po_number: string | null;
  po_received_date: string | null;
  pi_issued_date: string | null;
  md_approval_status: string;
  crm_stage: string;
  deal_status: string;
  salesperson: string | null;
  expected_closing: string | null;
}

export interface CultFitOrdersResponse {
  orders: CultFitOrder[];
  count: number;
}

// ── Phase 1: New Order Request (CultFit CRM Opportunity requests) ────────────

export interface CultFitProductOption {
  id: number;
  code: string;
  name: string;
  hasBundle: boolean;
}

export interface PortalRequestProduct {
  id: number;
  code: string;
  name: string;
}

export interface PortalRequestDetails {
  requestName: string;
  cocoFofo: 'COCO' | 'FOFO';
  mainProduct: PortalRequestProduct;
  quantity: number;
  includedProducts: PortalRequestProduct[];
  deliveryAddress: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  preferredDeliveryDate: string | null;
  notes: string;
  portalAccount: string;
  submittedDate: string;
}

export interface PortalRequestSummary {
  id: number;
  name: string;
  details: PortalRequestDetails | null;
  portal_stage: string;
  portal_stage_label: string;
  salesperson: string | null;
  created_date: string | null;
  last_updated: string | null;
}

export interface PortalRequestTimelineEntry {
  date: string | null;
  author: string;
  body: string;
}

export interface PortalRequestDetail extends PortalRequestSummary {
  timeline: PortalRequestTimelineEntry[];
}

export interface NewOrderRequestPayload {
  requestName: string;
  cocoFofo: 'COCO' | 'FOFO';
  mainProductId: number;
  quantity: number;
  deliveryAddress: string;
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  preferredDeliveryDate?: string;
  notes?: string;
}
