// po-pdf-parser.ts — Server-only, in-memory PO PDF text extraction.
//
// The uploaded PDF is NEVER written to disk, Odoo, or any store. It exists
// only as a Buffer in this request's memory, is parsed synchronously within
// the request, and is discarded when the request completes — there is no
// code path anywhere in this file (or its caller) that persists the bytes.
//
// Uses pdfjs-dist directly (pinned, no native/binary deps — same reasoning
// that ruled out a headless browser after past Playwright/gstack friction in
// this project). Deliberately NOT pdf-parse: it wraps a bundled pdfjs-dist
// from 2017 (v1.10.100) that was verified live, over 10 repeated runs on the
// same file, to intermittently throw "bad XRef entry" on a perfectly valid
// PDF — a real, non-deterministic reliability bug, not a fluke. Current
// pdfjs-dist (6.x) parsed the identical file correctly 10/10 times.

import 'server-only';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

interface PdfTextItem { str: string; transform: number[] }

async function extractRawText(buf: Buffer): Promise<string> {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buf), useWorkerFetch: false,
    disableFontFace: true, verbosity: 0,
  }).promise;
  const lines: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY: number | null = null;
    let line = '';
    for (const raw of content.items as PdfTextItem[]) {
      const y = raw.transform?.[5] ?? null;
      if (lastY !== null && y !== lastY) { lines.push(line); line = ''; }
      line += raw.str;
      lastY = y;
    }
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

export class InvalidPdfError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidPdfError'; }
}
export class EncryptedPdfError extends Error {
  constructor() { super('This PDF is password-protected. Please upload an unprotected PO PDF.'); this.name = 'EncryptedPdfError'; }
}
export class PdfTooLargeError extends Error {
  constructor(maxMb: number) { super(`PDF exceeds the ${maxMb}MB upload limit.`); this.name = 'PdfTooLargeError'; }
}

// Vercel's Node.js serverless functions hard-cap the request body at 4.5MB
// regardless of any application-level setting — this limit is kept safely
// below that so a validation error is returned instead of a raw platform 413.
export const MAX_PO_PDF_BYTES = 3.5 * 1024 * 1024; // 3.5MB

const PDF_MAGIC = Buffer.from('%PDF-');

// Validates the raw bytes BEFORE any parsing is attempted — magic-byte check
// catches a renamed non-PDF file even if the browser sent a spoofed
// Content-Type/extension. Throws typed, user-safe errors only; never leaks
// internals.
export function validatePdfBytes(buf: Buffer, declaredFilename: string): void {
  if (buf.length === 0) throw new InvalidPdfError('The uploaded file is empty.');
  if (buf.length > MAX_PO_PDF_BYTES) throw new PdfTooLargeError(MAX_PO_PDF_BYTES / (1024 * 1024));
  if (!/\.pdf$/i.test(declaredFilename)) throw new InvalidPdfError('Only .pdf files are accepted.');
  if (!buf.subarray(0, 5).equals(PDF_MAGIC)) throw new InvalidPdfError('The file does not appear to be a valid PDF.');
}

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

function emptyExtraction(): ExtractedPoData {
  return {
    poNumber: null, poDate: null, expectedDeliveryDate: null, paymentTerms: null, currency: null,
    requesterName: null, createdBy: null, approvedBy: null,
    billingCompany: null, billingAddress: null, billingCity: null, billingState: null, billingPin: null, billingGstin: null,
    shippingCompany: null, shippingAddress: null, shippingCity: null, shippingState: null, shippingPin: null, shippingGstin: null,
    lineItems: [], untaxedAmount: null, taxAmount: null, grandTotal: null, amountInWords: null,
    piReference: null, vendorName: null, deliveryContact: null, notesToSupplier: null,
  };
}

// ── Generic label→value line matching ──────────────────────────────────────
// Real InBody-received PO layouts vary by customer/ERP; this is a
// best-effort, label-proximity matcher for a label and its value on the
// SAME line, or a bare label with its value on the very NEXT line
// (verified live: e.g. a real Cult.fit PO's "Vendor Registered Name" /
// "Inbody India Pvt Ltd" on two consecutive lines). Deliberately does NOT
// scan multiple lines ahead — an earlier version did, to handle a
// different real layout (see matchLabelBlock below), but scanning past
// the immediate next line risks grabbing a DIFFERENT field's bare label
// as if it were this field's value whenever several bare labels appear
// consecutively, which is exactly the block layout matchLabelBlock exists
// for. Never invents a value — an unmatched field stays null.
function matchLabel(lines: string[], labelPatterns: RegExp[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    for (const pat of labelPatterns) {
      const m = lines[i].match(pat);
      if (!m) continue;
      if (m[1] && m[1].trim()) return m[1].trim();
      const next = lines[i + 1]?.trim();
      if (next && !labelPatterns.some(p => p.test(next))) {
        const stripped = next.replace(/^[:\-]\s*/, '').trim();
        if (stripped) return stripped;
      }
      return null;
    }
  }
  return null;
}

// Handles PDFs that render a GROUP of header fields as two parallel
// columns — a run of N consecutive bare label lines, immediately followed
// by a run of N consecutive value lines (colon-prefixed or plain) in the
// SAME order — verified live as the actual layout a real Cult.fit PO uses
// for its "PO Creation Date / PO Date / PO Number / PO Terms / ..." field
// group (matchLabel alone cannot resolve this: the "next line" after any
// one of these bare labels is just the NEXT label, not that field's
// value). `fieldPatterns[i]` is the bare-label pattern(s) for the field at
// position i, in the exact order they're expected to appear; requires at
// least 2 consecutive fields to match before trusting the block, and never
// invents a value for a position whose corresponding value line is blank.
function matchLabelBlock(lines: string[], fieldPatterns: RegExp[][]): (string | null)[] {
  const empty = new Array<string | null>(fieldPatterns.length).fill(null);
  for (let i = 0; i < lines.length; i++) {
    if (!fieldPatterns[0].some(p => p.test(lines[i]))) continue;
    let matched = 0;
    while (matched < fieldPatterns.length && i + matched < lines.length
      && fieldPatterns[matched].some(p => p.test(lines[i + matched]))) matched++;
    if (matched < 2) continue;

    const result = [...empty];
    let vi = i + matched, collected = 0;
    while (vi < lines.length && collected < matched) {
      const stripped = lines[vi].replace(/^[:\-]\s*/, '').trim();
      if (stripped) { result[collected] = stripped; collected++; }
      vi++;
    }
    return result;
  }
  return empty;
}

function toNumber(s: string | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,\s₹%]/g, '').replace(/^Rs\.?/i, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Tolerates DD/MM/YYYY, DD-MM-YYYY, DD Mon YYYY, DD-Mon-YYYY (verified live
// against a real Cult.fit PO — its ERP prints dates as "07-JUL-2026", which
// the space-only version of the Mon-name pattern below did not match at
// all, silently returning null for both PO Date and Expected Delivery
// Date), Mon DD, YYYY — returns ISO yyyy-mm-dd or null. Never guesses an
// ambiguous format silently wrong; on ambiguity it still applies the
// DD-MM-YYYY convention (Indian PO documents), which the customer review
// step exists specifically to catch if wrong.
function parseFlexibleDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  m = s.match(/(\d{1,2})[-\s]+([A-Za-z]{3,9})[-\s,]+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

// 15 chars: 2-digit state code + 10-char PAN (5 letters + 4 digits + 1
// letter) + 1-digit entity number + literal "Z" + 1 alphanumeric checksum.
const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\dZ[A-Z\d])\b/;
const PIN_RE = /\b(\d{6})\b/;

// Breaks the block on the next section label, on the GSTIN line itself, or
// on anything that looks like the product table's header row. A real
// Cult.fit PO was verified live to print an 11-line company/multi-line-
// street/city/state/country block before its GSTIN line — a fixed small
// line-count cap (originally 6 for the address text, 8 for the GSTIN
// search) truncated the block well before reaching either the real
// boundary or the GSTIN itself. Both now share ONE boundary computation —
// generously capped (25 lines) only as a runaway safety net, not as the
// primary bound — instead of two independently-guessed window sizes that
// disagreed with each other.
const ADDRESS_BLOCK_BREAK_RE = /^(gstin|shipping|billing|ship\s*to|bill\s*to)/i;
const TABLE_HEADER_RE = /description|item/i;
const ADDRESS_BLOCK_MAX_LINES = 25;

function findBlockEnd(lines: string[], startIdx: number): number {
  let j = startIdx;
  for (; j < Math.min(startIdx + ADDRESS_BLOCK_MAX_LINES, lines.length); j++) {
    const l = lines[j].trim();
    if (!l || ADDRESS_BLOCK_BREAK_RE.test(l) || (TABLE_HEADER_RE.test(l) && /qty|quantity/i.test(l))) break;
  }
  return j;
}

function extractGstinNear(lines: string[], anchorPatterns: RegExp[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (anchorPatterns.some(p => p.test(lines[i]))) {
      const end = findBlockEnd(lines, i + 1);
      // The GSTIN line itself is what stopped the block (matched
      // ADDRESS_BLOCK_BREAK_RE's "gstin" branch) — check it plus a couple
      // of lines past it, since some layouts print GSTIN just after a
      // trailing blank line rather than as the literal break line.
      for (let j = i; j < Math.min(end + 2, lines.length); j++) {
        const m = lines[j].match(GSTIN_RE);
        if (m) return m[1];
      }
    }
  }
  return null;
}

function extractAddressBlockNear(lines: string[], anchorPatterns: RegExp[]): {
  company: string | null; address: string | null; city: string | null; state: string | null; pin: string | null;
} {
  for (let i = 0; i < lines.length; i++) {
    if (anchorPatterns.some(p => p.test(lines[i]))) {
      const end = findBlockEnd(lines, i + 1);
      const block = lines.slice(i + 1, end).map(l => l.trim()).filter(Boolean);
      if (!block.length) continue;
      const pinMatch = block.join(' ').match(PIN_RE);
      // Heuristic: last comma-separated segment before the PIN is usually
      // "City, State" — not asserted with high confidence, left for
      // customer review like every other extracted field.
      const joined = block.join(', ');
      const cityStateMatch = joined.match(/,\s*([A-Za-z .]+),\s*([A-Za-z .]+)\s*-?\s*\d{6}?/);
      return {
        company: block[0] || null,
        address: block.join(', '),
        city: cityStateMatch ? cityStateMatch[1].trim() : null,
        state: cityStateMatch ? cityStateMatch[2].trim() : null,
        pin: pinMatch ? pinMatch[1] : null,
      };
    }
  }
  return { company: null, address: null, city: null, state: null, pin: null };
}

const UNIT_TOKEN_RE = /^(nos?|pcs?|pieces?|units?|each|ea|kg|box(es)?|set(s)?|qty)$/i;
const CODE_TOKEN_RE = /^(?=[A-Z0-9]{6,14}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]+$/;

// Best-effort table row parser — see file header + master-context "known
// parser limitations". Finds the region between a header row (containing
// column-name keywords) and a totals row, then classifies each ROW by
// whitespace-separated TOKENS rather than by scanning for digit substrings
// within the line — a product code like "I9F300001" contains digits, and a
// naive digit-substring scan (the first implementation here) misread the
// digits inside it as the start of the numeric columns. Never invents a
// value for a column it can't find.
// A product row starts with a sequence number followed by an HSN/SAC code
// (6-10 digits) — e.g. "1 90181990 CS987332CM InBody 260S...". Anchoring
// on this is far more reliable than the header keywords below, because a
// real Cult.fit PO renders its header ITSELF fragmented across many short
// single-word lines ("Description", "Item", "Quantity" each on their own
// line, never together) — the same-line "description ... quantity" check
// never matches at all on that layout, which is why line-item extraction
// returned 0 items even though the table was clearly present.
const ROW_START_RE = /^\d+\s+\d{6,10}\b/;

function extractLineItems(lines: string[]): ExtractedPoLineItem[] {
  let dataStart = lines.findIndex(l => ROW_START_RE.test(l));
  const fragmented = dataStart !== -1;
  if (!fragmented) {
    const headerIdx = lines.findIndex(l => /description|item/i.test(l) && /qty|quantity/i.test(l));
    if (headerIdx === -1) return [];
    dataStart = headerIdx + 1;
  }
  const totalIdx = lines.findIndex((l, i) => i >= dataStart && /grand\s*total|^total\b/i.test(l));
  const dataEnd = totalIdx === -1 ? Math.min(dataStart + 60, lines.length) : totalIdx;

  // Only group multi-line when a row-start marker actually appears
  // somewhere in the data region (the fragmented real-Cult.fit-PO case —
  // a single row spans ~15 lines, one number/word fragment per line).
  // Simpler layouts with one complete row per line (no such marker) are
  // treated as already one-row-per-line — grouping unconditionally here
  // previously DROPPED every row on non-fragmented PDFs, since the first
  // data line never matched the marker and there was no "current" row yet
  // to append it to.
  let rows: string[];
  if (fragmented) {
    rows = [];
    let current: string[] = [];
    for (let i = dataStart; i < dataEnd; i++) {
      if (ROW_START_RE.test(lines[i])) {
        if (current.length) rows.push(current.join(' '));
        current = [lines[i]];
      } else if (current.length) {
        current.push(lines[i]);
      }
    }
    if (current.length) rows.push(current.join(' '));
  } else {
    rows = lines.slice(dataStart, dataEnd);
  }

  const items: ExtractedPoLineItem[] = [];
  // Trailing "%" allowed — a real Cult.fit PO's tax-rate columns print as
  // "5.00%" — treating that as non-numeric broke the trailing-run scan
  // immediately on hitting it, dropping the entire row (0 line items
  // extracted) even though the quantity/prices/amounts before it were
  // perfectly readable. toNumber() strips the "%" when converting.
  const isNumericToken = (t: string) => /^-?[\d,]*\.?\d+%?$/.test(t);

  for (const rawRow of rows) {
    // Rejoin a "%" that landed on its own line right after its number.
    const line = rawRow.replace(/(\d)\s+%/g, '$1%').trim();
    if (!line || line.length < 3) continue;
    const tokens = line.split(/\s+/);

    // Walk from the right collecting a trailing run of numeric tokens,
    // allowing exactly one non-numeric "unit" token (e.g. "Nos") to appear
    // inside that run without breaking it — the one real ambiguity a flat
    // token scan can't resolve on its own, since a unit column sits between
    // quantity and the rate/amount columns in most PO layouts.
    let cut = tokens.length;
    let unit: string | null = null;
    let sawUnit = false;
    while (cut > 0) {
      const t = tokens[cut - 1];
      if (isNumericToken(t)) { cut--; continue; }
      if (!sawUnit && UNIT_TOKEN_RE.test(t)) { unit = t; sawUnit = true; cut--; continue; }
      break;
    }
    const numTokens = tokens.slice(cut).filter(isNumericToken);
    if (numTokens.length < 2) continue; // need at least qty + one amount to treat this as a line item

    const descTokens = tokens.slice(0, cut);
    const codeIdx = descTokens.findIndex(t => CODE_TOKEN_RE.test(t));
    const code = codeIdx !== -1 ? descTokens[codeIdx] : null;
    const description = descTokens.filter((_, idx) => idx !== codeIdx).join(' ').replace(/^\d+\.?\s*/, '').trim() || null;

    const parsed = numTokens.map(toNumber).filter((n): n is number => n !== null);
    // Column count varies by PO layout — verified live that a real
    // Cult.fit PO row has 8 numeric-ish tokens (qty, unit price, base
    // value, IGST amount, IGST%, CGST%, SGST%, total), not the 5-6 this
    // scheme was originally tuned for. lineTotal is always the RIGHTMOST
    // value regardless of column count (a universal PO convention — same
    // rule extractTotalsFromTableRow uses for the grand-total row), so it
    // no longer silently picks up whatever arbitrary column happens to
    // land at a fixed index. Same for quantity/unitPrice/baseValue at the
    // front, which are far more consistently positioned across layouts
    // than the tax breakdown in the middle. Anything between baseValue and
    // the total is summed into one aggregate taxAmount rather than
    // mislabeling one arbitrary rate/amount column as "the" tax figure —
    // still never invented, just aggregated from what's confidently there.
    const quantity = parsed[0] ?? null;
    let unitPrice: number | null = null, baseValue: number | null = null,
      taxRate: number | null = null, taxAmount: number | null = null, lineTotal: number | null = null;
    if (parsed.length >= 2) lineTotal = parsed[parsed.length - 1];
    if (parsed.length >= 3) unitPrice = parsed[1];
    if (parsed.length >= 4) baseValue = parsed[2];
    if (parsed.length === 5) {
      taxAmount = parsed[3];
    } else if (parsed.length === 6) {
      taxRate = parsed[3]; taxAmount = parsed[4];
    } else if (parsed.length > 6) {
      taxAmount = parsed.slice(3, parsed.length - 1).reduce((a, b) => a + b, 0);
    }

    items.push({ description, code, quantity, unit, unitPrice, baseValue, taxRate, taxAmount, lineTotal });
  }
  return items;
}

// Fallback for totals that are printed as a TABLE ROW ("Total  2.00
// 245,000.00  12250.00  0.00  0.00  257250.00") rather than a "Label:
// Value" line — verified live on a real Cult.fit PO, whose totals row has
// no colon at all, so none of the label-based patterns above ever matched
// it. Only used when the label-based extraction found nothing. Grand total
// is always the rightmost number (universal convention); untaxed/tax are
// only inferred when there are enough columns to do so with reasonable
// confidence (qty-sum, base-value-sum, ...tax breakdown..., grand-total) —
// otherwise left null rather than guessed, same as everywhere else in this
// file.
function extractTotalsFromTableRow(lines: string[]): { untaxedAmount: number | null; taxAmount: number | null; grandTotal: number | null } {
  const startIdx = lines.findIndex(l => /^total\b/i.test(l.trim()));
  if (startIdx === -1) return { untaxedAmount: null, taxAmount: null, grandTotal: null };
  // The totals row can be fragmented across several lines too (same real
  // Cult.fit PO layout as the product rows) — group forward until the next
  // clearly-different section rather than assuming one line has everything.
  let endIdx = startIdx + 1;
  while (endIdx < lines.length && endIdx < startIdx + 10
    && !/amount\s*in\s*words|rupees|^note/i.test(lines[endIdx])) endIdx++;
  const row = lines.slice(startIdx, endIdx).join(' ').replace(/(\d)\s+%/g, '$1%');
  const nums = (row.match(/-?[\d,]*\.?\d+/g) || []).map(toNumber).filter((n): n is number => n !== null);
  if (!nums.length) return { untaxedAmount: null, taxAmount: null, grandTotal: null };
  const grandTotal = nums[nums.length - 1];
  if (nums.length < 4) return { untaxedAmount: null, taxAmount: null, grandTotal };
  const untaxedAmount = nums[1];
  const taxAmount = nums.slice(2, -1).reduce((a, b) => a + b, 0);
  return { untaxedAmount, taxAmount, grandTotal };
}

export async function extractPoDataFromPdf(buf: Buffer): Promise<ExtractedPoData> {
  let rawText: string;
  try {
    rawText = await extractRawText(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypt/i.test(msg)) throw new EncryptedPdfError();
    throw new InvalidPdfError('Could not read this PDF — it may be corrupted or in an unsupported format.');
  }
  if (!rawText || !rawText.trim()) {
    throw new InvalidPdfError('No readable text found in this PDF. Scanned/image-only PDFs are not supported yet.');
  }

  const allLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  // Truncate before the legal Terms & Conditions boilerplate — verified
  // live that without this, "Payment Terms:" inside clause 6 of a real
  // Cult.fit PO's standard T&Cs (an entirely unrelated legal paragraph, not
  // the PO header field of the same name) was matched as the PO's payment
  // terms. The actual PO data (header fields, addresses, product table,
  // totals) always appears before this heading; the numbered legal clauses
  // after it are boilerplate that must never feed any of the extractors
  // below.
  const tcIdx = allLines.findIndex(l => /terms\s+and\s+conditions/i.test(l));
  const lines = tcIdx === -1 ? allLines : allLines.slice(0, tcIdx);
  const result = emptyExtraction();

  // Same-line "label: value" first — works for POs that print them
  // together (or label + value on two plain consecutive lines).
  result.poNumber = matchLabel(lines, [
    /(?:P\.?O\.?\s*(?:No|Number|#)\.?)\s*[:\-]\s*(.+)/i,
    /Purchase\s*Order\s*(?:No|Number|#)?\.?\s*[:\-]\s*(.+)/i,
  ]);
  result.poDate = parseFlexibleDate(matchLabel(lines, [
    /P\.?O\.?\s*Date\s*[:\-]\s*(.+)/i, /Order\s*Date\s*[:\-]\s*(.+)/i,
  ]));
  // "PO Terms" verified live as the actual label on a real Cult.fit PO —
  // "Payment Terms" alone missed it, AND (before the T&C truncation above)
  // incorrectly matched a same-named legal clause instead.
  result.paymentTerms = matchLabel(lines, [/(?:PO\s*|Payment\s*)Terms\s*[:\-]\s*(.+)/i]);
  result.createdBy = matchLabel(lines, [/(?:PO\s*)?Created\s*By\s*[:\-]\s*(.+)/i, /Prepared\s*By\s*[:\-]\s*(.+)/i]);
  result.approvedBy = matchLabel(lines, [/(?:PO\s*)?Approved\s*By\s*[:\-]\s*(.+)/i, /Authoriz(?:ed|er)\s*By\s*[:\-]\s*(.+)/i]);
  result.expectedDeliveryDate = parseFlexibleDate(matchLabel(lines, [
    /Expected\s*Delivery\s*Date\s*[:\-]\s*(.+)/i, /Delivery\s*Date\s*[:\-]\s*(.+)/i, /Required\s*(?:By|Date)\s*[:\-]\s*(.+)/i,
  ]));

  // Fallback: the "two parallel columns" block layout (see
  // matchLabelBlock's own comment) — verified live as the real Cult.fit PO
  // template for exactly these two field groups. Only fills in whatever
  // the same-line pass above didn't already find.
  // Full 8-field block, even though only 4 are used below — a real
  // Cult.fit PO's label run is 8 long (...Currency/Exchange Rate/Nature of
  // Expense/Advance % follow); modeling only the 4 fields this code cares
  // about made the value-collection window start 4 lines too early,
  // landing on the LAST 4 labels themselves instead of the real values.
  const [creationDateBlk, poDateBlk, poNumberBlk, poTermsBlk] = matchLabelBlock(lines, [
    [/^PO\s*Creation\s*Date\s*$/i], [/^P\.?O\.?\s*Date\s*$/i],
    [/^P\.?O\.?\s*(?:No|Number|#)\.?\s*$/i], [/^PO\s*Terms\s*$/i],
    [/^PO\s*Currency\s*$/i], [/^PO\s*Exchange\s*Rate\s*$/i],
    [/^Nature\s*of\s*Expense\s*$/i], [/^Advance\s*%\s*$/i],
  ]);
  void creationDateBlk;
  result.poNumber ??= poNumberBlk;
  result.poDate ??= parseFlexibleDate(poDateBlk);
  result.paymentTerms ??= poTermsBlk;

  const [createdByBlk, approvedByBlk, expectedDeliveryBlk, piRefBlk] = matchLabelBlock(lines, [
    [/^(?:PO\s*)?Created\s*By\s*$/i], [/^(?:PO\s*)?Approved\s*By\s*$/i],
    [/^Expected\s*Delivery\s*Date\s*$/i], [/^(?:Imports\s*)?PI\s*(?:No|Number|Ref)\.?\s*$/i],
  ]);
  result.createdBy ??= createdByBlk;
  result.approvedBy ??= approvedByBlk;
  result.expectedDeliveryDate ??= parseFlexibleDate(expectedDeliveryBlk);

  // Real POs print the currency name, not a code/symbol ("PO Currency :
  // Indian Rupee") — verified live; the code/symbol check alone missed it.
  const searchText = lines.join('\n');
  const currencyMatch = searchText.match(/\b(INR|USD|EUR|GBP)\b/);
  result.currency = currencyMatch ? currencyMatch[1]
    : /Indian\s*Rupees?/i.test(searchText) ? 'INR'
    : /₹|Rs\.?\s/.test(searchText) ? 'INR' : null;
  result.requesterName = matchLabel(lines, [/Requester\s*[:\-]\s*(.+)/i, /Requested\s*By\s*[:\-]\s*(.+)/i]);

  const billing = extractAddressBlockNear(lines, [/^bill\s*to\b/i, /billing\s*address/i]);
  result.billingCompany = billing.company; result.billingAddress = billing.address;
  result.billingCity = billing.city; result.billingState = billing.state; result.billingPin = billing.pin;
  result.billingGstin = extractGstinNear(lines, [/^bill\s*to\b/i, /billing\s*address/i, /billing\s*gstin/i]);

  const shipping = extractAddressBlockNear(lines, [/^ship\s*to\b/i, /shipping\s*address/i, /delivery\s*address/i]);
  result.shippingCompany = shipping.company; result.shippingAddress = shipping.address;
  result.shippingCity = shipping.city; result.shippingState = shipping.state; result.shippingPin = shipping.pin;
  result.shippingGstin = extractGstinNear(lines, [/^ship\s*to\b/i, /shipping\s*address/i, /shipping\s*gstin/i]);

  result.lineItems = extractLineItems(lines);

  result.untaxedAmount = toNumber(matchLabel(lines, [
    /(?:Taxable|Untaxed|Base)\s*(?:Value|Amount)\s*[:\-]\s*(.+)/i, /Sub\s*[- ]?Total\s*[:\-]\s*(.+)/i,
  ]));
  result.taxAmount = toNumber(matchLabel(lines, [/(?:Total\s*)?Tax\s*(?:Amount)?\s*[:\-]\s*(.+)/i, /GST\s*[:\-]\s*(.+)/i]));
  result.grandTotal = toNumber(matchLabel(lines, [
    /Grand\s*Total\s*[:\-]\s*(.+)/i, /Total\s*Amount\s*[:\-]\s*(.+)/i, /^Total\s*[:\-]\s*(.+)/i,
  ]));
  if (result.grandTotal === null) {
    const tableTotals = extractTotalsFromTableRow(lines);
    result.untaxedAmount ??= tableTotals.untaxedAmount;
    result.taxAmount ??= tableTotals.taxAmount;
    result.grandTotal = tableTotals.grandTotal;
  }
  result.amountInWords = matchLabel(lines, [/Amount\s*in\s*Words\s*[:\-]\s*(.+)/i, /Rupees\s*[:\-]\s*(.+)/i]);

  result.piReference = matchLabel(lines, [
    /PI\s*(?:No|Number|Ref)\.?\s*[:\-]\s*(.+)/i, /Proforma\s*(?:Invoice)?\s*(?:No|Ref)\.?\s*[:\-]\s*(.+)/i,
  ]) ?? piRefBlk; // "Imports PI Number" — bare label, verified live via matchLabelBlock above
  // "Supplier" alone (no "Name") is deliberately NOT accepted as a
  // vendor-name label here — verified live that it wrongly matched inside
  // "Note to Supplier: <notes text>" on a real Cult.fit PO, an unrelated
  // field, and silently overwrote vendorName with notes content.
  result.vendorName = matchLabel(lines, [
    /Vendor\s*(?:Name)?\s*[:\-]\s*(.+)/i, /Supplier\s*Name\s*[:\-]\s*(.+)/i,
    // Label-only line with the value on the next line — verified live as
    // the actual layout on a real Cult.fit PO ("Vendor Registered Name" /
    // "Inbody India Pvt Ltd" on consecutive lines, no colon at all).
    /^Vendor\s*Registered\s*Name\s*$/i,
  ]);
  result.deliveryContact = matchLabel(lines, [/Delivery\s*Contact\s*[:\-]\s*(.+)/i, /Contact\s*Person\s*[:\-]\s*(.+)/i]);
  result.notesToSupplier = matchLabel(lines, [/Notes?\s*to\s*Supplier\s*[:\-]\s*(.+)/i, /Special\s*Instructions?\s*[:\-]\s*(.+)/i]);

  return result;
}
