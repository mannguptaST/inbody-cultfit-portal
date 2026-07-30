// po-validation.ts — Server-side re-validation of the customer's final
// (reviewed/corrected) PO submission. The extraction step is a convenience;
// this is the only step that is actually trusted — every field here is
// re-checked from scratch, never assumed correct just because it round-
// tripped through the browser.

export class PoValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'PoValidationError'; }
}

export interface PortalPoLineItem {
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

const MAX_LEN = {
  short: 120, medium: 300, long: 1000,
};

function reqText(v: unknown, field: string, max = MAX_LEN.medium): string {
  if (typeof v !== 'string' || !v.trim()) throw new PoValidationError(`${field} is required.`);
  const t = v.trim();
  if (t.length > max) throw new PoValidationError(`${field} must be ${max} characters or fewer.`);
  return t;
}

function optText(v: unknown, max = MAX_LEN.medium): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim().slice(0, max);
}

function optNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function reqDate(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new PoValidationError(`${field} must be a valid date.`);
  }
  return v;
}

function optDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return v;
}

const MAX_LINE_ITEMS = 50;

function validateLineItems(v: unknown): PortalPoLineItem[] {
  if (!Array.isArray(v) || v.length === 0) throw new PoValidationError('At least one product line is required.');
  if (v.length > MAX_LINE_ITEMS) throw new PoValidationError(`No more than ${MAX_LINE_ITEMS} product lines are supported.`);
  return v.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new PoValidationError(`Product line ${i + 1} is invalid.`);
    const l = raw as Record<string, unknown>;
    return {
      description: optText(l.description, MAX_LEN.medium),
      code: optText(l.code, MAX_LEN.short),
      quantity: optNumber(l.quantity),
      unit: optText(l.unit, MAX_LEN.short),
      unitPrice: optNumber(l.unitPrice),
      baseValue: optNumber(l.baseValue),
      taxRate: optNumber(l.taxRate),
      taxAmount: optNumber(l.taxAmount),
      lineTotal: optNumber(l.lineTotal),
    };
  });
}

// Every field is re-derived from `input` here — nothing from a prior
// extraction is trusted implicitly; the browser must resend the full,
// customer-reviewed values on submit.
export function validatePoSubmission(input: Record<string, unknown>): PortalPoData {
  const grandTotal = optNumber(input.grandTotal);
  if (grandTotal === null) throw new PoValidationError('Grand total is required.');

  return {
    poNumber: reqText(input.poNumber, 'PO Number', MAX_LEN.short),
    poDate: reqDate(input.poDate, 'PO Date'),
    expectedDeliveryDate: optDate(input.expectedDeliveryDate),
    paymentTerms: optText(input.paymentTerms, MAX_LEN.short),
    currency: optText(input.currency, 10),
    requesterName: optText(input.requesterName, MAX_LEN.short),
    createdBy: optText(input.createdBy, MAX_LEN.short),
    approvedBy: optText(input.approvedBy, MAX_LEN.short),
    billingCompany: optText(input.billingCompany, MAX_LEN.short),
    billingAddress: reqText(input.billingAddress, 'Billing Address', MAX_LEN.long),
    billingCity: optText(input.billingCity, MAX_LEN.short),
    billingState: optText(input.billingState, MAX_LEN.short),
    billingPin: optText(input.billingPin, 10),
    billingGstin: optText(input.billingGstin, 15),
    shippingCompany: optText(input.shippingCompany, MAX_LEN.short),
    shippingAddress: reqText(input.shippingAddress, 'Shipping Address', MAX_LEN.long),
    shippingCity: optText(input.shippingCity, MAX_LEN.short),
    shippingState: optText(input.shippingState, MAX_LEN.short),
    shippingPin: optText(input.shippingPin, 10),
    shippingGstin: optText(input.shippingGstin, 15),
    lineItems: validateLineItems(input.lineItems),
    untaxedAmount: optNumber(input.untaxedAmount),
    taxAmount: optNumber(input.taxAmount),
    grandTotal,
    amountInWords: optText(input.amountInWords, MAX_LEN.medium),
    piReference: optText(input.piReference, MAX_LEN.short),
    vendorName: optText(input.vendorName, MAX_LEN.short),
    deliveryContact: optText(input.deliveryContact, MAX_LEN.short),
    notesToSupplier: optText(input.notesToSupplier, MAX_LEN.long),
  };
}

const MAX_CORRECTION_COMMENT = 2000;

export function validateCorrectionComment(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new PoValidationError('A comment is required to request a correction.');
  const t = v.trim();
  if (t.length > MAX_CORRECTION_COMMENT) throw new PoValidationError(`Comment must be ${MAX_CORRECTION_COMMENT} characters or fewer.`);
  return t;
}
