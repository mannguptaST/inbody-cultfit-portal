"""
portal_auth.py — Portal-only authentication endpoints.

SEPARATE FROM ODOO LOGIN:
  The existing /auth/login endpoint validates against Odoo's res.users table.
  THIS module validates against the local portal_users SQLite table.

  Why separate?
    • CultFit contacts (Guru, Vijay) are not Odoo users — no ERP licence needed
    • Portal login works even if Odoo is down for maintenance
    • Simpler credential management (admin can reset passwords without Odoo access)

JWT COMPATIBILITY:
  Tokens issued here use the SAME JWT_SECRET and SAME payload shape as the
  Odoo-issued tokens.  This means every downstream route (cultfit orders,
  admin stage update) works without any changes — they just read
  token_data.role and token_data.partner_id as before.
"""

import base64
import hashlib
import hmac
import json
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.config import get_settings
from app.db.portal_db import check_password, get_user_by_email, get_user_by_id
from app.limiter import limiter

logger   = logging.getLogger(__name__)
settings = get_settings()
router   = APIRouter()
_bearer  = HTTPBearer()

PORTAL_TOKEN_EXPIRY_HOURS = 24


# ── JWT helpers ───────────────────────────────────────────────────────────────

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _create_portal_token(user: dict) -> str:
    """
    Issue a signed JWT for a portal user.
    Payload is identical in shape to Odoo-issued tokens so all existing
    FastAPI route dependencies (get_token_data) accept it without change.
    """
    header  = _b64url(b'{"alg":"HS256","typ":"JWT"}')
    exp     = int((datetime.now(timezone.utc) + timedelta(hours=PORTAL_TOKEN_EXPIRY_HOURS)).timestamp())
    payload = {
        "partner_id": user["partner_id"],   # 0 = admin (sees all), >0 = customer filter
        "role":       user["role"],
        "name":       user["name"],
        "company":    "",
        "user_id":    user["id"],           # extra field — safe, ignored by old code
        "exp":        exp,
    }
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig_input   = f"{header}.{payload_b64}".encode()
    sig         = hmac.new(settings.JWT_SECRET.encode(), sig_input, hashlib.sha256).digest()
    return f"{header}.{payload_b64}.{_b64url(sig)}"


def _decode_portal_token(token: str) -> dict:
    """Verify + decode a portal JWT. Raises ValueError on any failure."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid token structure")
    header_b64, body_b64, sig_b64 = parts
    sig_input = f"{header_b64}.{body_b64}".encode()
    expected  = hmac.new(settings.JWT_SECRET.encode(), sig_input, hashlib.sha256).digest()
    if not hmac.compare_digest(sig_b64, _b64url(expected)):
        raise ValueError("Invalid token signature")
    import math
    padding = 4 - len(body_b64) % 4
    payload = json.loads(base64.urlsafe_b64decode(body_b64 + "=" * padding).decode())
    if payload.get("exp", 0) < datetime.now(tz=timezone.utc).timestamp():
        raise ValueError("Token has expired")
    return payload


# ── Request/Response models ───────────────────────────────────────────────────

class PortalLoginRequest(BaseModel):
    email:    str
    password: str

    class Config:
        json_schema_extra = {"example": {"email": "guru@cultfittest.in", "password": "Guru@2024"}}


class PortalLoginResponse(BaseModel):
    token:      str
    expires_in: int
    user:       dict


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post(
    "/portal/auth/login",
    response_model=PortalLoginResponse,
    summary="Portal-only login",
    description=(
        "Authenticates against the local portal_users table (NOT Odoo).\n\n"
        "Returns a JWT token compatible with all existing API endpoints.\n\n"
        "**admin** → can see all CultFit orders and access admin table.\n"
        "**customer** → can only see their own company's CultFit orders (view-only).\n\n"
        "Rate limited to 5 requests per minute per IP."
    ),
)
@limiter.limit("5/minute")
async def portal_login(request: Request, body: PortalLoginRequest):
    email    = body.email.strip().lower()
    user     = get_user_by_email(email)

    # Constant-time-ish: always call check_password even when user not found
    # to avoid leaking which emails exist via timing differences.
    dummy_hash = "pbkdf2:sha256:260000$00000000000000000000000000000000$" + "0" * 64
    stored     = user["password_hash"] if user else dummy_hash
    valid      = check_password(body.password, stored)

    if not user or not valid:
        logger.warning("Portal login failed for: %s", email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    logger.info("Portal login: %s (role=%s partner_id=%d)", email, user["role"], user["partner_id"])

    token = _create_portal_token(user)
    return {
        "token":      token,
        "expires_in": PORTAL_TOKEN_EXPIRY_HOURS * 3600,
        "user": {
            "name":    user["name"],
            "email":   user["email"],
            "role":    user["role"],
            "company": "",
        },
    }


@router.get(
    "/portal/auth/me",
    summary="Current portal user",
    description="Decodes the current JWT and returns user info. Works for both portal and Odoo tokens.",
)
async def portal_me(credentials: HTTPAuthorizationCredentials = Depends(_bearer)):
    try:
        payload = _decode_portal_token(credentials.credentials)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(e))

    user_id = payload.get("user_id")
    db_user = get_user_by_id(user_id) if user_id else None

    return {
        "partner_id": payload.get("partner_id", 0),
        "role":       payload.get("role"),
        "name":       payload.get("name"),
        "email":      db_user["email"] if db_user else None,
    }


@router.post(
    "/portal/auth/logout",
    summary="Logout (stateless)",
    description="JWT tokens are stateless — logout instructs the client to discard the token.",
)
async def portal_logout():
    return {"message": "Logged out. Please discard your token."}
