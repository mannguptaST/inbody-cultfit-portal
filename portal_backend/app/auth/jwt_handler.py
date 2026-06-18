"""
jwt_handler.py — JWT token verification for FastAPI.

WHY THIS EXISTS:
The Odoo module creates JWT tokens using a shared secret.
FastAPI uses the SAME secret to verify those tokens.

This means:
- Odoo issues the token on login
- FastAPI verifies it on every subsequent request
- No separate user database needed in FastAPI
- One token works for both systems

HOW JWT WORKS:
  Token = Header.Payload.Signature

  Header:    {"alg": "HS256", "typ": "JWT"}
  Payload:   {"partner_id": 3, "role": "inbody_manager", "exp": 1234567890}
  Signature: HMAC-SHA256(Header + "." + Payload, secret)

  Anyone can READ the payload (it's just base64).
  But only someone with the SECRET can CREATE a valid signature.
  So the server verifies: "did I sign this token?" If yes → trust it.
"""

import base64
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# HTTPBearer extracts the "Bearer <token>" from the Authorization header
bearer_scheme = HTTPBearer()


def _b64url_decode(s: str) -> bytes:
    """Decode base64url string (JWT uses URL-safe base64 without padding)."""
    padding = 4 - len(s) % 4
    return base64.urlsafe_b64decode(s + "=" * padding)


def verify_token(token: str) -> dict:
    """
    Verifies a JWT token and returns its payload.

    Returns the decoded payload dict if valid.
    Raises ValueError if the token is invalid or expired.

    WHY WE DO THIS MANUALLY:
    The Odoo module uses pure Python stdlib for JWT (no PyJWT).
    We use the same approach here so both sides are consistent.
    """
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("Token must have 3 parts")

        header_b64, body_b64, sig_b64 = parts

        # Re-compute the expected signature
        sig_input = f"{header_b64}.{body_b64}".encode()
        expected_sig = hmac.new(
            settings.JWT_SECRET.encode(),
            sig_input,
            hashlib.sha256,
        ).digest()
        expected_b64 = base64.urlsafe_b64encode(expected_sig).rstrip(b"=").decode()

        # Compare signatures (constant-time to prevent timing attacks)
        if not hmac.compare_digest(sig_b64, expected_b64):
            raise ValueError("Invalid signature")

        # Decode and parse payload
        payload = json.loads(_b64url_decode(body_b64).decode())

        # Check expiry
        exp = payload.get("exp", 0)
        now = datetime.now(tz=timezone.utc).timestamp()
        if exp < now:
            raise ValueError("Token has expired")

        return payload

    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Token decode error: {e}") from e


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """
    FastAPI dependency — validates JWT and returns the decoded payload.

    Usage in routes:
        @router.get("/orders")
        async def get_orders(user: dict = Depends(get_current_user)):
            partner_id = user["partner_id"]
            role = user["role"]

    WHY DEPENDENCIES:
    FastAPI's Depends() system automatically runs this function before the
    route handler. If the token is invalid, FastAPI returns 401 automatically.
    The route handler only runs if auth succeeds.
    """
    try:
        payload = verify_token(credentials.credentials)
        return payload
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(e),
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_inbody_staff(user: dict = Depends(get_current_user)) -> dict:
    """
    Stricter dependency — only allows InBody staff (not external customers).
    Use on admin-only endpoints.
    """
    if user.get("role") not in ("inbody_manager", "inbody_user"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="InBody staff access only.",
        )
    return user


def require_inbody_manager(user: dict = Depends(get_current_user)) -> dict:
    """Only allows InBody managers. Use for sensitive operations."""
    if user.get("role") != "inbody_manager":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="InBody Manager access only.",
        )
    return user
