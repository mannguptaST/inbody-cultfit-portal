# -*- coding: utf-8 -*-
"""
odoo_xmlrpc.py — CultFit deal data from live Odoo via XML-RPC.

Data source: crm.lead (CRM opportunities), not sale.order.
All reads are read-only. Write-back functions are only called
when an admin explicitly triggers a stage change in the portal.
"""

import asyncio
import logging
from datetime import date, datetime, timezone

import xmlrpc.client

from app.config import get_settings

logger   = logging.getLogger(__name__)
settings = get_settings()

ODOO_URL  = settings.ODOO_BASE_URL
ODOO_DB   = settings.ODOO_DB
ODOO_USER = settings.ODOO_API_USER
ODOO_PASS = settings.ODOO_API_PASS

# CRM stage IDs in live Odoo (from fields_get / stage listing)
_CLOSED_STAGE_IDS = {8, 10, 11, 9}   # Deal Closed, Lost, Rejected, Archive
_COLLECTED_STAGE_ID = 8               # "7. Deal Closed (Payment done)"
_PARTIAL_STAGE_ID   = 7              # "5. Confirmed (Partial Paid)"

# CultFit partner name filter
CULTFIT_DOMAIN = [
    '|', '|', '|',
    ['partner_id.commercial_partner_id.name', 'ilike', 'cultfit'],
    ['partner_id.commercial_partner_id.name', 'ilike', 'curefit'],
    ['partner_id.commercial_partner_id.name', 'ilike', 'cult fit'],
    ['partner_id.commercial_partner_id.name', 'ilike', 'cultfit healthcare'],
]

# deal_status_id name → portal_stage key
DEAL_STATUS_MAP = {
    'PO received':            'po_received',
    'PI shared':              'pi_shared',
    'Dispatch Requested':     'dispatch_requested',
    'Dispatched':             'dispatched',
    'Delivered(not Inst yet)': 'delivered',
    'Server Updated':         'server_updated',
}

STAGE_LABELS = {
    'new':               'New',
    'po_received':       'PO Received',
    'pi_shared':         'PI Shared',
    'dispatch_requested': 'Dispatch Requested',
    'dispatched':        'Dispatched',
    'delivered':         'Delivered (Not Installed)',
    'server_updated':    'Server Updated',
    'deal_closed':       'Deal Closed',
}

# deal_status_id name → delivery_status label (matches frontend DELIVERY_COLORS keys)
_DELIVERY_MAP = {
    None:                     'No Delivery',
    'PO received':            'Pending',
    'PI shared':              'Pending',
    'Dispatch Requested':     'Pending',
    'Dispatched':             'Ready to Dispatch',
    'Delivered(not Inst yet)': 'Delivered',
    'Server Updated':         'Delivered',
}

# CRM stage_id → invoice_status label (matches frontend INVOICE_COLORS keys)
_INVOICE_MAP = {
    8: 'Invoiced',           # Deal Closed
    7: 'To Invoice',         # Confirmed (Partial Paid)
}


def _connect():
    """Returns (uid, models_proxy). Synchronous — do not call from async context."""
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASS, {})
    if not uid:
        raise RuntimeError("Odoo XML-RPC authentication failed — check credentials.")
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    return uid, models


def _parse_date(val) -> str | None:
    if not val:
        return None
    return str(val)[:10]


def _days_to(deadline_str: str | None) -> int:
    if not deadline_str:
        return 0
    try:
        d = date.fromisoformat(deadline_str[:10])
        delta = (d - date.today()).days
        return max(0, delta)
    except Exception:
        return 0


def _is_overdue(deadline_str: str | None, stage_id: int) -> bool:
    if not deadline_str or stage_id in _CLOSED_STAGE_IDS:
        return False
    try:
        d = date.fromisoformat(deadline_str[:10])
        return d < date.today()
    except Exception:
        return False


def _build_lead(lead: dict) -> dict:
    stage_id_val = lead.get('stage_id')
    stage_id     = stage_id_val[0] if stage_id_val else 0
    stage_label  = stage_id_val[1] if stage_id_val else ''

    deal_status_val  = lead.get('deal_status_id')
    deal_status_name = deal_status_val[1] if deal_status_val else None

    portal_stage = DEAL_STATUS_MAP.get(deal_status_name, 'new')
    if stage_id == _COLLECTED_STAGE_ID:
        portal_stage = 'deal_closed'

    portal_stage_label = STAGE_LABELS.get(portal_stage, deal_status_name or 'New')

    deadline_str     = _parse_date(lead.get('date_deadline'))
    payment_status   = 'collected' if stage_id == _COLLECTED_STAGE_ID else 'pending'
    payment_overdue  = _is_overdue(deadline_str, stage_id)
    days_to_payment  = _days_to(deadline_str)

    delivery_status  = _DELIVERY_MAP.get(deal_status_name, 'No Delivery')
    invoice_status   = _INVOICE_MAP.get(stage_id, 'Nothing to Invoice')

    location = lead.get('x_studio_machine_installed_at') or lead.get('city') or None

    partner = lead.get('partner_id')
    customer = partner[1] if partner else None

    return {
        'id':           lead['id'],
        'order_no':     lead.get('name') or f"CRM-{lead['id']}",
        'customer':     customer,
        'location':     location,
        'model_names':  [],
        'order_date':   _parse_date(lead.get('create_date')),
        'last_updated': _parse_date(lead.get('write_date')),
        'amount_total': lead.get('forecasted_amt') or 0,
        'amount_untaxed': 0,
        'amount_tax':     0,
        'currency':       'INR',
        'payment_terms':  (lead['payment_term_id'][1] if lead.get('payment_term_id') else None),
        'order_status':   stage_label,
        'delivery_status': delivery_status,
        'invoice_status':  invoice_status,
        'portal_stage':       portal_stage,
        'portal_stage_label': portal_stage_label,
        'payment_status':   payment_status,
        'payment_overdue':  payment_overdue,
        'payment_due_date': deadline_str,
        'days_to_payment':  days_to_payment,
        'installation_status': 'not_started',
        'vendor_portal_status': 'not_uploaded',
        'confirmation_mail_sent': False,
        'portal_notes': '',
        'po_number': None,
        'po_received_date': None,
        'pi_issued_date': None,
        'md_approval_status': 'pending',
        'crm_stage': stage_label,
        'deal_status': deal_status_name or '',
        'salesperson': (lead['user_id'][1] if lead.get('user_id') else None),
        'expected_closing': deadline_str,
    }


_LEAD_FIELDS = [
    'id', 'name', 'partner_id', 'stage_id', 'deal_status_id',
    'deal_type', 'date_deadline', 'create_date', 'write_date',
    'user_id', 'x_studio_machine_installed_at', 'city',
    'payment_term_id', 'forecasted_amt', 'won_status', 'is_credit_deal',
]


def _sync_fetch_cultfit_orders(partner_id: int = 0) -> dict:
    uid, models = _connect()

    if partner_id > 0:
        domain = [['partner_id.commercial_partner_id', '=', partner_id]]
    else:
        domain = list(CULTFIT_DOMAIN)

    leads = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'search_read',
        [domain],
        {'fields': _LEAD_FIELDS, 'order': 'id desc', 'limit': 200},
    )

    result = [_build_lead(l) for l in leads]
    return {'orders': result, 'count': len(result)}


async def fetch_cultfit_orders(partner_id: int = 0) -> dict:
    """Async entry point — wraps sync XML-RPC in a thread pool."""
    return await asyncio.to_thread(_sync_fetch_cultfit_orders, partner_id)


def _sync_fetch_cultfit_order_by_id(order_id: int, partner_id: int = 0) -> dict | None:
    uid, models = _connect()

    domain: list = [['id', '=', order_id]]
    if partner_id > 0:
        domain.append(['partner_id.commercial_partner_id', '=', partner_id])

    leads = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'search_read',
        [domain],
        {'fields': _LEAD_FIELDS, 'limit': 1},
    )

    if not leads:
        return None
    return _build_lead(leads[0])


async def fetch_cultfit_order_by_id(order_id: int, partner_id: int = 0) -> dict | None:
    """Async entry point for single-order detail."""
    return await asyncio.to_thread(_sync_fetch_cultfit_order_by_id, order_id, partner_id)


# ── Stage write-back (read-only by default — only used when admin triggers) ───

STAGE_KEYS = list(STAGE_LABELS.keys())


def _sync_update_cultfit_stage(
    order_id: int, action: str, changed_by: str = '', reason: str = ''
) -> dict:
    """
    Move deal status forward ('next') or back ('prev') via XML-RPC.
    Only updates deal_status_id on crm.lead.
    """
    uid, models = _connect()

    records = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'read',
        [[order_id]], {'fields': ['deal_status_id']},
    )
    if not records:
        raise ValueError(f"Lead {order_id} not found")

    ds = records[0].get('deal_status_id')
    old_name = ds[1] if ds else None
    old_key  = DEAL_STATUS_MAP.get(old_name, 'new')
    idx = STAGE_KEYS.index(old_key) if old_key in STAGE_KEYS else 0

    if action == 'next':
        new_idx = min(idx + 1, len(STAGE_KEYS) - 1)
    elif action == 'prev':
        new_idx = max(idx - 1, 0)
    else:
        raise ValueError("action must be 'next' or 'prev'")

    new_key   = STAGE_KEYS[new_idx]
    new_label = STAGE_LABELS.get(new_key, new_key)

    # Find deal.status ID matching the new stage key
    reverse_map = {v: k for k, v in DEAL_STATUS_MAP.items()}
    new_status_name = reverse_map.get(new_key)
    if new_status_name:
        statuses = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'deal.status', 'search_read',
            [[['name', '=', new_status_name]]], {'fields': ['id']},
        )
        if statuses:
            models.execute_kw(
                ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'write',
                [[order_id], {'deal_status_id': statuses[0]['id']}],
            )

    return {
        'order_id':        order_id,
        'new_stage':       new_key,
        'new_stage_label': new_label,
    }


async def update_cultfit_stage(
    order_id: int, action: str, changed_by: str = '', reason: str = ''
) -> dict:
    return await asyncio.to_thread(
        _sync_update_cultfit_stage, order_id, action, changed_by, reason
    )


def _sync_set_cultfit_stage(
    order_id: int, stage_key: str, changed_by: str = '', reason: str = ''
) -> dict:
    """Set portal stage directly by key via XML-RPC."""
    if stage_key not in STAGE_LABELS:
        raise ValueError(f"Unknown stage key: {stage_key!r}")

    uid, models = _connect()
    reverse_map = {v: k for k, v in DEAL_STATUS_MAP.items()}

    if stage_key == 'deal_closed':
        models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'write',
            [[order_id], {'stage_id': _COLLECTED_STAGE_ID}],
        )
    elif stage_key == 'new':
        models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'write',
            [[order_id], {'deal_status_id': False}],
        )
    else:
        status_name = reverse_map.get(stage_key)
        if not status_name:
            raise ValueError(f"No Odoo deal.status mapping for stage {stage_key!r}")
        statuses = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'deal.status', 'search_read',
            [[['name', '=', status_name]]], {'fields': ['id']},
        )
        if not statuses:
            raise ValueError(f"deal.status '{status_name}' not found in Odoo")
        models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'write',
            [[order_id], {'deal_status_id': statuses[0]['id']}],
        )

    return {
        'order_id':        order_id,
        'new_stage':       stage_key,
        'new_stage_label': STAGE_LABELS.get(stage_key, stage_key),
    }


async def set_cultfit_stage(
    order_id: int, stage_key: str, changed_by: str = '', reason: str = ''
) -> dict:
    return await asyncio.to_thread(
        _sync_set_cultfit_stage, order_id, stage_key, changed_by, reason
    )


async def update_cultfit_deal_fields(
    order_id: int, updates: dict, changed_by: str = '', reason: str = ''
) -> dict:
    """Stub — deal field write-back not yet mapped for live Odoo."""
    return {'order_id': order_id, 'updated': []}


# ── Odoo attachment download ───────────────────────────────────────────────────

def _sync_fetch_order_attachments(lead_id: int) -> list[dict]:
    """Return PDF attachments for the sale orders and invoices linked to a CRM lead."""
    import base64 as _b64
    uid, models = _connect()

    leads = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'crm.lead', 'read',
        [[lead_id]], {'fields': ['order_ids', 'name']},
    )
    if not leads:
        return []

    so_ids = leads[0].get('order_ids') or []
    if not so_ids:
        return []

    sos = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'sale.order', 'read',
        [so_ids], {'fields': ['id', 'name', 'invoice_ids']},
    )

    result = []

    so_atts = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'ir.attachment', 'search_read',
        [[['res_model', '=', 'sale.order'], ['res_id', 'in', so_ids],
          ['mimetype', '=', 'application/pdf']]],
        {'fields': ['id', 'name', 'file_size', 'create_date', 'res_id']},
    )
    for a in so_atts:
        so_name = next((s['name'] for s in sos if s['id'] == a['res_id']), '')
        result.append({
            'id':       a['id'],
            'name':     a['name'],
            'type':     'quotation',
            'label':    f"Quotation – {so_name}",
            'size':     a.get('file_size', 0),
            'date':     str(a['create_date'])[:10] if a.get('create_date') else None,
            'mimetype': 'application/pdf',
        })

    all_inv_ids = []
    for s in sos:
        all_inv_ids.extend(s.get('invoice_ids') or [])

    if all_inv_ids:
        invoices = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'account.move', 'read',
            [all_inv_ids], {'fields': ['id', 'name']},
        )
        inv_atts = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'ir.attachment', 'search_read',
            [[['res_model', '=', 'account.move'], ['res_id', 'in', all_inv_ids],
              ['mimetype', '=', 'application/pdf']]],
            {'fields': ['id', 'name', 'file_size', 'create_date', 'res_id']},
        )
        for a in inv_atts:
            inv = next((i for i in invoices if i['id'] == a['res_id']), None)
            inv_name = inv['name'] if inv else ''
            result.append({
                'id':       a['id'],
                'name':     a['name'],
                'type':     'invoice',
                'label':    f"Invoice – {inv_name}",
                'size':     a.get('file_size', 0),
                'date':     str(a['create_date'])[:10] if a.get('create_date') else None,
                'mimetype': 'application/pdf',
            })

    return result


async def fetch_order_attachments(lead_id: int) -> list[dict]:
    return await asyncio.to_thread(_sync_fetch_order_attachments, lead_id)


def _sync_fetch_attachment_data(attachment_id: int) -> tuple:
    """Returns (bytes, mimetype, filename) for an ir.attachment."""
    import base64 as _b64
    uid, models = _connect()
    records = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'ir.attachment', 'read',
        [[attachment_id]], {'fields': ['name', 'mimetype', 'datas']},
    )
    if not records or not records[0].get('datas'):
        raise ValueError(f"Attachment {attachment_id} not found or has no data")
    rec = records[0]
    data = _b64.b64decode(rec['datas'])
    return data, rec['mimetype'], rec['name']


async def fetch_attachment_data(attachment_id: int) -> tuple:
    return await asyncio.to_thread(_sync_fetch_attachment_data, attachment_id)
