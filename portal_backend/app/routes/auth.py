"""
auth.py — Authentication endpoints.

Endpoints:
  POST /api/v1/auth/login   → validate credentials, return JWT
  POST /api/v1/auth/logout  → (stateless JWT — just instruct client to discard token)
  GET  /api/v1/auth/me      → return current user info from token

HOW LOGIN FLOW WORKS:
  1. Browser sends POST /api/v1/auth/login with {email, password}
  2. FastAPI calls Odoo's login API
  3. Odoo validates credentials against res.users
  4. Odoo issues JWT token (signed with shared secret)
  5. FastAPI returns that token to the browser
  6. Browser stores token (localStorage or httpOnly cookie)
  7. All future requests include: Authorization: Bearer <token>
"""

import logging

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr

from app.auth.jwt_handler import get_current_user
from app.services.odoo_client import OdooError, odoo_login
from fastapi import Depends

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Request / Response Models ────────────────────────────────────────────────
# Pydantic models validate incoming request data automatically.
# If a required field is missing or wrong type, FastAPI returns 422 automatically.

class LoginRequest(BaseModel):
    email: str
    password: str

    class Config:
        json_schema_extra = {
            "example": {"email": "admin", "password": "admin"}
        }


class LoginResponse(BaseModel):
    token: str
    expires_in: int
    user: dict


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.post(
    "/auth/login",
    response_model=LoginResponse,
    summary="Login and get JWT token",
    description=(
        "Authenticates against Odoo and returns a JWT token. "
        "Include this token in subsequent requests as: Authorization: Bearer <token>"
    ),
)
async def login(body: LoginRequest):
    """
    Validates credentials against Odoo and returns a JWT token.
    The token is valid for 24 hours.
    """
    logger.info("Login attempt for: %s", body.email)

    try:
        odoo_response = await odoo_login(body.email.strip().lower(), body.password)
        logger.info("Login successful for: %s (role: %s)", body.email, odoo_response.get("user", {}).get("role"))
        return odoo_response

    except OdooError as e:
        if e.status_code == 401:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password.",
            )
        elif e.status_code == 503:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Authentication service temporarily unavailable.",
            )
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post(
    "/auth/logout",
    summary="Logout",
    description="JWT tokens are stateless — logout just instructs the client to discard the token.",
)
async def logout():
    """
    Since JWT tokens are stateless, there is no server-side session to destroy.
    The client must discard the token on logout.
    In a future version, we can implement a token blocklist for immediate invalidation.
    """
    return {"message": "Logged out. Please discard your token."}


@router.get(
    "/auth/me",
    summary="Get current user info",
    description="Returns the authenticated user's profile decoded from their JWT token.",
)
async def get_me(user: dict = Depends(get_current_user)):
    """
    Returns the current user's info without calling Odoo.
    The info comes directly from the JWT payload (fast — no DB call).
    """
    return {
        "partner_id": user.get("partner_id"),
        "company": user.get("company"),
        "role": user.get("role"),
        "token_expires_at": user.get("exp"),
    }
