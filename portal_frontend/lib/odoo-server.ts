// odoo-server.ts — Server-only Odoo XML-RPC client.
// Never import this on the client side.

import 'server-only';
import type { CustomerScope } from '@/lib/auth-server';
import { STAGE_LABELS, STAGE_KEYS } from '@/lib/stage-config';

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

const CULTFIT_DOMAIN = [
  '|', '|', '|',
  ['partner_id.commercial_partner_id.name', 'ilike', 'cultfit'],
  ['partner_id.commercial_partner_id.name', 'ilike', 'curefit'],
  ['partner_id.commercial_partner_id.name', 'ilike', 'cult fit'],
  ['partner_id.commercial_partner_id.name', 'ilike', 'cultfit healthcare'],
];

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
// this function only. It always includes the CultFit/Curefit domain, even
// for admin, so no authenticated user of any role can ever read a crm.lead
// outside the CultFit family through these functions, and a customer with
// no (or an empty) scope gets a hard 403 rather than any fallback to broad
// access.
function authzDomain(authz: Authz): unknown[] {
  if (authz.role === 'admin') return [...CULTFIT_DOMAIN];

  const scope = authz.scope;
  if (!scope) throw new PartnerNotMappedError();
  if (scope.kind === 'cultfit_domain') return [...CULTFIT_DOMAIN];
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

const SO_FIELDS = ['id', 'name', 'opportunity_id', 'amount_untaxed', 'amount_tax', 'order_line'];

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

function buildLead(lead: Record<string, unknown>): Record<string, unknown> {
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
    model_names:  [],
    order_date:   parseDate(lead.create_date),
    last_updated: parseDate(lead.write_date),
    amount_total: lead.expected_revenue || 0,
    amount_untaxed: 0,
    amount_tax:   0,
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
    po_number:        null,
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

  const allSoIds: number[] = [];
  const leadToSo: Record<number, number[]> = {};
  for (const l of leads) {
    const ids = (l.order_ids as number[]) || [];
    leadToSo[l.id as number] = ids;
    allSoIds.push(...ids);
  }

  const soMap: Record<number, Record<string, unknown>> = {};
  if (allSoIds.length > 0) {
    const sos = await executeKw('sale.order', 'read', [allSoIds], { fields: SO_FIELDS }) as Record<string, unknown>[];
    for (const so of sos) soMap[so.id as number] = so;
  }

  const orders = leads.map(l => buildLead(l));
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

  return leads.length ? buildLead(leads[0]) : null;
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
  const count = await executeKw('crm.lead', 'search_count', [[['id', '=', orderId], ...CULTFIT_DOMAIN]]) as number;
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
