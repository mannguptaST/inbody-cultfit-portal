# -*- coding: utf-8 -*-
"""
odoo_xmlrpc.py — Direct XML-RPC queries to Odoo for CultFit orders.

WHY THIS EXISTS:
The existing odoo_client.py proxies through Odoo's custom REST portal API, which
only exposes a subset of inbody_* custom fields. For Phase 3+, we need standard
Odoo fields (invoice_status, delivery_count, order_line products, payment_term_id,
stock.picking state, etc.) that are not surfaced by the custom REST API.

XML-RPC gives us direct access to all model fields without changing Odoo code.

ASYNC SAFETY:
xmlrpc.client is synchronous. All sync calls are wrapped in asyncio.to_thread()
so they run in a thread pool and never block the FastAPI event loop.
"""

import asyncio
import logging
import xmlrpc.client
from datetime import datetime, timezone

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

ODOO_URL  = settings.ODOO_BASE_URL
ODOO_DB   = settings.ODOO_DB
ODOO_USER = settings.ODOO_API_USER
ODOO_PASS = settings.ODOO_API_PASS

# CultFit name filter — intentionally specific, never use bare 'cult'
CULTFIT_DOMAIN = [
    '|', '|', '|',
    ['partner_id.commercial_partner_id.name', 'ilike', 'cultfit'],
    ['partner_id.commercial_partner_id.name', 'ilike', 'curefit'],
    ['partner_id.commercial_partner_id.name', 'ilike', 'cult fit'],
    ['partner_id.commercial_partner_id.name', 'ilike', 'cultfit healthcare'],
]

STAGE_LABELS = {
    'stage_1_order_received':         'Stage 1 — Order Received',
    'stage_2_pi_issued':              'Stage 2 — PI Issued',
    'stage_3_po_received':            'Stage 3 — PO Received',
    'stage_4_md_approved':            'Stage 4 — MD Approved',
    'stage_5_dispatched':             'Stage 5 — Dispatched',
    'stage_6_installation_confirmed': 'Stage 6 — Installation Confirmed',
    'stage_7_vendor_uploaded':        'Stage 7 — Vendor Portal Uploaded',
    'stage_8_confirmation_sent':      'Stage 8 — Confirmation Mail Sent',
    'stage_9_payment_collected':      'Stage 9 — Payment Collected',
}

STATE_LABELS = {
    'draft':  'Quotation',
    'sent':   'Quotation Sent',
    'sale':   'Sales Order',
    'done':   'Locked',
    'cancel': 'Cancelled',
}

INVOICE_STATUS_LABELS = {
    'no':         'Nothing to Invoice',
    'to invoice': 'To Invoice',
    'invoiced':   'Invoiced',
    'upselling':  'Upselling Opportunity',
}

INSTALLATION_LABELS = {
    'not_started': 'Not Started',
    'in_progress': 'In Progress',
    'confirmed':   'Confirmed',
    'pending':     'Not Started',   # legacy dev-data value
}

VENDOR_PORTAL_LABELS = {
    'not_uploaded': 'Not Uploaded',
    'uploaded':     'Uploaded',
    'pending':      'Not Uploaded', # legacy dev-data value
}


def _connect():
    """Returns (uid, models_proxy). Synchronous — do not call from async context."""
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASS, {})
    if not uid:
        raise RuntimeError("Odoo XML-RPC authentication failed — check credentials.")
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    return uid, models


def _delivery_label(pickings: list) -> str:
    """Compute a single human-readable delivery status from the order's pickings."""
    if not pickings:
        return "No Delivery"
    active = [p for p in pickings if p['state'] != 'cancel']
    if not active:
        return "No Delivery"
    states = {p['state'] for p in active}
    if states == {'done'}:
        return "Delivered"
    if 'done' in states:
        return "Partially Dispatched"
    if 'assigned' in states:
        return "Ready to Dispatch"
    return "Pending"


def _sync_fetch_cultfit_orders(partner_id: int = 0) -> dict:
    """
    Synchronous XML-RPC function — called via asyncio.to_thread only.

    partner_id == 0  → staff role, returns all CultFit orders (name-based filter)
    partner_id > 0   → customer role, returns only that commercial partner's orders
    """
    uid, models = _connect()

    if partner_id > 0:
        domain = [['partner_id.commercial_partner_id', '=', partner_id]]
    else:
        domain = list(CULTFIT_DOMAIN)

    # ── 1. Fetch orders ──────────────────────────────────────────────────────
    orders_raw = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'sale.order', 'search_read',
        [domain],
        {
            'fields': [
                'id', 'name', 'state', 'partner_id', 'date_order', 'write_date',
                'amount_untaxed', 'amount_tax', 'amount_total', 'currency_id',
                'invoice_status', 'payment_term_id',
                'delivery_count', 'order_line',
                'inbody_portal_stage', 'inbody_centre_name',
                'inbody_payment_status', 'inbody_payment_overdue',
                'inbody_payment_due_date', 'inbody_days_to_payment_due',
                'inbody_installation_status', 'inbody_vendor_portal_status',
                'inbody_confirmation_mail_sent', 'inbody_customer_notes',
                'inbody_pi_issued_date', 'inbody_po_number', 'inbody_po_received_date',
                'inbody_md_approval_status',
            ],
            'order': 'name desc',
            'limit': 200,
        },
    )

    if not orders_raw:
        return {'orders': [], 'count': 0}

    order_ids = [o['id'] for o in orders_raw]

    # ── 2. Batch-fetch order lines for product/model names ───────────────────
    all_line_ids = [lid for o in orders_raw for lid in (o.get('order_line') or [])]
    lines_by_order: dict = {}
    if all_line_ids:
        lines_raw = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'sale.order.line', 'search_read',
            [[['id', 'in', all_line_ids]]],
            {'fields': ['order_id', 'product_id', 'name']},
        )
        for line in lines_raw:
            oid = line['order_id'][0]
            product_name = (
                line['product_id'][1]
                if line.get('product_id')
                else (line.get('name') or 'Unknown')
            )
            lines_by_order.setdefault(oid, []).append(product_name)

    # ── 3. Batch-fetch pickings for delivery status ──────────────────────────
    pickings_raw = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'stock.picking', 'search_read',
        [[['sale_id', 'in', order_ids]]],
        {'fields': ['sale_id', 'state', 'date_done']},
    )
    pickings_by_order: dict = {}
    for p in pickings_raw:
        oid = p['sale_id'][0]
        pickings_by_order.setdefault(oid, []).append(p)

    # ── 4. Build clean response ──────────────────────────────────────────────
    result = []
    for o in orders_raw:
        oid = o['id']
        stage_key = o.get('inbody_portal_stage') or 'stage_1_order_received'
        raw_inst  = o.get('inbody_installation_status') or 'not_started'
        raw_vend  = o.get('inbody_vendor_portal_status') or 'not_uploaded'

        result.append({
            # Core identifiers
            'id':          oid,
            'order_no':    o['name'],
            'customer':    o['partner_id'][1] if o.get('partner_id') else None,
            'location':    o.get('inbody_centre_name') or None,
            'model_names': lines_by_order.get(oid, []),

            # Dates
            'order_date':  str(o['date_order'])[:10] if o.get('date_order') else None,
            'last_updated': str(o['write_date'])[:10] if o.get('write_date') else None,

            # Financials
            'amount_untaxed': o.get('amount_untaxed', 0),
            'amount_tax':     o.get('amount_tax', 0),
            'amount_total':   o.get('amount_total', 0),
            'currency':       o['currency_id'][1] if o.get('currency_id') else 'INR',
            'payment_terms':  o['payment_term_id'][1] if o.get('payment_term_id') else None,

            # Odoo standard statuses (human-readable)
            'order_status':    STATE_LABELS.get(o.get('state', ''), o.get('state', '')),
            'delivery_status': _delivery_label(pickings_by_order.get(oid, [])),
            'invoice_status':  INVOICE_STATUS_LABELS.get(
                o.get('invoice_status', 'no'), o.get('invoice_status', 'Unknown')
            ),

            # Portal stage (custom inbody computed)
            'portal_stage':       stage_key,
            'portal_stage_label': STAGE_LABELS.get(stage_key, stage_key),

            # InBody custom fields
            'payment_status':   o.get('inbody_payment_status') or 'pending',
            'payment_overdue':  bool(o.get('inbody_payment_overdue')),
            'payment_due_date': str(o['inbody_payment_due_date']) if o.get('inbody_payment_due_date') else None,
            'days_to_payment':  o.get('inbody_days_to_payment_due') or 0,

            'installation_status': INSTALLATION_LABELS.get(raw_inst, raw_inst),
            'vendor_portal_status': VENDOR_PORTAL_LABELS.get(raw_vend, raw_vend),
            'confirmation_mail_sent': bool(o.get('inbody_confirmation_mail_sent')),

            'portal_notes':     o.get('inbody_customer_notes') or '',
            'po_number':        o.get('inbody_po_number') or None,
            'po_received_date': str(o['inbody_po_received_date']) if o.get('inbody_po_received_date') else None,
            'pi_issued_date':   str(o['inbody_pi_issued_date']) if o.get('inbody_pi_issued_date') else None,
            'md_approval_status': o.get('inbody_md_approval_status') or 'pending',
        })

    return {'orders': result, 'count': len(result)}


async def fetch_cultfit_orders(partner_id: int = 0) -> dict:
    """Async entry point — wraps sync XML-RPC in a thread pool."""
    return await asyncio.to_thread(_sync_fetch_cultfit_orders, partner_id)


def _sync_fetch_cultfit_order_by_id(order_id: int, partner_id: int = 0) -> dict | None:
    """
    Fetch a single CultFit order by Odoo ID.

    partner_id == 0  → staff, no partner filter (any order by ID)
    partner_id > 0   → customer, adds commercial_partner check (returns None if not theirs)
    """
    uid, models = _connect()

    domain: list = [['id', '=', order_id]]
    if partner_id > 0:
        domain.append(['partner_id.commercial_partner_id', '=', partner_id])

    orders_raw = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'sale.order', 'search_read',
        [domain],
        {
            'fields': [
                'id', 'name', 'state', 'partner_id', 'date_order', 'write_date',
                'amount_untaxed', 'amount_tax', 'amount_total', 'currency_id',
                'invoice_status', 'payment_term_id',
                'delivery_count', 'order_line',
                'inbody_portal_stage', 'inbody_centre_name',
                'inbody_payment_status', 'inbody_payment_overdue',
                'inbody_payment_due_date', 'inbody_days_to_payment_due',
                'inbody_installation_status', 'inbody_vendor_portal_status',
                'inbody_confirmation_mail_sent', 'inbody_customer_notes',
                'inbody_pi_issued_date', 'inbody_po_number', 'inbody_po_received_date',
                'inbody_md_approval_status',
            ],
            'limit': 1,
        },
    )

    if not orders_raw:
        return None

    o = orders_raw[0]
    oid = o['id']

    # Order lines — product/model names
    line_ids = o.get('order_line') or []
    model_names: list[str] = []
    if line_ids:
        lines_raw = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, 'sale.order.line', 'search_read',
            [[['id', 'in', line_ids]]],
            {'fields': ['product_id', 'name']},
        )
        for line in lines_raw:
            name = (
                line['product_id'][1]
                if line.get('product_id')
                else (line.get('name') or 'Unknown')
            )
            model_names.append(name)

    # Pickings — delivery status
    pickings_raw = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'stock.picking', 'search_read',
        [[['sale_id', '=', oid]]],
        {'fields': ['state', 'date_done']},
    )

    stage_key = o.get('inbody_portal_stage') or 'stage_1_order_received'
    raw_inst  = o.get('inbody_installation_status') or 'not_started'
    raw_vend  = o.get('inbody_vendor_portal_status') or 'not_uploaded'

    return {
        'id':          oid,
        'order_no':    o['name'],
        'customer':    o['partner_id'][1] if o.get('partner_id') else None,
        'location':    o.get('inbody_centre_name') or None,
        'model_names': model_names,
        'order_date':  str(o['date_order'])[:10] if o.get('date_order') else None,
        'last_updated': str(o['write_date'])[:10] if o.get('write_date') else None,
        'amount_untaxed': o.get('amount_untaxed', 0),
        'amount_tax':     o.get('amount_tax', 0),
        'amount_total':   o.get('amount_total', 0),
        'currency':       o['currency_id'][1] if o.get('currency_id') else 'INR',
        'payment_terms':  o['payment_term_id'][1] if o.get('payment_term_id') else None,
        'order_status':    STATE_LABELS.get(o.get('state', ''), o.get('state', '')),
        'delivery_status': _delivery_label(pickings_raw),
        'invoice_status':  INVOICE_STATUS_LABELS.get(
            o.get('invoice_status', 'no'), o.get('invoice_status', 'Unknown')
        ),
        'portal_stage':       stage_key,
        'portal_stage_label': STAGE_LABELS.get(stage_key, stage_key),
        'payment_status':   o.get('inbody_payment_status') or 'pending',
        'payment_overdue':  bool(o.get('inbody_payment_overdue')),
        'payment_due_date': str(o['inbody_payment_due_date']) if o.get('inbody_payment_due_date') else None,
        'days_to_payment':  o.get('inbody_days_to_payment_due') or 0,
        'installation_status': INSTALLATION_LABELS.get(raw_inst, raw_inst),
        'vendor_portal_status': VENDOR_PORTAL_LABELS.get(raw_vend, raw_vend),
        'confirmation_mail_sent': bool(o.get('inbody_confirmation_mail_sent')),
        'portal_notes':     o.get('inbody_customer_notes') or '',
        'po_number':        o.get('inbody_po_number') or None,
        'po_received_date': str(o['inbody_po_received_date']) if o.get('inbody_po_received_date') else None,
        'pi_issued_date':   str(o['inbody_pi_issued_date']) if o.get('inbody_pi_issued_date') else None,
        'md_approval_status': o.get('inbody_md_approval_status') or 'pending',
    }


async def fetch_cultfit_order_by_id(order_id: int, partner_id: int = 0) -> dict | None:
    """Async entry point for single-order detail."""
    return await asyncio.to_thread(_sync_fetch_cultfit_order_by_id, order_id, partner_id)


# ── Stage write-back ──────────────────────────────────────────────────────────

STAGE_KEYS = list(STAGE_LABELS.keys())  # Ordered — position determines next/prev


def _sync_update_cultfit_stage(
    order_id: int, action: str, changed_by: str = '', reason: str = ''
) -> dict:
    """
    Move order one stage forward ('next') or back ('prev') via XML-RPC.
    Writes inbody_stage_override and creates an inbody.stage.history record.
    """
    uid, models = _connect()

    records = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'sale.order', 'read',
        [[order_id]], {'fields': ['inbody_portal_stage']},
    )
    if not records:
        raise ValueError(f"Order {order_id} not found")

    old_stage = records[0].get('inbody_portal_stage') or STAGE_KEYS[0]
    idx = STAGE_KEYS.index(old_stage) if old_stage in STAGE_KEYS else 0

    if action == 'next':
        new_idx = min(idx + 1, len(STAGE_KEYS) - 1)
        source  = 'admin_next'
    elif action == 'prev':
        new_idx = max(idx - 1, 0)
        source  = 'admin_prev'
    else:
        raise ValueError("action must be 'next' or 'prev'")

    new_stage = STAGE_KEYS[new_idx]

    models.execute_kw(ODOO_DB, uid, ODOO_PASS, 'sale.order', 'write',
        [[order_id], {'inbody_stage_override': new_stage}])

    models.execute_kw(ODOO_DB, uid, ODOO_PASS, 'inbody.stage.history', 'create', [{
        'order_id':   order_id,
        'old_stage':  old_stage,
        'new_stage':  new_stage,
        'changed_by': changed_by,
        'reason':     reason,
        'source':     source,
    }])

    return {
        'order_id':        order_id,
        'new_stage':       new_stage,
        'new_stage_label': STAGE_LABELS.get(new_stage, new_stage),
    }


async def update_cultfit_stage(
    order_id: int, action: str, changed_by: str = '', reason: str = ''
) -> dict:
    """Async wrapper — moves order stage next/prev via XML-RPC."""
    return await asyncio.to_thread(
        _sync_update_cultfit_stage, order_id, action, changed_by, reason
    )


# ── Deal field write-back ─────────────────────────────────────────────────────

_DEAL_FIELD_MAP: dict[str, str] = {
    'payment_status':        'inbody_payment_status',
    'installation_status':   'inbody_installation_status',
    'vendor_portal_status':  'inbody_vendor_portal_status',
    'confirmation_mail_sent': 'inbody_confirmation_mail_sent',
    'md_approval_status':    'inbody_md_approval_status',
}

_DEAL_FIELD_ALLOWED: dict[str, frozenset] = {
    'inbody_payment_status':        frozenset({'pending', 'overdue', 'collected'}),
    'inbody_installation_status':   frozenset({'not_started', 'in_progress', 'confirmed'}),
    'inbody_vendor_portal_status':  frozenset({'not_uploaded', 'uploaded'}),
    'inbody_md_approval_status':    frozenset({'pending', 'approved', 'rejected'}),
}


# Human-readable labels for the audit log entry
_DEAL_FIELD_LABELS: dict[str, str] = {
    'inbody_payment_status':        'Payment Status',
    'inbody_installation_status':   'Installation Status',
    'inbody_vendor_portal_status':  'Vendor Portal Status',
    'inbody_confirmation_mail_sent': 'Confirmation Mail Sent',
    'inbody_md_approval_status':    'MD Approval Status',
}

_DEAL_VALUE_LABELS: dict[str, str] = {
    'pending':      'Pending',
    'overdue':      'Overdue',
    'collected':    'Collected',
    'not_started':  'Not Started',
    'in_progress':  'In Progress',
    'confirmed':    'Confirmed',
    'not_uploaded': 'Not Uploaded',
    'uploaded':     'Uploaded',
    'approved':     'Approved',
    'rejected':     'Rejected',
}


def _build_audit_entry(write_vals: dict, changed_by: str, reason: str) -> str:
    """Build a single timestamped audit line for inbody_internal_notes."""
    ts = datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')
    who = changed_by or 'InBody Admin'
    changes = []
    for odoo_field, value in write_vals.items():
        label = _DEAL_FIELD_LABELS.get(odoo_field, odoo_field)
        if isinstance(value, bool):
            display = 'Yes' if value else 'No'
        else:
            display = _DEAL_VALUE_LABELS.get(str(value), str(value))
        changes.append(f"{label}: {display}")
    lines = [f"[{ts} | {who}]", "Updated: " + ", ".join(changes)]
    if reason and reason.strip():
        lines.append(f"Note: {reason.strip()}")
    lines.append("-" * 40)
    return "\n".join(lines)


def _sync_update_cultfit_deal_fields(
    order_id: int, updates: dict, changed_by: str = '', reason: str = ''
) -> dict:
    """
    Write specific deal status fields to Odoo via XML-RPC.
    The model's write() override handles side effects (auto-date stamps, etc.).
    Appends a timestamped audit entry (with reason) to inbody_internal_notes.
    """
    uid, models = _connect()

    write_vals: dict = {}
    for portal_key, value in updates.items():
        odoo_field = _DEAL_FIELD_MAP.get(portal_key)
        if not odoo_field:
            raise ValueError(f"Unknown field: '{portal_key}'")
        if odoo_field == 'inbody_confirmation_mail_sent':
            write_vals[odoo_field] = bool(value)
        else:
            allowed = _DEAL_FIELD_ALLOWED.get(odoo_field, frozenset())
            if allowed and value not in allowed:
                raise ValueError(
                    f"Invalid value '{value}' for {portal_key}. "
                    f"Allowed: {sorted(allowed)}"
                )
            write_vals[odoo_field] = value

    if not write_vals:
        raise ValueError("No valid fields to update")

    # Read current internal notes and order existence check in one call
    records = models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'sale.order', 'read',
        [[order_id]], {'fields': ['inbody_internal_notes']},
    )
    if not records:
        raise ValueError(f"Order {order_id} not found")

    existing_notes = records[0].get('inbody_internal_notes') or ''
    audit_entry    = _build_audit_entry(write_vals, changed_by, reason)
    separator      = '\n\n' if existing_notes.strip() else ''
    write_vals['inbody_internal_notes'] = audit_entry + separator + existing_notes

    models.execute_kw(
        ODOO_DB, uid, ODOO_PASS, 'sale.order', 'write',
        [[order_id], write_vals],
    )

    return {
        'order_id': order_id,
        'updated':  sorted(k for k in write_vals if k != 'inbody_internal_notes'),
    }


async def update_cultfit_deal_fields(
    order_id: int, updates: dict, changed_by: str = '', reason: str = ''
) -> dict:
    """Async wrapper — writes deal status fields + audit note via XML-RPC."""
    return await asyncio.to_thread(
        _sync_update_cultfit_deal_fields, order_id, updates, changed_by, reason
    )
