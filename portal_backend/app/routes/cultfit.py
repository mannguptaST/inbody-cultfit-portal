"""
cultfit.py — CultFit / Curefit order endpoints.

Pulls directly from Odoo via XML-RPC (not through the custom portal REST API)
so we get full field coverage: standard Odoo fields + custom inbody_* fields.

Auth:
  Staff roles (admin, inbody_manager, inbody_user) → see all CultFit orders
  Customer role → sees only their commercial partner's orders
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.auth.token_extractor import TokenData, get_token_data
from app.services.odoo_xmlrpc import (
    fetch_attachment_data,
    fetch_cultfit_order_by_id,
    fetch_cultfit_orders,
    fetch_order_attachments,
    set_cultfit_stage,
    update_cultfit_deal_fields,
    update_cultfit_stage,
)

logger = logging.getLogger(__name__)
router = APIRouter()

_STAFF_ROLES = frozenset({'admin', 'inbody_manager', 'inbody_user'})

_STAGE_WRITEBACK_ENABLED = True


# ── Request models ────────────────────────────────────────────────────────────

class StageActionRequest(BaseModel):
    action: str   # 'next' or 'prev'
    reason: str = ""

    class Config:
        json_schema_extra = {"example": {"action": "next", "reason": "PO received from CultFit"}}


class SetStageRequest(BaseModel):
    stage: str
    reason: str = ""

    class Config:
        json_schema_extra = {"example": {"stage": "dispatched", "reason": "Units shipped via Blue Dart"}}


class DealStatusRequest(BaseModel):
    payment_status:         Optional[str]  = None   # pending | overdue | collected
    installation_status:    Optional[str]  = None   # not_started | in_progress | confirmed
    vendor_portal_status:   Optional[str]  = None   # not_uploaded | uploaded
    confirmation_mail_sent: Optional[bool] = None
    md_approval_status:     Optional[str]  = None   # pending | approved | rejected
    reason:                 str            = ""     # stored in inbody_internal_notes

    class Config:
        json_schema_extra = {
            "example": {
                "payment_status": "collected",
                "installation_status": "confirmed",
                "vendor_portal_status": "uploaded",
                "confirmation_mail_sent": True,
                "md_approval_status": "approved",
                "reason": "Customer payment received via NEFT on 16 Jun 2026",
            }
        }


@router.get(
    "/portal/cultfit/orders",
    summary="CultFit order list",
    description=(
        "Returns CultFit / Curefit orders with full field coverage.\n\n"
        "**Staff** see all CultFit orders.\n"
        "**Customer** sees only their company's orders.\n\n"
        "Includes: order status, delivery status, invoice status, "
        "product/model names, payment terms, and InBody portal stage."
    ),
    tags=["CultFit"],
)
async def get_cultfit_orders(token_data: TokenData = Depends(get_token_data)):
    try:
        partner_id = 0 if token_data.role in _STAFF_ROLES else token_data.partner_id
        return await fetch_cultfit_orders(partner_id=partner_id)
    except Exception as e:
        logger.error("get_cultfit_orders failed: %s", e)
        raise HTTPException(
            status_code=503,
            detail=f"Could not fetch CultFit orders from Odoo: {e}",
        )


@router.get(
    "/portal/cultfit/orders/{order_id}",
    summary="CultFit order detail",
    description=(
        "Returns full detail for a single CultFit order.\n\n"
        "**Staff** can view any order by ID.\n"
        "**Customer** can only view their own commercial partner's orders — "
        "returns 404 if the order doesn't belong to them."
    ),
    tags=["CultFit"],
)
async def get_cultfit_order_detail(
    order_id: int,
    token_data: TokenData = Depends(get_token_data),
):
    try:
        partner_id = 0 if token_data.role in _STAFF_ROLES else token_data.partner_id
        order = await fetch_cultfit_order_by_id(order_id, partner_id=partner_id)
    except Exception as e:
        logger.error("get_cultfit_order_detail(%d) failed: %s", order_id, e)
        raise HTTPException(
            status_code=503,
            detail=f"Could not fetch order from Odoo: {e}",
        )
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    return order


@router.post(
    "/admin/cultfit/orders/{order_id}/stage",
    summary="Move CultFit order stage next or prev",
    description=(
        "Advances or reverts the portal stage of a CultFit order via XML-RPC.\n\n"
        "**Staff only.** Writes `inbody_stage_override` and logs to stage history."
    ),
    tags=["CultFit Admin"],
)
async def admin_update_cultfit_stage(
    order_id: int,
    body: StageActionRequest,
    token_data: TokenData = Depends(get_token_data),
):
    if not _STAGE_WRITEBACK_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="Portal stage override is not enabled in this deployment. Planned for Phase 10.",
        )
    if token_data.role not in _STAFF_ROLES:
        raise HTTPException(status_code=403, detail="InBody staff only.")
    if body.action not in ("next", "prev"):
        raise HTTPException(status_code=400, detail="action must be 'next' or 'prev'.")
    changed_by = token_data.payload.get("name") or token_data.payload.get("email") or ""
    try:
        result = await update_cultfit_stage(
            order_id, body.action, changed_by=changed_by, reason=body.reason
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("admin_update_cultfit_stage(%d) failed: %s", order_id, e)
        raise HTTPException(status_code=503, detail=f"Could not update stage: {e}")
    logger.info("Stage %s for CultFit order %d by %s", body.action, order_id, changed_by)
    return result


@router.post(
    "/admin/cultfit/orders/{order_id}/set_stage",
    summary="Set CultFit portal stage directly",
    description="Set the portal stage of a CultFit order to any valid stage key. **Staff only.**",
    tags=["CultFit Admin"],
)
async def admin_set_cultfit_stage(
    order_id: int,
    body: SetStageRequest,
    token_data: TokenData = Depends(get_token_data),
):
    if token_data.role not in _STAFF_ROLES:
        raise HTTPException(status_code=403, detail="InBody staff only.")
    changed_by = token_data.payload.get("name") or token_data.payload.get("email") or ""
    try:
        result = await set_cultfit_stage(
            order_id, body.stage, changed_by=changed_by, reason=body.reason
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("admin_set_cultfit_stage(%d) failed: %s", order_id, e)
        raise HTTPException(status_code=503, detail=f"Could not set stage: {e}")
    logger.info("Stage set to %s for CultFit order %d by %s", body.stage, order_id, changed_by)
    return result


@router.patch(
    "/admin/cultfit/orders/{order_id}/deal_status",
    summary="Update CultFit deal status fields",
    description=(
        "Updates one or more deal status fields on a CultFit order via XML-RPC.\n\n"
        "**Staff only.** Odoo's write() hook auto-stamps dates when status changes "
        "(e.g. vendor_portal_upload_date when vendor_portal_status → 'uploaded')."
    ),
    tags=["CultFit Admin"],
)
async def admin_update_cultfit_deal_status(
    order_id: int,
    body: DealStatusRequest,
    token_data: TokenData = Depends(get_token_data),
):
    if token_data.role not in _STAFF_ROLES:
        raise HTTPException(status_code=403, detail="InBody staff only.")

    updates: dict = {}
    if body.payment_status is not None:
        updates["payment_status"] = body.payment_status
    if body.installation_status is not None:
        updates["installation_status"] = body.installation_status
    if body.vendor_portal_status is not None:
        updates["vendor_portal_status"] = body.vendor_portal_status
    if body.confirmation_mail_sent is not None:
        updates["confirmation_mail_sent"] = body.confirmation_mail_sent
    if body.md_approval_status is not None:
        updates["md_approval_status"] = body.md_approval_status

    if not updates:
        raise HTTPException(status_code=400, detail="No fields provided to update.")

    changed_by = token_data.payload.get("name") or token_data.payload.get("email") or ""
    try:
        result = await update_cultfit_deal_fields(
            order_id, updates, changed_by=changed_by, reason=body.reason
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("admin_update_cultfit_deal_status(%d) failed: %s", order_id, e)
        raise HTTPException(status_code=503, detail=f"Could not update deal status: {e}")

    logger.info("Deal fields %s updated for order %d by %s", list(updates), order_id, changed_by)
    return result


# ── Document download endpoints ───────────────────────────────────────────────

@router.get(
    "/portal/cultfit/orders/{lead_id}/attachments",
    summary="List Odoo PDF attachments for a CultFit order",
    tags=["CultFit"],
)
async def list_cultfit_attachments(
    lead_id: int,
    token_data: TokenData = Depends(get_token_data),
):
    try:
        docs = await fetch_order_attachments(lead_id)
        return {"attachments": docs, "count": len(docs)}
    except Exception as e:
        logger.error("list_cultfit_attachments(%d) failed: %s", lead_id, e)
        raise HTTPException(status_code=503, detail=f"Could not fetch attachments: {e}")


@router.get(
    "/portal/cultfit/orders/{lead_id}/attachments/{attachment_id}",
    summary="Download a PDF attachment from Odoo",
    tags=["CultFit"],
)
async def download_cultfit_attachment(
    lead_id: int,
    attachment_id: int,
    token_data: TokenData = Depends(get_token_data),
):
    try:
        data, mimetype, filename = await fetch_attachment_data(attachment_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("download_cultfit_attachment(%d/%d) failed: %s", lead_id, attachment_id, e)
        raise HTTPException(status_code=503, detail=f"Could not download attachment: {e}")

    safe_name = filename.replace('"', '')
    return Response(
        content=data,
        media_type=mimetype,
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )
