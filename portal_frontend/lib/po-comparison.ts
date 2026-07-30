// po-comparison.ts — Compares customer-submitted PO data against the latest
// confirmed PI. Business rule (explicit): a mismatch is ALWAYS shown, NEVER
// blocks submission — this module only classifies and describes, it never
// throws or rejects.

import type { PIPublishedSnapshot } from '@/lib/odoo-server';
import type { ExtractedPoData } from '@/lib/po-pdf-parser';

export type ComparisonSeverity =
  | 'match' | 'warning' | 'missing_from_po' | 'extra_in_po'
  | 'amount_mismatch' | 'quantity_mismatch' | 'product_mismatch' | 'tax_mismatch';

export interface ComparisonResult {
  field: string;
  severity: ComparisonSeverity;
  message: string;
}

const AMOUNT_TOLERANCE_ABS = 1; // ₹1 — absorbs pure rounding noise, nothing more
const AMOUNT_TOLERANCE_REL = 0.005; // 0.5%

function amountsClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(AMOUNT_TOLERANCE_ABS, Math.abs(b) * AMOUNT_TOLERANCE_REL);
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function comparePoToPi(po: ExtractedPoData, pi: PIPublishedSnapshot): ComparisonResult[] {
  const results: ComparisonResult[] = [];

  // Product lines: match PI lines to PO lines by code first, then by
  // description containment — both directions checked so nothing silently
  // disappears either way.
  const poLines = po.lineItems;
  const matchedPoIdx = new Set<number>();

  for (const piLine of pi.lineItems) {
    const idx = poLines.findIndex((l, i) => {
      if (matchedPoIdx.has(i)) return false;
      if (l.code && piLine.code && normalize(l.code) === normalize(piLine.code)) return true;
      if (l.description && normalize(l.description).includes(normalize(piLine.name).split(' ')[0])) return true;
      return false;
    });
    if (idx === -1) {
      results.push({ field: `product:${piLine.code || piLine.name}`, severity: 'missing_from_po', message: `${piLine.name} (${piLine.code}) from the confirmed PI was not found in the PO.` });
      continue;
    }
    matchedPoIdx.add(idx);
    const poLine = poLines[idx];
    if (poLine.quantity !== null && poLine.quantity !== piLine.quantity) {
      results.push({ field: `quantity:${piLine.code || piLine.name}`, severity: 'quantity_mismatch', message: `${piLine.name}: PI quantity ${piLine.quantity}, PO quantity ${poLine.quantity}.` });
    } else {
      results.push({ field: `product:${piLine.code || piLine.name}`, severity: 'match', message: `${piLine.name} matched.` });
    }
  }
  poLines.forEach((l, i) => {
    if (!matchedPoIdx.has(i)) {
      results.push({ field: `product:${l.code || l.description || `line ${i + 1}`}`, severity: 'extra_in_po', message: `PO line "${l.description ?? l.code ?? `#${i + 1}`}" was not found on the confirmed PI.` });
    }
  });

  // Totals
  if (po.untaxedAmount !== null) {
    results.push(amountsClose(po.untaxedAmount, pi.untaxedAmount)
      ? { field: 'untaxedAmount', severity: 'match', message: 'Untaxed amount matches.' }
      : { field: 'untaxedAmount', severity: 'amount_mismatch', message: `PI untaxed amount is ₹${pi.untaxedAmount}, PO shows ₹${po.untaxedAmount}.` });
  } else {
    results.push({ field: 'untaxedAmount', severity: 'warning', message: 'Untaxed amount could not be read from the PO — please confirm manually.' });
  }

  if (po.taxAmount !== null) {
    results.push(amountsClose(po.taxAmount, pi.taxAmount)
      ? { field: 'taxAmount', severity: 'match', message: 'Tax amount matches.' }
      : { field: 'taxAmount', severity: 'tax_mismatch', message: `PI tax amount is ₹${pi.taxAmount}, PO shows ₹${po.taxAmount}.` });
  } else {
    results.push({ field: 'taxAmount', severity: 'warning', message: 'Tax amount could not be read from the PO — please confirm manually.' });
  }

  if (po.grandTotal !== null) {
    results.push(amountsClose(po.grandTotal, pi.totalAmount)
      ? { field: 'grandTotal', severity: 'match', message: 'Grand total matches.' }
      : { field: 'grandTotal', severity: 'amount_mismatch', message: `PI total is ₹${pi.totalAmount}, PO shows ₹${po.grandTotal}.` });
  } else {
    results.push({ field: 'grandTotal', severity: 'warning', message: 'Grand total could not be read from the PO — please confirm manually.' });
  }

  // Currency
  if (po.currency && po.currency !== 'INR') {
    results.push({ field: 'currency', severity: 'warning', message: `PO currency appears to be ${po.currency}, expected INR.` });
  }

  // CultFit company sanity check (loose — never blocks)
  if (po.billingCompany && !normalize(po.billingCompany).includes('cult')) {
    results.push({ field: 'billingCompany', severity: 'warning', message: `Billing company "${po.billingCompany}" does not obviously match CultFit — please confirm.` });
  }

  // PI reference, if the PO happens to print it
  if (po.piReference && !normalize(po.piReference).includes(normalize(pi.quotationNumber))) {
    results.push({ field: 'piReference', severity: 'warning', message: `PO references "${po.piReference}", which does not match the confirmed PI ${pi.quotationNumber}.` });
  }

  return results;
}
