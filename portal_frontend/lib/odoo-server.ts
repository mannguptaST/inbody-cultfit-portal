// odoo-server.ts — Server-only Odoo XML-RPC client.
// Never import this on the client side.

import 'server-only';
import { randomUUID } from 'node:crypto';
import type { CustomerScope } from '@/lib/auth-server';
import { STAGE_LABELS, STAGE_KEYS, REQUEST_STAGE_LABELS } from '@/lib/stage-config';
import { resolveRegionFromRequestName } from '@/lib/region-resolver';
import { extractPoDataFromPdf, validatePdfBytes, type ExtractedPoData } from '@/lib/po-pdf-parser';
import { comparePoToPi, type ComparisonResult } from '@/lib/po-comparison';
import { validatePoSubmission, validateCorrectionComment, type PortalPoData } from '@/lib/po-validation';

const ODOO_URL  = (process.env.ODOO_BASE_URL  ?? '').replace(/\/$/, '');
const ODOO_DB   = process.env.ODOO_DB          ?? '';
const ODOO_USER = process.env.ODOO_API_USER    ?? '';
const ODOO_PASS = process.env.ODOO_API_PASS    ?? '';

// ──── XML-RPC serializer ──────────────────────────────────────────────────────

function xmlEsc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toXml(v: unknown): string {
  if (v === null || v === undefined) return '<value><nil/></value>';
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? `<value><int>${v}</int></value>`
      : `<value><double>${v}</double></value>`;
  }
  if (typeof v === 'string') return `<value><string>${xmlEsc(v)}</string></value>`;
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(toXml).join('')}</data></array></value>`;
  }
  if (typeof v === 'object') {
    const mems = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `<member><name>${k}</name>${toXml(x)}</member>`)
      .join('');
    return `<value><struct>${mems}</struct></value>`;
  }
  return `<value><string>${xmlEsc(String(v))}</string></value>`;
}

function buildCall(method: string, params: unknown[]) {
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${
    params.map(p => `<param>${toXml(p)}</param>`).join('')
  }</params></methodCall>`;
}

// ──── XML-RPC parser ──────────────────────────────────────────────────────────

interface Tok { type: 'open' | 'close' | 'self' | 'text'; name?: string; value?: string }

function tokenize(xml: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const end = xml.indexOf('<', i);
      const s = (end === -1 ? xml.slice(i) : xml.slice(i, end)).trim();
      if (s) out.push({ type: 'text', value: s });
      i = end === -1 ? xml.length : end;
    } else if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i);
      out.push({ type: 'close', name: xml.slice(i + 2, end).trim() });
      i = end + 1;
    } else if (xml.startsWith('<?', i) || xml.startsWith('<!--', i)) {
      const end = xml.startsWith('<?', i) ? xml.indexOf('?>', i) + 2 : xml.indexOf('-->', i) + 3;
      i = Math.max(i + 1, end);
    } else {
      const end = xml.indexOf('>', i);
      if (end === -1) break;
      const inner = xml.slice(i + 1, end);
      const self = inner.endsWith('/');
      const name = (self ? inner.slice(0, -1) : inner).trim().split(/[\s/]/)[0];
      out.push({ type: self ? 'self' : 'open', name });
      i = end + 1;
    }
  }
  return out;
}

function decodeEnt(s: string) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

type Cur = { i: number };

function parseVal(toks: Tok[], c: Cur): unknown {
  let tok = toks[c.i];
  if (tok?.type === 'open' && tok.name === 'value') { c.i++; tok = toks[c.i]; }

  let result: unknown = null;

  if (!tok || (tok.type === 'close' && tok.name === 'value')) {
    result = '';
  } else if (tok.type === 'text') {
    result = decodeEnt(tok.value!); c.i++;
  } else if (tok.type === 'self') {
    if (tok.name === 'nil') result = null;
    else if (tok.name === 'string') result = '';
    c.i++;
  } else if (tok.type === 'open') {
    const tag = tok.name!; c.i++;
    switch (tag) {
      case 'boolean': { const t = toks[c.i++]; result = t?.value?.trim() === '1'; c.i++; break; }
      case 'int': case 'i4': case 'i8': { const t = toks[c.i++]; result = parseInt(t?.value ?? '0', 10); c.i++; break; }
      case 'double': { const t = toks[c.i++]; result = parseFloat(t?.value ?? '0'); c.i++; break; }
      case 'string': {
        const t = toks[c.i];
        if (t?.type === 'text') { result = decodeEnt(t.value!); c.i++; } else result = '';
        if (toks[c.i]?.type === 'close') c.i++;
        break;
      }
      case 'array': {
        if (toks[c.i]?.name === 'data') c.i++;
        const items: unknown[] = [];
        while (!(toks[c.i]?.type === 'close' && toks[c.i]?.name === 'data') && c.i < toks.length) {
          if (toks[c.i]?.name === 'value') items.push(parseVal(toks, c));
          else c.i++;
        }
        if (toks[c.i]?.name === 'data') c.i++;
        if (toks[c.i]?.name === 'array') c.i++;
        result = items;
        break;
      }
      case 'struct': {
        const obj: Record<string, unknown> = {};
        while (!(toks[c.i]?.type === 'close' && toks[c.i]?.name === 'struct') && c.i < toks.length) {
          if (toks[c.i]?.name === 'member') {
            c.i++;
            if (toks[c.i]?.name === 'name') c.i++;
            const nt = toks[c.i];
            const mname = nt?.type === 'text' ? nt.value! : '';
            if (nt?.type === 'text') c.i++;
            if (toks[c.i]?.type === 'close') c.i++;
            obj[mname] = parseVal(toks, c);
            if (toks[c.i]?.type === 'close' && toks[c.i]?.name === 'member') c.i++;
          } else c.i++;
        }
        if (toks[c.i]?.name === 'struct') c.i++;
        result = obj;
        break;
      }
      default: {
        let d = 1;
        while (c.i < toks.length && d > 0) {
          const t = toks[c.i++];
          if (t.type === 'open') d++;
          if (t.type === 'close') d--;
        }
      }
    }
  }

  if (toks[c.i]?.type === 'close' && toks[c.i]?.name === 'value') c.i++;
  return result;
}

function parseResponse(xml: string): unknown {
  const toks = tokenize(xml);
  const fi = toks.findIndex(t => t.type === 'open' && t.name === 'fault');
  if (fi !== -1) {
    const f = parseVal(toks, { i: fi + 1 }) as Record<string, unknown>;
    throw new Error(`Odoo fault ${f?.faultCode}: ${f?.faultString}`);
  }
  const pi = toks.findIndex(t => t.type === 'open' && t.name === 'param');
  if (pi === -1) throw new Error('No param in XML-RPC response');
  return parseVal(toks, { i: pi + 1 });
}

// ──── HTTP caller ─────────────────────────────────────────────────────────────

export class OdooUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Odoo is temporarily unavailable.');
    this.name = 'OdooUnavailableError';
    if (cause instanceof Error) this.cause = cause;
  }
}

const RPC_TIMEOUT_MS = 15_000;

async function rpcPost(endpoint: string, method: string, params: unknown[]): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${ODOO_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: buildCall(method, params),
      signal: controller.signal,
    });
  } catch (e) {
    // Covers both the abort (timeout) and any network-level failure
    // (DNS, connection refused, TLS, etc.) reaching Odoo.
    throw new OdooUnavailableError(e);
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) throw new OdooUnavailableError(new Error(`HTTP ${resp.status} from Odoo`));
  return parseResponse(await resp.text());
}

let _uid: number | null = null;

async function getUid(): Promise<number> {
  if (_uid) return _uid;
  const uid = await rpcPost('/xmlrpc/2/common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PASS, {}]) as number;
  if (!uid) throw new Error('Odoo XML-RPC authentication failed — check credentials');
  _uid = uid;
  return _uid;
}

export async function executeKw(
  model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}
): Promise<unknown> {
  try {
    const uid = await getUid();
    return await rpcPost('/xmlrpc/2/object', 'execute_kw', [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs]);
  } catch (e) {
    // Only retry when the cached uid might be stale (an auth/session-level
    // fault). Odoo being genuinely unreachable (timeout, network failure) is
    // a distinct failure mode — retrying that would just double the wait
    // before the caller ever finds out.
    if (e instanceof OdooUnavailableError) throw e;
    _uid = null;
    const uid = await getUid();
    return rpcPost('/xmlrpc/2/object', 'execute_kw', [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs]);
  }
}

// Cheap, unauthenticated reachability check for /api/health — never throws,
// never leaks the Odoo URL/DB/credentials, just true/false.
export async function checkOdooHealth(): Promise<boolean> {
  try {
    await rpcPost('/xmlrpc/2/common', 'version', []);
    return true;
  } catch {
    return false;
  }
}

// ──── Business logic constants ────────────────────────────────────────────────

const CLOSED_STAGE_IDS = new Set([8, 9, 10, 11]);
const COLLECTED_STAGE_ID = 8;

// Single source of truth for "which Odoo commercial partner is CultFit" — a
// stable id, configured via env, never hardcoded at any other call site in
// this file. Replaces the name-based domain this project shipped with
// initially: on 2026-07-29 the canonical partner (id 1822, ~80 linked leads)
// was renamed live in production from "CULTFIT HEALTHCARE PRIVATE LIMITED"
// to "CULT.FIT LIMITED" mid-session — a plain substring match against the
// other 4 patterns this file used to rely on no longer caught it ('cult fit'
// has a space, this has a period), which silently dropped the matched-lead
// count from ~85 to 3 and affected every existing CultFit read (dashboard,
// admin, order detail), not just this file's new additions. A rename can
// never do that again with an id-based domain. commercial_partner_id already
// resolves any child/location contact up to its top-level company, so a
// single equality check on this id covers every CultFit location/address
// without needing to enumerate them.
const CULTFIT_PARTNER_ID = Number(process.env.CULTFIT_PARTNER_ID);

function cultfitDomain(): unknown[] {
  if (!Number.isInteger(CULTFIT_PARTNER_ID) || CULTFIT_PARTNER_ID <= 0) {
    throw new Error('CULTFIT_PARTNER_ID is not configured — refusing to resolve CultFit access.');
  }
  return [['partner_id.commercial_partner_id', '=', CULTFIT_PARTNER_ID]];
}

// Retained ONLY as a guarded, opt-in diagnostic — never used to grant or
// deny access. checkCultFitPartnerDrift() below compares this against the
// id-based domain so a future rename shows up as a logged warning instead of
// a silent access change, without ever letting a name match widen or narrow
// what a customer can actually see.
const CULTFIT_NAME_FALLBACK_DOMAIN = [
  '|', '|', '|', '|',
  ['partner_id.commercial_partner_id.name', 'ilike', 'cultfit'],
  ['partner_id.commercial_partner_id.name', 'ilike', 'curefit'],
  ['partner_id.commercial_partner_id.name', 'ilike', 'cult fit'],
  ['partner_id.commercial_partner_id.name', 'ilike', 'cultfit healthcare'],
  ['partner_id.commercial_partner_id.name', 'ilike', 'cult.fit'],
];

// Best-effort, on-demand drift check — NOT called automatically on any
// request path (an extra live Odoo round-trip per request isn't worth it for
// a diagnostic). Call this manually (e.g. from a future admin/health route)
// if you want to confirm the configured id still matches what name-based
// matching would find. Never throws, never affects authorization.
export async function checkCultFitPartnerDrift(): Promise<{ idBasedCount: number; nameBasedCount: number; drifted: boolean }> {
  try {
    const [idBasedCount, nameBasedCount] = await Promise.all([
      executeKw('crm.lead', 'search_count', [cultfitDomain()]) as Promise<number>,
      executeKw('crm.lead', 'search_count', [CULTFIT_NAME_FALLBACK_DOMAIN]) as Promise<number>,
    ]);
    return { idBasedCount, nameBasedCount, drifted: idBasedCount !== nameBasedCount };
  } catch {
    return { idBasedCount: -1, nameBasedCount: -1, drifted: false };
  }
}

// ──── Authorization (never trust client input for any of this) ───────────────

export class PartnerNotMappedError extends Error {
  constructor() {
    super('Customer account is not mapped to an Odoo partner.');
    this.name = 'PartnerNotMappedError';
  }
}

export type Authz =
  | { role: 'admin' }
  | { role: 'logistics' }
  | { role: 'cs' }
  | { role: 'customer'; scope: CustomerScope | undefined };

// Every CultFit fetch — list AND single-record — resolves its domain from
// this function only. It always includes the CultFit domain, even for admin,
// logistics and CS, so no authenticated user of any role can ever read a
// crm.lead outside the CultFit family through these functions, and a
// customer with no (or an empty) scope gets a hard 403 rather than any
// fallback to broad access. Logistics and CS are each granted the same READ
// domain as admin (see §3 of the Phase 4 spec and the equivalent Phase 5
// rule: "CS must see all CultFit orders") — every function that must stay
// admin-only, or admin/logistics-only, for WRITES already gates on
// `authz.role !== 'admin'` (etc.) explicitly, which correctly rejects 'cs'
// too without needing separate handling per call site.
function authzDomain(authz: Authz): unknown[] {
  if (authz.role === 'admin' || authz.role === 'logistics' || authz.role === 'cs') return cultfitDomain();

  const scope = authz.scope;
  if (!scope) throw new PartnerNotMappedError();
  if (scope.kind === 'cultfit_domain') return cultfitDomain();
  if (scope.kind === 'partner_ids') {
    if (!scope.partnerIds.length) throw new PartnerNotMappedError();
    return [['partner_id.commercial_partner_id', 'in', scope.partnerIds]];
  }
  throw new PartnerNotMappedError();
}

const DEAL_STATUS_MAP: Record<string, string> = {
  'PO received':             'po_received',
  'PI shared':               'pi_shared',
  'Dispatch Requested':      'dispatch_requested',
  'Dispatched':              'dispatched',
  'Delivered(not Inst yet)': 'delivered',
  'Server Updated':          'server_updated',
};

const DELIVERY_MAP: Record<string, string> = {
  'PO received':             'Pending',
  'PI shared':               'Pending',
  'Dispatch Requested':      'Pending',
  'Dispatched':              'Ready to Dispatch',
  'Delivered(not Inst yet)': 'Delivered',
  'Server Updated':          'Delivered',
};

const INVOICE_MAP: Record<number, string> = { 8: 'Invoiced', 7: 'To Invoice' };

const LEAD_FIELDS = [
  'id', 'name', 'partner_id', 'stage_id', 'deal_status_id',
  'deal_type', 'date_deadline', 'create_date', 'write_date',
  'user_id', 'x_studio_machine_installed_at', 'city',
  'payment_term_id', 'expected_revenue', 'won_status', 'is_credit_deal', 'order_ids',
];

const SO_FIELDS = ['id', 'name', 'opportunity_id', 'amount_untaxed', 'amount_tax', 'order_line', 'client_order_ref'];

// ──── Helpers ─────────────────────────────────────────────────────────────────

function parseDate(v: unknown): string | null {
  return v ? String(v).slice(0, 10) : null;
}

function daysTo(ds: string | null): number {
  if (!ds) return 0;
  const diff = Math.floor((new Date(ds).getTime() - Date.now()) / 86_400_000);
  return Math.max(0, diff);
}

function isOverdue(ds: string | null, stageId: number): boolean {
  if (!ds || CLOSED_STAGE_IDS.has(stageId)) return false;
  return new Date(ds) < new Date(new Date().toDateString());
}

type OdooTuple = [number, string] | false;

// Per-lead rollup of its linked sale.order(s). A crm.lead can have zero, one,
// or several linked sale orders (order_ids) — these three fields each need a
// different combination rule when there's more than one:
//   - poNumber: no meaningful way to combine two reference strings, so we use
//     the most-recently-linked order (last id in order_ids) as "the" order —
//     the same convention the pre-Next.js FastAPI backend used (so_ids[-1:]).
//   - amountUntaxed / amountTax: money combines cleanly by summation, so all
//     linked orders are summed rather than picking just one.
//   - modelNames: the deduplicated union of every product across every linked
//     order, since a deal can accumulate models across more than one order.
// Confirmed via a live, read-only fields_get probe against production Odoo:
// no field for "PO received date" or "PI issued date" exists on crm.lead or
// sale.order (the only close match is client_order_ref, mapped to poNumber
// above). Do not invent a value for those two dates — leave them null.
interface SoAggregate {
  amountUntaxed: number;
  amountTax: number;
  poNumber: string | null;
  modelNames: string[];
}

const EMPTY_SO_AGG: SoAggregate = { amountUntaxed: 0, amountTax: 0, poNumber: null, modelNames: [] };

// Batched for a set of already-fetched leads (each must include order_ids from
// LEAD_FIELDS). Reused by both the list and single-order fetch so detail pages
// and list pages never disagree on these fields. No new authorization surface:
// every sale.order/sale.order.line id read here is reached only through
// order_ids on a lead that already passed authzDomain()/the id-match domain.
async function fetchSoAggregates(leads: Record<string, unknown>[]): Promise<Map<number, SoAggregate>> {
  const result = new Map<number, SoAggregate>();

  const leadToSo: Record<number, number[]> = {};
  const allSoIds: number[] = [];
  for (const l of leads) {
    const ids = (l.order_ids as number[]) || [];
    leadToSo[l.id as number] = ids;
    allSoIds.push(...ids);
  }
  if (!allSoIds.length) return result;

  const sos = await executeKw('sale.order', 'read', [allSoIds], { fields: SO_FIELDS }) as Record<string, unknown>[];
  const soMap = new Map(sos.map(so => [so.id as number, so]));

  const allLineIds = sos.flatMap(so => (so.order_line as number[]) || []);
  const lineProductMap = new Map<number, string>();
  if (allLineIds.length) {
    const lines = await executeKw('sale.order.line', 'read', [allLineIds], { fields: ['id', 'product_id'] }) as Record<string, unknown>[];
    for (const line of lines) {
      const p = line.product_id as OdooTuple;
      if (p) lineProductMap.set(line.id as number, p[1]);
    }
  }

  for (const [leadIdStr, soIds] of Object.entries(leadToSo)) {
    const leadSos = soIds.map(id => soMap.get(id)).filter((s): s is Record<string, unknown> => !!s);
    if (!leadSos.length) continue;
    const primary = leadSos[leadSos.length - 1];
    const modelNames = Array.from(new Set(
      leadSos.flatMap(so => ((so.order_line as number[]) || [])
        .map(lineId => lineProductMap.get(lineId))
        .filter((n): n is string => !!n))
    ));
    result.set(Number(leadIdStr), {
      amountUntaxed: leadSos.reduce((sum, so) => sum + ((so.amount_untaxed as number) || 0), 0),
      amountTax: leadSos.reduce((sum, so) => sum + ((so.amount_tax as number) || 0), 0),
      poNumber: (primary.client_order_ref as string) || null,
      modelNames,
    });
  }
  return result;
}

function buildLead(lead: Record<string, unknown>, soAgg: SoAggregate = EMPTY_SO_AGG): Record<string, unknown> {
  const stageVal     = lead.stage_id      as OdooTuple;
  const dsVal        = lead.deal_status_id as OdooTuple;
  const partnerVal   = lead.partner_id    as OdooTuple;
  const ptVal        = lead.payment_term_id as OdooTuple;
  const userVal      = lead.user_id       as OdooTuple;

  const stageId    = stageVal ? stageVal[0] : 0;
  const stageLabel = stageVal ? stageVal[1] : '';
  const dsName     = dsVal    ? dsVal[1]    : null;

  let portalStage = DEAL_STATUS_MAP[dsName as string] ?? 'new';
  if (stageId === COLLECTED_STAGE_ID) portalStage = 'deal_closed';

  const deadlineStr = parseDate(lead.date_deadline);

  return {
    id:           lead.id,
    order_no:     lead.name || `CRM-${lead.id}`,
    customer:     partnerVal ? partnerVal[1] : null,
    location:     lead.x_studio_machine_installed_at || lead.city || null,
    model_names:  soAgg.modelNames,
    order_date:   parseDate(lead.create_date),
    last_updated: parseDate(lead.write_date),
    amount_total: lead.expected_revenue || 0,
    amount_untaxed: soAgg.amountUntaxed,
    amount_tax:   soAgg.amountTax,
    currency:     'INR',
    payment_terms: ptVal ? ptVal[1] : null,
    order_status:  stageLabel,
    delivery_status: DELIVERY_MAP[dsName as string] ?? 'No Delivery',
    invoice_status:  INVOICE_MAP[stageId] ?? 'Nothing to Invoice',
    portal_stage:       portalStage,
    portal_stage_label: STAGE_LABELS[portalStage] ?? dsName ?? 'New',
    payment_status:  stageId === COLLECTED_STAGE_ID ? 'collected' : 'pending',
    payment_overdue: isOverdue(deadlineStr, stageId),
    payment_due_date: deadlineStr,
    days_to_payment:  daysTo(deadlineStr),
    installation_status:    'not_started',
    vendor_portal_status:   'not_uploaded',
    confirmation_mail_sent: false,
    portal_notes: '',
    po_number:        soAgg.poNumber,
    // No field for either date exists on crm.lead or sale.order in production
    // Odoo (verified live via fields_get) — left null rather than invented.
    po_received_date: null,
    pi_issued_date:   null,
    md_approval_status: 'pending',
    crm_stage:    stageLabel,
    deal_status:  dsName ?? '',
    salesperson:  userVal ? userVal[1] : null,
    expected_closing: deadlineStr,
  };
}

// ──── Public API ──────────────────────────────────────────────────────────────

export async function fetchCultFitOrders(authz: Authz): Promise<{ orders: unknown[]; count: number }> {
  const domain = authzDomain(authz);

  const leads = await executeKw('crm.lead', 'search_read', [domain], {
    fields: LEAD_FIELDS, order: 'id desc', limit: 200,
  }) as Record<string, unknown>[];

  const soAggMap = await fetchSoAggregates(leads);
  const orders = leads.map(l => buildLead(l, soAggMap.get(l.id as number)));
  return { orders, count: orders.length };
}

export async function fetchCultFitOrderById(orderId: number, authz: Authz): Promise<Record<string, unknown> | null> {
  // CultFit domain is always ANDed in here too — previously this function had
  // NO domain restriction at all beyond the id match, so any authenticated
  // user (customer or admin) could read any crm.lead in the whole Odoo
  // instance by guessing an id. Never regress this.
  const domain: unknown[] = [['id', '=', orderId], ...authzDomain(authz)];

  const leads = await executeKw('crm.lead', 'search_read', [domain], {
    fields: LEAD_FIELDS, limit: 1,
  }) as Record<string, unknown>[];
  if (!leads.length) return null;

  const soAggMap = await fetchSoAggregates(leads);
  return buildLead(leads[0], soAggMap.get(leads[0].id as number));
}

const REVERSE_DS = Object.fromEntries(Object.entries(DEAL_STATUS_MAP).map(([k, v]) => [v, k]));

export class LeadNotFoundError extends Error {
  constructor() {
    super('Order not found.');
    this.name = 'LeadNotFoundError';
  }
}

export class InvalidStageError extends Error {
  constructor(stageKey: string) {
    super(`Unknown stage: '${stageKey}'.`);
    this.name = 'InvalidStageError';
  }
}

export interface OdooAttachmentMeta {
  id: number;
  name: string;
  type: 'quotation' | 'invoice';
  label: string;
  size: number;
  date: string | null;
  mimetype: string;
}

// Resolves the sale.order and account.move ids a lead is allowed to expose
// attachments for — scoped by the same authz domain as everything else, so
// a customer (or admin, via a stale/wrong id) can never reach a lead outside
// their CultFit scope through the attachments endpoints either.
async function authorizedOrderInvoiceIds(leadId: number, authz: Authz): Promise<{ soIds: number[]; invIds: number[] }> {
  const domain = [['id', '=', leadId], ...authzDomain(authz)];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['order_ids'] }) as Record<string, unknown>[];
  if (!leads.length) throw new LeadNotFoundError();

  const soIds = (leads[0].order_ids as number[]) || [];
  if (!soIds.length) return { soIds: [], invIds: [] };

  const sos = await executeKw('sale.order', 'read', [soIds], { fields: ['invoice_ids'] }) as Record<string, unknown>[];
  const invIds = sos.flatMap(s => (s.invoice_ids as number[]) || []);
  return { soIds, invIds };
}

export async function fetchOrderAttachments(leadId: number, authz: Authz): Promise<OdooAttachmentMeta[]> {
  const { soIds, invIds } = await authorizedOrderInvoiceIds(leadId, authz);
  const result: OdooAttachmentMeta[] = [];

  if (soIds.length) {
    const sos = await executeKw('sale.order', 'read', [soIds], { fields: ['id', 'name'] }) as Record<string, unknown>[];
    const atts = await executeKw('ir.attachment', 'search_read', [[
      ['res_model', '=', 'sale.order'], ['res_id', 'in', soIds], ['mimetype', '=', 'application/pdf'],
    ]], { fields: ['id', 'name', 'file_size', 'create_date', 'res_id'] }) as Record<string, unknown>[];
    for (const a of atts) {
      const so = sos.find(s => s.id === a.res_id);
      result.push({
        id: a.id as number, name: a.name as string, type: 'quotation',
        label: `Quotation – ${so?.name ?? ''}`, size: (a.file_size as number) ?? 0,
        date: a.create_date ? String(a.create_date).slice(0, 10) : null, mimetype: 'application/pdf',
      });
    }
  }

  if (invIds.length) {
    const invoices = await executeKw('account.move', 'read', [invIds], { fields: ['id', 'name'] }) as Record<string, unknown>[];
    const atts = await executeKw('ir.attachment', 'search_read', [[
      ['res_model', '=', 'account.move'], ['res_id', 'in', invIds], ['mimetype', '=', 'application/pdf'],
    ]], { fields: ['id', 'name', 'file_size', 'create_date', 'res_id'] }) as Record<string, unknown>[];
    for (const a of atts) {
      const inv = invoices.find(i => i.id === a.res_id);
      result.push({
        id: a.id as number, name: a.name as string, type: 'invoice',
        label: `Invoice – ${inv?.name ?? ''}`, size: (a.file_size as number) ?? 0,
        date: a.create_date ? String(a.create_date).slice(0, 10) : null, mimetype: 'application/pdf',
      });
    }
  }

  return result;
}

export async function fetchAttachmentData(
  leadId: number, attachmentId: number, authz: Authz,
): Promise<{ data: Buffer; mimetype: string; filename: string }> {
  const { soIds, invIds } = await authorizedOrderInvoiceIds(leadId, authz);

  // Verify this specific attachment genuinely belongs to a sale order or
  // invoice reachable from THIS authorized lead before reading its bytes —
  // the reference implementation this was ported from read any attachment
  // id with no such check, which would let any authenticated user download
  // any PDF in the whole Odoo instance by guessing an id. Do not repeat that.
  let owned = false;
  if (soIds.length) {
    const count = await executeKw('ir.attachment', 'search_count', [[
      ['id', '=', attachmentId], ['res_model', '=', 'sale.order'], ['res_id', 'in', soIds],
    ]]) as number;
    owned = owned || count > 0;
  }
  if (!owned && invIds.length) {
    const count = await executeKw('ir.attachment', 'search_count', [[
      ['id', '=', attachmentId], ['res_model', '=', 'account.move'], ['res_id', 'in', invIds],
    ]]) as number;
    owned = owned || count > 0;
  }
  if (!owned) throw new LeadNotFoundError();

  const records = await executeKw('ir.attachment', 'read', [[attachmentId]], { fields: ['name', 'mimetype', 'datas'] }) as Record<string, unknown>[];
  if (!records.length || !records[0].datas) throw new LeadNotFoundError();
  const rec = records[0];
  return {
    data: Buffer.from(rec.datas as string, 'base64'),
    mimetype: (rec.mimetype as string) || 'application/pdf',
    filename: (rec.name as string) || 'document.pdf',
  };
}

// Every stage-write path calls this first. Even though only admins can reach
// these functions (checked by the API route), this portal is CultFit-scoped
// everywhere else — a write endpoint that will silently edit ANY crm.lead by
// id (no existence or domain check at all, as it did before this change) is
// a foot-gun even for a trusted staff caller. Refuses to write to a lead
// outside the CultFit/Curefit domain.
async function assertCultFitLead(orderId: number): Promise<void> {
  const count = await executeKw('crm.lead', 'search_count', [[['id', '=', orderId], ...cultfitDomain()]]) as number;
  if (!count) throw new LeadNotFoundError();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Lightweight audit trail: no database exists in this architecture, and none
// is worth adding just for this. Instead, post an internal chatter note on
// the crm.lead itself via Odoo's own mail.thread — reuses infrastructure
// InBody staff already see directly in Odoo, with zero new infra. Best
// effort: a failure here must never block or roll back the actual stage
// write, which is the operation that matters.
async function postStageAuditNote(
  orderId: number, oldLabel: string, newLabel: string, adminEmail: string, reason: string,
): Promise<void> {
  const body = [
    `Portal stage changed: <b>${escapeHtml(oldLabel)}</b> → <b>${escapeHtml(newLabel)}</b>`,
    `By: ${escapeHtml(adminEmail)}`,
    reason.trim() ? `Reason: ${escapeHtml(reason.trim())}` : null,
  ].filter(Boolean).join('<br/>');

  try {
    await executeKw('crm.lead', 'message_post', [[orderId]], {
      body,
      subtype_xmlid: 'mail.mt_note',
    });
  } catch (e) {
    console.error('[audit] failed to post stage-change note for lead', orderId, e instanceof Error ? e.message : e);
  }
}

async function applyStageKey(orderId: number, stageKey: string) {
  if (stageKey === 'deal_closed') {
    await executeKw('crm.lead', 'write', [[orderId], { stage_id: COLLECTED_STAGE_ID }]);
  } else if (stageKey === 'new') {
    await executeKw('crm.lead', 'write', [[orderId], { deal_status_id: false }]);
  } else {
    const statusName = REVERSE_DS[stageKey];
    if (!statusName) throw new Error(`No Odoo mapping for stage '${stageKey}'`);
    const statuses = await executeKw('deal.status', 'search_read', [[['name', '=', statusName]]], { fields: ['id'] }) as Record<string, unknown>[];
    if (!statuses.length) throw new Error(`deal.status '${statusName}' not found in Odoo`);
    await executeKw('crm.lead', 'write', [[orderId], { deal_status_id: statuses[0].id }]);
  }
}

export async function updateCultFitStage(
  orderId: number, action: 'next' | 'prev', adminEmail: string, reason = '',
): Promise<Record<string, unknown>> {
  await assertCultFitLead(orderId);
  const records = await executeKw('crm.lead', 'read', [[orderId]], { fields: ['deal_status_id'] }) as Record<string, unknown>[];
  if (!records.length) throw new LeadNotFoundError();

  const ds = records[0].deal_status_id as OdooTuple;
  const oldKey = DEAL_STATUS_MAP[ds ? ds[1] : ''] ?? 'new';
  let idx = STAGE_KEYS.indexOf(oldKey);
  if (idx === -1) idx = 0;

  const newIdx = action === 'next' ? Math.min(idx + 1, STAGE_KEYS.length - 1) : Math.max(idx - 1, 0);
  const newKey = STAGE_KEYS[newIdx];
  await applyStageKey(orderId, newKey);
  const oldLabel = STAGE_LABELS[oldKey] ?? oldKey;
  const newLabel = STAGE_LABELS[newKey] ?? newKey;
  await postStageAuditNote(orderId, oldLabel, newLabel, adminEmail, reason);
  return { order_id: orderId, new_stage: newKey, new_stage_label: newLabel };
}

export async function setCultFitStage(
  orderId: number, stageKey: string, adminEmail: string, reason = '',
): Promise<Record<string, unknown>> {
  if (!STAGE_LABELS[stageKey]) throw new InvalidStageError(stageKey);
  await assertCultFitLead(orderId);

  const records = await executeKw('crm.lead', 'read', [[orderId]], { fields: ['deal_status_id'] }) as Record<string, unknown>[];
  const ds = records[0]?.deal_status_id as OdooTuple;
  const oldKey = DEAL_STATUS_MAP[ds ? ds[1] : ''] ?? 'new';
  const oldLabel = STAGE_LABELS[oldKey] ?? oldKey;

  await applyStageKey(orderId, stageKey);
  await postStageAuditNote(orderId, oldLabel, STAGE_LABELS[stageKey], adminEmail, reason);
  return { order_id: orderId, new_stage: stageKey, new_stage_label: STAGE_LABELS[stageKey] };
}

// ──── New Order Request (Phase 1) ──────────────────────────────────────────────
// A customer-submitted request creates ONLY a crm.lead Opportunity — never a
// res.partner, sale.order, or PI. Everything specific to the request (product,
// quantity, COCO/FOFO, delivery/contact info) has nowhere else to live in
// today's schema, so it's kept as a machine-readable JSON blob inside the
// lead's own `description` (html) field, base64-wrapped inside an HTML
// comment so it can never break the comment syntax regardless of what a
// customer types, alongside a human-readable rendering so InBody staff see
// it normally in Odoo. No new Odoo field or model is created.

const PORTAL_REQUEST_MARKER = 'PORTAL_ORDER_REQUEST';

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
  // Resolved server-side from the existing CultFit contact structure — see
  // resolveCultFitParty() below and CULTFIT_PORTAL_MASTER_CONTEXT.md. Always
  // present on records created from this point forward.
  cultfitCompany: string | null;
  contact: ResolvedCultFitContact | null;
  // Added alongside the standard-defaults/region-detection feature — absent
  // (undefined) on every record created before this, decoded safely as such.
  // territoryName is only set when confidence is 'high' and a territory_id
  // was actually written to the lead; admin can still change territory_id
  // later via updateRequestTerritory() regardless of what's stored here,
  // this is a point-in-time record of what auto-detection found/did.
  regionDetection?: {
    matchedToken: string | null;
    city: string | null;
    state: string | null;
    territoryName: string | null;
    confidence: 'high' | 'unclear';
  };
  // Legacy — only ever present on records created before contact resolution
  // moved server-side (customer used to type these into the form directly).
  // Never written by new code; kept only so decodeRequestDetails and the UI
  // can still render old records without breaking.
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string | null;
  // Legacy — only present on records created before the New Request form
  // stopped collecting these (2026-08). Delivery/expected-delivery info now
  // comes from the customer's PO during Phase 3 review instead, so it's
  // never asked for twice. New records never set these; kept only so
  // decodeRequestDetails and the UI can still render old records safely.
  deliveryAddress?: string;
  preferredDeliveryDate?: string | null;
  // The customer's requested delivery date at request-creation time —
  // distinct from preferredDeliveryDate above (dead/legacy, unvalidated) and
  // from the PO's own expectedDeliveryDate/sale.order.commitment_date
  // (Phase 3, set later at PO-approval time from what the customer's actual
  // PO document says). Mandatory server-side for every request submitted
  // from 2026-08 onward (see validateRequestedDeliveryDate) — absent on
  // every record created before that; decode safely as undefined for those.
  requestedDeliveryDate?: string;
}

function encodeRequestDetails(details: PortalRequestDetails): string {
  return Buffer.from(JSON.stringify(details)).toString('base64');
}

function decodeRequestDetails(description: unknown): PortalRequestDetails | null {
  if (typeof description !== 'string') return null;
  const m = description.match(/<!--PORTAL_REQUEST_DATA:([A-Za-z0-9+/=]+)-->/);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as PortalRequestDetails;
  } catch {
    return null;
  }
}

function buildRequestDescriptionHtml(details: PortalRequestDetails): string {
  const includedLine = details.includedProducts.length
    ? details.includedProducts.map(p => `${escapeHtml(p.code)} ${escapeHtml(p.name)}`).join(', ')
    : '—';
  const c = details.contact;
  const contactLine = c
    ? [c.name, c.phone, c.email].filter(Boolean).map(v => escapeHtml(String(v))).join(' · ') || '—'
    : '—';
  const lines = [
    `<p><b>${PORTAL_REQUEST_MARKER}</b> — submitted via CultFit portal by ${escapeHtml(details.portalAccount)} on ${escapeHtml(details.submittedDate)}</p>`,
    details.cultfitCompany ? `<p><b>CultFit company:</b> ${escapeHtml(details.cultfitCompany)}</p>` : '',
    `<p><b>Location/Request name:</b> ${escapeHtml(details.requestName)}</p>`,
    `<p><b>COCO/FOFO:</b> ${escapeHtml(details.cocoFofo)}</p>`,
    `<p><b>Main product:</b> ${escapeHtml(details.mainProduct.code)} ${escapeHtml(details.mainProduct.name)} × ${details.quantity}</p>`,
    `<p><b>Included (free):</b> ${includedLine}</p>`,
    details.requestedDeliveryDate ? `<p><b>Requested delivery date:</b> ${escapeHtml(details.requestedDeliveryDate)}</p>` : '',
    details.deliveryAddress ? `<p><b>Delivery address:</b> ${escapeHtml(details.deliveryAddress)}</p>` : '',
    `<p><b>Contact (from existing Odoo record, source: ${escapeHtml(c?.source ?? 'none')}):</b> ${contactLine}</p>`,
    details.regionDetection
      ? `<p><b>Detected region:</b> ${details.regionDetection.territoryName
          ? `${escapeHtml(details.regionDetection.territoryName)} (from "${escapeHtml(details.regionDetection.matchedToken ?? '')}")`
          : 'Admin review required — could not confidently detect from the request name'}</p>`
      : '',
    details.preferredDeliveryDate ? `<p><b>Preferred delivery date:</b> ${escapeHtml(details.preferredDeliveryDate)}</p>` : '',
    details.notes ? `<p><b>Notes:</b> ${escapeHtml(details.notes)}</p>` : '',
    `<!--PORTAL_REQUEST_DATA:${encodeRequestDetails(details)}-->`,
  ];
  return lines.filter(Boolean).join('');
}

// Resolves the CultFit company + contact details to store on a new request —
// never customer-submitted (the contact-entry form fields were removed; the
// CultFit customer/contact already exists in Odoo, so we don't ask them to
// retype it — see CULTFIT_PORTAL_MASTER_CONTEXT.md). Priority, per the
// confirmed resolution rule:
//   1. A res.partner under the CultFit company whose email matches the
//      authenticated portal account exactly. None exists today — the portal
//      login (cultfit@curefit.com) is a shared account, not mapped to any
//      Odoo contact — verified live. Kept as priority 1 so this resolves
//      correctly the moment a future per-user account IS mapped.
//   2. The CultFit company's primary contact — res.partner type='contact'
//      (Odoo's own convention for "the" default contact on a company),
//      verified live to exist for partner 1822 with both phone and email.
//   3. The company record itself (partner_id = CULTFIT_PARTNER_ID) if it has
//      usable phone/email.
//   4. Fallback: only the portal account's own email — never invented, never
//      a blank field presented as real data.
async function resolveCultFitParty(
  authz: Authz, portalAccountEmail: string,
): Promise<{ companyName: string | null; contact: ResolvedCultFitContact }> {
  const partnerId = resolveCultFitPartnerId(authz);

  const company = await executeKw('res.partner', 'read', [[partnerId]], { fields: ['name', 'phone', 'email'] }) as
    { name: string; phone: string | false; email: string | false }[];
  const companyName = company[0]?.name ?? null;

  const mapped = await executeKw('res.partner', 'search_read', [
    [['email', '=', portalAccountEmail], ['id', 'child_of', partnerId]],
  ], { fields: ['name', 'phone', 'email'], limit: 1 }) as { name: string; phone: string | false; email: string | false }[];
  if (mapped.length) {
    return { companyName, contact: { name: mapped[0].name, phone: mapped[0].phone || null, email: mapped[0].email || null, source: 'portal-mapped' } };
  }

  const primary = await executeKw('res.partner', 'search_read', [
    [['parent_id', '=', partnerId], ['type', '=', 'contact']],
  ], { fields: ['name', 'phone', 'email'], limit: 1 }) as { name: string; phone: string | false; email: string | false }[];
  if (primary.length && (primary[0].phone || primary[0].email)) {
    return { companyName, contact: { name: primary[0].name, phone: primary[0].phone || null, email: primary[0].email || null, source: 'primary-contact' } };
  }

  if (company[0] && (company[0].phone || company[0].email)) {
    return { companyName, contact: { name: company[0].name, phone: company[0].phone || null, email: company[0].email || null, source: 'company' } };
  }

  return { companyName, contact: { name: null, phone: null, email: portalAccountEmail, source: 'portal-account-only' } };
}

// The single canonical CultFit commercial partner for new-request creation —
// reads the same CULTFIT_PARTNER_ID config every other CultFit access check
// uses (see cultfitDomain() above), never a separate lookup. If the
// authenticated customer's own scope is a specific single partner (the
// 'partner_ids' allowlist form — see auth-server.ts), that is used directly
// instead, since it is more specific than the shared default. The customer
// never supplies this value in any form.
function resolveCultFitPartnerId(authz: Authz): number {
  if (authz.role === 'customer' && authz.scope?.kind === 'partner_ids' && authz.scope.partnerIds.length === 1) {
    return authz.scope.partnerIds[0];
  }
  if (!Number.isInteger(CULTFIT_PARTNER_ID) || CULTFIT_PARTNER_ID <= 0) {
    throw new Error('CULTFIT_PARTNER_ID is not configured — refusing to create a portal request.');
  }
  return CULTFIT_PARTNER_ID;
}

let _newStageId: number | null = null;

// The CRM pipeline's actual entry stage (crm.stage), not the deal_status_id
// used elsewhere in this file for the order-fulfillment portal_stage. A
// freshly submitted request is a raw opportunity that hasn't entered the
// order-fulfillment flow yet. Resolved by lowest `sequence` rather than by
// name — the stage used to be literally named "New" (id 1), but InBody's
// Odoo team deleted/renumbered the whole pipeline in production
// (found 2026-08-12), which broke a hardcoded name lookup and silently took
// down new-request submission entirely. Sequence-based lookup self-heals if
// stages get relabeled again.
async function resolveNewStageId(): Promise<number> {
  if (_newStageId) return _newStageId;
  const stages = await executeKw('crm.stage', 'search_read', [[]], { fields: ['id'], order: 'sequence asc', limit: 1 }) as { id: number }[];
  if (!stages.length) throw new Error('Could not resolve the CRM pipeline entry stage in Odoo.');
  _newStageId = stages[0].id;
  return _newStageId;
}

let _fitnessIndustryId: number | null = null;

// crm.lead.industry_id is mandatory in this Odoo instance (a customization,
// not stock Odoo behavior) — discovered live via a real Odoo fault ("Missing
// required value for the field 'Industry'") when it wasn't set. Verified:
// 100% of existing CultFit leads (80/80) use the "Fitness" industry —
// resolved by name here, never hardcoded, same pattern as resolveNewStageId.
async function resolveFitnessIndustryId(): Promise<number> {
  if (_fitnessIndustryId) return _fitnessIndustryId;
  const industries = await executeKw('res.partner.industry', 'search_read', [[['name', '=', 'Fitness']]], { fields: ['id'], limit: 1 }) as { id: number }[];
  if (!industries.length) throw new Error("Could not resolve the 'Fitness' industry in Odoo.");
  _fitnessIndustryId = industries[0].id;
  return _fitnessIndustryId;
}

let _defaultSubIndustryId: number | null = null;

// crm.lead.sub_industry_id is ALSO mandatory in this instance (discovered
// live, same way as industry_id) — but unlike industry_id, there is no
// single dominant value: historically 81% of CultFit leads use "High Budget
// Fitness", 12% "Medium", 6% "Low" — a real budget-tier classification this
// portal has no input to determine per-request (it isn't one of the form
// fields). "High Budget Fitness" (the majority value) is used here as a
// placeholder default so the required field is satisfied, NOT because it's
// verified correct for any given request — flag this to InBody: either
// accept staff correcting it manually per request, or add a real form field
// for it in a later phase.
async function resolveDefaultSubIndustryId(): Promise<number> {
  if (_defaultSubIndustryId) return _defaultSubIndustryId;
  const subIndustries = await executeKw('sub.industry', 'search_read', [[['name', '=', 'High Budget Fitness']]], { fields: ['id'], limit: 1 }) as { id: number }[];
  if (!subIndustries.length) throw new Error("Could not resolve a default sub-industry in Odoo.");
  _defaultSubIndustryId = subIndustries[0].id;
  return _defaultSubIndustryId;
}

// ──── Standard CultFit Opportunity defaults ────────────────────────────────
// Every new CultFit Opportunity carries a fixed set of CRM classification
// values, confirmed live via a read-only field/record investigation (see
// CULTFIT_PORTAL_MASTER_CONTEXT.md). Same cached-by-name pattern as
// resolveFitnessIndustryId/resolveDefaultSubIndustryId above — resolved by
// name every time (never a hardcoded id), so a future rename doesn't
// silently drift. Each throws if its record can't be found: these values are
// as load-bearing to a correctly-classified Opportunity as industry/
// sub-industry, so a request whose defaults can't be resolved must fail
// loudly rather than create a lead with a missing/wrong classification.

let _keyAccountManagerId: number | null = null;
async function resolveKeyAccountManagerId(): Promise<number> {
  if (_keyAccountManagerId) return _keyAccountManagerId;
  const users = await executeKw('res.users', 'search_read', [[['name', '=', 'Nihal Pawar']]], { fields: ['id'], limit: 1 }) as { id: number }[];
  if (!users.length) throw new Error("Could not resolve the 'Nihal Pawar' Key Account Manager user in Odoo.");
  _keyAccountManagerId = users[0].id;
  return _keyAccountManagerId;
}

let _recurringSourceId: number | null = null;
async function resolveSourceId(): Promise<number> {
  if (_recurringSourceId) return _recurringSourceId;
  const sources = await executeKw('utm.source', 'search_read', [[['name', '=', 'Recurring']]], { fields: ['id'], limit: 1 }) as { id: number }[];
  if (!sources.length) throw new Error("Could not resolve the 'Recurring' Source in Odoo.");
  _recurringSourceId = sources[0].id;
  return _recurringSourceId;
}

let _franchiseSubLeadSourceId: number | null = null;
// Exact-match only — sub.lead.source id 39 is a typo'd duplicate ("Franhise")
// of the real "Franchise" record (id 40); an ilike/fuzzy match here could
// silently pick the wrong one.
async function resolveSubLeadSourceId(): Promise<number> {
  if (_franchiseSubLeadSourceId) return _franchiseSubLeadSourceId;
  const sources = await executeKw('sub.lead.source', 'search_read', [[['name', '=', 'Franchise']]], { fields: ['id'], limit: 1 }) as { id: number }[];
  if (!sources.length) throw new Error("Could not resolve the 'Franchise' Sub Lead Source in Odoo.");
  _franchiseSubLeadSourceId = sources[0].id;
  return _franchiseSubLeadSourceId;
}

let _privateOwnershipId: number | null = null;
async function resolveOwnershipId(): Promise<number> {
  if (_privateOwnershipId) return _privateOwnershipId;
  const records = await executeKw('res.ownership', 'search_read', [[['name', '=', 'Private']]], { fields: ['id'], limit: 1 }) as { id: number }[];
  if (!records.length) throw new Error("Could not resolve the 'Private' Ownership in Odoo.");
  _privateOwnershipId = records[0].id;
  return _privateOwnershipId;
}

let _directChannelId: number | null = null;
async function resolveChannelId(): Promise<number> {
  if (_directChannelId) return _directChannelId;
  const media = await executeKw('utm.medium', 'search_read', [[['name', '=', 'Direct']]], { fields: ['id'], limit: 1 }) as { id: number }[];
  if (!media.length) throw new Error("Could not resolve the 'Direct' Channel in Odoo.");
  _directChannelId = media[0].id;
  return _directChannelId;
}

// ──── Territory ("Region") resolution ──────────────────────────────────────
// There is no "Region" model in this Odoo instance — the real concept is
// crm.lead.territory_id (many2one -> res.territory), and its state_ids
// relation already encodes exactly which Indian states fall in which
// territory. Resolved dynamically (cached) rather than hardcoding territory
// ids, same reasoning as every other resolver in this file — and it means a
// future territory reconfiguration in Odoo is picked up automatically rather
// than silently drifting from a copy baked into this app. crm.lead.city/
// state_id are NOT usable here (verified live: constant "Chennai"/"Tamil
// Nadu" on every real CultFit lead, mirroring the CultFit partner's billing
// address) — see lib/region-resolver.ts for the free-text name parser this
// combines with.

interface TerritoryConfig {
  stateNameToTerritoryId: Map<string, number>; // lowercase state name -> territory id
  idToName: Map<number, string>;
}

let _territoryConfig: TerritoryConfig | null = null;

async function loadTerritoryConfig(): Promise<TerritoryConfig> {
  if (_territoryConfig) return _territoryConfig;

  const territories = await executeKw('res.territory', 'search_read', [[]], { fields: ['id', 'name', 'state_ids'] }) as
    { id: number; name: string; state_ids: number[] }[];

  const allStateIds = [...new Set(territories.flatMap(t => t.state_ids || []))];
  const states = allStateIds.length
    ? await executeKw('res.country.state', 'read', [allStateIds], { fields: ['id', 'name'] }) as { id: number; name: string }[]
    : [];
  const stateNameById = new Map(states.map(s => [s.id, s.name.toLowerCase()]));

  const stateNameToTerritoryId = new Map<string, number>();
  for (const t of territories) {
    for (const stateId of t.state_ids || []) {
      const name = stateNameById.get(stateId);
      if (name) stateNameToTerritoryId.set(name, t.id);
    }
  }

  _territoryConfig = { stateNameToTerritoryId, idToName: new Map(territories.map(t => [t.id, t.name])) };
  return _territoryConfig;
}

export interface TerritoryOption {
  id: number;
  name: string;
}

export async function fetchTerritoryList(): Promise<TerritoryOption[]> {
  const { idToName } = await loadTerritoryConfig();
  return [...idToName.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Returns null (never guesses) if the resolved state has no configured
// territory in Odoo today (e.g. Bihar — confirmed live to have no territory
// assignment at all) or if the request name didn't resolve to a known state.
async function resolveTerritoryIdForState(stateName: string): Promise<{ id: number; name: string } | null> {
  const { stateNameToTerritoryId, idToName } = await loadTerritoryConfig();
  const id = stateNameToTerritoryId.get(stateName.toLowerCase());
  if (!id) return null;
  return { id, name: idToName.get(id) ?? '' };
}

// Accessory/bundle-only products, verified live against every historical
// CultFit order line — never offered as a selectable "main product". Also
// excludes one deprecated SKU and one legacy duplicate 260S entry.
const EXCLUDED_PRODUCT_IDS = new Set([
  12044, // [IIPLPR002] HP 1008A — printer, bundle-only
  12313, // [O40208301] LB WEB_B_1Y — software, bundle-only
  12060, // [O40208002] Not Use_LB WEB Membership Fee(Franchise) — deprecated SKU
  11881, // [Z9ZZ04006] [X][Assy]Stand 120 — bundle-only
  12047, // [L9I100039] G_LookinBody120 InBT400 IB120 — bundle-only
  10837, // [E01903012] Adapter 3.4A_3rd — accessory, bundle-only
  12343, // [IIPLRS001] Result Sheet Set — accessory
  12277, // G_InBody 260S — legacy duplicate of 12019 (1 historical use, no code prefix)
]);

// Deliberately NOT reused by the admin product editor below: most of the ids
// above (printer, LB WEB, Stand 120, LookinBody, adapter, result sheet) are
// legitimate real accessory/bundle products admin must be able to add to a
// PI by hand — EXCLUDED_PRODUCT_IDS only hides them from the customer-facing
// *main product* picker (fetchCultFitProductCatalog), it was never meant to
// mean "never usable anywhere." Only the genuinely bad records are excluded
// from the admin editor: the legacy duplicate, and (via a live name filter,
// not a hardcoded copy) the "Not Use" family.
const ADMIN_EDITOR_EXCLUDED_PRODUCT_IDS = new Set([
  12277, // G_InBody 260S — legacy duplicate of 12019
]);

// mainProductId -> included free products. Verified against historical
// order lines (every InBody260S order includes the HP 1008A printer;
// every InBody120 order includes Stand 120 + LookinBody120 software).
// NF1500/270S have no verified bundle rule — deliberately left unmapped
// rather than guessed; they're still selectable as a main product, just
// with no automatic inclusions.
const BUNDLE_MAP: Record<number, PortalRequestProduct[]> = {
  12019: [ // G_InBody260S ENG
    { id: 12044, code: 'IIPLPR002', name: 'HP 1008A' },
    { id: 12313, code: 'O40208301', name: 'LB WEB_B_1Y' },
  ],
  12001: [ // G_InBody120 ENG
    { id: 11881, code: 'Z9ZZ04006', name: '[X][Assy]Stand 120' },
    { id: 12047, code: 'L9I100039', name: 'G_LookinBody120 InBT400 IB120' },
  ],
};

function parseProductLabel(displayName: string): { code: string; name: string } {
  const m = displayName.match(/^\[([^\]]+)]\s*(.*)$/);
  return m ? { code: m[1], name: m[2] } : { code: '', name: displayName };
}

export interface CultFitProductOption {
  id: number;
  code: string;
  name: string;
  hasBundle: boolean;
}

// Builds the product picker from products already used in CultFit/Curefit
// orders — never the full Odoo catalog (1,835 products). Deliberately
// queried live rather than hardcoded, so a genuinely new main model shows up
// automatically the first time InBody staff use it in a real order.
export async function fetchCultFitProductCatalog(): Promise<CultFitProductOption[]> {
  const leads = await executeKw('crm.lead', 'search_read', [cultfitDomain()], { fields: ['order_ids'] }) as { order_ids: number[] }[];
  const soIds = [...new Set(leads.flatMap(l => l.order_ids || []))];
  if (!soIds.length) return [];

  const sos = await executeKw('sale.order', 'read', [soIds], { fields: ['order_line'] }) as { order_line: number[] }[];
  const lineIds = [...new Set(sos.flatMap(s => s.order_line || []))];
  if (!lineIds.length) return [];

  const lines = await executeKw('sale.order.line', 'read', [lineIds], { fields: ['product_id'] }) as { product_id: OdooTuple }[];
  const seen = new Map<number, string>();
  for (const l of lines) {
    if (l.product_id && !EXCLUDED_PRODUCT_IDS.has(l.product_id[0])) {
      seen.set(l.product_id[0], l.product_id[1]);
    }
  }
  return [...seen.entries()]
    .map(([id, displayName]) => ({ id, ...parseProductLabel(displayName), hasBundle: !!BUNDLE_MAP[id] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class InvalidRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidRequestError'; }
}

export class DuplicateRequestError extends Error {
  constructor() {
    super('A similar request was already submitted recently. Check My Requests before submitting again.');
    this.name = 'DuplicateRequestError';
  }
}

const DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes — long enough to catch a double-click/retry, short enough not to block a genuinely repeated order later

function normalizeForCompare(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Guards against double-click/network-retry duplicate submissions, not
// against a customer intentionally placing the same order again later — the
// short time window is what keeps those two cases apart. Scoped to the same
// CultFit partner (never cross-customer), same marker, and an exact
// normalized match on the fields that define "the same request".
async function findRecentDuplicateRequest(
  partnerId: number, requestName: string, mainProductId: number, quantity: number,
): Promise<boolean> {
  const sinceIso = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
  const domain = [
    ['partner_id.commercial_partner_id', '=', partnerId],
    ['description', 'ilike', PORTAL_REQUEST_MARKER],
    ['create_date', '>=', sinceIso],
  ];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['description'] }) as Record<string, unknown>[];

  const normName = normalizeForCompare(requestName);
  return leads.some(l => {
    const details = decodeRequestDetails(l.description);
    if (!details) return false;
    return normalizeForCompare(details.requestName) === normName
      && details.mainProduct.id === mainProductId
      && details.quantity === quantity;
  });
}

export interface NewOrderRequestInput {
  requestName: unknown;
  cocoFofo: unknown;
  mainProductId: unknown;
  quantity: unknown;
  notes: unknown;
  requestedDeliveryDate: unknown;
}

const MAX_LEN = { requestName: 120, notes: 1000 };

function requiredText(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new InvalidRequestError(`${field} is required.`);
  const trimmed = v.trim();
  if (trimmed.length > max) throw new InvalidRequestError(`${field} must be ${max} characters or fewer.`);
  return trimmed;
}

// India-only business — a fixed IST offset (no DST in India) gives a single,
// server-consistent definition of "today" regardless of the Vercel region's
// own local clock or whatever timezone the customer's browser happens to be
// in. Never derived from client input.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MIN_DELIVERY_LEAD_DAYS = 10;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIstDateStr(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The only place a customer-supplied delivery date is trusted — re-validates
// the exact same +10-day rule the frontend date picker already enforces, so
// a forged/bypassed earlier date can never reach Odoo. ISO string comparison
// is valid here because YYYY-MM-DD is zero-padded (lexicographic order ==
// chronological order).
function validateRequestedDeliveryDate(v: unknown): string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) {
    throw new InvalidRequestError('Delivery Date is required and must be a valid date (YYYY-MM-DD).');
  }
  const [y, m, d] = v.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    throw new InvalidRequestError('Delivery Date is not a valid calendar date.');
  }
  const earliest = addDaysToDateStr(todayIstDateStr(), MIN_DELIVERY_LEAD_DAYS);
  if (v < earliest) {
    throw new InvalidRequestError(`Delivery Date must be on or after ${earliest} (at least ${MIN_DELIVERY_LEAD_DAYS} days from today).`);
  }
  return v;
}

// Every field here is re-validated from scratch — this function is the only
// place client input for a new request is trusted, and only for the fields
// listed in NewOrderRequestInput. partner/salesperson/stage/price are never
// read from `input` at all, let alone written from it.
export async function createPortalOrderRequest(
  input: NewOrderRequestInput,
  authz: Authz,
  portalAccountEmail: string,
): Promise<{ id: number; name: string }> {
  if (authz.role !== 'customer') throw new InvalidRequestError('Only a customer account can submit a request.');

  const requestName = requiredText(input.requestName, 'Request/location name', MAX_LEN.requestName);

  if (input.cocoFofo !== 'COCO' && input.cocoFofo !== 'FOFO') {
    throw new InvalidRequestError('COCO/FOFO must be COCO or FOFO.');
  }
  const cocoFofo = input.cocoFofo;

  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    throw new InvalidRequestError('Quantity must be a whole number between 1 and 999.');
  }

  let notes = '';
  if (typeof input.notes === 'string' && input.notes.trim()) {
    notes = input.notes.trim();
    if (notes.length > MAX_LEN.notes) throw new InvalidRequestError(`Notes must be ${MAX_LEN.notes} characters or fewer.`);
  }

  const requestedDeliveryDate = validateRequestedDeliveryDate(input.requestedDeliveryDate);

  // Never trust a client-supplied product id blindly — re-verify it against
  // the same live "already used by CultFit" catalog the picker itself came
  // from, so a tampered request can't reference an arbitrary Odoo product
  // or claim a bundle that doesn't apply to it.
  const catalog = await fetchCultFitProductCatalog();
  const mainProduct = catalog.find(p => p.id === Number(input.mainProductId));
  if (!mainProduct) throw new InvalidRequestError('Selected product is not a valid CultFit product.');
  const includedProducts = BUNDLE_MAP[mainProduct.id] ?? [];

  const partnerId = resolveCultFitPartnerId(authz);
  const [
    stageId, industryId, subIndustryId,
    keyAccountManagerId, sourceId, subLeadSourceId, ownershipId, channelId,
    { companyName, contact },
  ] = await Promise.all([
    resolveNewStageId(), resolveFitnessIndustryId(), resolveDefaultSubIndustryId(),
    resolveKeyAccountManagerId(), resolveSourceId(), resolveSubLeadSourceId(), resolveOwnershipId(), resolveChannelId(),
    resolveCultFitParty(authz, portalAccountEmail),
  ]);

  // Region ("Territory") is the one default that's allowed to come back
  // empty — an unclear/ambiguous location must never block submission, it
  // just leaves territory_id unset for admin to review (see
  // lib/region-resolver.ts and resolveTerritoryIdForState above).
  const regionMatch = resolveRegionFromRequestName(requestName);
  const territory = regionMatch.confidence === 'high' && regionMatch.state
    ? await resolveTerritoryIdForState(regionMatch.state)
    : null;

  if (await findRecentDuplicateRequest(partnerId, requestName, mainProduct.id, quantity)) {
    throw new DuplicateRequestError();
  }

  const details: PortalRequestDetails = {
    requestName,
    cocoFofo,
    mainProduct: { id: mainProduct.id, code: mainProduct.code, name: mainProduct.name },
    quantity,
    includedProducts,
    notes,
    requestedDeliveryDate,
    portalAccount: portalAccountEmail,
    submittedDate: new Date().toISOString().slice(0, 10),
    cultfitCompany: companyName,
    contact,
    regionDetection: {
      matchedToken: regionMatch.matchedToken,
      city: regionMatch.city,
      state: regionMatch.state,
      territoryName: territory?.name ?? null,
      confidence: territory ? 'high' : 'unclear',
    },
  };

  const leadId = await executeKw('crm.lead', 'create', [{
    name: requestName,
    type: 'opportunity',
    partner_id: partnerId,
    stage_id: stageId,
    industry_id: industryId,
    sub_industry_id: subIndustryId,
    key_account_manager: keyAccountManagerId,
    source_id: sourceId,
    sub_lead_source_id: subLeadSourceId,
    ownership_id: ownershipId,
    medium_id: channelId,
    account_type: 'franchise',
    territory_id: territory?.id ?? false,
    // Explicit false, not merely omitted — discovered live that Odoo's own
    // team/onchange defaults silently auto-assign a salesperson on create if
    // this key is left out entirely, which violates "leave salesperson
    // unassigned for admin to set manually".
    user_id: false,
    description: buildRequestDescriptionHtml(details),
  }]) as number;

  try {
    await executeKw('crm.lead', 'message_post', [[leadId]], {
      body: `<p><b>${PORTAL_REQUEST_MARKER}</b>: new order request submitted via the CultFit customer portal by ${escapeHtml(portalAccountEmail)}.</p>`,
      subtype_xmlid: 'mail.mt_note',
    });
  } catch (e) {
    console.error('[portal-request] failed to post confirmation note for lead', leadId, e instanceof Error ? e.message : e);
  }

  return { id: leadId, name: requestName };
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

const PORTAL_REQUEST_FIELDS = [
  'id', 'name', 'description', 'deal_status_id', 'stage_id', 'user_id', 'create_date', 'write_date',
];

function buildRequestSummary(lead: Record<string, unknown>): PortalRequestSummary {
  // Reuse the exact same stage-derivation logic as the existing order
  // pipeline (buildLead) — a portal request is still just a crm.lead, so its
  // status must never be computed a second, independent way.
  const built = buildLead(lead);
  const userVal = lead.user_id as OdooTuple;
  const portalStage = built.portal_stage as string;
  return {
    id: lead.id as number,
    name: (lead.name as string) || `CRM-${lead.id}`,
    details: decodeRequestDetails(lead.description),
    portal_stage: portalStage,
    portal_stage_label: REQUEST_STAGE_LABELS[portalStage] ?? (built.portal_stage_label as string),
    salesperson: userVal ? userVal[1] : null,
    salespersonPhone: null, // filled in by the batched lookup below — never a fake/blank value shown as real
    created_date: parseDate(lead.create_date),
    last_updated: parseDate(lead.write_date),
  };
}

// Batched (one query for however many distinct salespeople appear across
// the whole list) rather than one res.users read per request. Prefers
// mobile_phone over phone since Call/WhatsApp buttons work best with a
// mobile number — falls back to phone, and to null (never a fake number)
// if this Odoo user genuinely has neither set.
async function fetchSalespersonPhones(userIds: number[]): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  if (!userIds.length) return result;
  const users = await executeKw('res.users', 'read', [userIds], { fields: ['id', 'phone', 'mobile_phone'] }) as
    { id: number; phone: string | false; mobile_phone: string | false }[];
  for (const u of users) result.set(u.id, (u.mobile_phone || u.phone) || null);
  return result;
}

function distinctUserIds(leads: Record<string, unknown>[]): number[] {
  return [...new Set(leads
    .map(l => (l.user_id as OdooTuple) ? (l.user_id as [number, string])[0] : null)
    .filter((id): id is number => id != null))];
}

// Only leads carrying the portal marker are ever returned here — this is
// deliberately narrower than fetchCultFitOrders, which shows the entire
// CultFit deal history. "My Requests" must show only what the customer
// themselves submitted through this flow.
export async function fetchPortalOrderRequests(authz: Authz): Promise<PortalRequestSummary[]> {
  const domain = [...authzDomain(authz), ['description', 'ilike', PORTAL_REQUEST_MARKER]];
  const leads = await executeKw('crm.lead', 'search_read', [domain], {
    fields: PORTAL_REQUEST_FIELDS, order: 'id desc', limit: 200,
  }) as Record<string, unknown>[];
  const phoneMap = await fetchSalespersonPhones(distinctUserIds(leads));
  return leads.map(l => {
    const summary = buildRequestSummary(l);
    const userVal = l.user_id as OdooTuple;
    return { ...summary, salespersonPhone: userVal ? phoneMap.get(userVal[0]) ?? null : null };
  });
}

function stripHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface PortalRequestTimelineEntry {
  date: string | null;
  author: string;
  body: string;
}

export interface PortalRequestDetail extends PortalRequestSummary {
  timeline: PortalRequestTimelineEntry[];
}

export async function fetchPortalOrderRequestById(id: number, authz: Authz): Promise<PortalRequestDetail | null> {
  const domain = [['id', '=', id], ...authzDomain(authz), ['description', 'ilike', PORTAL_REQUEST_MARKER]];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: PORTAL_REQUEST_FIELDS, limit: 1 }) as Record<string, unknown>[];
  if (!leads.length) return null;
  const summary = buildRequestSummary(leads[0]);
  const userVal = leads[0].user_id as OdooTuple;
  if (userVal) {
    const phoneMap = await fetchSalespersonPhones([userVal[0]]);
    summary.salespersonPhone = phoneMap.get(userVal[0]) ?? null;
  }

  // Chatter is presentation-only here (never re-parsed for structured data —
  // that always comes from the description blob above) — a failure to load
  // it must never break the rest of the request detail page.
  let timeline: PortalRequestTimelineEntry[] = [];
  try {
    const messages = await executeKw('mail.message', 'search_read', [[
      ['res_id', '=', id], ['model', '=', 'crm.lead'],
    ]], { fields: ['date', 'author_id', 'body'], order: 'date desc', limit: 30 }) as Record<string, unknown>[];
    timeline = messages
      .map(m => ({
        date: m.date ? String(m.date) : null,
        author: (m.author_id as OdooTuple) ? (m.author_id as [number, string])[1] : 'Odoo',
        body: stripHtml(String(m.body ?? '')),
      }))
      .filter(m => m.body);
  } catch (e) {
    console.error('[portal-request] failed to load chatter for lead', id, e instanceof Error ? e.message : e);
  }

  return { ...summary, timeline };
}

// ──── PI Workflow (Phase 2) ─────────────────────────────────────────────────
// Admin assigns a salesperson, creates a draft sale.order from the stored
// request details, edits price/validity/lines, then publishes it. Publishing
// now fetches Odoo's own native Quotation PDF (see fetchNativeOdooPdf below)
// via Odoo's public customer-portal controller — calling
// ir.actions.report._render_qweb_pdf over XML-RPC is still refused by Odoo
// itself ("Private methods ... cannot be called remotely"), and the raw
// /report/pdf/ endpoint still needs a backend session login this portal's
// API account doesn't have, but the /my/orders/<id> portal route validates
// via a per-order access_token instead and works with no login (verified
// live). The old self-rendered PDFKit look-alike (lib/pi-pdf.ts) is no
// longer used for new publishes — kept in the repo, unused, only so old
// stored PI snapshots (already-frozen ir.attachment bytes, unaffected by
// this change either way) have no dependency on it disappearing.
// No new Odoo field/model exists for PI status or versioning — same
// zero-new-infrastructure approach as Phase 1: a structured JSON blob
// embedded in a chatter note on the Opportunity (crm.lead), one marker per
// publish/response, decoded back out rather than trusted from live
// sale.order state (so an earlier published version's numbers stay frozen
// even if the underlying quotation is later revised).

export class PIWorkflowError extends Error {
  constructor(message: string) { super(message); this.name = 'PIWorkflowError'; }
}

export interface EligibleSalesperson {
  id: number;
  name: string;
}

const SALES_GROUP_FULL_NAMES = [
  'Sales / User: Own Documents Only',
  'Sales / User: All Documents',
  'Sales / Administrator',
];

// Resolved by name on every call (same "verified live, never frozen"
// philosophy as resolveNewStageId/fetchCultFitProductCatalog) rather than
// hardcoded group ids — a renamed/reconfigured group should never silently
// go stale the way the CultFit partner name once did. Union of all three
// Sales access groups, since a salesperson could plausibly hold any of them.
// Historical CultFit leads' own salespeople were checked live and found to
// no longer be members of any active Sales group (past staff, presumably) —
// so the eligible list is today's active roster, not frozen history.
export async function fetchEligibleSalespeople(): Promise<EligibleSalesperson[]> {
  const groups = await executeKw('res.groups', 'search_read', [[['full_name', 'in', SALES_GROUP_FULL_NAMES]]], { fields: ['user_ids'] }) as { user_ids: number[] }[];
  const userIds = [...new Set(groups.flatMap(g => g.user_ids || []))];
  if (!userIds.length) return [];
  const users = await executeKw('res.users', 'search_read', [[['id', 'in', userIds], ['active', '=', true]]], { fields: ['id', 'name'] }) as EligibleSalesperson[];
  return users.sort((a, b) => a.name.localeCompare(b.name));
}

export async function assignSalesperson(
  leadId: number, salespersonId: number, authz: Authz, adminEmail: string,
): Promise<EligibleSalesperson> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can assign a salesperson.');
  await assertCultFitLead(leadId);

  const eligible = await fetchEligibleSalespeople();
  const match = eligible.find(s => s.id === Number(salespersonId));
  if (!match) throw new PIWorkflowError('Selected salesperson is not a valid InBody sales user.');

  await executeKw('crm.lead', 'write', [[leadId], { user_id: match.id }]);
  try {
    await executeKw('crm.lead', 'message_post', [[leadId]], {
      body: `<p><b>PORTAL_SALESPERSON_ASSIGNED</b>: ${escapeHtml(match.name)} assigned by ${escapeHtml(adminEmail)}.</p>`,
      subtype_xmlid: 'mail.mt_note',
    });
  } catch (e) {
    console.error('[pi] failed to post salesperson-assigned note for lead', leadId, e instanceof Error ? e.message : e);
  }
  return match;
}

// Lets admin review/override the auto-detected Territory at any time — never
// blocks PI creation/publish (territory_id is not Odoo-required). The
// supplied id is always re-verified against the live res.territory list
// before writing, same discipline as assignSalesperson() re-verifying
// against fetchEligibleSalespeople() — never trust a client-supplied id.
export async function updateRequestTerritory(
  leadId: number, territoryId: number, authz: Authz, adminEmail: string,
): Promise<TerritoryOption> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can change the Territory.');
  await assertCultFitLead(leadId);

  const territories = await fetchTerritoryList();
  const match = territories.find(t => t.id === Number(territoryId));
  if (!match) throw new PIWorkflowError('Selected Territory is not a valid Odoo record.');

  await executeKw('crm.lead', 'write', [[leadId], { territory_id: match.id }]);
  try {
    await executeKw('crm.lead', 'message_post', [[leadId]], {
      body: `<p><b>PORTAL_TERRITORY_UPDATED</b>: Territory set to ${escapeHtml(match.name)} by ${escapeHtml(adminEmail)}.</p>`,
      subtype_xmlid: 'mail.mt_note',
    });
  } catch (e) {
    console.error('[pi] failed to post territory-updated note for lead', leadId, e instanceof Error ? e.message : e);
  }
  return match;
}

export type PIStatus = 'not_created' | 'draft' | 'awaiting_confirmation' | 'confirmed' | 'correction_requested';

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

const SO_DRAFT_FIELDS = ['id', 'name', 'state', 'validity_date', 'order_line', 'amount_untaxed', 'amount_tax', 'amount_total'];
// disc_calculation/fixed_amt are custom fields from the `inbody` Odoo module
// (not stock Odoo, not Studio — confirmed live via ir.model.fields) that sit
// alongside stock Odoo's discount(%) field: disc_calculation picks which of
// {discount, fixed_amt} actually drives price_subtotal. Odoo computes
// price_subtotal/price_tax/price_total itself from
// price_unit/discount/disc_calculation/fixed_amt/product_uom_qty/tax_ids on
// write, so reading them back after any write is all that's needed; no
// pricing/tax math is reimplemented here.
const SOL_DRAFT_FIELDS = ['id', 'product_id', 'product_uom_qty', 'product_uom_id', 'price_unit', 'discount', 'disc_calculation', 'fixed_amt', 'tax_ids', 'price_subtotal', 'price_tax', 'price_total'];

// The one deterministic way this app resolves "which line is the main
// InBody product" — the exact product id the customer selected when
// creating the request (crm.lead's own stored PortalRequestDetails,
// decoded fresh here, not cached). Never inferred from price, discount, or
// line order: now that included/bundle lines carry their own real Unit
// Price too (see buildAndCreateSO), none of those signals distinguish
// "main" from "included" any more.
async function resolveMainProductId(leadId: number): Promise<number | null> {
  const leads = await executeKw('crm.lead', 'read', [[leadId]], { fields: ['description'] }) as { description: unknown }[];
  return decodeRequestDetails(leads[0]?.description)?.mainProduct.id ?? null;
}

async function buildDraftSOInfo(so: Record<string, unknown>, leadId: number): Promise<PIDraftInfo> {
  const lineIds = (so.order_line as number[]) || [];
  const lines = lineIds.length
    ? await executeKw('sale.order.line', 'read', [lineIds], { fields: SOL_DRAFT_FIELDS }) as Record<string, unknown>[]
    : [];

  const taxIds = [...new Set(lines.flatMap(l => (l.tax_ids as number[]) || []))];
  const taxes = taxIds.length
    ? await executeKw('account.tax', 'read', [taxIds], { fields: ['id', 'name'] }) as { id: number; name: string }[]
    : [];
  const taxMap = new Map(taxes.map(t => [t.id, t.name]));

  const builtLines: PIDraftLine[] = lines.map(l => {
    const p = l.product_id as OdooTuple;
    const { code, name } = p ? parseProductLabel(p[1]) : { code: '', name: '' };
    const taxLabel = ((l.tax_ids as number[]) || []).map(id => taxMap.get(id)).filter(Boolean).join(', ') || 'No Tax';
    const unitVal = l.product_uom_id as OdooTuple;
    const discCalc = l.disc_calculation === 'fixed' ? 'fixed' : 'percentage';
    return {
      id: l.id as number, productId: p ? p[0] : 0, code, name,
      quantity: (l.product_uom_qty as number) || 0, unit: unitVal ? unitVal[1] : '',
      unitPrice: (l.price_unit as number) || 0,
      discCalculation: discCalc as 'percentage' | 'fixed', fixedAmount: (l.fixed_amt as number) || 0,
      discount: (l.discount as number) || 0, taxLabel,
      untaxedTotal: (l.price_subtotal as number) || 0, taxTotal: (l.price_tax as number) || 0,
      lineTotal: (l.price_total as number) || 0,
    };
  });
  const mainProductId = await resolveMainProductId(leadId);
  const mainLine = (mainProductId != null ? builtLines.find(l => l.productId === mainProductId) : undefined) ?? builtLines[0] ?? null;

  return {
    id: so.id as number, name: so.name as string, state: so.state as string,
    validityDate: parseDate(so.validity_date),
    mainProductUnitPrice: mainLine ? mainLine.unitPrice : 0,
    lines: builtLines,
    untaxedAmount: (so.amount_untaxed as number) || 0,
    taxAmount: (so.amount_tax as number) || 0,
    totalAmount: (so.amount_total as number) || 0,
  };
}

// The single, currently-active (non-cancelled) sale.order linked to a
// request lead, if any — "active" meaning not explicitly superseded via
// createPIRevision. A published PI is still an Odoo 'draft'/'sent'
// quotation (Phase 1/2 deliberately never confirm it), so this is also what
// the admin PI editor and Publish PI operate on.
async function findActiveDraftSO(leadId: number): Promise<PIDraftInfo | null> {
  const leads = await executeKw('crm.lead', 'read', [[leadId]], { fields: ['order_ids'] }) as { order_ids: number[] }[];
  const soIds = leads[0]?.order_ids || [];
  if (!soIds.length) return null;

  const sos = await executeKw('sale.order', 'read', [soIds], { fields: SO_DRAFT_FIELDS }) as Record<string, unknown>[];
  const active = sos.filter(s => s.state !== 'cancel').sort((a, b) => (b.id as number) - (a.id as number))[0];
  return active ? buildDraftSOInfo(active, leadId) : null;
}

// Verifies a specific sale.order id genuinely belongs to this lead (via
// crm.lead.order_ids) before any read/write touches it — same "never trust a
// stored/supplied id blindly" pattern as fetchAttachmentData's ownership
// check. Used by update/publish so an admin can never act on an SO from a
// different request even by guessing/tampering with an id.
async function verifySOBelongsToLead(leadId: number, soId: number): Promise<PIDraftInfo> {
  const leads = await executeKw('crm.lead', 'read', [[leadId]], { fields: ['order_ids'] }) as { order_ids: number[] }[];
  if (!(leads[0]?.order_ids || []).includes(soId)) throw new LeadNotFoundError();
  const sos = await executeKw('sale.order', 'read', [[soId]], { fields: SO_DRAFT_FIELDS }) as Record<string, unknown>[];
  if (!sos.length) throw new LeadNotFoundError();
  return buildDraftSOInfo(sos[0], leadId);
}

const COMPANY_ID = 1; // "InBody India Private Limited" — verified live: every historical CultFit sale.order uses this company (this Odoo instance has a second, unrelated company, id 2)
const DEFAULT_VALIDITY_DAYS = 30; // matches the ~30-day windows seen on real historical CultFit quotations
const MAX_PRICE = 100_000_000; // sanity ceiling against a fat-fingered price, not a business rule

// Sanity-checks a price read from Odoo's own product.list_price (never
// admin/client input — see the "no manual price editing" rule this whole
// file follows now). Guards against a product with no Sales Price
// configured in Odoo, not against a fat-fingered admin entry.
function assertOdooPriceIsUsable(v: unknown, productLabel: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PRICE) {
    throw new PIWorkflowError(`${productLabel} has no valid Sales Price set in Odoo — set one in Odoo before creating a PI.`);
  }
  return n;
}

// ──── Product-based Terms & Conditions (CultFit quotations) ───────────────
// Odoo's native quotation report renders sale.order.note (HTML) directly —
// both companies here have terms_type='plain' (confirmed live), which is
// what makes Odoo inline the note's HTML into the PDF rather than linking
// out to a web page. So writing the right text into `note` is the entire
// mechanism: no custom PDF, no new Odoo model/field.
//
// A pre-existing base.automation ("Terms and Conditions(quotation)", id 92,
// confirmed live) writes a generic, non-product-specific hardcoded block
// into `note` on sale.order creation, but only for 4 specific CS-team users
// and only if `note` doesn't already contain the literal substring
// "Terms and Conditions". It is NOT touched by this code (other flows may
// depend on it) — instead recalculateOrderTerms below is always called as
// an explicit follow-up write() *after* create(), which runs after any
// on_create automation and therefore always wins, regardless of which
// salesperson triggered it or that automation's string-matching guard.
//
// Main-machine detection: every real InBody machine model has its own
// dedicated product category "InBody / IBD_<Model>" (verified live —
// InBody120/260S/etc. each have exactly 1-2 SKUs in their own category).
// Every accessory lives in a different category entirely (Stand120 ->
// IBD_Assy, a 46-product shared parts bucket; LookinBody -> Software/*;
// printer -> Common/*) — matching on this existing category structure, not
// on fragile product name/id/display-text matching.
interface MachineTermsTemplate {
  warrantyPeriod: string; // exact wording inserted into clause 3, e.g. "1 year", "5 years"
}

// Keyed by the product category's own short name (categ_id's display text
// is "InBody / IBD_<Model>"; only the "IBD_<Model>" part is matched/keyed
// here). Add one entry per machine model as its T&C is confirmed with the
// business — detection logic above never needs to change for a new model.
const MACHINE_TERMS_TEMPLATES: Record<string, MachineTermsTemplate> = {
  IBD_InBody120: { warrantyPeriod: '1 year' },
  IBD_InBody260S: { warrantyPeriod: '5 years' },
};

function machineCategoryKey(categoryDisplayName: string | undefined): string | null {
  if (!categoryDisplayName) return null;
  const m = categoryDisplayName.match(/IBD_InBody\S*/);
  return m ? m[0] : null;
}

// Odoo's validity_date is stored/read as ISO (YYYY-MM-DD); the reference
// quotations (and every human-typed one seen live) write it as DD-MM-YYYY.
function fmtValidityDateForTerms(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}-${m}-${y}`;
}

// Matches the exact structure/wording confirmed live on reference
// quotations S00984 (InBody 120) and S00852 (InBody 260S) — only the
// warranty clause and the validity date vary by product/order. The bank
// details block is identical to what sales staff have always typed
// manually (confirmed live — it is not generated by any Odoo mechanism),
// kept verbatim per the "keep the existing bank details" requirement.
function buildTermsHtml(warrantyPeriod: string, validityDateIso: string): string {
  const validity = fmtValidityDateForTerms(validityDateIso);
  return (
    '<div data-oe-version="2.0">Terms &amp; Conditions</div>'
    + '<div>1. PRICES: The prices are firm, inclusive of air freight, insurance charges, customs duty, custom clearance expenses, secondary freight &amp; insurance charges, from Mumbai to any major port in India. </div>'
    + '<div>2. PAYMENT TERMS: 100% payment along with the order.</div>'
    + `<div>3. WARRANTY: ${escapeHtml(warrantyPeriod)} from the date of delivery/installation. </div>`
    + '<div>4. DELIVERY PERIOD: Ex-stock or four weeks from the date of receipt of the confirmed order.</div>'
    + `<div>5. VALIDITY: The prices will remain valid till ${validity}.<br><br></div>`
    + '<div><br>InBody India Bank Details [FOR BANK TRANSFER]</div>'
    + '<div>Name: INBODY INDIA PVT. LTD.</div>'
    + '<div>Account No.:196205000495</div>'
    + '<div>Bank Name: ICICI Bank Limited</div>'
    + '<div>Branch: Kurla (West)</div>'
    + '<div>IFSC: ICIC0001962</div>'
    + '<div>Account Type: Current Account</div>'
    + '<div>Currency: Indian Rupees</div>'
  );
}

// Re-derives the applicable T&C from the SO's CURRENT lines every time a
// line is added/removed or the SO is (re)created — cheap (a handful of
// lines per PI) and stays correct no matter how the machine line got there
// or was swapped, rather than special-casing every call site individually.
// Deliberately never blanks an existing note when no templated machine line
// is found (all machine lines removed, or a not-yet-templated model) — only
// ever writes when a confident single match exists, per "do not guess
// silently" — an untemplated machine simply keeps whatever note it had.
async function recalculateOrderTerms(soId: number): Promise<void> {
  const sos = await executeKw('sale.order', 'read', [[soId]], { fields: ['order_line', 'validity_date'] }) as { order_line: number[]; validity_date: string | false }[];
  const so = sos[0];
  if (!so || !so.order_line?.length || !so.validity_date) return;

  const lines = await executeKw('sale.order.line', 'read', [so.order_line], { fields: ['product_id', 'sequence'] }) as { product_id: OdooTuple; sequence: number }[];
  const productIds = [...new Set(lines.map(l => l.product_id && l.product_id[0]).filter((id): id is number => !!id))];
  if (!productIds.length) return;

  const products = await executeKw('product.product', 'read', [productIds], { fields: ['id', 'categ_id'] }) as { id: number; categ_id: OdooTuple }[];
  const categNameByProduct = new Map(products.map(p => [p.id, p.categ_id ? p.categ_id[1] : undefined]));

  const machineLine = lines
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .find(l => l.product_id && machineCategoryKey(categNameByProduct.get(l.product_id[0])));
  if (!machineLine || !machineLine.product_id) return;

  const key = machineCategoryKey(categNameByProduct.get(machineLine.product_id[0]));
  const template = key ? MACHINE_TERMS_TEMPLATES[key] : undefined;
  if (!template) return;

  await executeKw('sale.order', 'write', [[soId], { note: buildTermsHtml(template.warrantyPeriod, so.validity_date) }]);
}

// Shared by createDraftPI and createPIRevision — builds order_line commands
// from the request's own stored details (never re-derived any other way, so
// the PI always matches exactly what the customer originally asked for) and
// creates the sale.order. Does not check for an existing active draft —
// callers are responsible for that (createDraftPI refuses if one exists,
// createPIRevision cancels the old one first). The main product's price is
// always read from Odoo's own product.list_price (Sales Price) — never
// admin-typed — so the PI's starting price always matches Odoo.
// Classification fields that live on crm.lead (see §11a Opportunity
// defaults) but are separate, independently-stored fields of the same name
// on sale.order too — confirmed live via fields_get (store:true,
// readonly:false, not related/computed). Odoo's own UI copies these onto a
// new quotation via client-side onchange when a human creates one from an
// Opportunity; a raw XML-RPC create() (what this app does) skips onchange
// entirely, so without this explicit copy the quotation's own copies stay
// blank even though the linked Opportunity has them set correctly.
const SO_CLASSIFICATION_FIELDS = ['industry_id', 'sub_industry_id', 'territory_id', 'source_id', 'sub_lead_source_id', 'ownership_id', 'medium_id'] as const;

function tupleId(v: unknown): number | false {
  return Array.isArray(v) ? (v as [number, string])[0] : false;
}

async function buildAndCreateSO(
  leadId: number, authz: Authz, adminEmail: string,
): Promise<PIDraftInfo> {
  const leads = await executeKw('crm.lead', 'read', [[leadId]], { fields: ['description', 'user_id', ...SO_CLASSIFICATION_FIELDS] }) as Record<string, unknown>[];
  if (!leads.length) throw new LeadNotFoundError();
  const lead = leads[0];

  const details = decodeRequestDetails(lead.description);
  if (!details) throw new PIWorkflowError('This request has no stored product details to build a PI from.');

  const userVal = lead.user_id as OdooTuple;
  if (!userVal) throw new PIWorkflowError('Assign a salesperson before creating a PI.');

  const classificationFields = Object.fromEntries(
    SO_CLASSIFICATION_FIELDS.map(f => [f, tupleId(lead[f])]),
  );

  const quantity = details.quantity;
  const productIds = [details.mainProduct.id, ...details.includedProducts.map(p => p.id)];
  const products = await executeKw('product.product', 'read', [productIds], { fields: ['id', 'list_price', 'taxes_id', 'uom_id'] }) as { id: number; list_price: number; taxes_id: number[]; uom_id: OdooTuple }[];
  const productMap = new Map(products.map(p => [p.id, p]));

  // Every line — the main product AND every included/free accessory —
  // always uses Odoo's own product.list_price as price_unit. An included
  // product is marked free via Odoo's native 100% discount, never by
  // zeroing price_unit: that would hide the real Sales Price the native
  // quotation PDF is supposed to show (see verification report, bundle
  // pricing fix).
  function lineCommand(id: number, code: string, name: string, discount: number, includedLabel: boolean) {
    const p = productMap.get(id);
    if (!p) throw new PIWorkflowError(`Product [${code}] ${name} could not be found in Odoo — cannot build this PI.`);
    const unitPrice = assertOdooPriceIsUsable(p.list_price, `[${code}] ${name}`);
    return [0, 0, {
      product_id: id,
      name: includedLabel ? `[${code}] ${name} (included)` : `[${code}] ${name}`,
      product_uom_qty: quantity,
      price_unit: unitPrice,
      discount,
      tax_ids: [[6, 0, p.taxes_id || []]],
      product_uom_id: p.uom_id ? p.uom_id[0] : false,
    }];
  }

  const orderLines = [
    lineCommand(details.mainProduct.id, details.mainProduct.code, details.mainProduct.name, 0, false),
    ...details.includedProducts.map(incl => lineCommand(incl.id, incl.code, incl.name, 100, true)),
  ];

  const partnerId = resolveCultFitPartnerId(authz);
  const partnerRead = await executeKw('res.partner', 'read', [[partnerId]], { fields: ['property_product_pricelist'] }) as { property_product_pricelist: OdooTuple }[];
  const pricelistId = partnerRead[0]?.property_product_pricelist ? partnerRead[0].property_product_pricelist[0] : false;

  const validityDate = new Date(Date.now() + DEFAULT_VALIDITY_DAYS * 86_400_000).toISOString().slice(0, 10);

  const soId = await executeKw('sale.order', 'create', [{
    partner_id: partnerId,
    partner_invoice_id: partnerId,
    partner_shipping_id: partnerId,
    company_id: COMPANY_ID,
    opportunity_id: leadId,
    user_id: userVal[0],
    pricelist_id: pricelistId,
    client_order_ref: `REQ-${leadId}`,
    validity_date: validityDate,
    order_line: orderLines,
    ...classificationFields,
  }]) as number;

  // Explicit follow-up write, after create() — see recalculateOrderTerms'
  // comment for why this must happen as a separate write rather than a
  // field passed into create() above (defeats the pre-existing on_create
  // automation regardless of which salesperson triggered it).
  try {
    await recalculateOrderTerms(soId);
  } catch (e) {
    console.error('[pi] failed to apply product-based terms for lead', leadId, e instanceof Error ? e.message : e);
  }

  try {
    await executeKw('crm.lead', 'message_post', [[leadId]], {
      body: `<p><b>PORTAL_PI_DRAFT_CREATED</b>: draft PI created by ${escapeHtml(adminEmail)}.</p>`,
      subtype_xmlid: 'mail.mt_note',
    });
  } catch (e) {
    console.error('[pi] failed to post draft-created note for lead', leadId, e instanceof Error ? e.message : e);
  }

  const sos = await executeKw('sale.order', 'read', [[soId]], { fields: SO_DRAFT_FIELDS }) as Record<string, unknown>[];
  return buildDraftSOInfo(sos[0], leadId);
}

export async function createDraftPI(
  leadId: number, authz: Authz, adminEmail: string,
): Promise<PIDraftInfo> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can create a PI.');
  await assertCultFitLead(leadId);

  const existing = await findActiveDraftSO(leadId);
  if (existing) throw new PIWorkflowError('An active draft PI already exists for this request. Use "Create Revision" to replace it.');

  return buildAndCreateSO(leadId, authz, adminEmail);
}

export async function createPIRevision(
  leadId: number, authz: Authz, adminEmail: string,
): Promise<PIDraftInfo> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can create a PI revision.');
  await assertCultFitLead(leadId);

  const existing = await findActiveDraftSO(leadId);
  if (!existing) throw new PIWorkflowError('No active PI exists to revise — use Create Draft PI instead.');

  await executeKw('sale.order', 'write', [[existing.id], { state: 'cancel' }]);
  try {
    await executeKw('crm.lead', 'message_post', [[leadId]], {
      body: `<p><b>PORTAL_PI_SUPERSEDED</b>: ${escapeHtml(existing.name)} cancelled by ${escapeHtml(adminEmail)} to create a revision.</p>`,
      subtype_xmlid: 'mail.mt_note',
    });
  } catch (e) {
    console.error('[pi] failed to post superseded note for lead', leadId, e instanceof Error ? e.message : e);
  }

  return buildAndCreateSO(leadId, authz, adminEmail);
}

export interface PIDraftUpdate {
  validityDate?: string;
}

// Unit price is never editable here (or anywhere in the PI editor) — it
// always comes from Odoo's own product.list_price, resolved at line
// creation time in buildAndCreateSO/addPIDraftLine. Only validity date is
// editable through this function; per-line quantity/discount go through
// updatePIDraftLine below.
export async function updatePIDraft(
  leadId: number, soId: number, updates: PIDraftUpdate, authz: Authz,
): Promise<PIDraftInfo> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can edit a PI.');
  await assertCultFitLead(leadId);

  const so = await verifySOBelongsToLead(leadId, soId);
  if (so.state === 'cancel') throw new PIWorkflowError('This PI has been superseded and can no longer be edited.');

  if (updates.validityDate !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(updates.validityDate) || updates.validityDate < new Date().toISOString().slice(0, 10)) {
      throw new PIWorkflowError('Validity date must be a valid date, not in the past.');
    }
    await executeKw('sale.order', 'write', [[soId], { validity_date: updates.validityDate }]);
  }

  const sos = await executeKw('sale.order', 'read', [[soId]], { fields: SO_DRAFT_FIELDS }) as Record<string, unknown>[];
  return buildDraftSOInfo(sos[0], leadId);
}

// ──── Admin PI product editor ──────────────────────────────────────────────
// Lets admin add/remove/reprice any approved product on a still-editable
// draft PI, not just the one main-product price updatePIDraft above handles.
// Every function here re-verifies soId belongs to the lead (verifySOBelongsToLead)
// and, for line-level ops, that lineId belongs to that soId — never trusts a
// client-supplied id. Publishing (publishPI) reads so.lines fresh regardless
// of how they got there, so these are safe additive operations on the same
// draft sale.order buildAndCreateSO already created.

function requireValidQuantity(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new PIWorkflowError('Quantity must be a whole number between 1 and 999.');
  return n;
}

// Odoo's own native Discount (%) field on sale.order.line — 0-100, same
// range Odoo's own UI enforces. Defaults to 0 (no discount) when not
// supplied. Never trusted blindly from the client beyond this range check.
function requireValidDiscount(v: unknown): number {
  if (v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new PIWorkflowError('Discount must be a percentage between 0 and 100.');
  return n;
}

// Odoo's `fixed_amt` field (from the inbody module, sibling to disc_calculation)
// — a currency amount, only meaningful when disc_calculation='fixed'. Bounded
// by the line's own pre-discount value (price_unit * qty) so a line can never
// go negative, same ceiling Odoo's own price_subtotal compute implicitly enforces.
function requireValidFixedAmount(v: unknown, maxAmount: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > maxAmount + 0.01) {
    throw new PIWorkflowError(`Fixed discount amount must be between 0 and ${maxAmount.toFixed(2)} for this line.`);
  }
  return n;
}

// disc_calculation ('percentage' | 'fixed') plus whichever of discount/fixed_amt
// is active — the other stays at Odoo's default rather than being computed
// here, since price_subtotal only depends on the active mode's field (confirmed
// against live production data) and mirroring the inactive field is a cosmetic
// nicety Odoo's own UI does client-side, not something this app needs to redo.
function resolveDiscountFields(
  input: { discCalculation?: 'percentage' | 'fixed'; discount?: number; fixedAmount?: number },
  lineBase: number,
): Record<string, unknown> {
  if (input.discCalculation === 'fixed') {
    return { disc_calculation: 'fixed', fixed_amt: requireValidFixedAmount(input.fixedAmount, lineBase), discount: 0 };
  }
  return { disc_calculation: 'percentage', discount: requireValidDiscount(input.discount) };
}

export interface AdminProductOption {
  id: number;
  code: string;
  name: string;
  unitPrice: number;
  unit: string;
  taxLabel: string;
}

// Broader than fetchCultFitProductCatalog (which only surfaces products
// already used in a real CultFit order) — the full, searchable Odoo catalog
// (verified live: 1,834 active/sellable products company-wide) so admin can
// add any approved product. Excludes the same EXCLUDED_PRODUCT_IDS as the
// customer-facing picker, plus every product matching the real "Not Use"
// naming convention discovered live (covers 5 more deprecated products than
// the hardcoded id list alone) — never returns an inactive/non-sellable one.
// unitPrice/unit/taxLabel are Odoo's own list_price/uom_id/taxes_id — shown
// to admin so everything about the product is visible before it's added, but
// all re-read fresh from Odoo again in addPIDraftLine rather than trusted
// from this search result.
export async function searchAdminProducts(query: string): Promise<AdminProductOption[]> {
  const q = query.trim().slice(0, 100);
  if (!q) return [];
  const domain: unknown[] = [
    ['sale_ok', '=', true], ['active', '=', true], ['name', 'not ilike', 'not use'],
    '|', ['name', 'ilike', q], ['default_code', 'ilike', q],
  ];
  const products = await executeKw('product.product', 'search_read', [domain], {
    fields: ['id', 'display_name', 'list_price', 'uom_id', 'taxes_id'], limit: 20,
  }) as { id: number; display_name: string; list_price: number; uom_id: OdooTuple; taxes_id: number[] }[];
  const visible = products.filter(p => !ADMIN_EDITOR_EXCLUDED_PRODUCT_IDS.has(p.id));

  const taxIds = [...new Set(visible.flatMap(p => p.taxes_id || []))];
  const taxes = taxIds.length
    ? await executeKw('account.tax', 'read', [taxIds], { fields: ['id', 'name'] }) as { id: number; name: string }[]
    : [];
  const taxMap = new Map(taxes.map(t => [t.id, t.name]));

  return visible.map(p => ({
    id: p.id, ...parseProductLabel(p.display_name), unitPrice: p.list_price || 0,
    unit: p.uom_id ? p.uom_id[1] : '',
    taxLabel: (p.taxes_id || []).map(id => taxMap.get(id)).filter(Boolean).join(', ') || 'No Tax',
  }));
}

export interface PIDraftLineDiscountInput {
  discCalculation?: 'percentage' | 'fixed';
  discount?: number;
  fixedAmount?: number;
}

// Unit price always comes from Odoo's own product.list_price — never a
// client-supplied value (see the "no manual price editing" rule this file
// follows now). Admin controls quantity and the discount mode/value only.
export async function addPIDraftLine(
  leadId: number, soId: number, productId: number, quantity: number,
  discountInput: PIDraftLineDiscountInput, authz: Authz, adminEmail: string,
): Promise<PIDraftInfo> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can edit a PI.');
  await assertCultFitLead(leadId);

  const so = await verifySOBelongsToLead(leadId, soId);
  if (so.state === 'cancel') throw new PIWorkflowError('This PI has been superseded and can no longer be edited.');

  const qty = requireValidQuantity(quantity);

  // Never trust a client-supplied product id blindly — re-verify it's a
  // real, active, sellable, non-excluded/non-deprecated product before using
  // it in a line, same discipline as createPortalOrderRequest's catalog check.
  const products = await executeKw('product.product', 'read', [[Number(productId)]], {
    fields: ['id', 'display_name', 'active', 'sale_ok', 'list_price', 'taxes_id', 'uom_id'],
  }) as { id: number; display_name: string; active: boolean; sale_ok: boolean; list_price: number; taxes_id: number[]; uom_id: OdooTuple }[];
  const product = products[0];
  if (!product || !product.active || !product.sale_ok || ADMIN_EDITOR_EXCLUDED_PRODUCT_IDS.has(product.id) || /not use/i.test(product.display_name)) {
    throw new PIWorkflowError('Selected product is not a valid, approved Odoo product.');
  }

  const discFields = resolveDiscountFields(discountInput, (product.list_price || 0) * qty);

  const { code, name } = parseProductLabel(product.display_name);
  await executeKw('sale.order.line', 'create', [{
    order_id: soId,
    product_id: product.id,
    name: `[${code}] ${name}`,
    product_uom_qty: qty,
    price_unit: product.list_price || 0,
    ...discFields,
    tax_ids: [[6, 0, product.taxes_id || []]],
    product_uom_id: product.uom_id ? product.uom_id[0] : false,
  }]);

  // Re-derive from ALL current lines, not just the one just added — a newly
  // added machine may now be the applicable one, or may simply be an
  // accessory that leaves the existing machine/terms untouched either way.
  try {
    await recalculateOrderTerms(soId);
  } catch (e) {
    console.error('[pi] failed to recalculate product-based terms for lead', leadId, e instanceof Error ? e.message : e);
  }

  try {
    await executeKw('crm.lead', 'message_post', [[leadId]], {
      body: `<p><b>PORTAL_PI_LINE_ADDED</b>: [${escapeHtml(code)}] ${escapeHtml(name)} × ${qty} added by ${escapeHtml(adminEmail)}.</p>`,
      subtype_xmlid: 'mail.mt_note',
    });
  } catch (e) {
    console.error('[pi] failed to post line-added note for lead', leadId, e instanceof Error ? e.message : e);
  }

  const sos = await executeKw('sale.order', 'read', [[soId]], { fields: SO_DRAFT_FIELDS }) as Record<string, unknown>[];
  return buildDraftSOInfo(sos[0], leadId);
}

export async function removePIDraftLine(
  leadId: number, soId: number, lineId: number, authz: Authz, adminEmail: string,
): Promise<PIDraftInfo> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can edit a PI.');
  await assertCultFitLead(leadId);

  const so = await verifySOBelongsToLead(leadId, soId);
  if (so.state === 'cancel') throw new PIWorkflowError('This PI has been superseded and can no longer be edited.');

  const line = so.lines.find(l => l.id === Number(lineId));
  if (!line) throw new PIWorkflowError('That line does not belong to this PI.');
  if (so.lines.length <= 1) throw new PIWorkflowError('A PI must have at least one line item.');

  await executeKw('sale.order.line', 'unlink', [[line.id]]);

  // If the removed line was the machine the current terms were based on, a
  // different remaining machine line (if any) now becomes applicable. If no
  // machine line remains at all, recalculateOrderTerms leaves the existing
  // note untouched rather than blanking it — see its own comment.
  try {
    await recalculateOrderTerms(soId);
  } catch (e) {
    console.error('[pi] failed to recalculate product-based terms for lead', leadId, e instanceof Error ? e.message : e);
  }

  try {
    await executeKw('crm.lead', 'message_post', [[leadId]], {
      body: `<p><b>PORTAL_PI_LINE_REMOVED</b>: [${escapeHtml(line.code)}] ${escapeHtml(line.name)} removed by ${escapeHtml(adminEmail)}.</p>`,
      subtype_xmlid: 'mail.mt_note',
    });
  } catch (e) {
    console.error('[pi] failed to post line-removed note for lead', leadId, e instanceof Error ? e.message : e);
  }

  const sos = await executeKw('sale.order', 'read', [[soId]], { fields: SO_DRAFT_FIELDS }) as Record<string, unknown>[];
  return buildDraftSOInfo(sos[0], leadId);
}

export interface PIDraftLineUpdate extends PIDraftLineDiscountInput {
  quantity?: number;
}

// Quantity and the discount mode/value are editable; unit price is never
// accepted here — it stays whatever was resolved from Odoo's
// product.list_price when the line was created, exactly like every other
// read-only field on this line.
export async function updatePIDraftLine(
  leadId: number, soId: number, lineId: number, updates: PIDraftLineUpdate, authz: Authz,
): Promise<PIDraftInfo> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can edit a PI.');
  await assertCultFitLead(leadId);

  const so = await verifySOBelongsToLead(leadId, soId);
  if (so.state === 'cancel') throw new PIWorkflowError('This PI has been superseded and can no longer be edited.');

  const line = so.lines.find(l => l.id === Number(lineId));
  if (!line) throw new PIWorkflowError('That line does not belong to this PI.');

  const writeFields: Record<string, unknown> = {};
  if (updates.quantity !== undefined) writeFields.product_uom_qty = requireValidQuantity(updates.quantity);
  const touchesDiscount = updates.discCalculation !== undefined || updates.discount !== undefined || updates.fixedAmount !== undefined;
  if (touchesDiscount) {
    const qtyForBase = updates.quantity !== undefined ? Number(writeFields.product_uom_qty) : line.quantity;
    Object.assign(writeFields, resolveDiscountFields({
      discCalculation: updates.discCalculation ?? line.discCalculation,
      discount: updates.discount ?? line.discount,
      fixedAmount: updates.fixedAmount ?? line.fixedAmount,
    }, line.unitPrice * qtyForBase));
  }
  if (Object.keys(writeFields).length) {
    await executeKw('sale.order.line', 'write', [[line.id], writeFields]);
  }

  const sos = await executeKw('sale.order', 'read', [[soId]], { fields: SO_DRAFT_FIELDS }) as Record<string, unknown>[];
  return buildDraftSOInfo(sos[0], leadId);
}

interface PISnapshotLineItem {
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

interface PIResponseRecord {
  version: number;
  action: 'confirm' | 'request_correction';
  comment: string;
  respondedAt: string;
  respondedBy: string;
}

const PI_PUBLISHED_MARKER = 'PORTAL_PI_PUBLISHED';
const PI_RESPONSE_MARKER = 'PORTAL_PI_CUSTOMER_RESPONSE';

function encodeMarkerData(prefix: string, data: unknown): string {
  return `<!--${prefix}:${Buffer.from(JSON.stringify(data)).toString('base64')}-->`;
}

function decodeMarkerData<T>(prefix: string, body: unknown): T | null {
  if (typeof body !== 'string') return null;
  const m = body.match(new RegExp(`<!--${prefix}:([A-Za-z0-9+/=]+)-->`));
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function piStatusFrom(snapshot: PIPublishedSnapshot | null, response: PIResponseRecord | null, hasActiveDraft: boolean): PIStatus {
  if (!snapshot) return hasActiveDraft ? 'draft' : 'not_created';
  if (response?.action === 'confirm') return 'confirmed';
  if (response?.action === 'request_correction') return 'correction_requested';
  return 'awaiting_confirmation';
}

// Reads every publish/response marker ever posted on this lead's chatter and
// picks the latest published version by its own version number (not message
// order) plus any response matching that same version — order-independent,
// so it's correct regardless of how mail.message ids/dates interleave.
async function fetchLatestPISnapshotAndResponse(leadId: number): Promise<{ snapshot: PIPublishedSnapshot | null; response: PIResponseRecord | null }> {
  const messages = await executeKw('mail.message', 'search_read', [[
    ['res_id', '=', leadId], ['model', '=', 'crm.lead'],
    '|', ['body', 'ilike', PI_PUBLISHED_MARKER], ['body', 'ilike', PI_RESPONSE_MARKER],
  ]], { fields: ['body'] }) as { body: string }[];

  const snapshots: PIPublishedSnapshot[] = [];
  const responses: PIResponseRecord[] = [];
  for (const m of messages) {
    const s = decodeMarkerData<PIPublishedSnapshot>(PI_PUBLISHED_MARKER, m.body);
    if (s) { snapshots.push(s); continue; }
    const r = decodeMarkerData<PIResponseRecord>(PI_RESPONSE_MARKER, m.body);
    if (r) responses.push(r);
  }
  if (!snapshots.length) return { snapshot: null, response: null };
  const latest = snapshots.reduce((a, b) => (b.version > a.version ? b : a));
  const response = responses.find(r => r.version === latest.version) ?? null;
  return { snapshot: latest, response };
}

// Fetches Odoo's own native Quotation PDF (report `sale.report_saleorder`,
// Odoo's standard order-print report — confirmed live as the report this
// route actually renders; the separate Pro-Forma Invoice report isn't
// reachable through any unauthenticated route today, see
// CULTFIT_PORTAL_MASTER_CONTEXT.md §Phase 2) via Odoo's own public
// customer-portal controller, which validates access via a per-order
// access_token instead of requiring the backend session login this portal's
// API account doesn't have — verified live to work with no login.
// sale.order.access_token is a plain char field Odoo normally generates
// lazily on first portal view (via a private method that, like
// _render_qweb_pdf, can't be called remotely); a fresh, portal-created draft
// order has none yet, so one is generated and written here if empty — this
// is the ONLY field this function ever writes, and only when missing.
async function fetchNativeOdooPdf(soId: number): Promise<Buffer> {
  const sos = await executeKw('sale.order', 'read', [[soId]], { fields: ['access_token'] }) as { access_token: string | false }[];
  let token = sos[0]?.access_token || '';
  if (!token) {
    token = randomUUID();
    await executeKw('sale.order', 'write', [[soId], { access_token: token }]);
  }

  const url = `${ODOO_URL}/my/orders/${soId}?report_type=pdf&access_token=${encodeURIComponent(token)}&download=true`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } catch (e) {
    throw new OdooUnavailableError(e);
  } finally {
    clearTimeout(timeout);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (!resp.ok || !contentType.includes('application/pdf')) {
    throw new PIWorkflowError('Could not generate the native Odoo PI PDF. Please try publishing again.');
  }
  return Buffer.from(await resp.arrayBuffer());
}

export async function publishPI(leadId: number, soId: number, authz: Authz, adminEmail: string): Promise<PIPublishedSnapshot> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Only an admin can publish a PI.');
  await assertCultFitLead(leadId);

  const so = await verifySOBelongsToLead(leadId, soId);
  if (so.state === 'cancel') throw new PIWorkflowError('This PI has been superseded and cannot be published.');

  const leads = await executeKw('crm.lead', 'read', [[leadId]], { fields: ['description', 'user_id', 'order_ids'] }) as Record<string, unknown>[];
  const lead = leads[0];
  const details = decodeRequestDetails(lead.description);
  if (!details) throw new PIWorkflowError('Request details missing — cannot publish.');

  const userVal = lead.user_id as OdooTuple;
  if (!userVal) throw new PIWorkflowError('Assign a salesperson before publishing.');

  // Same deterministic id-based rule as buildDraftSOInfo's resolveMainProductId
  // — details is already decoded above, so no extra lookup is needed here.
  const mainLine = so.lines.find(l => l.productId === details.mainProduct.id);
  if (!mainLine) throw new PIWorkflowError('Set the main product price before publishing.');
  if (!so.validityDate) throw new PIWorkflowError('Set a validity date before publishing.');

  const partnerId = resolveCultFitPartnerId(authz);
  const partnerRead = await executeKw('res.partner', 'read', [[partnerId]], { fields: ['name'] }) as { name: string }[];
  const companyName = partnerRead[0]?.name ?? details.cultfitCompany ?? 'CultFit';

  const version = ((lead.order_ids as number[]) || []).length;
  const publishedDate = new Date().toISOString().slice(0, 10);

  const pdfBuffer = await fetchNativeOdooPdf(soId);

  const filename = `PI-${so.name}-V${version}.pdf`;
  const attachmentId = await executeKw('ir.attachment', 'create', [{
    name: filename,
    datas: pdfBuffer.toString('base64'),
    res_model: 'sale.order',
    res_id: soId,
    mimetype: 'application/pdf',
    type: 'binary',
    public: false,
  }]) as number;

  const snapshot: PIPublishedSnapshot = {
    version, quotationId: soId, quotationNumber: so.name,
    publishedDate, publishedBy: adminEmail, attachmentId,
    requestReference: `REQ-${leadId}`, cultfitCompanyName: companyName,
    // details.deliveryAddress/preferredDeliveryDate are legacy-only fields
    // (see PortalRequestDetails) — never set on requests created after the
    // New Request form stopped collecting them; fall back to empty/null so
    // this snapshot's own (still-required) shape is unaffected either way.
    deliveryAddress: details.deliveryAddress ?? '', cocoFofo: details.cocoFofo,
    preferredDeliveryDate: details.preferredDeliveryDate ?? null, salespersonName: userVal[1],
    lineItems: so.lines.map(l => ({
      code: l.code, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice,
      taxLabel: l.taxLabel, taxTotal: l.taxTotal, untaxedTotal: l.untaxedTotal,
    })),
    untaxedAmount: so.untaxedAmount, taxAmount: so.taxAmount, totalAmount: so.totalAmount,
    validityDate: so.validityDate,
  };

  // Not wrapped in try/catch like the other audit-only chatter posts above —
  // this note IS the publish record (the customer-facing PI status is
  // derived entirely from it), so a failure here must surface as a failed
  // publish, not be silently swallowed.
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: `<p><b>${PI_PUBLISHED_MARKER}</b>: ${escapeHtml(so.name)} (v${version}) published by ${escapeHtml(adminEmail)}. Status: Awaiting Customer Confirmation.</p>`
      + encodeMarkerData(PI_PUBLISHED_MARKER, snapshot),
    subtype_xmlid: 'mail.mt_note',
  });

  return snapshot;
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
  // Live crm.lead.territory_id, not the frozen regionDetection snapshot on
  // `details` (which only reflects what auto-detection found at creation
  // time) — this always reflects the current value, including after an
  // admin override via updateRequestTerritory.
  currentTerritory: TerritoryOption | null;
  opportunityDefaults: OpportunityDefaults;
}

async function fetchCurrentTerritory(leadId: number): Promise<TerritoryOption | null> {
  const leads = await executeKw('crm.lead', 'read', [[leadId]], { fields: ['territory_id'] }) as { territory_id: OdooTuple }[];
  const t = leads[0]?.territory_id;
  return t ? { id: t[0], name: t[1] } : null;
}

// Read-only display of the standard defaults set at creation (see
// createPortalOrderRequest) — read live from crm.lead rather than assumed,
// so a request created before this feature existed correctly shows blank
// rather than a misleading hardcoded label.
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

const ACCOUNT_TYPE_LABELS: Record<string, string> = { franchise: 'Franchise', non_franchise: 'Non-Franchise' };

async function fetchOpportunityDefaults(leadId: number): Promise<OpportunityDefaults> {
  const leads = await executeKw('crm.lead', 'read', [[leadId]], {
    fields: ['key_account_manager', 'industry_id', 'sub_industry_id', 'source_id', 'sub_lead_source_id', 'ownership_id', 'medium_id', 'account_type'],
  }) as Record<string, unknown>[];
  const lead = leads[0] ?? {};
  const tupleLabel = (v: unknown) => (v ? (v as [number, string])[1] : null);
  const accountType = lead.account_type as string | false | undefined;
  return {
    keyAccountManager: tupleLabel(lead.key_account_manager),
    industry: tupleLabel(lead.industry_id),
    subIndustry: tupleLabel(lead.sub_industry_id),
    source: tupleLabel(lead.source_id),
    subLeadSource: tupleLabel(lead.sub_lead_source_id),
    ownership: tupleLabel(lead.ownership_id),
    channel: tupleLabel(lead.medium_id),
    accountType: accountType ? (ACCOUNT_TYPE_LABELS[accountType] ?? accountType) : null,
  };
}

// Batched across every lead in the list in a single pair of extra round
// trips (chatter search + sale.order state read), not one query per lead —
// same batching discipline as fetchSoAggregates above.
async function fetchPIStatusMap(leadIds: number[]): Promise<Map<number, PIStatus>> {
  const result = new Map<number, PIStatus>();
  if (!leadIds.length) return result;

  const messages = await executeKw('mail.message', 'search_read', [[
    ['res_id', 'in', leadIds], ['model', '=', 'crm.lead'],
    '|', ['body', 'ilike', PI_PUBLISHED_MARKER], ['body', 'ilike', PI_RESPONSE_MARKER],
  ]], { fields: ['res_id', 'body'] }) as { res_id: number; body: string }[];

  const snapshotsByLead = new Map<number, PIPublishedSnapshot[]>();
  const responsesByLead = new Map<number, PIResponseRecord[]>();
  for (const m of messages) {
    const s = decodeMarkerData<PIPublishedSnapshot>(PI_PUBLISHED_MARKER, m.body);
    if (s) { (snapshotsByLead.get(m.res_id) ?? snapshotsByLead.set(m.res_id, []).get(m.res_id)!).push(s); continue; }
    const r = decodeMarkerData<PIResponseRecord>(PI_RESPONSE_MARKER, m.body);
    if (r) (responsesByLead.get(m.res_id) ?? responsesByLead.set(m.res_id, []).get(m.res_id)!).push(r);
  }

  const draftLeadIds = leadIds.filter(id => !snapshotsByLead.has(id));
  const hasActiveDraftMap = new Map<number, boolean>();
  if (draftLeadIds.length) {
    const leadsWithOrders = await executeKw('crm.lead', 'read', [draftLeadIds], { fields: ['id', 'order_ids'] }) as { id: number; order_ids: number[] }[];
    const allSoIds = [...new Set(leadsWithOrders.flatMap(l => l.order_ids || []))];
    if (allSoIds.length) {
      const sos = await executeKw('sale.order', 'read', [allSoIds], { fields: ['id', 'state'] }) as { id: number; state: string }[];
      const soStateMap = new Map(sos.map(s => [s.id, s.state]));
      for (const l of leadsWithOrders) {
        hasActiveDraftMap.set(l.id, (l.order_ids || []).some(soId => soStateMap.get(soId) !== 'cancel'));
      }
    }
  }

  for (const leadId of leadIds) {
    const snaps = snapshotsByLead.get(leadId) || [];
    const latest = snaps.length ? snaps.reduce((a, b) => (b.version > a.version ? b : a)) : null;
    const response = latest ? (responsesByLead.get(leadId) || []).find(r => r.version === latest.version) ?? null : null;
    result.set(leadId, piStatusFrom(latest, response, hasActiveDraftMap.get(leadId) ?? false));
  }
  return result;
}

// Batched the same way as fetchPIStatusMap — one query for every lead in
// the list rather than one per lead.
async function fetchPOStatusMap(leadIds: number[]): Promise<Map<number, PoStatus>> {
  const result = new Map<number, PoStatus>();
  if (!leadIds.length) return result;

  const messages = await executeKw('mail.message', 'search_read', [[
    ['res_id', 'in', leadIds], ['model', '=', 'crm.lead'],
    '|', '|', ['body', 'ilike', PO_SUBMITTED_MARKER], ['body', 'ilike', PO_CORRECTION_MARKER], ['body', 'ilike', PO_APPROVED_MARKER],
  ]], { fields: ['res_id', 'body'] }) as { res_id: number; body: string }[];

  const byLead = new Map<number, { body: string }[]>();
  for (const m of messages) (byLead.get(m.res_id) ?? byLead.set(m.res_id, []).get(m.res_id)!).push({ body: m.body });

  for (const leadId of leadIds) {
    const { submissions, corrections, approvals } = groupPoMarkers(byLead.get(leadId) ?? []);
    result.set(leadId, poStatusFrom(submissions, corrections, approvals).status);
  }
  return result;
}

export async function fetchAdminRequestList(authz: Authz): Promise<AdminRequestSummary[]> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Admin access required.');
  const base = await fetchPortalOrderRequests(authz);
  const leadIds = base.map(r => r.id);
  const [piMap, poMap] = await Promise.all([fetchPIStatusMap(leadIds), fetchPOStatusMap(leadIds)]);
  return base.map(r => ({ ...r, piStatus: piMap.get(r.id) ?? 'not_created', poStatus: poMap.get(r.id) ?? 'awaiting_upload' }));
}

export async function fetchAdminRequestDetail(id: number, authz: Authz): Promise<AdminRequestDetail | null> {
  if (authz.role !== 'admin') throw new PIWorkflowError('Admin access required.');
  const base = await fetchPortalOrderRequestById(id, authz);
  if (!base) return null;

  const draftPI = await findActiveDraftSO(id);
  const { snapshot, response } = await fetchLatestPISnapshotAndResponse(id);
  const piStatus = piStatusFrom(snapshot, response, !!draftPI);
  const po = await fetchAdminPoDetail(id, authz);
  const [currentTerritory, opportunityDefaults] = await Promise.all([
    fetchCurrentTerritory(id), fetchOpportunityDefaults(id),
  ]);
  return { ...base, piStatus, draftPI, publishedPI: snapshot, po, currentTerritory, opportunityDefaults };
}

// Never looks at a draft sale.order — only ever returns a published
// snapshot, so a customer can never see a PI before it's published, by
// construction (there is nothing in this function's data path that reads
// draft-only fields).
export async function fetchCustomerPublishedPI(
  leadId: number, authz: Authz,
): Promise<{ status: PIStatus; snapshot: PIPublishedSnapshot | null }> {
  const domain = [['id', '=', leadId], ...authzDomain(authz), ['description', 'ilike', PORTAL_REQUEST_MARKER]];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['id'] }) as { id: number }[];
  if (!leads.length) throw new LeadNotFoundError();

  const { snapshot, response } = await fetchLatestPISnapshotAndResponse(leadId);
  const status = piStatusFrom(snapshot, response, false);
  return { status, snapshot };
}

export async function respondToPublishedPI(
  leadId: number, action: unknown, comment: unknown, authz: Authz, customerEmail: string,
): Promise<{ status: PIStatus }> {
  if (authz.role !== 'customer') throw new InvalidRequestError('Only a customer can respond to a PI.');
  if (action !== 'confirm' && action !== 'request_correction') throw new InvalidRequestError('Invalid action.');

  const commentText = typeof comment === 'string' ? comment.trim().slice(0, 1000) : '';
  if (action === 'request_correction' && !commentText) {
    throw new InvalidRequestError('Please describe what needs correcting.');
  }

  const domain = [['id', '=', leadId], ...authzDomain(authz), ['description', 'ilike', PORTAL_REQUEST_MARKER]];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['id', 'user_id'] }) as Record<string, unknown>[];
  if (!leads.length) throw new LeadNotFoundError();

  const { snapshot, response } = await fetchLatestPISnapshotAndResponse(leadId);
  if (!snapshot) throw new InvalidRequestError('No published PI to respond to.');
  if (response) throw new InvalidRequestError('This PI has already received a response.');

  const record: PIResponseRecord = {
    version: snapshot.version, action, comment: commentText,
    respondedAt: new Date().toISOString(), respondedBy: customerEmail,
  };
  const label = action === 'confirm' ? 'Confirmed' : 'Correction Requested';
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: `<p><b>${PI_RESPONSE_MARKER}</b>: Customer ${label} for PI ${escapeHtml(snapshot.quotationNumber)} (v${snapshot.version}).`
      + (commentText ? ` Comment: ${escapeHtml(commentText)}` : '') + '</p>'
      + encodeMarkerData(PI_RESPONSE_MARKER, record),
    subtype_xmlid: 'mail.mt_note',
  });

  // Correction requests need to actually reach the assigned salesperson, not
  // just sit in chatter — schedule a standard Odoo activity on them (no
  // email involved; this is Odoo's own in-app "To-Do" activity system,
  // already used by staff for every other follow-up). Created directly via
  // mail.activity rather than the activity_schedule() convenience method —
  // that method's kwargs (e.g. activity_type_xmlid) turned out not to match
  // this Odoo 19 instance's signature (verified live via a real fault:
  // "Invalid field 'activity_type_xmlid' in 'mail.activity'"). Also
  // verified live that res_model_id (the ir.model record, not just the
  // res_model char) must be set explicitly — omitting it faults with
  // "Activities have to be linked to records with a not null res_id" even
  // though res_id was set. Resolves the "To-Do" type and crm.lead's
  // ir.model id live rather than hardcoding either. Best-effort: a failure
  // here must never block the customer's response from being recorded,
  // which is the operation that matters.
  if (action === 'request_correction') {
    const userVal = leads[0].user_id as OdooTuple;
    if (userVal) {
      try {
        const [todoTypes, leadModels] = await Promise.all([
          executeKw('mail.activity.type', 'search_read', [[['name', '=', 'To-Do']]], { fields: ['id'], limit: 1 }) as Promise<{ id: number }[]>,
          executeKw('ir.model', 'search_read', [[['model', '=', 'crm.lead']]], { fields: ['id'], limit: 1 }) as Promise<{ id: number }[]>,
        ]);
        if (todoTypes.length && leadModels.length) {
          await executeKw('mail.activity', 'create', [{
            res_model_id: leadModels[0].id,
            res_model: 'crm.lead',
            res_id: leadId,
            activity_type_id: todoTypes[0].id,
            summary: `Portal PI correction requested — ${snapshot.quotationNumber} (v${snapshot.version})`,
            note: escapeHtml(commentText),
            user_id: userVal[0],
            date_deadline: new Date().toISOString().slice(0, 10),
          }]);
        }
      } catch (e) {
        console.error('[pi-respond] failed to schedule correction activity for lead', leadId, e instanceof Error ? e.message : e);
      }
    }
  }

  return { status: action === 'confirm' ? 'confirmed' : 'correction_requested' };
}

// Secure download for the customer — mirrors fetchAttachmentData's
// ownership-check pattern: the attachment id comes only from our own
// published snapshot (never a client-supplied id), and is still re-verified
// against Odoo directly before its bytes are read.
export async function fetchPIPdfData(leadId: number, authz: Authz): Promise<{ data: Buffer; filename: string }> {
  const domain = [['id', '=', leadId], ...authzDomain(authz), ['description', 'ilike', PORTAL_REQUEST_MARKER]];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['id'] }) as { id: number }[];
  if (!leads.length) throw new LeadNotFoundError();

  const { snapshot } = await fetchLatestPISnapshotAndResponse(leadId);
  if (!snapshot) throw new LeadNotFoundError();

  const count = await executeKw('ir.attachment', 'search_count', [[
    ['id', '=', snapshot.attachmentId], ['res_model', '=', 'sale.order'], ['res_id', '=', snapshot.quotationId],
  ]]) as number;
  if (!count) throw new LeadNotFoundError();

  const records = await executeKw('ir.attachment', 'read', [[snapshot.attachmentId]], { fields: ['name', 'datas'] }) as Record<string, unknown>[];
  if (!records.length || !records[0].datas) throw new LeadNotFoundError();
  return {
    data: Buffer.from(records[0].datas as string, 'base64'),
    filename: (records[0].name as string) || `PI-${snapshot.quotationNumber}.pdf`,
  };
}

// ──── PO workflow (Phase 3) ────────────────────────────────────────────────
// The uploaded PO PDF is NEVER persisted anywhere — not to Odoo (no
// ir.attachment), not to disk, not to any store. It exists only as a Buffer
// for the duration of the extract request (see lib/po-pdf-parser.ts) and is
// discarded when that request completes. Only the customer-reviewed,
// server-validated STRUCTURED DATA is ever saved, and only in structured
// chatter markers on the Opportunity — same zero-new-infrastructure pattern
// as Phase 1/2 (no new Odoo field/model, except the two verified-unused
// native fields written on approval; see approvePoData below).

export class PoWorkflowError extends Error {
  constructor(message: string) { super(message); this.name = 'PoWorkflowError'; }
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

const PO_SUBMITTED_MARKER = 'PORTAL_PO_SUBMITTED';
const PO_CORRECTION_MARKER = 'PORTAL_PO_CORRECTION_REQUESTED';
const PO_APPROVED_MARKER = 'PORTAL_PO_APPROVED';

async function fetchPoMarkers(leadId: number): Promise<{
  submissions: PoSubmissionRecord[]; corrections: PoCorrectionRecord[]; approvals: PoApprovalRecord[];
}> {
  const messages = await executeKw('mail.message', 'search_read', [[
    ['res_id', '=', leadId], ['model', '=', 'crm.lead'],
    '|', '|', ['body', 'ilike', PO_SUBMITTED_MARKER], ['body', 'ilike', PO_CORRECTION_MARKER], ['body', 'ilike', PO_APPROVED_MARKER],
  ]], { fields: ['body'] }) as { body: string }[];
  return groupPoMarkers(messages);
}

function groupPoMarkers(messages: { body: string }[]): {
  submissions: PoSubmissionRecord[]; corrections: PoCorrectionRecord[]; approvals: PoApprovalRecord[];
} {
  const submissions: PoSubmissionRecord[] = [];
  const corrections: PoCorrectionRecord[] = [];
  const approvals: PoApprovalRecord[] = [];
  for (const m of messages) {
    const s = decodeMarkerData<PoSubmissionRecord>(PO_SUBMITTED_MARKER, m.body);
    if (s) { submissions.push(s); continue; }
    const c = decodeMarkerData<PoCorrectionRecord>(PO_CORRECTION_MARKER, m.body);
    if (c) { corrections.push(c); continue; }
    const a = decodeMarkerData<PoApprovalRecord>(PO_APPROVED_MARKER, m.body);
    if (a) approvals.push(a);
  }
  return { submissions, corrections, approvals };
}

// Version-independent status derivation — mirrors piStatusFrom's philosophy:
// the latest SUBMITTED version is "the" PO; a correction only "sticks" if it
// targets that same version (a fresh submission always supersedes an older
// correction request, the same way createPIRevision supersedes a response).
function poStatusFrom(
  submissions: PoSubmissionRecord[], corrections: PoCorrectionRecord[], approvals: PoApprovalRecord[],
): { status: PoStatus; latestSubmission: PoSubmissionRecord | null; latestCorrection: PoCorrectionRecord | null; latestApproval: PoApprovalRecord | null } {
  if (approvals.length) {
    const latestApproval = approvals.reduce((a, b) => (b.version > a.version ? b : a));
    const latestSubmission = submissions.find(s => s.version === latestApproval.version) ?? null;
    return { status: 'approved', latestSubmission, latestCorrection: null, latestApproval };
  }
  if (!submissions.length) return { status: 'awaiting_upload', latestSubmission: null, latestCorrection: null, latestApproval: null };
  const latestSubmission = submissions.reduce((a, b) => (b.version > a.version ? b : a));
  const latestCorrection = corrections.find(c => c.version === latestSubmission.version) ?? null;
  return { status: latestCorrection ? 'correction_requested' : 'submitted', latestSubmission, latestCorrection, latestApproval: null };
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

// Read-only — used by the customer GET status route, the eligibility check
// below, AND the extraction step (extraction must never write to Odoo).
async function loadPoContext(leadId: number, authz: Authz): Promise<PoCustomerView & { requestName: string }> {
  const domain = [['id', '=', leadId], ...authzDomain(authz), ['description', 'ilike', PORTAL_REQUEST_MARKER]];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['id', 'name', 'description'] }) as Record<string, unknown>[];
  if (!leads.length) throw new LeadNotFoundError();
  const details = decodeRequestDetails(leads[0].description);

  const { snapshot: pi, response } = await fetchLatestPISnapshotAndResponse(leadId);
  const piConfirmed = !!pi && response?.action === 'confirm';

  const { submissions, corrections, approvals } = await fetchPoMarkers(leadId);
  const { status, latestSubmission, latestCorrection } = poStatusFrom(submissions, corrections, approvals);

  const piSummary: PoPiSummary | null = pi ? {
    quotationNumber: pi.quotationNumber, version: pi.version,
    requestName: details?.requestName ?? (leads[0].name as string),
    mainProduct: details ? `${details.mainProduct.name} × ${details.quantity}` : '',
    deliveryAddress: pi.deliveryAddress,
    untaxedAmount: pi.untaxedAmount, taxAmount: pi.taxAmount, totalAmount: pi.totalAmount,
  } : null;

  return {
    status, version: latestSubmission?.version ?? 0, latestSubmission, latestCorrection,
    piConfirmed, piSummary, requestName: details?.requestName ?? (leads[0].name as string),
  };
}

export async function fetchCustomerPoStatus(leadId: number, authz: Authz): Promise<PoCustomerView> {
  const ctx = await loadPoContext(leadId, authz);
  return ctx;
}

// The single gate every write path (extract AND submit) goes through.
// Extraction is read-only against Odoo but still must not be reachable
// before the PI is confirmed or after the PO is approved/awaiting review —
// the eligibility rule is the same for both steps, per spec §6.
async function assertPoEligibleForWrite(leadId: number, authz: Authz): Promise<{ pi: PIPublishedSnapshot; nextVersion: number }> {
  const ctx = await loadPoContext(leadId, authz);
  if (!ctx.piConfirmed) throw new PoWorkflowError('The PI must be confirmed before uploading a PO.');
  if (ctx.status === 'approved') throw new PoWorkflowError('This PO has already been approved.');
  if (ctx.status === 'submitted') throw new PoWorkflowError('A PO submission is already awaiting InBody review.');

  const { snapshot: pi } = await fetchLatestPISnapshotAndResponse(leadId);
  if (!pi) throw new PoWorkflowError('The PI must be confirmed before uploading a PO.'); // defensive; ctx.piConfirmed already covers this
  return { pi, nextVersion: (ctx.version ?? 0) + 1 };
}

// Step A — extraction only. No Odoo write occurs anywhere in this function.
export async function extractPoPdf(
  leadId: number, fileBuffer: Buffer, filename: string, authz: Authz,
): Promise<ExtractedPoData> {
  if (authz.role !== 'customer') throw new PoWorkflowError('Only a customer can upload a PO.');
  await assertPoEligibleForWrite(leadId, authz);
  validatePdfBytes(fileBuffer, filename);
  return extractPoDataFromPdf(fileBuffer);
}

export interface PoSubmitResult {
  status: PoStatus;
  version: number;
  comparisonWarnings: ComparisonResult[];
}

// Step B — the only place PO data is ever written. `rawInput` is the
// customer's reviewed/corrected values; validatePoSubmission re-checks every
// field from scratch (see lib/po-validation.ts) — nothing from the
// extraction step is trusted just because it round-tripped through the
// browser unedited.
export async function submitPoData(
  leadId: number, rawInput: Record<string, unknown>, authz: Authz, customerEmail: string,
): Promise<PoSubmitResult> {
  if (authz.role !== 'customer') throw new PoWorkflowError('Only a customer can submit PO data.');
  const { pi, nextVersion } = await assertPoEligibleForWrite(leadId, authz);
  const data = validatePoSubmission(rawInput);
  const comparisonWarnings = comparePoToPi(data, pi);

  const record: PoSubmissionRecord = {
    version: nextVersion, data, comparisonWarnings,
    relatedPiVersion: pi.version, relatedPiNumber: pi.quotationNumber,
    submittedAt: new Date().toISOString(), submittedBy: customerEmail,
  };

  const warningCount = comparisonWarnings.filter(w => w.severity !== 'match').length;
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: `<p><b>${PO_SUBMITTED_MARKER}</b>: PO ${escapeHtml(data.poNumber)} submitted (v${nextVersion}) by ${escapeHtml(customerEmail)} `
      + `against confirmed PI ${escapeHtml(pi.quotationNumber)} (v${pi.version}). ${warningCount} comparison warning(s).</p>`
      + encodeMarkerData(PO_SUBMITTED_MARKER, record),
    subtype_xmlid: 'mail.mt_note',
  });

  return { status: 'submitted', version: nextVersion, comparisonWarnings };
}

export interface PoAdminView extends PoCustomerView {
  latestApproval: PoApprovalRecord | null;
  allSubmissions: PoSubmissionRecord[];
  salespersonAssigned: boolean;
}

export async function fetchAdminPoDetail(leadId: number, authz: Authz): Promise<PoAdminView> {
  if (authz.role !== 'admin') throw new PoWorkflowError('Admin access required.');
  await assertCultFitLead(leadId);

  const { snapshot: pi, response } = await fetchLatestPISnapshotAndResponse(leadId);
  const piConfirmed = !!pi && response?.action === 'confirm';
  const { submissions, corrections, approvals } = await fetchPoMarkers(leadId);
  const { status, latestSubmission, latestCorrection, latestApproval } = poStatusFrom(submissions, corrections, approvals);

  const leads = await executeKw('crm.lead', 'read', [[leadId]], { fields: ['name', 'description', 'user_id'] }) as Record<string, unknown>[];
  const details = decodeRequestDetails(leads[0]?.description);
  const piSummary: PoPiSummary | null = pi ? {
    quotationNumber: pi.quotationNumber, version: pi.version,
    requestName: details?.requestName ?? (leads[0]?.name as string ?? ''),
    mainProduct: details ? `${details.mainProduct.name} × ${details.quantity}` : '',
    deliveryAddress: pi.deliveryAddress,
    untaxedAmount: pi.untaxedAmount, taxAmount: pi.taxAmount, totalAmount: pi.totalAmount,
  } : null;

  return {
    status, version: latestSubmission?.version ?? 0, latestSubmission, latestCorrection, latestApproval,
    piConfirmed, piSummary, allSubmissions: submissions.sort((a, b) => a.version - b.version),
    salespersonAssigned: !!(leads[0]?.user_id as OdooTuple),
  };
}

export interface PoApproveResult {
  status: PoStatus;
  poNumberSaved: boolean;
  expectedDeliveryDateSaved: boolean;
}

// Never confirms the sale order, never creates an invoice/picking/delivery —
// only writes two verified-unused native fields (see §2 investigation notes
// in CULTFIT_PORTAL_MASTER_CONTEXT.md) and records the approval marker.
export async function approvePoData(leadId: number, authz: Authz, adminEmail: string): Promise<PoApproveResult> {
  if (authz.role !== 'admin') throw new PoWorkflowError('Admin access required.');
  await assertCultFitLead(leadId);

  const { snapshot: pi, response } = await fetchLatestPISnapshotAndResponse(leadId);
  if (!pi || response?.action !== 'confirm') throw new PoWorkflowError('The PI must be confirmed before approving a PO.');

  const { submissions, corrections, approvals } = await fetchPoMarkers(leadId);
  const { status, latestSubmission } = poStatusFrom(submissions, corrections, approvals);
  if (status === 'approved') throw new PoWorkflowError('This PO has already been approved.');
  if (status !== 'submitted' || !latestSubmission) throw new PoWorkflowError('No PO submission is awaiting approval.');

  // Best-effort: the approval record is the substantive event here — a
  // failure to write the two native fields must not block recording it, but
  // it IS surfaced in the response so the admin isn't left thinking the
  // fields were saved when they weren't.
  let poNumberSaved = false, expectedDeliveryDateSaved = false;
  try {
    const writeVals: Record<string, unknown> = { client_order_ref: latestSubmission.data.poNumber };
    if (latestSubmission.data.expectedDeliveryDate) {
      writeVals.commitment_date = `${latestSubmission.data.expectedDeliveryDate} 00:00:00`;
    }
    await executeKw('sale.order', 'write', [[pi.quotationId], writeVals]);
    poNumberSaved = true;
    expectedDeliveryDateSaved = !!latestSubmission.data.expectedDeliveryDate;
  } catch (e) {
    console.error('[po-approve] failed to write client_order_ref/commitment_date for SO', pi.quotationId, e instanceof Error ? e.message : e);
  }

  const record: PoApprovalRecord = {
    version: latestSubmission.version, approvedAt: new Date().toISOString(), approvedBy: adminEmail,
    poNumberSavedToOdoo: poNumberSaved, expectedDeliveryDateSavedToOdoo: expectedDeliveryDateSaved,
  };
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: `<p><b>${PO_APPROVED_MARKER}</b>: PO ${escapeHtml(latestSubmission.data.poNumber)} (v${latestSubmission.version}) approved by ${escapeHtml(adminEmail)}.</p>`
      + encodeMarkerData(PO_APPROVED_MARKER, record),
    subtype_xmlid: 'mail.mt_note',
  });

  return { status: 'approved', poNumberSaved, expectedDeliveryDateSaved };
}

export interface PoCorrectionResult {
  status: PoStatus;
  activityCreated: boolean;
  warning: string | null;
}

export async function requestPoCorrection(
  leadId: number, rawComment: unknown, authz: Authz, adminEmail: string,
): Promise<PoCorrectionResult> {
  if (authz.role !== 'admin') throw new PoWorkflowError('Admin access required.');
  await assertCultFitLead(leadId);
  const comment = validateCorrectionComment(rawComment);

  const { submissions, corrections, approvals } = await fetchPoMarkers(leadId);
  const { status, latestSubmission } = poStatusFrom(submissions, corrections, approvals);
  if (status === 'approved') throw new PoWorkflowError('This PO has already been approved.');
  if (!latestSubmission) throw new PoWorkflowError('No PO submission to correct.');
  if (status === 'correction_requested') throw new PoWorkflowError('A correction has already been requested for this PO version.');

  // The marker is the substantive record — posted unconditionally, before
  // the best-effort activity attempt below, so a missing salesperson or an
  // activity-creation fault can never cause the correction request itself
  // to go unrecorded.
  const record: PoCorrectionRecord = {
    version: latestSubmission.version, comment, requestedAt: new Date().toISOString(), requestedBy: adminEmail,
  };
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: `<p><b>${PO_CORRECTION_MARKER}</b>: Correction requested on PO v${latestSubmission.version} by ${escapeHtml(adminEmail)}. Comment: ${escapeHtml(comment)}</p>`
      + encodeMarkerData(PO_CORRECTION_MARKER, record),
    subtype_xmlid: 'mail.mt_note',
  });

  const leads = await executeKw('crm.lead', 'read', [[leadId]], { fields: ['user_id'] }) as Record<string, unknown>[];
  const userVal = leads[0]?.user_id as OdooTuple;
  let activityCreated = false;
  let warning: string | null = null;
  if (!userVal) {
    warning = 'No salesperson is assigned to this request — the correction was recorded, but no follow-up activity could be scheduled.';
  } else {
    try {
      const [todoTypes, leadModels] = await Promise.all([
        executeKw('mail.activity.type', 'search_read', [[['name', '=', 'To-Do']]], { fields: ['id'], limit: 1 }) as Promise<{ id: number }[]>,
        executeKw('ir.model', 'search_read', [[['model', '=', 'crm.lead']]], { fields: ['id'], limit: 1 }) as Promise<{ id: number }[]>,
      ]);
      if (todoTypes.length && leadModels.length) {
        await executeKw('mail.activity', 'create', [{
          res_model_id: leadModels[0].id, res_model: 'crm.lead', res_id: leadId,
          activity_type_id: todoTypes[0].id,
          summary: `PO correction requested — v${latestSubmission.version}`,
          note: escapeHtml(comment),
          user_id: userVal[0],
          date_deadline: new Date().toISOString().slice(0, 10),
        }]);
        activityCreated = true;
      }
    } catch (e) {
      console.error('[po-correction] failed to schedule activity for lead', leadId, e instanceof Error ? e.message : e);
      warning = 'The correction was recorded, but the follow-up activity could not be created.';
    }
  }

  return { status: 'correction_requested', activityCreated, warning };
}

// ──── Logistics workflow (Phase 4) ─────────────────────────────────────────
// account.move (invoices) and stock.picking (dispatch) are the sources of
// truth — the portal never creates either. Only three native, side-effect-
// free stock.picking fields are ever written (scheduled_date,
// carrier_tracking_ref, carrier_tracking_url) — never picking state, never
// date_done (Odoo sets that itself on real validation, which this portal
// never triggers), never carrier_id (would require an existing
// delivery.carrier record; courier name is kept as portal metadata text
// instead so logistics can enter any real-world courier without one). No
// sale.order is ever confirmed, no stock is reserved or moved. Everything
// else (courier name, dispatch date, actual delivery date, the portal's
// own richer delivery-status enum, logistics note, invoice selection) lives
// in structured chatter markers on the Opportunity — same zero-new-
// infrastructure pattern as Phase 1-3.

export class LogisticsWorkflowError extends Error {
  constructor(message: string) { super(message); this.name = 'LogisticsWorkflowError'; }
}

export type DeliveryStatus =
  | 'not_started' | 'logistics_processing' | 'ready_to_dispatch'
  | 'dispatched' | 'in_transit' | 'delivered' | 'delivery_issue';

const VALID_DELIVERY_STATUSES: DeliveryStatus[] = [
  'not_started', 'logistics_processing', 'ready_to_dispatch',
  'dispatched', 'in_transit', 'delivered', 'delivery_issue',
];

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
  pickingState: string | null; // Odoo's own state — always read-only here
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
  // The actual machine delivery location — separate from the PO's own
  // Billing/Shipping Address (never overwritten by this). No safe native
  // Odoo text field exists for an arbitrary per-order dispatch address
  // (crm.lead.shipping_address_id, sale.order.partner_shipping_id,
  // stock.picking.partner_id/warehouse_address_id/customer_id/
  // customer_billing_id are all many2one to res.partner — investigated
  // live; using them would require creating/reusing a partner record,
  // which this app never does), so it's portal metadata, same as the rest
  // of DispatchInfo. 'po_shipping_fallback' means nothing has been
  // explicitly saved yet and this is only a display default from the PO's
  // Shipping Address — an explicit save always wins from then on.
  dispatchAddress: string | null;
  dispatchAddressSource: 'explicit' | 'po_shipping_fallback' | 'none';
}

interface DispatchMetadataRecord {
  dispatchDate: string | null;
  courier: string | null;
  awb: string | null;
  trackingUrl: string | null;
  expectedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  deliveryStatus: DeliveryStatus;
  logisticsNote: string | null;
  dispatchAddress: string | null;
  updatedAt: string;
  updatedBy: string;
}

interface InvoiceLinkRecord {
  invoiceId: number;
  linkedAt: string;
  linkedBy: string;
}

const LOGISTICS_UPDATED_MARKER = 'PORTAL_LOGISTICS_UPDATED';
const INVOICE_LINKED_MARKER = 'PORTAL_INVOICE_LINKED';
const DISPATCHED_MARKER = 'PORTAL_DISPATCHED';
const DELIVERED_MARKER = 'PORTAL_DELIVERED';

// Resolves the sale.order ids reachable from an authorized lead — the same
// ownership root every invoice/picking lookup below starts from, so a
// logistics/admin/customer id can never be used to reach a SO outside the
// caller's authorized lead.
async function resolveOrderSoIds(leadId: number, authz: Authz): Promise<number[]> {
  const domain = [['id', '=', leadId], ...authzDomain(authz)];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['order_ids'] }) as { order_ids: number[] }[];
  if (!leads.length) throw new LeadNotFoundError();
  return leads[0].order_ids || [];
}

// Only "real" invoices are ever candidates: posted (not draft/cancelled —
// a draft could still change), out_invoice (never a credit note — a
// refund is not "the bill" a customer downloads), and independently
// re-verified against the CultFit commercial partner even though the SO
// itself is already lead-scoped, since invoice_ids is a many2many that
// nothing stops Odoo staff from linking unusually.
async function fetchOrderInvoiceCandidates(soIds: number[], authz: Authz): Promise<LogisticsInvoiceSummary[]> {
  if (!soIds.length) return [];
  const sos = await executeKw('sale.order', 'read', [soIds], { fields: ['invoice_ids'] }) as { invoice_ids: number[] }[];
  const invIds = [...new Set(sos.flatMap(s => s.invoice_ids || []))];
  if (!invIds.length) return [];

  const partnerId = resolveCultFitPartnerId(authz);
  const invoices = await executeKw('account.move', 'search_read', [[
    ['id', 'in', invIds], ['move_type', '=', 'out_invoice'], ['state', '=', 'posted'],
    ['partner_id.commercial_partner_id', '=', partnerId],
  ]], {
    fields: ['id', 'name', 'invoice_date', 'invoice_date_due', 'amount_untaxed', 'amount_tax', 'amount_total', 'payment_state', 'state', 'currency_id'],
    order: 'invoice_date desc',
  }) as Record<string, unknown>[];

  return invoices.map(inv => ({
    id: inv.id as number, name: (inv.name as string) || `INV-${inv.id}`,
    invoiceDate: parseDate(inv.invoice_date), dueDate: parseDate(inv.invoice_date_due),
    untaxedAmount: (inv.amount_untaxed as number) || 0, taxAmount: (inv.amount_tax as number) || 0,
    totalAmount: (inv.amount_total as number) || 0,
    paymentState: (inv.payment_state as string) || 'not_paid', state: inv.state as string,
    currency: (inv.currency_id as OdooTuple) ? (inv.currency_id as [number, string])[1] : 'INR',
  }));
}

// The real, outgoing (never return/incoming) delivery picking — verified
// live that a real CultFit sale order can carry both an outgoing delivery
// AND a separate return picking; only the outgoing one is ever "the"
// dispatch this feature tracks.
async function fetchOutgoingPicking(soIds: number[]): Promise<Record<string, unknown> | null> {
  if (!soIds.length) return null;
  const pickings = await executeKw('stock.picking', 'search_read', [[
    ['sale_id', 'in', soIds], ['picking_type_id.code', '=', 'outgoing'],
  ]], {
    fields: ['id', 'name', 'state', 'scheduled_date', 'date_done', 'carrier_tracking_ref', 'carrier_tracking_url'],
    order: 'id desc', limit: 1,
  }) as Record<string, unknown>[];
  return pickings[0] ?? null;
}

async function fetchDispatchMetadata(leadId: number): Promise<DispatchMetadataRecord | null> {
  const messages = await executeKw('mail.message', 'search_read', [[
    ['res_id', '=', leadId], ['model', '=', 'crm.lead'],
    '|', '|', ['body', 'ilike', LOGISTICS_UPDATED_MARKER], ['body', 'ilike', DISPATCHED_MARKER], ['body', 'ilike', DELIVERED_MARKER],
  ]], { fields: ['body', 'date'] }) as { body: string; date: string }[];

  let latest: DispatchMetadataRecord | null = null;
  let latestDate = '';
  for (const m of messages) {
    const rec = decodeMarkerData<DispatchMetadataRecord>(LOGISTICS_UPDATED_MARKER, m.body)
      ?? decodeMarkerData<DispatchMetadataRecord>(DISPATCHED_MARKER, m.body)
      ?? decodeMarkerData<DispatchMetadataRecord>(DELIVERED_MARKER, m.body);
    if (rec && m.date > latestDate) { latest = rec; latestDate = m.date; }
  }
  return latest;
}

// Merges the native picking (when one exists — always the source of truth
// for scheduled_date/tracking ref/url and the read-only Odoo state) with
// portal metadata (source of truth for everything Odoo has no field for:
// courier name, our own richer delivery-status enum, actual delivery date,
// the logistics note). Metadata always wins for the fields Odoo doesn't
// have; the picking always wins for the fields it does, since Odoo staff
// may also edit a picking directly outside the portal.
function buildDispatchInfo(
  picking: Record<string, unknown> | null, meta: DispatchMetadataRecord | null,
  poShippingAddressFallback: string | null = null,
): DispatchInfo {
  const explicitDispatchAddress = meta?.dispatchAddress ?? null;
  return {
    pickingId: picking ? (picking.id as number) : null,
    pickingName: picking ? (picking.name as string) : null,
    pickingState: picking ? (picking.state as string) : null,
    dispatchDate: meta?.dispatchDate ?? null,
    courier: meta?.courier ?? null,
    awb: (picking?.carrier_tracking_ref as string) || meta?.awb || null,
    trackingUrl: (picking?.carrier_tracking_url as string) || meta?.trackingUrl || null,
    expectedDeliveryDate: parseDate(picking?.scheduled_date) ?? meta?.expectedDeliveryDate ?? null,
    actualDeliveryDate: meta?.actualDeliveryDate ?? parseDate(picking?.date_done),
    // A completed real picking is hard evidence the order was actually
    // delivered, even if no logistics user has ever touched this order in
    // the portal (true for most historical orders) — defaulting to
    // 'not_started' here previously contradicted the actualDeliveryDate
    // above, which already read the same picking.date_done.
    deliveryStatus: meta?.deliveryStatus ?? (picking?.state === 'done' ? 'delivered' : 'not_started'),
    logisticsNote: meta?.logisticsNote ?? null,
    updatedAt: meta?.updatedAt ?? null,
    updatedBy: meta?.updatedBy ?? null,
    // Explicit saved value always wins; only falls back to the PO Shipping
    // Address (informational default, never written back anywhere) when
    // nothing has been explicitly saved yet.
    dispatchAddress: explicitDispatchAddress ?? poShippingAddressFallback ?? null,
    dispatchAddressSource: explicitDispatchAddress ? 'explicit' : poShippingAddressFallback ? 'po_shipping_fallback' : 'none',
  };
}

// Pure helper — given the same PO submission records every PO UI already
// reduces to "the current one" (poStatusFrom), returns just the Shipping
// Address for the dispatch-address fallback. Never the source of truth for
// PO status itself; callers that already computed poStatusFrom should reuse
// its latestSubmission directly instead of calling this a second time.
function latestPoShippingAddress(
  submissions: PoSubmissionRecord[], corrections: PoCorrectionRecord[], approvals: PoApprovalRecord[],
): string | null {
  return poStatusFrom(submissions, corrections, approvals).latestSubmission?.data.shippingAddress ?? null;
}

async function fetchInvoiceLink(leadId: number): Promise<InvoiceLinkRecord | null> {
  const messages = await executeKw('mail.message', 'search_read', [[
    ['res_id', '=', leadId], ['model', '=', 'crm.lead'], ['body', 'ilike', INVOICE_LINKED_MARKER],
  ]], { fields: ['body', 'date'] }) as { body: string; date: string }[];
  let latest: InvoiceLinkRecord | null = null;
  let latestDate = '';
  for (const m of messages) {
    const rec = decodeMarkerData<InvoiceLinkRecord>(INVOICE_LINKED_MARKER, m.body);
    if (rec && m.date > latestDate) { latest = rec; latestDate = m.date; }
  }
  return latest;
}

// Resolution rule: an explicit logistics selection wins as long as it still
// points at a currently-valid candidate (an invoice can be cancelled after
// being selected); otherwise, auto-resolve only when unambiguous (exactly
// one valid candidate) — never guess between two real invoices.
function resolveSelectedInvoice(candidates: LogisticsInvoiceSummary[], link: InvoiceLinkRecord | null): LogisticsInvoiceSummary | null {
  if (link) {
    const linked = candidates.find(c => c.id === link.invoiceId);
    if (linked) return linked;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export interface LogisticsOrderSummary {
  id: number;
  name: string;
  customer: string | null;
  mainProduct: string | null;
  salesperson: string | null;
  poStatus: PoStatus;
  // True only when this order was actually submitted through the portal's
  // own New Order Request / PO flow. Most real CultFit orders predate the
  // portal and were never expected to go through it — for those,
  // poStatus is technically 'awaiting_upload' (no portal submission ever
  // happened) but displaying that as "Awaiting PO" would wrongly suggest
  // action is needed on an order that may already be fully delivered.
  // The UI uses this flag to show a neutral "Not tracked in portal" state
  // instead, for historical orders only — poStatus itself is untouched.
  isPortalRequest: boolean;
  invoiceStatus: 'not_created' | 'needs_selection' | 'available';
  deliveryStatus: DeliveryStatus;
  courier: string | null;
  awb: string | null;
  expectedDeliveryDate: string | null;
  lastUpdated: string | null;
}

export async function fetchLogisticsOrderList(authz: Authz): Promise<LogisticsOrderSummary[]> {
  if (authz.role !== 'admin' && authz.role !== 'logistics') throw new LogisticsWorkflowError('Logistics access required.');
  const domain = authzDomain(authz);
  const leads = await executeKw('crm.lead', 'search_read', [domain], {
    fields: LEAD_FIELDS, order: 'id desc', limit: 500,
  }) as Record<string, unknown>[];

  const soAggMap = await fetchSoAggregates(leads);
  const leadIds = leads.map(l => l.id as number);
  const [poMap] = await Promise.all([fetchPOStatusMap(leadIds)]);

  // Batched across all leads — one pass over every linked sale.order's
  // invoice/picking ids rather than a query per lead.
  const allSoIds = [...new Set(leads.flatMap(l => (l.order_ids as number[]) || []))];
  const soData = allSoIds.length
    ? await executeKw('sale.order', 'read', [allSoIds], { fields: ['id', 'invoice_ids'] }) as { id: number; invoice_ids: number[] }[]
    : [];
  const soInvoiceMap = new Map(soData.map(s => [s.id, s.invoice_ids || []]));

  const partnerId = resolveCultFitPartnerId(authz);
  const allInvIds = [...new Set(soData.flatMap(s => s.invoice_ids || []))];
  const validInvIds = allInvIds.length
    ? new Set((await executeKw('account.move', 'search_read', [[
      ['id', 'in', allInvIds], ['move_type', '=', 'out_invoice'], ['state', '=', 'posted'],
      ['partner_id.commercial_partner_id', '=', partnerId],
    ]], { fields: ['id'] }) as { id: number }[]).map(i => i.id))
    : new Set<number>();

  const outgoingPickings = allSoIds.length
    ? await executeKw('stock.picking', 'search_read', [[
      ['sale_id', 'in', allSoIds], ['picking_type_id.code', '=', 'outgoing'],
    ]], { fields: ['id', 'sale_id', 'state', 'date_done', 'carrier_tracking_ref', 'carrier_tracking_url', 'scheduled_date'], order: 'id desc' }) as Record<string, unknown>[]
    : [];
  const pickingBySoId = new Map<number, Record<string, unknown>>();
  for (const p of outgoingPickings) {
    const soId = (p.sale_id as OdooTuple) ? (p.sale_id as [number, string])[0] : null;
    if (soId && !pickingBySoId.has(soId)) pickingBySoId.set(soId, p);
  }

  const dispatchMetaEntries = await Promise.all(leadIds.map(id => fetchDispatchMetadata(id).then(m => [id, m] as const)));
  const dispatchMetaMap = new Map(dispatchMetaEntries);

  return leads.map(lead => {
    const leadId = lead.id as number;
    const built = buildLead(lead, soAggMap.get(leadId));
    const details = decodeRequestDetails(lead.description);
    const soIds = (lead.order_ids as number[]) || [];

    let invoiceStatus: LogisticsOrderSummary['invoiceStatus'] = 'not_created';
    const validCount = soIds.flatMap(id => soInvoiceMap.get(id) || []).filter(id => validInvIds.has(id)).length;
    if (validCount === 1) invoiceStatus = 'available';
    else if (validCount > 1) invoiceStatus = 'needs_selection';

    const picking = soIds.map(id => pickingBySoId.get(id)).find(Boolean) ?? null;
    const meta = dispatchMetaMap.get(leadId) ?? null;
    const dispatch = buildDispatchInfo(picking ?? null, meta ?? null);

    return {
      id: leadId, name: (lead.name as string) || `CRM-${leadId}`,
      customer: built.customer as string | null,
      mainProduct: details?.mainProduct.name ?? (soAggMap.get(leadId)?.modelNames.join(', ') || null),
      salesperson: built.salesperson as string | null,
      poStatus: poMap.get(leadId) ?? 'awaiting_upload',
      isPortalRequest: details !== null,
      invoiceStatus,
      deliveryStatus: dispatch.deliveryStatus,
      courier: dispatch.courier,
      awb: dispatch.awb,
      expectedDeliveryDate: dispatch.expectedDeliveryDate,
      lastUpdated: parseDate(lead.write_date),
    };
  });
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

export async function fetchLogisticsOrderDetail(id: number, authz: Authz): Promise<LogisticsOrderDetail | null> {
  if (authz.role !== 'admin' && authz.role !== 'logistics') throw new LogisticsWorkflowError('Logistics access required.');
  const domain = [['id', '=', id], ...authzDomain(authz)];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: [...LEAD_FIELDS, 'stage_id', 'description'] }) as Record<string, unknown>[];
  if (!leads.length) return null;
  const lead = leads[0];
  const soIds = (lead.order_ids as number[]) || [];

  const [snapshotResp, poCtx, invoiceCandidates, picking, meta, invoiceLink, timelineMessages] = await Promise.all([
    fetchLatestPISnapshotAndResponse(id),
    (async () => {
      const { submissions } = await fetchPoMarkers(id);
      return submissions.length ? submissions.reduce((a, b) => (b.version > a.version ? b : a)) : null;
    })(),
    fetchOrderInvoiceCandidates(soIds, authz),
    fetchOutgoingPicking(soIds),
    fetchDispatchMetadata(id),
    fetchInvoiceLink(id),
    executeKw('mail.message', 'search_read', [[['res_id', '=', id], ['model', '=', 'crm.lead']]], { fields: ['date', 'author_id', 'body'], order: 'date desc', limit: 30 }) as Promise<Record<string, unknown>[]>,
  ]);

  const { submissions, corrections, approvals } = await fetchPoMarkers(id);
  const poStatusResult = poStatusFrom(submissions, corrections, approvals);

  const stageVal = lead.stage_id as OdooTuple;
  const timeline = timelineMessages
    .map(m => ({
      date: m.date ? String(m.date) : null,
      author: (m.author_id as OdooTuple) ? (m.author_id as [number, string])[1] : 'Odoo',
      body: stripHtml(String(m.body ?? '')),
    }))
    .filter(m => m.body);

  return {
    id, name: (lead.name as string) || `CRM-${id}`,
    customer: (lead.partner_id as OdooTuple) ? (lead.partner_id as [number, string])[1] : null,
    requestDetails: decodeRequestDetails(lead.description),
    salesperson: (lead.user_id as OdooTuple) ? (lead.user_id as [number, string])[1] : null,
    crmStage: stageVal ? stageVal[1] : null,
    publishedPI: snapshotResp.snapshot,
    poStatus: poStatusResult.status,
    approvedPoSummary: poCtx,
    invoiceCandidates,
    selectedInvoice: resolveSelectedInvoice(invoiceCandidates, invoiceLink),
    dispatch: buildDispatchInfo(picking, meta, poStatusResult.latestSubmission?.data.shippingAddress ?? null),
    timeline,
  };
}

export async function selectOrderInvoice(leadId: number, invoiceId: unknown, authz: Authz, userEmail: string): Promise<LogisticsInvoiceSummary> {
  if (authz.role !== 'admin' && authz.role !== 'logistics') throw new LogisticsWorkflowError('Logistics access required.');
  const invId = Number(invoiceId);
  if (!Number.isInteger(invId) || invId <= 0) throw new LogisticsWorkflowError('A valid invoice ID is required.');

  const soIds = await resolveOrderSoIds(leadId, authz);
  const candidates = await fetchOrderInvoiceCandidates(soIds, authz);
  const match = candidates.find(c => c.id === invId);
  if (!match) throw new LogisticsWorkflowError('That invoice is not linked to this request, or is not a valid posted invoice.');

  const record: InvoiceLinkRecord = { invoiceId: invId, linkedAt: new Date().toISOString(), linkedBy: userEmail };
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: `<p><b>${INVOICE_LINKED_MARKER}</b>: Invoice ${escapeHtml(match.name)} linked by ${escapeHtml(userEmail)}.</p>`
      + encodeMarkerData(INVOICE_LINKED_MARKER, record),
    subtype_xmlid: 'mail.mt_note',
  });
  return match;
}

export interface DispatchUpdateInput {
  dispatchDate?: unknown;
  courier?: unknown;
  awb?: unknown;
  trackingUrl?: unknown;
  expectedDeliveryDate?: unknown;
  actualDeliveryDate?: unknown;
  deliveryStatus?: unknown;
  logisticsNote?: unknown;
  dispatchAddress?: unknown;
}

const MAX_LOGISTICS_TEXT = { courier: 120, awb: 60, note: 1000, address: 500 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optDateField(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new LogisticsWorkflowError(`${field} must be a valid date.`);
  return v;
}

// Rejects text that's too long rather than silently truncating it — matches
// the convention already established in po-validation.ts. A silent truncate
// would let a logistics user believe a full note saved when only part of it
// did.
function optTextField(v: unknown, max: number, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new LogisticsWorkflowError(`${field} must be text.`);
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new LogisticsWorkflowError(`${field} must be ${max} characters or fewer.`);
  return trimmed;
}

// Only http(s) allowed — rejects javascript:, data:, and any other scheme a
// malicious tracking URL could use, since this value is later rendered as a
// clickable link in both the logistics and customer UI.
function safeTrackingUrl(v: unknown): string | null {
  const s = optTextField(v, 500, 'Tracking URL');
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LogisticsWorkflowError('Tracking URL must be a valid http(s) link.');
    return u.toString();
  } catch (e) {
    if (e instanceof LogisticsWorkflowError) throw e;
    throw new LogisticsWorkflowError('Tracking URL must be a valid http(s) link.');
  }
}

// A field omitted from the request body (undefined) keeps its previously
// saved value; a field explicitly sent as null/'' clears it. Only a field
// that's actually present and invalid is rejected. This is what makes
// updateDispatchInfo a real partial update rather than a full replace that
// would silently blank out every field the caller didn't happen to send.
function mergeField<T>(v: unknown, existing: T | null, compute: () => T | null): T | null {
  return v === undefined ? existing : compute();
}

// The only server-side entry point for any dispatch write — every field is
// re-validated from scratch here regardless of what the client sent.
// Writes the three safe native picking fields when a picking exists
// (never picking state, never date_done, never carrier_id — see file
// header), and always records the full picture in portal metadata, which
// is what both the logistics and customer views actually read from for
// every field Odoo has no equivalent of.
export async function updateDispatchInfo(
  leadId: number, input: DispatchUpdateInput, authz: Authz, userEmail: string,
): Promise<DispatchInfo> {
  if (authz.role !== 'admin' && authz.role !== 'logistics') throw new LogisticsWorkflowError('Logistics access required.');

  const soIds = await resolveOrderSoIds(leadId, authz);
  const picking = await fetchOutgoingPicking(soIds);
  const existing = await fetchDispatchMetadata(leadId);

  if (input.deliveryStatus !== undefined
    && !(typeof input.deliveryStatus === 'string' && VALID_DELIVERY_STATUSES.includes(input.deliveryStatus as DeliveryStatus))) {
    throw new LogisticsWorkflowError('Invalid delivery status.');
  }
  const deliveryStatus: DeliveryStatus = input.deliveryStatus === undefined
    ? (existing?.deliveryStatus ?? 'not_started')
    : input.deliveryStatus as DeliveryStatus;

  const record: DispatchMetadataRecord = {
    dispatchDate: mergeField(input.dispatchDate, existing?.dispatchDate ?? null, () => optDateField(input.dispatchDate, 'Dispatch date')),
    courier: mergeField(input.courier, existing?.courier ?? null, () => optTextField(input.courier, MAX_LOGISTICS_TEXT.courier, 'Courier')),
    awb: mergeField(input.awb, existing?.awb ?? null, () => optTextField(input.awb, MAX_LOGISTICS_TEXT.awb, 'AWB / tracking number')),
    trackingUrl: mergeField(input.trackingUrl, existing?.trackingUrl ?? null, () => safeTrackingUrl(input.trackingUrl)),
    expectedDeliveryDate: mergeField(input.expectedDeliveryDate, existing?.expectedDeliveryDate ?? null, () => optDateField(input.expectedDeliveryDate, 'Expected delivery date')),
    actualDeliveryDate: mergeField(input.actualDeliveryDate, existing?.actualDeliveryDate ?? null, () => optDateField(input.actualDeliveryDate, 'Actual delivery date')),
    deliveryStatus,
    logisticsNote: mergeField(input.logisticsNote, existing?.logisticsNote ?? null, () => optTextField(input.logisticsNote, MAX_LOGISTICS_TEXT.note, 'Logistics note')),
    dispatchAddress: mergeField(input.dispatchAddress, existing?.dispatchAddress ?? null, () => optTextField(input.dispatchAddress, MAX_LOGISTICS_TEXT.address, 'Dispatch / Final Delivery Address')),
    updatedAt: new Date().toISOString(), updatedBy: userEmail,
  };

  // Best-effort native write — a failure here must not lose the portal
  // metadata update, which is the record both UIs actually read from.
  if (picking) {
    try {
      const writeVals: Record<string, unknown> = {};
      if (record.awb) writeVals.carrier_tracking_ref = record.awb;
      if (record.trackingUrl) writeVals.carrier_tracking_url = record.trackingUrl;
      if (record.expectedDeliveryDate) writeVals.scheduled_date = `${record.expectedDeliveryDate} 00:00:00`;
      if (Object.keys(writeVals).length) await executeKw('stock.picking', 'write', [[picking.id], writeVals]);
    } catch (e) {
      console.error('[logistics] failed to write safe picking fields for SO', leadId, e instanceof Error ? e.message : e);
    }
  }

  // Marker choice is presentation/timeline-only (all three decode via the
  // same DispatchMetadataRecord shape) — DELIVERED/DISPATCHED just make the
  // chatter/timeline read naturally at those specific transitions.
  const marker = deliveryStatus === 'delivered' ? DELIVERED_MARKER
    : (deliveryStatus === 'dispatched' || deliveryStatus === 'in_transit') ? DISPATCHED_MARKER
    : LOGISTICS_UPDATED_MARKER;
  const label = deliveryStatus === 'delivered' ? 'Delivered' : deliveryStatus === 'dispatched' ? 'Dispatched' : 'Logistics info updated';
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: `<p><b>${marker}</b>: ${escapeHtml(label)} by ${escapeHtml(userEmail)}.</p>` + encodeMarkerData(marker, record),
    subtype_xmlid: 'mail.mt_note',
  });

  const { submissions, corrections, approvals } = await fetchPoMarkers(leadId);
  return buildDispatchInfo(picking, record, latestPoShippingAddress(submissions, corrections, approvals));
}

export interface CustomerLogisticsView {
  invoice: LogisticsInvoiceSummary | null;
  invoiceStatus: 'not_created' | 'needs_selection' | 'available';
  dispatch: DispatchInfo;
}

// Deliberately NOT filtered to PORTAL_REQUEST_MARKER (unlike the Phase 1-3
// "My Requests" fetch) — most real CultFit orders predate the portal and
// were never submitted through it, but they have real Odoo invoices/
// pickings all the same. Scoping this to portal-submitted requests only
// would hide real billing/dispatch data from the customer for the majority
// of their actual orders. Ownership is still fully enforced by
// authzDomain(authz) alone, identical to how /orders/[id] itself is scoped.
export async function fetchCustomerLogisticsView(leadId: number, authz: Authz): Promise<CustomerLogisticsView> {
  const domain = [['id', '=', leadId], ...authzDomain(authz)];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['order_ids'] }) as { order_ids: number[] }[];
  if (!leads.length) throw new LeadNotFoundError();
  const soIds = leads[0].order_ids || [];

  const [candidates, link, picking, meta, poMarkers] = await Promise.all([
    fetchOrderInvoiceCandidates(soIds, authz),
    fetchInvoiceLink(leadId),
    fetchOutgoingPicking(soIds),
    fetchDispatchMetadata(leadId),
    fetchPoMarkers(leadId),
  ]);

  const selected = resolveSelectedInvoice(candidates, link);
  return {
    invoice: selected,
    invoiceStatus: selected ? 'available' : candidates.length > 1 ? 'needs_selection' : 'not_created',
    dispatch: buildDispatchInfo(picking, meta, latestPoShippingAddress(poMarkers.submissions, poMarkers.corrections, poMarkers.approvals)),
  };
}

// Root cause of the "invoice download doesn't work" bug (found by checking
// live production data, not guessed): this used to require a pre-existing
// ir.attachment on the account.move record. Odoo only creates that
// attachment if a staff member manually printed/emailed that specific
// invoice from Odoo's own UI at some point — verified live that 0 of the 30
// most recent real posted CultFit invoices have one. Every real download
// was hitting the empty-attachment branch and 404ing.
// Fixed the same way fetchNativeOdooPdf (above) already fixed the identical
// problem for quotations: fetch Odoo's own native invoice report on demand
// through its public customer-portal controller (part of stock Odoo's
// `account`/`portal` modules — /my/invoices/<id>, sibling to /my/orders/<id>),
// which validates via a per-invoice access_token instead of the backend
// session login this portal's API account doesn't have. Verified live
// (id 101660, INV/26-27/0467): returns a real 108,991-byte
// application/pdf. account.move.access_token is the same lazily-generated
// portal.mixin field sale.order.access_token already is — generated and
// written here only when missing, exactly like fetchNativeOdooPdf does.
async function fetchNativeOdooInvoicePdf(invoiceId: number): Promise<Buffer> {
  const invs = await executeKw('account.move', 'read', [[invoiceId]], { fields: ['access_token'] }) as { access_token: string | false }[];
  let token = invs[0]?.access_token || '';
  if (!token) {
    token = randomUUID();
    await executeKw('account.move', 'write', [[invoiceId], { access_token: token }]);
  }

  const url = `${ODOO_URL}/my/invoices/${invoiceId}?report_type=pdf&access_token=${encodeURIComponent(token)}&download=true`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } catch (e) {
    throw new OdooUnavailableError(e);
  } finally {
    clearTimeout(timeout);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (!resp.ok || !contentType.includes('application/pdf')) {
    throw new PIWorkflowError('Could not generate the invoice PDF. Please try again later.');
  }
  return Buffer.from(await resp.arrayBuffer());
}

// Secure download for the customer — the invoice id comes only from the
// server-resolved selection (never a client-supplied id), and is still
// re-verified belongs to this lead's sale order(s) and the CultFit partner
// before any bytes are read (fetchOrderInvoiceCandidates already filters to
// move_type='out_invoice' + state='posted' + the CultFit commercial
// partner — credit notes, drafts, and cancelled invoices never appear in
// `candidates`, so they can never be selected/re-verified here). Same
// ownership-check discipline as fetchAttachmentData/fetchPIPdfData above.
export async function fetchInvoicePdfData(leadId: number, authz: Authz): Promise<{ data: Buffer; filename: string }> {
  const view = await fetchCustomerLogisticsView(leadId, authz);
  if (!view.invoice) throw new LeadNotFoundError();

  const soIds = await resolveOrderSoIds(leadId, authz);
  const candidates = await fetchOrderInvoiceCandidates(soIds, authz);
  if (!candidates.some(c => c.id === view.invoice!.id)) throw new LeadNotFoundError();

  const data = await fetchNativeOdooInvoicePdf(view.invoice.id);
  return {
    data,
    filename: `Invoice-${view.invoice.name.replace(/[^A-Za-z0-9-]/g, '')}.pdf`,
  };
}

// ──── Installation workflow (Phase 5 — CS / Customer Care) ────────────────────
//
// Read-only investigation before writing any of this (see PORTAL_ENVIRONMENT.md
// / CULTFIT_PORTAL_MASTER_CONTEXT.md for the full findings) confirmed there is
// no reliable, already-used native mechanism for installation tracking on
// CultFit orders specifically:
//   - crm.lead.cs_person (many2one res.users, "CS Person") is real and
//     semantically exactly this, but is empty on every real CultFit order
//     checked — never populated in practice. Writing to it from the portal
//     would be the first thing to ever touch this field operationally, with
//     no visibility into whether other automation (activity assignment,
//     notifications) reacts to it. Left read-only/unused rather than risking
//     a surprise side effect on a core, heavily-automated model.
//   - crm.lead.x_studio_machine_installed_at looks installation-related by
//     name but is actually a location-TYPE classifier (Gym/Clinic/Hospital/
//     Home/...), unrelated to installation status. Not used.
//   - stock.picking.is_installation_required (boolean) is real and populated
//     true on every real CultFit outgoing delivery checked — reused below as
//     read-only context only, never written.
//   - stock.picking.installation_count is always 0 on every real CultFit
//     order — it counts linked project.task records, and none exist.
//   - project.task has a genuine sale_order_id FK and is actively used
//     elsewhere in this Odoo instance (364 records), but zero are linked to
//     any real CultFit sale order — not the mechanism actually used here,
//     and auto-creating one from the portal would be creating a new Odoo
//     business record, which the spec explicitly disallows.
//   - account.move.is_sale_installed (boolean) is real and true on the real
//     CultFit invoices checked — a reasonable coarse hint, but boolean-only
//     (no date/installer/notes), so it can't carry the full status/schedule/
//     notes model this phase needs. Not integrated.
//   - installation.data is a real, purpose-built physical-installation
//     checklist model (installer name, date, LCD/adapter/grounding checks),
//     but only 1 record exists system-wide and it links only via partner_id
//     + lot_id/serial number — no crm.lead/sale.order FK at all. Too
//     unreliable to build on.
//   - maintenance.equipment / maintenance.request don't exist (Maintenance
//     app not installed). calendar.event exists and is heavily used
//     elsewhere, but not for CultFit installation — not integrated, to avoid
//     introducing a second scheduling surface beyond the portal's own
//     Scheduled Date/Time fields.
//
// Conclusion: same pattern as Phase 4 dispatch — no native field is both
// reliably linked AND safe to write, so status/schedule/notes/completion
// live entirely in structured chatter metadata, versioned and never
// overwritten (latest-by-date wins on read, same as dispatch metadata).
// is_installation_required is read from the linked picking purely as
// display context.

export class CsWorkflowError extends Error {
  constructor(message: string) { super(message); this.name = 'CsWorkflowError'; }
}

export type InstallationStatus = 'not_scheduled' | 'scheduled' | 'in_progress' | 'installed' | 'completed';

const VALID_INSTALLATION_STATUSES: InstallationStatus[] = [
  'not_scheduled', 'scheduled', 'in_progress', 'installed', 'completed',
];

export interface InstallationInfo {
  status: InstallationStatus;
  scheduledDate: string | null;
  scheduledTime: string | null;
  assignedCs: string | null;
  installationNotes: string | null;
  completedOn: string | null;
  completionNotes: string | null;
  installationRequired: boolean | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface InstallationMetadataRecord {
  status: InstallationStatus;
  scheduledDate: string | null;
  scheduledTime: string | null;
  assignedCs: string | null;
  installationNotes: string | null;
  completedOn: string | null;
  completionNotes: string | null;
  updatedAt: string;
  updatedBy: string;
}

const INSTALLATION_SCHEDULED_MARKER = 'PORTAL_INSTALLATION_SCHEDULED';
const INSTALLATION_UPDATED_MARKER = 'PORTAL_INSTALLATION_UPDATED';
const INSTALLATION_STARTED_MARKER = 'PORTAL_INSTALLATION_STARTED';
const INSTALLATION_COMPLETED_MARKER = 'PORTAL_INSTALLATION_COMPLETED';

async function fetchInstallationMetadata(leadId: number): Promise<InstallationMetadataRecord | null> {
  const messages = await executeKw('mail.message', 'search_read', [[
    ['res_id', '=', leadId], ['model', '=', 'crm.lead'],
    '|', '|', '|',
    ['body', 'ilike', INSTALLATION_SCHEDULED_MARKER], ['body', 'ilike', INSTALLATION_UPDATED_MARKER],
    ['body', 'ilike', INSTALLATION_STARTED_MARKER], ['body', 'ilike', INSTALLATION_COMPLETED_MARKER],
  ]], { fields: ['body', 'date'] }) as { body: string; date: string }[];

  let latest: InstallationMetadataRecord | null = null;
  let latestDate = '';
  for (const m of messages) {
    const rec = decodeMarkerData<InstallationMetadataRecord>(INSTALLATION_SCHEDULED_MARKER, m.body)
      ?? decodeMarkerData<InstallationMetadataRecord>(INSTALLATION_UPDATED_MARKER, m.body)
      ?? decodeMarkerData<InstallationMetadataRecord>(INSTALLATION_STARTED_MARKER, m.body)
      ?? decodeMarkerData<InstallationMetadataRecord>(INSTALLATION_COMPLETED_MARKER, m.body);
    if (rec && m.date > latestDate) { latest = rec; latestDate = m.date; }
  }
  return latest;
}

function buildInstallationInfo(picking: Record<string, unknown> | null, meta: InstallationMetadataRecord | null): InstallationInfo {
  return {
    status: meta?.status ?? 'not_scheduled',
    scheduledDate: meta?.scheduledDate ?? null,
    scheduledTime: meta?.scheduledTime ?? null,
    assignedCs: meta?.assignedCs ?? null,
    installationNotes: meta?.installationNotes ?? null,
    completedOn: meta?.completedOn ?? null,
    completionNotes: meta?.completionNotes ?? null,
    installationRequired: picking ? Boolean(picking.is_installation_required) : null,
    updatedAt: meta?.updatedAt ?? null,
    updatedBy: meta?.updatedBy ?? null,
  };
}

// Same batched-picking-fields need as fetchOutgoingPicking, plus the one
// read-only installation context field.
async function fetchOutgoingPickingForInstallation(soIds: number[]): Promise<Record<string, unknown> | null> {
  if (!soIds.length) return null;
  const pickings = await executeKw('stock.picking', 'search_read', [[
    ['sale_id', 'in', soIds], ['picking_type_id.code', '=', 'outgoing'],
  ]], {
    fields: ['id', 'name', 'state', 'scheduled_date', 'date_done', 'carrier_tracking_ref', 'carrier_tracking_url', 'is_installation_required'],
    order: 'id desc', limit: 1,
  }) as Record<string, unknown>[];
  return pickings[0] ?? null;
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

export async function fetchCsOrderList(authz: Authz): Promise<CsOrderSummary[]> {
  if (authz.role !== 'admin' && authz.role !== 'cs') throw new CsWorkflowError('CS access required.');
  const domain = authzDomain(authz);
  const leads = await executeKw('crm.lead', 'search_read', [domain], {
    fields: LEAD_FIELDS, order: 'id desc', limit: 500,
  }) as Record<string, unknown>[];

  const soAggMap = await fetchSoAggregates(leads);
  const leadIds = leads.map(l => l.id as number);

  const allSoIds = [...new Set(leads.flatMap(l => (l.order_ids as number[]) || []))];
  const outgoingPickings = allSoIds.length
    ? await executeKw('stock.picking', 'search_read', [[
      ['sale_id', 'in', allSoIds], ['picking_type_id.code', '=', 'outgoing'],
    ]], { fields: ['id', 'sale_id', 'state', 'date_done', 'is_installation_required'], order: 'id desc' }) as Record<string, unknown>[]
    : [];
  const pickingBySoId = new Map<number, Record<string, unknown>>();
  for (const p of outgoingPickings) {
    const soId = (p.sale_id as OdooTuple) ? (p.sale_id as [number, string])[0] : null;
    if (soId && !pickingBySoId.has(soId)) pickingBySoId.set(soId, p);
  }

  const dispatchMetaEntries = await Promise.all(leadIds.map(id => fetchDispatchMetadata(id).then(m => [id, m] as const)));
  const dispatchMetaMap = new Map(dispatchMetaEntries);
  const installMetaEntries = await Promise.all(leadIds.map(id => fetchInstallationMetadata(id).then(m => [id, m] as const)));
  const installMetaMap = new Map(installMetaEntries);

  return leads.map(lead => {
    const leadId = lead.id as number;
    const built = buildLead(lead, soAggMap.get(leadId));
    const soIds = (lead.order_ids as number[]) || [];
    const picking = soIds.map(id => pickingBySoId.get(id)).find(Boolean) ?? null;

    const dispatch = buildDispatchInfo(picking ?? null, dispatchMetaMap.get(leadId) ?? null);
    const installation = buildInstallationInfo(picking ?? null, installMetaMap.get(leadId) ?? null);

    return {
      id: leadId, name: (lead.name as string) || `CRM-${leadId}`,
      customer: built.customer as string | null,
      mainProduct: soAggMap.get(leadId)?.modelNames.join(', ') || null,
      salesperson: built.salesperson as string | null,
      deliveryStatus: dispatch.deliveryStatus,
      installationStatus: installation.status,
      assignedCs: installation.assignedCs,
      scheduledDate: installation.scheduledDate,
      lastUpdated: parseDate(lead.write_date),
    };
  });
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

export async function fetchCsOrderDetail(id: number, authz: Authz): Promise<CsOrderDetail | null> {
  if (authz.role !== 'admin' && authz.role !== 'cs') throw new CsWorkflowError('CS access required.');
  const domain = [['id', '=', id], ...authzDomain(authz)];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: [...LEAD_FIELDS, 'stage_id', 'description'] }) as Record<string, unknown>[];
  if (!leads.length) return null;
  const lead = leads[0];
  const soIds = (lead.order_ids as number[]) || [];

  const [picking, dispatchMeta, installMeta, timelineMessages, poMarkers] = await Promise.all([
    fetchOutgoingPickingForInstallation(soIds),
    fetchDispatchMetadata(id),
    fetchInstallationMetadata(id),
    executeKw('mail.message', 'search_read', [[['res_id', '=', id], ['model', '=', 'crm.lead']]], { fields: ['date', 'author_id', 'body'], order: 'date desc', limit: 30 }) as Promise<Record<string, unknown>[]>,
    fetchPoMarkers(id),
  ]);

  const stageVal = lead.stage_id as OdooTuple;
  const timeline = timelineMessages
    .map(m => ({
      date: m.date ? String(m.date) : null,
      author: (m.author_id as OdooTuple) ? (m.author_id as [number, string])[1] : 'Odoo',
      body: stripHtml(String(m.body ?? '')),
    }))
    .filter(m => m.body);

  return {
    id, name: (lead.name as string) || `CRM-${id}`,
    customer: (lead.partner_id as OdooTuple) ? (lead.partner_id as [number, string])[1] : null,
    requestDetails: decodeRequestDetails(lead.description),
    salesperson: (lead.user_id as OdooTuple) ? (lead.user_id as [number, string])[1] : null,
    crmStage: stageVal ? stageVal[1] : null,
    dispatch: buildDispatchInfo(picking, dispatchMeta, latestPoShippingAddress(poMarkers.submissions, poMarkers.corrections, poMarkers.approvals)),
    installation: buildInstallationInfo(picking, installMeta),
    timeline,
  };
}

export interface InstallationUpdateInput {
  status: unknown;
  scheduledDate?: unknown;
  scheduledTime?: unknown;
  installationNotes?: unknown;
  completedOn?: unknown;
  completionNotes?: unknown;
}

const MAX_INSTALLATION_TEXT = { time: 20, note: 1000 };

function optInstallationTextField(v: unknown, max: number, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new CsWorkflowError(`${field} must be text.`);
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new CsWorkflowError(`${field} must be ${max} characters or fewer.`);
  return trimmed;
}

// The only server-side entry point for any installation write — every field
// is re-validated from scratch here regardless of what the client sent.
// Never writes any native Odoo field (see the file-header note above for
// why); always records the full picture in portal metadata, which is what
// both the CS and customer views read from. A field omitted from the
// request (undefined) keeps its previously saved value — same partial-merge
// semantics as updateDispatchInfo, so a caller that only changes one field
// can never accidentally blank out the others.
export async function updateInstallationInfo(
  leadId: number, input: InstallationUpdateInput, authz: Authz, userEmail: string,
): Promise<InstallationInfo> {
  if (authz.role !== 'admin' && authz.role !== 'cs') throw new CsWorkflowError('CS access required.');

  const soIds = await resolveOrderSoIds(leadId, authz);
  const picking = await fetchOutgoingPickingForInstallation(soIds);
  const existing = await fetchInstallationMetadata(leadId);

  if (!(typeof input.status === 'string' && VALID_INSTALLATION_STATUSES.includes(input.status as InstallationStatus))) {
    throw new CsWorkflowError('Invalid installation status.');
  }
  const status = input.status as InstallationStatus;

  const record: InstallationMetadataRecord = {
    status,
    scheduledDate: mergeField(input.scheduledDate, existing?.scheduledDate ?? null, () => optDateField(input.scheduledDate, 'Scheduled date')),
    scheduledTime: mergeField(input.scheduledTime, existing?.scheduledTime ?? null, () => optInstallationTextField(input.scheduledTime, MAX_INSTALLATION_TEXT.time, 'Scheduled time')),
    // Not independently settable (no "assign" action was requested) — it's
    // simply whoever first touched this order's installation record, so the
    // customer view has a real, meaningful "Assigned CS" without inventing
    // a reassignment UI nothing asked for.
    assignedCs: existing?.assignedCs ?? userEmail,
    installationNotes: mergeField(input.installationNotes, existing?.installationNotes ?? null, () => optInstallationTextField(input.installationNotes, MAX_INSTALLATION_TEXT.note, 'Installation note')),
    completedOn: mergeField(input.completedOn, existing?.completedOn ?? null, () => optDateField(input.completedOn, 'Completed on')),
    completionNotes: mergeField(input.completionNotes, existing?.completionNotes ?? null, () => optInstallationTextField(input.completionNotes, MAX_INSTALLATION_TEXT.note, 'Completion note')),
    updatedAt: new Date().toISOString(), updatedBy: userEmail,
  };

  const marker = status === 'completed' ? INSTALLATION_COMPLETED_MARKER
    : status === 'in_progress' ? INSTALLATION_STARTED_MARKER
    : status === 'scheduled' && !existing ? INSTALLATION_SCHEDULED_MARKER
    : INSTALLATION_UPDATED_MARKER;
  const label = status === 'completed' ? 'Installation completed' : status === 'in_progress' ? 'Installation started' : status === 'scheduled' ? 'Installation scheduled' : 'Installation info updated';
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: `<p><b>${marker}</b>: ${escapeHtml(label)} by ${escapeHtml(userEmail)}.</p>` + encodeMarkerData(marker, record),
    subtype_xmlid: 'mail.mt_note',
  });

  return buildInstallationInfo(picking, record);
}

export interface CustomerInstallationView {
  installation: InstallationInfo;
}

// Same scoping choice as fetchCustomerLogisticsView — not filtered to
// PORTAL_REQUEST_MARKER, since most real CultFit orders predate the portal.
// Ownership is still fully enforced by authzDomain(authz) alone.
export async function fetchCustomerInstallationView(leadId: number, authz: Authz): Promise<CustomerInstallationView> {
  const domain = [['id', '=', leadId], ...authzDomain(authz)];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['order_ids'] }) as { order_ids: number[] }[];
  if (!leads.length) throw new LeadNotFoundError();
  const soIds = leads[0].order_ids || [];

  const [picking, meta] = await Promise.all([
    fetchOutgoingPickingForInstallation(soIds),
    fetchInstallationMetadata(leadId),
  ]);

  return { installation: buildInstallationInfo(picking, meta) };
}
