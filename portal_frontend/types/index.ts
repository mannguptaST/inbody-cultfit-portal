// TypeScript types for the InBody Customer Portal
// These mirror the JSON responses from FastAPI / Odoo

export interface User {
  name: string;
  email: string | false;
  role: 'admin' | 'inbody_manager' | 'inbody_user' | 'customer' | 'logistics' | 'cs';
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
  notes: string;
  portalAccount: string;
  submittedDate: string;
  cultfitCompany: string | null;
  contact: ResolvedCultFitContact | null;
  // Absent on records created before the standard-defaults/region-detection
  // feature — decode safely as undefined for those.
  regionDetection?: {
    matchedToken: string | null;
    city: string | null;
    state: string | null;
    territoryName: string | null;
    confidence: 'high' | 'unclear';
  };
  // Legacy — only present on records created before contact resolution moved
  // server-side. New records never set these; kept so old records still
  // render. See CULTFIT_PORTAL_MASTER_CONTEXT.md.
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string | null;
  // Legacy — only present on records created before the New Request form
  // stopped collecting these (2026-08). Delivery/expected-delivery info now
  // comes from the customer's PO during Phase 3 review instead, so it's
  // never asked for twice. New records never set these; kept so old records
  // still decode/render safely.
  deliveryAddress?: string;
  preferredDeliveryDate?: string | null;
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
  notes?: string;
}

// ── Phase 2: PI workflow (admin creates/publishes, customer confirms) ────────

export type PIStatus = 'not_created' | 'draft' | 'awaiting_confirmation' | 'confirmed' | 'correction_requested';

export interface EligibleSalesperson {
  id: number;
  name: string;
}

export interface TerritoryOption {
  id: number;
  name: string;
}

export interface AdminProductOption {
  id: number;
  code: string;
  name: string;
  unitPrice: number;
  unit: string;
  taxLabel: string;
}

export interface OpportunityDefaults {
  keyAccountManager: string | null;
  industry: string | null;
  subIndustry: string | null;
  source: string | null;
  subLeadSource: string | null;
  ownership: string | null;
  channel: string | null;
  accountType: string | null;
}

export interface PIDraftLine {
  id: number;
  productId: number;
  code: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  discCalculation: 'percentage' | 'fixed';
  fixedAmount: number;
  discount: number;
  taxLabel: string;
  untaxedTotal: number;
  taxTotal: number;
  lineTotal: number;
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
  // Live crm.lead.territory_id — always current, including after an admin
  // override, unlike details.regionDetection which is a point-in-time
  // snapshot of what auto-detection found at creation.
  currentTerritory: TerritoryOption | null;
  opportunityDefaults: OpportunityDefaults;
}

// ── Phase 4: Logistics (invoice + dispatch tracking) ─────────────────────────

export type DeliveryStatus =
  | 'not_started' | 'logistics_processing' | 'ready_to_dispatch'
  | 'dispatched' | 'in_transit' | 'delivered' | 'delivery_issue';

export interface LogisticsInvoiceSummary {
  id: number;
  name: string;
  invoiceDate: string | null;
  dueDate: string | null;
  untaxedAmount: number;
  taxAmount: number;
  totalAmount: number;
  paymentState: string;
  state: string;
  currency: string;
}

export interface DispatchInfo {
  pickingId: number | null;
  pickingName: string | null;
  pickingState: string | null;
  dispatchDate: string | null;
  courier: string | null;
  awb: string | null;
  trackingUrl: string | null;
  expectedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  deliveryStatus: DeliveryStatus;
  logisticsNote: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type InvoiceStatus = 'not_created' | 'needs_selection' | 'available';

export interface LogisticsOrderSummary {
  id: number;
  name: string;
  customer: string | null;
  mainProduct: string | null;
  salesperson: string | null;
  poStatus: PoStatus;
  isPortalRequest: boolean;
  invoiceStatus: InvoiceStatus;
  deliveryStatus: DeliveryStatus;
  courier: string | null;
  awb: string | null;
  expectedDeliveryDate: string | null;
  lastUpdated: string | null;
}

export interface LogisticsOrderDetail {
  id: number;
  name: string;
  customer: string | null;
  requestDetails: PortalRequestDetails | null;
  salesperson: string | null;
  crmStage: string | null;
  publishedPI: PIPublishedSnapshot | null;
  poStatus: PoStatus;
  approvedPoSummary: PoSubmissionRecord | null;
  invoiceCandidates: LogisticsInvoiceSummary[];
  selectedInvoice: LogisticsInvoiceSummary | null;
  dispatch: DispatchInfo;
  timeline: PortalRequestTimelineEntry[];
}

export interface DispatchUpdatePayload {
  dispatchDate?: string | null;
  courier?: string | null;
  awb?: string | null;
  trackingUrl?: string | null;
  expectedDeliveryDate?: string | null;
  actualDeliveryDate?: string | null;
  deliveryStatus: DeliveryStatus;
  logisticsNote?: string | null;
}

export interface CustomerLogisticsView {
  invoice: LogisticsInvoiceSummary | null;
  invoiceStatus: InvoiceStatus;
  dispatch: DispatchInfo;
}

// ── Phase 5: Installation (CS — Customer Care) ────────────────────────────────

export type InstallationStatus = 'not_scheduled' | 'scheduled' | 'in_progress' | 'installed' | 'completed';

export interface InstallationInfo {
  status: InstallationStatus;
  scheduledDate: string | null;
  scheduledTime: string | null;
  assignedCs: string | null;
  installationNotes: string | null;
  completedOn: string | null;
  completionNotes: string | null;
  installationRequired: boolean | null; // read-only context from stock.picking.is_installation_required, when known
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CsOrderSummary {
  id: number;
  name: string;
  customer: string | null;
  mainProduct: string | null;
  salesperson: string | null;
  deliveryStatus: DeliveryStatus;
  installationStatus: InstallationStatus;
  assignedCs: string | null;
  scheduledDate: string | null;
  lastUpdated: string | null;
}

export interface CsOrderDetail {
  id: number;
  name: string;
  customer: string | null;
  requestDetails: PortalRequestDetails | null;
  salesperson: string | null;
  crmStage: string | null;
  dispatch: DispatchInfo;
  installation: InstallationInfo;
  timeline: PortalRequestTimelineEntry[];
}

export interface InstallationUpdatePayload {
  status: InstallationStatus;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  installationNotes?: string | null;
  completedOn?: string | null;
  completionNotes?: string | null;
}

export interface CustomerInstallationView {
  installation: InstallationInfo;
}
