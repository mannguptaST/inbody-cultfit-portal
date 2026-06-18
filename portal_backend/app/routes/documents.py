"""
documents.py — Document list and download endpoints.

Endpoints:
  GET /api/v1/portal/orders/{order_id}/documents → list documents
  GET /api/v1/portal/documents/{doc_id}          → download file

All downloads stream through FastAPI — the Odoo server address is never exposed.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.auth.token_extractor import TokenData, get_token_data
from app.services.odoo_client import OdooError, odoo_download_document, odoo_get_documents

logger = logging.getLogger(__name__)
router = APIRouter()


def _raise(e: OdooError):
    status_map = {401: 401, 403: 403, 404: 404, 503: 503}
    raise HTTPException(status_code=status_map.get(e.status_code, 500), detail=e.detail)


@router.get(
    "/portal/orders/{order_id}/documents",
    summary="List documents for an order",
    description="FOFO orders: invoice documents are excluded from this list.",
)
async def list_documents(
    order_id: int,
    token_data: TokenData = Depends(get_token_data),
):
    try:
        return await odoo_get_documents(token_data.raw_token, order_id)
    except OdooError as e:
        _raise(e)


@router.get(
    "/portal/documents/{doc_id}",
    summary="Download a document",
    description="Streams the document binary. FOFO invoice documents cannot be downloaded.",
)
async def download_document(
    doc_id: int,
    token_data: TokenData = Depends(get_token_data),
):
    try:
        file_bytes, content_type, filename = await odoo_download_document(
            token_data.raw_token, doc_id
        )
        logger.info(
            "Document %s downloaded by partner %s (%s bytes)",
            doc_id, token_data.partner_id, len(file_bytes),
        )
        return Response(
            content=file_bytes,
            media_type=content_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except OdooError as e:
        _raise(e)
