// odoo-server.ts — Server-only Odoo XML-RPC client.
// Never import this on the client side.

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

async function rpcPost(endpoint: string, method: string, params: unknown[]): Promise<unknown> {
  const resp = await fetch(`${ODOO_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildCall(method, params),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from Odoo`);
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
  } catch (err) {
    _uid = null;
    const uid = await getUid();
    return rpcPost('/xmlrpc/2/object', 'execute_kw', [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs]);
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

const DEAL_STATUS_MAP: Record<string, string> = {
  'PO received':             'po_received',
  'PI shared':               'pi_shared',
  'Dispatch Requested':      'dispatch_requested',
  'Dispatched':              'dispatched',
  'Delivered(not Inst yet)': 'delivered',
  'Server Updated':          'server_updated',
};

export const STAGE_LABELS: Record<string, string> = {
  new:               'New',
  po_received:       'PO Received',
  pi_shared:         'PI Shared',
  dispatch_requested:'Dispatch Requested',
  dispatched:        'Dispatched',
  delivered:         'Delivered (Not Installed)',
  server_updated:    'Server Updated',
  deal_closed:       'Deal Closed',
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
  'payment_term_id', 'forecasted_amt', 'won_status', 'is_credit_deal', 'order_ids',
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
    amount_total: lead.forecasted_amt || 0,
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

export async function fetchCultFitOrders(partnerId = 0): Promise<{ orders: unknown[]; count: number }> {
  const domain = partnerId > 0
    ? [['partner_id.commercial_partner_id', '=', partnerId]]
    : [...CULTFIT_DOMAIN];

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

export async function fetchCultFitOrderById(orderId: number, partnerId = 0): Promise<Record<string, unknown> | null> {
  const domain: unknown[] = [['id', '=', orderId]];
  if (partnerId > 0) domain.push(['partner_id.commercial_partner_id', '=', partnerId]);

  const leads = await executeKw('crm.lead', 'search_read', [domain], {
    fields: LEAD_FIELDS, limit: 1,
  }) as Record<string, unknown>[];

  return leads.length ? buildLead(leads[0]) : null;
}

const STAGE_KEYS = Object.keys(STAGE_LABELS);
const REVERSE_DS = Object.fromEntries(Object.entries(DEAL_STATUS_MAP).map(([k, v]) => [v, k]));

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

export async function updateCultFitStage(orderId: number, action: 'next' | 'prev'): Promise<Record<string, unknown>> {
  const records = await executeKw('crm.lead', 'read', [[orderId]], { fields: ['deal_status_id'] }) as Record<string, unknown>[];
  if (!records.length) throw new Error(`Lead ${orderId} not found`);

  const ds = records[0].deal_status_id as OdooTuple;
  const oldKey = DEAL_STATUS_MAP[ds ? ds[1] : ''] ?? 'new';
  let idx = STAGE_KEYS.indexOf(oldKey);
  if (idx === -1) idx = 0;

  const newIdx = action === 'next' ? Math.min(idx + 1, STAGE_KEYS.length - 1) : Math.max(idx - 1, 0);
  const newKey = STAGE_KEYS[newIdx];
  await applyStageKey(orderId, newKey);
  return { order_id: orderId, new_stage: newKey, new_stage_label: STAGE_LABELS[newKey] ?? newKey };
}

export async function setCultFitStage(orderId: number, stageKey: string): Promise<Record<string, unknown>> {
  if (!STAGE_LABELS[stageKey]) throw new Error(`Unknown stage key: '${stageKey}'`);
  await applyStageKey(orderId, stageKey);
  return { order_id: orderId, new_stage: stageKey, new_stage_label: STAGE_LABELS[stageKey] };
}
