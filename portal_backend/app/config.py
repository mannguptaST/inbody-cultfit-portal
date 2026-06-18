"""
config.py — Central configuration using environment variables.

WHY: Never hardcode secrets (API keys, passwords, URLs) in code.
     Different environments (dev, staging, production) use different values.
     A .env file provides them locally; cloud platforms inject them as env vars.
"""

import os
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ── Odoo Connection ───────────────────────────────────────────────────────
    # Where your Odoo server is running.
    # Dev: http://localhost:8069
    # Production: https://odoo.yourdomain.com
    ODOO_BASE_URL: str = "http://localhost:8069"

    # Odoo service account for XML-RPC calls (portal_db reads, deal-status writes).
    # Dev: admin / admin (local Odoo)
    # Production: create a dedicated service user with minimal permissions.
    ODOO_API_USER: str = "admin"
    ODOO_API_PASS: str = "admin"

    # ── Database ──────────────────────────────────────────────────────────────
    # Empty string → SQLite (local dev, auto-created at portal_users.db)
    # postgresql://user:pass@host:5432/dbname → Supabase / any PostgreSQL
    DATABASE_URL: str = ""

    # The JWT secret must be IDENTICAL to the one in Odoo's ir.config_parameter.
    # Both sides (Odoo + FastAPI) sign/verify using this same secret.
    # WHY: A single secret means tokens issued by Odoo are accepted by FastAPI.
    JWT_SECRET: str = "inbody-portal-dev-secret-CHANGE-IN-PRODUCTION"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_HOURS: int = 24

    # ── FastAPI Server ────────────────────────────────────────────────────────
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    DEBUG: bool = True     # set to false in production to hide /docs and stack traces

    # ── Email Alerts ─────────────────────────────────────────────────────────
    # Used to send stage-change notifications to customers.
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = ""           # your Gmail or SMTP user
    SMTP_PASSWORD: str = ""       # your app password
    ALERT_FROM_EMAIL: str = "noreply@inbodyindia.com"

    # ── AI Engineer ───────────────────────────────────────────────────────────
    ANTHROPIC_API_KEY: str = ""
    CHROMA_DB_PATH: str = "./chroma_data"
    ODOO_DB: str = "inbody_dev"
    ODOO_DB_USER: str = "odoo_dev"
    ODOO_DB_PASS: str = "odoo_dev_pass"

    # ── Rate Limiting ─────────────────────────────────────────────────────────
    # Max API calls per minute per client company.
    RATE_LIMIT_PER_MINUTE: int = 60

    # ── CORS ──────────────────────────────────────────────────────────────────
    # Which origins are allowed to call this API.
    # Dev: localhost:3000 (Next.js dev server)
    # Production: your Vercel domain
    ALLOWED_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:3001",
        "https://*.vercel.app",
    ]

    class Config:
        env_file = ".env"           # reads from .env file in current directory
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    """
    Returns cached Settings instance.
    lru_cache means settings are read once and reused — not re-read on every request.
    """
    return Settings()
