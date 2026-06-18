// TypeScript types for the InBody Customer Portal
// These mirror the JSON responses from FastAPI / Odoo

export interface User {
  name: string;
  email: string | false;
  role: 'admin' | 'inbody_manager' | 'inbody_user' | 'customer';
  company?: string;
}

export interface LoginResponse {
  token: string;
  expires_in: number;
  user: User;
}

export type OrderStage =
  | 'stage_1_order_received'
  | 'stage_2_pi_issued'
  | 'stage_3_po_received'
  | 'stage_4_md_approved'
  | 'stage_5_dispatched'
  | 'stage_6_installation_confirmed'
  | 'stage_7_vendor_uploaded'
  | 'stage_8_confirmation_sent'
  | 'stage_9_payment_collected';

export type PaymentStatus = 'pending' | 'partial' | 'collected';
export type VendorPortalStatus = 'pending' | 'uploaded';
export type InstallationStatus = 'pending' | 'scheduled' | 'confirmed';
export type CocoFofoType = 'coco' | 'fofo';

export interface Order {
  id: number;
  name: string;
  centre_name: string;
  customer: string;
  coco_fofo_type: CocoFofoType;
  portal_stage: OrderStage;
  portal_stage_label: string;
  date_order: string | null;
  amount_total?: number;
  currency: string;
  payment_due_date: string | null;
  days_to_payment: number;
  payment_overdue: boolean;
  payment_status: PaymentStatus;
  vendor_portal_status: VendorPortalStatus;
  installation_status: InstallationStatus;
  portal_notes: string;
  // Detail-only fields (not in list)
  po_number?: string;
  po_received_date?: string | null;
  pi_issued_date?: string | null;
  md_approval_status?: 'pending' | 'approved' | 'rejected';
  vendor_portal_upload_date?: string | null;
  installation_date?: string | null;
  confirmation_mail_sent?: boolean;
}

export interface OrdersResponse {
  orders: Order[];
  count: number;
}

export type TimelineStatus = 'done' | 'pending' | 'rejected';

export interface TimelineStage {
  stage: number;
  label: string;
  status: TimelineStatus;
  date: string | null;
  icon: string;
}

export interface TimelineResponse {
  order_id: number;
  order_name: string;
  current_stage: number;
  coco_fofo_type: CocoFofoType;
  timeline: TimelineStage[];
}

export interface Document {
  id: number;
  name: string;
  mimetype: string;
  size: number;
  date: string | null;
  download_url: string;
}

export interface DocumentsResponse {
  order_id: number;
  documents: Document[];
  count: number;
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
}

export interface CultFitOrdersResponse {
  orders: CultFitOrder[];
  count: number;
}
