"""
orders.py — Order endpoints for the customer portal.

Endpoints:
  GET /api/v1/portal/orders                     → list all orders
  GET /api/v1/portal/orders/{order_id}          → single order detail
  GET /api/v1/portal/orders/{order_id}/timeline → 9-stage timeline

MULTI-TENANT ISOLATION:
Each user's JWT contains their partner_id and role.
Odoo enforces that customers only see their own company's orders.

FOFO MASKING:
Applied at TWO levels:
1. Odoo controller strips prices before sending
2. fofo_masker.py strips again here (defence in depth)
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth.token_extractor import TokenData, get_token_data
from app.services.odoo_client import OdooError, odoo_get_order_detail, odoo_get_orders, odoo_get_timeline

logger = logging.getLogger(__name__)
router = APIRouter()


def _raise(e: OdooError):
    """Maps OdooError status codes to HTTPException."""
    status_map = {401: 401, 403: 403, 404: 404, 503: 503}
    raise HTTPException(
        status_code=status_map.get(e.status_code, 500),
        detail=e.detail,
    )


@router.get(
    "/portal/orders",
    summary="List all orders",
    description=(
        "Returns orders visible to the authenticated user.\n\n"
        "**Customers** see only their company's orders.\n"
        "**InBody staff** see all orders.\n"
        "**FOFO orders**: price fields are automatically removed."
    ),
)
async def get_orders(
    centre: str | None = Query(None, description="Filter by centre name"),
    token_data: TokenData = Depends(get_token_data),
):
    try:
        orders_data = await odoo_get_orders(token_data.raw_token, centre=centre)
        return orders_data
    except OdooError as e:
        _raise(e)


@router.get(
    "/portal/orders/{order_id}",
    summary="Get order detail",
    description="Returns full detail for one order. FOFO orders have prices stripped.",
)
async def get_order_detail(
    order_id: int,
    token_data: TokenData = Depends(get_token_data),
):
    try:
        data = await odoo_get_order_detail(token_data.raw_token, order_id)
        return data
    except OdooError as e:
        _raise(e)


@router.get(
    "/portal/orders/{order_id}/timeline",
    summary="Get 9-stage order timeline",
    description="Returns the full 9-stage timeline with status and dates. No price data included.",
)
async def get_order_timeline(
    order_id: int,
    token_data: TokenData = Depends(get_token_data),
):
    try:
        return await odoo_get_timeline(token_data.raw_token, order_id)
    except OdooError as e:
        _raise(e)
