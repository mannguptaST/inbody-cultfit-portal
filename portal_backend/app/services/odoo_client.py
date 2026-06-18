"""
odoo_client.py — Async HTTP client for calling Odoo's REST API endpoints.

All communication with Odoo flows through this single file.
Every function is async and uses httpx for non-blocking I/O.

WHY ASYNC:
FastAPI is async — if we used synchronous HTTP calls here, every Odoo request
would block the entire server. With async, FastAPI can handle other requests
while waiting for Odoo to respond.

ERROR HANDLING:
All Odoo errors are converted to OdooError with a status_code and detail.
Route handlers catch OdooError and convert to HTTPException.
"""

import logging
from typing import Optional

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

ODOO_BASE = settings.ODOO_BASE_URL.rstrip("/")
PORTAL_API = f"{ODOO_BASE}/api/v1/portal"


class OdooError(Exception):
    """Raised when Odoo returns an error response."""
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _check(resp: httpx.Response):
    """Raises OdooError if the response is not 2xx."""
    if resp.status_code >= 400:
        try:
            body = resp.json()
            detail = body.get("message") or body.get("error") or resp.text
        except Exception:
            detail = resp.text or "Odoo returned an error."
        raise OdooError(status_code=resp.status_code, detail=detail)


async def odoo_login(email: str, password: str) -> dict:
    """Authenticates with Odoo and returns {token, expires_in, user}."""
    url = f"{PORTAL_API}/auth/login"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json={"email": email, "password": password})
        _check(resp)
        data = resp.json()
        return {
            "token": data["token"],
            "expires_in": 86400,
            "user": {
                "name": data.get("name"),
                "role": data.get("role"),
                "email": email,
            },
        }
    except OdooError:
        raise
    except httpx.ConnectError:
        raise OdooError(503, "Cannot connect to Odoo. Is the server running?")
    except Exception as e:
        logger.error("odoo_login error: %s", e)
        raise OdooError(500, "Unexpected error during login.")


async def odoo_get_orders(token: str, centre: Optional[str] = None) -> dict:
    """Fetches orders list from Odoo."""
    url = f"{PORTAL_API}/orders"
    params = {}
    if centre:
        params["centre"] = centre
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(url, headers=_auth_headers(token), params=params)
        _check(resp)
        return resp.json()
    except OdooError:
        raise
    except httpx.ConnectError:
        raise OdooError(503, "Cannot connect to Odoo.")
    except Exception as e:
        logger.error("odoo_get_orders error: %s", e)
        raise OdooError(500, "Unexpected error fetching orders.")


async def odoo_get_order_detail(token: str, order_id: int) -> dict:
    """Fetches single order detail from Odoo."""
    url = f"{PORTAL_API}/orders/{order_id}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=_auth_headers(token))
        _check(resp)
        return resp.json()
    except OdooError:
        raise
    except httpx.ConnectError:
        raise OdooError(503, "Cannot connect to Odoo.")
    except Exception as e:
        logger.error("odoo_get_order_detail error: %s", e)
        raise OdooError(500, "Unexpected error fetching order detail.")


async def odoo_get_timeline(token: str, order_id: int) -> dict:
    """Fetches 9-stage timeline for an order."""
    url = f"{PORTAL_API}/orders/{order_id}/timeline"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=_auth_headers(token))
        _check(resp)
        return resp.json()
    except OdooError:
        raise
    except httpx.ConnectError:
        raise OdooError(503, "Cannot connect to Odoo.")
    except Exception as e:
        logger.error("odoo_get_timeline error: %s", e)
        raise OdooError(500, "Unexpected error fetching timeline.")


async def odoo_get_documents(token: str, order_id: int) -> dict:
    """Fetches document list for an order."""
    url = f"{PORTAL_API}/orders/{order_id}/documents"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=_auth_headers(token))
        _check(resp)
        return resp.json()
    except OdooError:
        raise
    except httpx.ConnectError:
        raise OdooError(503, "Cannot connect to Odoo.")
    except Exception as e:
        logger.error("odoo_get_documents error: %s", e)
        raise OdooError(500, "Unexpected error fetching documents.")


async def odoo_download_document(token: str, doc_id: int) -> tuple[bytes, str, str]:
    """Downloads a document binary. Returns (bytes, content_type, filename)."""
    url = f"{PORTAL_API}/documents/{doc_id}"
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(url, headers=_auth_headers(token))
        _check(resp)
        content_type = resp.headers.get("content-type", "application/octet-stream")
        cd = resp.headers.get("content-disposition", "")
        filename = "document"
        if 'filename="' in cd:
            filename = cd.split('filename="')[1].rstrip('"')
        return resp.content, content_type, filename
    except OdooError:
        raise
    except httpx.ConnectError:
        raise OdooError(503, "Cannot connect to Odoo.")
    except Exception as e:
        logger.error("odoo_download_document error: %s", e)
        raise OdooError(500, "Unexpected error downloading document.")


async def odoo_update_stage(
    token: str, order_id: int, action: str, reason: str = ""
) -> dict:
    """Advances or reverts order stage (action = 'next' or 'prev')."""
    url = f"{PORTAL_API}/admin/orders/{order_id}/update_stage"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                url,
                headers=_auth_headers(token),
                json={"action": action, "reason": reason},
            )
        _check(resp)
        return resp.json()
    except OdooError:
        raise
    except httpx.ConnectError:
        raise OdooError(503, "Cannot connect to Odoo.")
    except Exception as e:
        logger.error("odoo_update_stage error: %s", e)
        raise OdooError(500, "Unexpected error updating stage.")


async def odoo_set_stage(
    token: str,
    order_id: int,
    stage: str,
    reason: str = "",
    source: str = "admin_manual",
) -> dict:
    """Sets order to a specific stage directly."""
    url = f"{PORTAL_API}/admin/orders/{order_id}/set_stage"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                url,
                headers=_auth_headers(token),
                json={"stage": stage, "reason": reason, "source": source},
            )
        _check(resp)
        return resp.json()
    except OdooError:
        raise
    except httpx.ConnectError:
        raise OdooError(503, "Cannot connect to Odoo.")
    except Exception as e:
        logger.error("odoo_set_stage error: %s", e)
        raise OdooError(500, "Unexpected error setting stage.")
