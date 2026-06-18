"""
fofo_masker.py — Second layer of FOFO price enforcement.

WHY TWO LAYERS?
Layer 1 (Odoo): strips prices before the API response leaves Odoo
Layer 2 (FastAPI): strips prices again before sending to the browser

Defence in depth: even if Layer 1 has a bug, Layer 2 catches it.
FOFO pricing must NEVER reach the customer's browser — this is a legal/contractual rule.
"""

# Fields that must NEVER appear in a FOFO order response
_FOFO_BLOCKED_FIELDS = frozenset({
    "amount_total",
    "amount_untaxed",
    "amount_tax",
    "amount_residual",
    "amount_to_invoice",
    "amount_invoiced",
    "price_unit",
    "price_subtotal",
    "price_tax",
    "price_total",
})


def mask_if_fofo(data: dict) -> dict:
    """
    Strips price fields from order data if the order is FOFO.
    Works on both single order and order-list items.
    Returns the modified dict (original is not mutated).
    """
    if data.get("coco_fofo_type") != "fofo":
        return data

    result = {k: v for k, v in data.items() if k not in _FOFO_BLOCKED_FIELDS}

    # Also strip from line items if present
    if "order_lines" in result:
        result["order_lines"] = [
            {k: v for k, v in line.items() if k not in _FOFO_BLOCKED_FIELDS}
            for line in result["order_lines"]
        ]

    result["fofo_notice"] = "Price information is not available for this order type."
    return result


def mask_orders_list(orders_response: dict) -> dict:
    """Apply FOFO masking to every order in a list response."""
    if "orders" not in orders_response:
        return orders_response
    return {
        **orders_response,
        "orders": [mask_if_fofo(order) for order in orders_response["orders"]],
    }
