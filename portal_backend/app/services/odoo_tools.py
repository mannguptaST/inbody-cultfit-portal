"""
odoo_tools.py — Live Odoo data query functions exposed as Claude tools.

Each function here becomes a tool Claude can call when answering questions.
Claude decides WHICH tool to call based on the user's question.
"""

import logging
import xmlrpc.client
from typing import Any

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

ODOO_URL = settings.ODOO_BASE_URL
ODOO_DB = settings.ODOO_DB
ODOO_USER = "admin"
ODOO_PASS = "admin"

# ─── Claude Tool Definitions ──────────────────────────────────────────────────
# These are passed to Claude so it knows what tools are available.

ODOO_TOOL_DEFINITIONS = [
    {
        "name": "query_odoo_model",
        "description": (
            "Query any Odoo model (table) to get live business data. "
            "Use this for sales orders, customers, products, invoices, etc. "
            "Returns a list of records matching the domain filter."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "model": {
                    "type": "string",
                    "description": "Odoo model name e.g. 'sale.order', 'res.partner', 'account.move', 'stock.picking'",
                },
                "domain": {
                    "type": "array",
                    "description": "Odoo domain filter e.g. [['state','=','sale']] or [] for all records",
                    "items": {},
                },
                "fields": {
                    "type": "array",
                    "description": "List of field names to return e.g. ['name', 'amount_total', 'partner_id']",
                    "items": {"type": "string"},
                },
                "limit": {
                    "type": "integer",
                    "description": "Max number of records to return (default 50, max 200)",
                },
                "order": {
                    "type": "string",
                    "description": "Sort order e.g. 'date_order desc' or 'name asc'",
                },
            },
            "required": ["model", "domain", "fields"],
        },
    },
    {
        "name": "get_sales_summary",
        "description": (
            "Get a high-level sales summary: total orders, revenue, overdue payments, "
            "orders by stage. Use this for dashboard-style questions like "
            "'how many orders do we have?' or 'what is the total revenue?'"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "client_name": {
                    "type": "string",
                    "description": "Filter by client name (optional). Leave empty for all clients.",
                },
                "stage": {
                    "type": "string",
                    "description": "Filter by portal stage key e.g. 'stage_3_po_received' (optional)",
                },
            },
            "required": [],
        },
    },
    {
        "name": "get_overdue_orders",
        "description": (
            "Get all orders with overdue payments. Returns order name, client, "
            "centre, days overdue, and amount. Use for payment follow-up questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "get_order_detail",
        "description": "Get full details of a specific sale order by order name (e.g. S00001).",
        "input_schema": {
            "type": "object",
            "properties": {
                "order_name": {
                    "type": "string",
                    "description": "The sale order name e.g. 'S00001'",
                },
            },
            "required": ["order_name"],
        },
    },
    {
        "name": "list_installed_modules",
        "description": "List all installed Odoo modules. Use when asked about what's installed or available.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filter_name": {
                    "type": "string",
                    "description": "Optional name filter e.g. 'inbody' to show only custom modules",
                },
            },
            "required": [],
        },
    },
    {
        "name": "get_model_fields",
        "description": (
            "Get all fields defined on an Odoo model with their types and labels. "
            "Use when asked about what data is stored on a model, or to understand its structure."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "model": {
                    "type": "string",
                    "description": "Odoo model name e.g. 'sale.order'",
                },
            },
            "required": ["model"],
        },
    },
]


# ─── XML-RPC Connection ───────────────────────────────────────────────────────

def _get_odoo_connection():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASS, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    return uid, models


# ─── Tool Implementations ─────────────────────────────────────────────────────

def query_odoo_model(
    model: str,
    domain: list,
    fields: list,
    limit: int = 50,
    order: str = "",
) -> dict[str, Any]:
    try:
        uid, models = _get_odoo_connection()
        kwargs: dict = {"fields": fields, "limit": min(limit, 200)}
        if order:
            kwargs["order"] = order
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASS, model, "search_read", [domain], kwargs)
        return {"success": True, "model": model, "count": len(records), "records": records}
    except Exception as e:
        logger.error("query_odoo_model failed: %s", e)
        return {"success": False, "error": str(e)}


def get_sales_summary(client_name: str = "", stage: str = "") -> dict[str, Any]:
    try:
        uid, models = _get_odoo_connection()

        domain: list = [["state", "in", ["sale", "done"]]]
        if client_name:
            domain.append(["partner_id.commercial_partner_id.name", "ilike", client_name])
        if stage:
            domain.append(["inbody_portal_stage", "=", stage])

        orders = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, "sale.order", "search_read",
            [domain],
            {
                "fields": [
                    "name", "partner_id", "amount_total", "currency_id",
                    "inbody_portal_stage", "inbody_payment_overdue",
                    "inbody_payment_status", "inbody_coco_fofo_type",
                    "inbody_centre_name", "date_order",
                ],
                "limit": 200,
            },
        )

        total_revenue = sum(
            o["amount_total"] for o in orders
            if o.get("inbody_coco_fofo_type") != "fofo"
        )
        overdue_count = sum(1 for o in orders if o.get("inbody_payment_overdue"))
        collected_count = sum(1 for o in orders if o.get("inbody_payment_status") == "collected")

        stage_counts: dict[str, int] = {}
        for o in orders:
            s = o.get("inbody_portal_stage", "unknown")
            stage_counts[s] = stage_counts.get(s, 0) + 1

        return {
            "success": True,
            "total_orders": len(orders),
            "total_revenue_inr": total_revenue,
            "overdue_orders": overdue_count,
            "collected_orders": collected_count,
            "orders_by_stage": stage_counts,
            "fofo_orders": sum(1 for o in orders if o.get("inbody_coco_fofo_type") == "fofo"),
        }
    except Exception as e:
        logger.error("get_sales_summary failed: %s", e)
        return {"success": False, "error": str(e)}


def get_overdue_orders() -> dict[str, Any]:
    try:
        uid, models = _get_odoo_connection()
        orders = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, "sale.order", "search_read",
            [[["inbody_payment_overdue", "=", True]]],
            {
                "fields": [
                    "name", "partner_id", "inbody_centre_name",
                    "amount_total", "inbody_payment_due_date",
                    "inbody_days_to_payment_due", "inbody_coco_fofo_type",
                    "inbody_portal_stage",
                ],
                "order": "inbody_days_to_payment_due asc",
                "limit": 100,
            },
        )
        return {"success": True, "overdue_count": len(orders), "orders": orders}
    except Exception as e:
        logger.error("get_overdue_orders failed: %s", e)
        return {"success": False, "error": str(e)}


def get_order_detail(order_name: str) -> dict[str, Any]:
    try:
        uid, models = _get_odoo_connection()
        orders = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, "sale.order", "search_read",
            [[["name", "=", order_name.upper()]]],
            {
                "fields": [
                    "name", "partner_id", "inbody_centre_name",
                    "amount_total", "currency_id", "date_order",
                    "inbody_portal_stage", "inbody_coco_fofo_type",
                    "inbody_payment_status", "inbody_payment_overdue",
                    "inbody_payment_due_date", "inbody_days_to_payment_due",
                    "inbody_pi_issued_date", "inbody_po_received_date",
                    "inbody_md_approval_status", "inbody_installation_status",
                    "inbody_vendor_portal_status", "inbody_confirmation_mail_sent",
                    "inbody_portal_visible_notes", "state",
                ],
                "limit": 1,
            },
        )
        if not orders:
            return {"success": False, "error": f"Order {order_name} not found"}
        return {"success": True, "order": orders[0]}
    except Exception as e:
        logger.error("get_order_detail failed: %s", e)
        return {"success": False, "error": str(e)}


def list_installed_modules(filter_name: str = "") -> dict[str, Any]:
    try:
        uid, models = _get_odoo_connection()
        domain: list = [["state", "=", "installed"]]
        if filter_name:
            domain.append(["name", "ilike", filter_name])
        modules = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, "ir.module.module", "search_read",
            [domain],
            {"fields": ["name", "shortdesc", "author", "installed_version"], "limit": 100},
        )
        return {"success": True, "count": len(modules), "modules": modules}
    except Exception as e:
        logger.error("list_installed_modules failed: %s", e)
        return {"success": False, "error": str(e)}


def get_model_fields(model: str) -> dict[str, Any]:
    try:
        uid, models = _get_odoo_connection()
        fields = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, model, "fields_get",
            [],
            {"attributes": ["string", "type", "help", "required"]},
        )
        simplified = [
            {
                "name": k,
                "label": v.get("string", k),
                "type": v.get("type", ""),
                "help": v.get("help", ""),
                "required": v.get("required", False),
            }
            for k, v in fields.items()
        ]
        simplified.sort(key=lambda x: x["name"])
        return {"success": True, "model": model, "field_count": len(simplified), "fields": simplified}
    except Exception as e:
        logger.error("get_model_fields failed: %s", e)
        return {"success": False, "error": str(e)}


# ─── Dispatcher ───────────────────────────────────────────────────────────────

TOOL_FUNCTIONS = {
    "query_odoo_model": query_odoo_model,
    "get_sales_summary": get_sales_summary,
    "get_overdue_orders": get_overdue_orders,
    "get_order_detail": get_order_detail,
    "list_installed_modules": list_installed_modules,
    "get_model_fields": get_model_fields,
}


def execute_tool(tool_name: str, tool_input: dict) -> Any:
    """Called by ai_engine when Claude requests a tool call."""
    fn = TOOL_FUNCTIONS.get(tool_name)
    if not fn:
        return {"error": f"Unknown tool: {tool_name}"}
    try:
        return fn(**tool_input)
    except Exception as e:
        logger.error("Tool %s failed with input %s: %s", tool_name, tool_input, e)
        return {"error": str(e)}
