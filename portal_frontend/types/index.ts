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

export interface ResolvedCultFitContact {
  name: string | null;
  phone: string | null;
  email: string | null;
  source: 'portal-mapped' | 'primary-contact' | 'company' | 'portal-account-only';
}

export interface PortalRequestDetails {
  requestName: string;
  cocoFofo: 'COCO' | 'FOFO';
  mainProduct: PortalRequestProduct;
  quantity: number;
  includedProducts: PortalRequestProduct[];
  deliveryAddress: string;
  preferredDeliveryDate: string | null;
  notes: string;
  portalAccount: string;
  submittedDate: string;
  cultfitCompany: string | null;
  contact: ResolvedCultFitContact | null;
  // Legacy — only present on records created before contact resolution moved
  // server-side. New records never set these; kept so old records still
  // render. See CULTFIT_PORTAL_MASTER_CONTEXT.md.
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string | null;
}

export interface PortalRequestSummary {
  id: number;
  name: string;
  details: PortalRequestDetails | null;
  portal_stage: string;
  portal_stage_label: string;
  salesperson: string | null;
  salespersonPhone: string | null;
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
  preferredDeliveryDate?: string;
  notes?: string;
}

// ── Phase 2: PI workflow (admin creates/publishes, customer confirms) ────────

export type PIStatus = 'not_created' | 'draft' | 'awaiting_confirmation' | 'confirmed' | 'correction_requested';

export interface EligibleSalesperson {
  id: number;
  name: string;
}

export interface PIDraftLine {
  id: number;
  productId: number;
  code: string;
  name: string;
  quantity: number;
  unitPrice: number;
  taxLabel: string;
  untaxedTotal: number;
  taxTotal: number;
}

export interface PIDraftInfo {
  id: number;
  name: string;
  state: string;
  validityDate: string | null;
  mainProductUnitPrice: number;
  lines: PIDraftLine[];
  untaxedAmount: number;
  taxAmount: number;
  totalAmount: number;
}

export interface PISnapshotLineItem {
  code: string;
  name: string;
  quantity: number;
  unitPrice: number;
  taxLabel: string;
  taxTotal: number;
  untaxedTotal: number;
}

export interface PIPublishedSnapshot {
  version: number;
  quotationId: number;
  quotationNumber: string;
  publishedDate: string;
  publishedBy: string;
  attachmentId: number;
  requestReference: string;
  cultfitCompanyName: string;
  deliveryAddress: string;
  cocoFofo: 'COCO' | 'FOFO';
  preferredDeliveryDate: string | null;
  salespersonName: string;
  lineItems: PISnapshotLineItem[];
  untaxedAmount: number;
  taxAmount: number;
  totalAmount: number;
  validityDate: string;
}

export interface CustomerPIView {
  status: PIStatus;
  snapshot: PIPublishedSnapshot | null;
}

// ── Phase 3: PO workflow (temporary PDF extraction, customer submits,
// admin reviews) ──────────────────────────────────────────────────────────

export interface ExtractedPoLineItem {
  description: string | null;
  code: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  baseValue: number | null;
  taxRate: number | null;
  taxAmount: number | null;
  lineTotal: number | null;
}

export interface ExtractedPoData {
  poNumber: string | null;
  poDate: string | null;
  expectedDeliveryDate: string | null;
  paymentTerms: string | null;
  currency: string | null;
  requesterName: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  billingCompany: string | null;
  billingAddress: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPin: string | null;
  billingGstin: string | null;
  shippingCompany: string | null;
  shippingAddress: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPin: string | null;
  shippingGstin: string | null;
  lineItems: ExtractedPoLineItem[];
  untaxedAmount: number | null;
  taxAmount: number | null;
  grandTotal: number | null;
  amountInWords: string | null;
  piReference: string | null;
  vendorName: string | null;
  deliveryContact: string | null;
  notesToSupplier: string | null;
}

// The customer-confirmed, server-validated version of ExtractedPoData — same
// shape, but poNumber/poDate/billingAddress/shippingAddress/grandTotal are
// guaranteed non-null (validated required before submission is accepted).
export type PortalPoLineItem = ExtractedPoLineItem;

export interface PortalPoData {
  poNumber: string;
  poDate: string;
  expectedDeliveryDate: string | null;
  paymentTerms: string | null;
  currency: string | null;
  requesterName: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  billingCompany: string | null;
  billingAddress: string;
  billingCity: string | null;
  billingState: string | null;
  billingPin: string | null;
  billingGstin: string | null;
  shippingCompany: string | null;
  shippingAddress: string;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPin: string | null;
  shippingGstin: string | null;
  lineItems: PortalPoLineItem[];
  untaxedAmount: number | null;
  taxAmount: number | null;
  grandTotal: number;
  amountInWords: string | null;
  piReference: string | null;
  vendorName: string | null;
  deliveryContact: string | null;
  notesToSupplier: string | null;
}

export type ComparisonSeverity =
  | 'match' | 'warning' | 'missing_from_po' | 'extra_in_po'
  | 'amount_mismatch' | 'quantity_mismatch' | 'product_mismatch' | 'tax_mismatch';

export interface ComparisonResult {
  field: string;
  severity: ComparisonSeverity;
  message: string;
}

export type PoStatus = 'awaiting_upload' | 'submitted' | 'correction_requested' | 'approved';

export interface PoSubmissionRecord {
  version: number;
  data: PortalPoData;
  comparisonWarnings: ComparisonResult[];
  relatedPiVersion: number;
  relatedPiNumber: string;
  submittedAt: string;
  submittedBy: string;
}

export interface PoCorrectionRecord {
  version: number;
  comment: string;
  requestedAt: string;
  requestedBy: string;
}

export interface PoApprovalRecord {
  version: number;
  approvedAt: string;
  approvedBy: string;
  poNumberSavedToOdoo: boolean;
  expectedDeliveryDateSavedToOdoo: boolean;
}

export interface PoPiSummary {
  quotationNumber: string;
  version: number;
  requestName: string;
  mainProduct: string;
  deliveryAddress: string;
  untaxedAmount: number;
  taxAmount: number;
  totalAmount: number;
}

export interface PoCustomerView {
  status: PoStatus;
  version: number;
  latestSubmission: PoSubmissionRecord | null;
  latestCorrection: PoCorrectionRecord | null;
  piConfirmed: boolean;
  piSummary: PoPiSummary | null;
}

export interface PoAdminView extends PoCustomerView {
  latestApproval: PoApprovalRecord | null;
  allSubmissions: PoSubmissionRecord[];
  salespersonAssigned: boolean;
}

export interface PoSubmitResult {
  status: PoStatus;
  version: number;
  comparisonWarnings: ComparisonResult[];
}

export interface PoApproveResult {
  status: PoStatus;
  poNumberSaved: boolean;
  expectedDeliveryDateSaved: boolean;
}

export interface PoCorrectionResult {
  status: PoStatus;
  activityCreated: boolean;
  warning: string | null;
}

export interface AdminRequestSummary extends PortalRequestSummary {
  piStatus: PIStatus;
  poStatus: PoStatus;
}

export interface AdminRequestDetail extends PortalRequestDetail {
  piStatus: PIStatus;
  draftPI: PIDraftInfo | null;
  publishedPI: PIPublishedSnapshot | null;
  po: PoAdminView;
}
