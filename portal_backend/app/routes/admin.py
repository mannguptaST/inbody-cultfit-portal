"""
admin.py — Admin-only endpoints for InBody staff.

Endpoints:
  POST /api/v1/admin/orders/{order_id}/update_stage → advance or revert stage
  POST /api/v1/admin/orders/{order_id}/set_stage    → jump to specific stage

ACCESS CONTROL:
Role must be 'admin' (inbody_manager or inbody_user).
Customers calling these endpoints receive 403 Forbidden.

These endpoints forward requests to Odoo which performs the actual DB write
and logs the change to inbody.stage.history.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth.token_extractor import TokenData, get_token_data
from app.services.odoo_client import OdooError, odoo_set_stage, odoo_update_stage

logger = logging.getLogger(__name__)
router = APIRouter()


def _raise(e: OdooError):
    status_map = {401: 401, 403: 403, 404: 404, 503: 503}
    raise HTTPException(status_code=status_map.get(e.status_code, 500), detail=e.detail)


def _require_staff(token_data: TokenData):
    if token_data.role == "customer":
        raise HTTPException(status_code=403, detail="Access denied. InBody staff only.")


class UpdateStageRequest(BaseModel):
    action: str  # 'next' or 'prev'
    reason: str = ""

    class Config:
        json_schema_extra = {
            "example": {"action": "next", "reason": "MD approval received"}
        }


class SetStageRequest(BaseModel):
    stage: str
    reason: str = ""
    source: str = "admin_manual"

    class Config:
        json_schema_extra = {
            "example": {
                "stage": "stage_4_md_approved",
                "reason": "MD signed off on 8 June",
                "source": "admin_manual",
            }
        }


@router.post(
    "/admin/orders/{order_id}/update_stage",
    summary="Advance or revert order stage",
    description=(
        "Moves the order one step forward (`action=next`) or backward (`action=prev`).\n\n"
        "**Staff only.** Every change is logged to the stage history audit trail."
    ),
)
async def update_stage(
    order_id: int,
    body: UpdateStageRequest,
    token_data: TokenData = Depends(get_token_data),
):
    _require_staff(token_data)
    if body.action not in ("next", "prev"):
        raise HTTPException(status_code=400, detail="action must be 'next' or 'prev'.")
    try:
        result = await odoo_update_stage(
            token_data.raw_token, order_id, body.action, body.reason
        )
        logger.info("Stage %s for order %s by %s", body.action, order_id, token_data.role)
        return result
    except OdooError as e:
        _raise(e)


@router.post(
    "/admin/orders/{order_id}/set_stage",
    summary="Set order to a specific stage",
    description=(
        "Jumps the order directly to any of the 9 stages.\n\n"
        "**Staff only.** Use `update_stage` for sequential next/prev movement.\n"
        "Every change is logged to the stage history audit trail."
    ),
)
async def set_stage(
    order_id: int,
    body: SetStageRequest,
    token_data: TokenData = Depends(get_token_data),
):
    _require_staff(token_data)
    try:
        result = await odoo_set_stage(
            token_data.raw_token, order_id, body.stage, body.reason, body.source
        )
        logger.info(
            "Stage set to %s for order %s by %s", body.stage, order_id, token_data.role
        )
        return result
    except OdooError as e:
        _raise(e)
