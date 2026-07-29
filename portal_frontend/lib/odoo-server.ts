// odoo-server.ts — Server-only Odoo XML-RPC client.
// Never import this on the client side.

import 'server-only';
import type { CustomerScope } from '@/lib/auth-server';
import { STAGE_LABELS, STAGE_KEYS, REQUEST_STAGE_LABELS } from '@/lib/stage-config';

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
  | { role: 'customer'; scope: CustomerScope | undefined };

// Every CultFit fetch — list AND single-record — resolves its domain from
// this function only. It always includes the CultFit domain, even for admin,
// so no authenticated user of any role can ever read a crm.lead outside the
// CultFit family through these functions, and a customer with no (or an
// empty) scope gets a hard 403 rather than any fallback to broad access.
function authzDomain(authz: Authz): unknown[] {
  if (authz.role === 'admin') return cultfitDomain();

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
  const lines = [
    `<p><b>${PORTAL_REQUEST_MARKER}</b> — submitted via CultFit portal by ${escapeHtml(details.portalAccount)} on ${escapeHtml(details.submittedDate)}</p>`,
    `<p><b>Location/Request name:</b> ${escapeHtml(details.requestName)}</p>`,
    `<p><b>COCO/FOFO:</b> ${escapeHtml(details.cocoFofo)}</p>`,
    `<p><b>Main product:</b> ${escapeHtml(details.mainProduct.code)} ${escapeHtml(details.mainProduct.name)} × ${details.quantity}</p>`,
    `<p><b>Included (free):</b> ${includedLine}</p>`,
    `<p><b>Delivery address:</b> ${escapeHtml(details.deliveryAddress)}</p>`,
    `<p><b>Contact:</b> ${escapeHtml(details.contactName)} · ${escapeHtml(details.contactPhone)}${details.contactEmail ? ' · ' + escapeHtml(details.contactEmail) : ''}</p>`,
    details.preferredDeliveryDate ? `<p><b>Preferred delivery date:</b> ${escapeHtml(details.preferredDeliveryDate)}</p>` : '',
    details.notes ? `<p><b>Notes:</b> ${escapeHtml(details.notes)}</p>` : '',
    `<!--PORTAL_REQUEST_DATA:${encodeRequestDetails(details)}-->`,
  ];
  return lines.filter(Boolean).join('');
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

// The CRM pipeline's actual "New" stage (crm.stage), not the deal_status_id
// used elsewhere in this file for the order-fulfillment portal_stage. A
// freshly submitted request is a raw opportunity that hasn't entered the
// order-fulfillment flow yet — verified live: crm.stage id 1 is named
// exactly "New", sequence 0 (the pipeline's own entry stage).
async function resolveNewStageId(): Promise<number> {
  if (_newStageId) return _newStageId;
  const stages = await executeKw('crm.stage', 'search_read', [[['name', '=', 'New']]], { fields: ['id'], limit: 1 }) as { id: number }[];
  if (!stages.length) throw new Error("Could not resolve the 'New' CRM stage in Odoo.");
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
  partnerId: number, requestName: string, mainProductId: number, quantity: number, deliveryAddress: string,
): Promise<boolean> {
  const sinceIso = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
  const domain = [
    ['partner_id.commercial_partner_id', '=', partnerId],
    ['description', 'ilike', PORTAL_REQUEST_MARKER],
    ['create_date', '>=', sinceIso],
  ];
  const leads = await executeKw('crm.lead', 'search_read', [domain], { fields: ['description'] }) as Record<string, unknown>[];

  const normName = normalizeForCompare(requestName);
  const normAddr = normalizeForCompare(deliveryAddress);
  return leads.some(l => {
    const details = decodeRequestDetails(l.description);
    if (!details) return false;
    return normalizeForCompare(details.requestName) === normName
      && details.mainProduct.id === mainProductId
      && details.quantity === quantity
      && normalizeForCompare(details.deliveryAddress) === normAddr;
  });
}

export interface NewOrderRequestInput {
  requestName: unknown;
  cocoFofo: unknown;
  mainProductId: unknown;
  quantity: unknown;
  deliveryAddress: unknown;
  contactName: unknown;
  contactPhone: unknown;
  contactEmail: unknown;
  preferredDeliveryDate: unknown;
  notes: unknown;
}

const MAX_LEN = { requestName: 120, deliveryAddress: 300, contactName: 100, contactPhone: 30, contactEmail: 150, notes: 1000 };

function requiredText(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new InvalidRequestError(`${field} is required.`);
  const trimmed = v.trim();
  if (trimmed.length > max) throw new InvalidRequestError(`${field} must be ${max} characters or fewer.`);
  return trimmed;
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
  const deliveryAddress = requiredText(input.deliveryAddress, 'Delivery address', MAX_LEN.deliveryAddress);
  const contactName = requiredText(input.contactName, 'Contact person name', MAX_LEN.contactName);
  const contactPhone = requiredText(input.contactPhone, 'Contact phone', MAX_LEN.contactPhone);
  if (!/^[0-9+()\-\s]{6,30}$/.test(contactPhone)) throw new InvalidRequestError('Contact phone looks invalid.');

  if (input.cocoFofo !== 'COCO' && input.cocoFofo !== 'FOFO') {
    throw new InvalidRequestError('COCO/FOFO must be COCO or FOFO.');
  }
  const cocoFofo = input.cocoFofo;

  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    throw new InvalidRequestError('Quantity must be a whole number between 1 and 999.');
  }

  let contactEmail: string | null = null;
  if (typeof input.contactEmail === 'string' && input.contactEmail.trim()) {
    const trimmed = input.contactEmail.trim();
    if (trimmed.length > MAX_LEN.contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new InvalidRequestError('Contact email looks invalid.');
    }
    contactEmail = trimmed;
  }

  let preferredDeliveryDate: string | null = null;
  if (typeof input.preferredDeliveryDate === 'string' && input.preferredDeliveryDate.trim()) {
    const d = input.preferredDeliveryDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new InvalidRequestError('Preferred delivery date must be a valid date.');
    preferredDeliveryDate = d;
  }

  let notes = '';
  if (typeof input.notes === 'string' && input.notes.trim()) {
    notes = input.notes.trim();
    if (notes.length > MAX_LEN.notes) throw new InvalidRequestError(`Notes must be ${MAX_LEN.notes} characters or fewer.`);
  }

  // Never trust a client-supplied product id blindly — re-verify it against
  // the same live "already used by CultFit" catalog the picker itself came
  // from, so a tampered request can't reference an arbitrary Odoo product
  // or claim a bundle that doesn't apply to it.
  const catalog = await fetchCultFitProductCatalog();
  const mainProduct = catalog.find(p => p.id === Number(input.mainProductId));
  if (!mainProduct) throw new InvalidRequestError('Selected product is not a valid CultFit product.');
  const includedProducts = BUNDLE_MAP[mainProduct.id] ?? [];

  const partnerId = resolveCultFitPartnerId(authz);
  const stageId = await resolveNewStageId();
  const industryId = await resolveFitnessIndustryId();
  const subIndustryId = await resolveDefaultSubIndustryId();

  if (await findRecentDuplicateRequest(partnerId, requestName, mainProduct.id, quantity, deliveryAddress)) {
    throw new DuplicateRequestError();
  }

  const details: PortalRequestDetails = {
    requestName,
    cocoFofo,
    mainProduct: { id: mainProduct.id, code: mainProduct.code, name: mainProduct.name },
    quantity,
    includedProducts,
    deliveryAddress,
    contactName,
    contactPhone,
    contactEmail,
    preferredDeliveryDate,
    notes,
    portalAccount: portalAccountEmail,
    submittedDate: new Date().toISOString().slice(0, 10),
  };

  const leadId = await executeKw('crm.lead', 'create', [{
    name: requestName,
    type: 'opportunity',
    partner_id: partnerId,
    stage_id: stageId,
    industry_id: industryId,
    sub_industry_id: subIndustryId,
    // Explicit false, not merely omitted — discovered live that Odoo's own
    // team/onchange defaults silently auto-assign a salesperson on create if
    // this key is left out entirely, which violates "leave salesperson
    // unassigned for admin to set manually".
    user_id: false,
    contact_name: contactName,
    phone: contactPhone,
    email_from: contactEmail || false,
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
    created_date: parseDate(lead.create_date),
    last_updated: parseDate(lead.write_date),
  };
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
  return leads.map(buildRequestSummary);
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
