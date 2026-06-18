"""
token_extractor.py — Extracts both the raw token string AND the decoded payload.

WHY THIS EXISTS:
The jwt_handler.py returns the decoded payload (partner_id, role, etc.).
But the Odoo client needs the raw token string to forward in Authorization headers.

FastAPI's Depends() system passes credentials through the bearer_scheme,
but by the time we're in the route handler, we only have the decoded payload.

This module provides a dependency that gives us BOTH the raw token AND the payload.
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
bearer_scheme = HTTPBearer()


def _b64url_decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    return base64.urlsafe_b64decode(s + "=" * padding)


class TokenData:
    """Holds both the raw token string and the decoded payload."""
    def __init__(self, raw_token: str, payload: dict):
        self.raw_token = raw_token
        self.payload = payload
        # Shortcut properties
        self.partner_id: int = payload.get("partner_id", 0)
        self.role: str = payload.get("role", "customer")
        self.company: str = payload.get("company", "")

    @property
    def is_inbody_staff(self) -> bool:
        return self.role in ("inbody_manager", "inbody_user")

    @property
    def is_manager(self) -> bool:
        return self.role == "inbody_manager"


def get_token_data(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> TokenData:
    """
    FastAPI dependency that validates the JWT and returns TokenData.
    TokenData.raw_token is the original token string (to forward to Odoo).
    TokenData.payload is the decoded dict.
    """
    raw_token = credentials.credentials

    try:
        parts = raw_token.split(".")
        if len(parts) != 3:
            raise ValueError("Invalid token structure")

        header_b64, body_b64, sig_b64 = parts

        sig_input = f"{header_b64}.{body_b64}".encode()
        expected = hmac.new(
            settings.JWT_SECRET.encode(), sig_input, hashlib.sha256
        ).digest()
        expected_b64 = base64.urlsafe_b64encode(expected).rstrip(b"=").decode()

        if not hmac.compare_digest(sig_b64, expected_b64):
            raise ValueError("Invalid signature")

        payload = json.loads(_b64url_decode(body_b64).decode())

        if payload.get("exp", 0) < datetime.now(tz=timezone.utc).timestamp():
            raise ValueError("Token expired")

        return TokenData(raw_token=raw_token, payload=payload)

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(e),
            headers={"WWW-Authenticate": "Bearer"},
        )
