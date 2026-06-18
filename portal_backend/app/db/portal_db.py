"""
portal_db.py — Portal user store: SQLite (dev) or PostgreSQL (production).

Dev (default):   SQLite file at portal_users.db — no extra setup needed.
Production:      Set DATABASE_URL=postgresql://... in .env → auto-switches to PostgreSQL.

PASSWORD SECURITY:
  Passwords are stored as  pbkdf2:sha256:260000$<hex-salt>$<hex-hash>
  Using Python's built-in hashlib.pbkdf2_hmac (no extra packages).
  260 000 iterations matches OWASP 2023 recommendation for PBKDF2-SHA256.
  The same hash format works in both SQLite and PostgreSQL — migration is lossless.
"""

import hashlib
import logging
import os
import secrets
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Backend selection ─────────────────────────────────────────────────────────
_DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
_USE_POSTGRES = bool(_DATABASE_URL)

if _USE_POSTGRES:
    try:
        import psycopg2
        import psycopg2.extras
        logger.info("portal_db: PostgreSQL mode (DATABASE_URL is set)")
    except ImportError as _err:
        raise RuntimeError(
            "DATABASE_URL is set but psycopg2 is not installed. "
            "Run: pip install psycopg2-binary"
        ) from _err
else:
    _DB_PATH = Path(__file__).resolve().parent.parent.parent / "portal_users.db"
    logger.info("portal_db: SQLite mode at %s", _DB_PATH)

PBKDF2_ITERATIONS = 260_000
PBKDF2_ALGO       = "sha256"
SALT_BYTES        = 16


# ── Password helpers (DB-agnostic) ───────────────────────────────────────────

def hash_password(password: str) -> str:
    """Hash a plain-text password. Returns a storable string."""
    salt = secrets.token_hex(SALT_BYTES)
    dk   = hashlib.pbkdf2_hmac(PBKDF2_ALGO, password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    return f"pbkdf2:{PBKDF2_ALGO}:{PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def check_password(password: str, stored: str) -> bool:
    """Verify a plain-text password against a stored hash. Constant-time safe."""
    try:
        meta, salt, dk_stored = stored.split("$")
        _, algo, iters_str    = meta.split(":")
        iters                 = int(iters_str)
        dk_check = hashlib.pbkdf2_hmac(algo, password.encode(), salt.encode(), iters)
        return secrets.compare_digest(dk_check.hex(), dk_stored)
    except Exception:
        return False


# ── Internal connection helpers ───────────────────────────────────────────────

def _pg_conn():
    return psycopg2.connect(_DATABASE_URL)


def _sq_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# ── Schema ────────────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create the portal_users table if it doesn't exist. Safe to call on every startup."""
    if _USE_POSTGRES:
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS portal_users (
                        id            SERIAL PRIMARY KEY,
                        email         TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        name          TEXT NOT NULL,
                        role          TEXT NOT NULL CHECK (role IN ('admin', 'customer')),
                        partner_id    INTEGER NOT NULL DEFAULT 0,
                        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
                        created_at    TIMESTAMPTZ DEFAULT NOW()
                    )
                """)
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS idx_portal_users_email "
                    "ON portal_users (email) WHERE is_active = TRUE"
                )
            conn.commit()
    else:
        with _sq_conn() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS portal_users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    email         TEXT    UNIQUE NOT NULL,
                    password_hash TEXT    NOT NULL,
                    name          TEXT    NOT NULL,
                    role          TEXT    NOT NULL CHECK(role IN ('admin', 'customer')),
                    partner_id    INTEGER NOT NULL DEFAULT 0,
                    is_active     INTEGER NOT NULL DEFAULT 1,
                    created_at    TEXT    DEFAULT (datetime('now'))
                )
            """)
            conn.commit()
    logger.info("portal_users DB ready (%s)", "PostgreSQL" if _USE_POSTGRES else "SQLite")


# ── CRUD ──────────────────────────────────────────────────────────────────────

def create_user(
    email: str,
    password: str,
    name: str,
    role: str,
    partner_id: int = 0,
) -> int:
    """Insert a new portal user. Returns the new row id."""
    hashed = hash_password(password)
    e = email.lower().strip()
    if _USE_POSTGRES:
        with _pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO portal_users (email, password_hash, name, role, partner_id) "
                    "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                    (e, hashed, name, role, partner_id),
                )
                new_id = cur.fetchone()[0]
            conn.commit()
        return new_id
    else:
        with _sq_conn() as conn:
            cur = conn.execute(
                "INSERT INTO portal_users (email, password_hash, name, role, partner_id) "
                "VALUES (?, ?, ?, ?, ?)",
                (e, hashed, name, role, partner_id),
            )
            conn.commit()
            return cur.lastrowid


def get_user_by_email(email: str) -> dict | None:
    """Return user row as dict, or None if not found / inactive."""
    e = email.lower().strip()
    if _USE_POSTGRES:
        with _pg_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT * FROM portal_users WHERE email = %s AND is_active = TRUE", (e,)
                )
                row = cur.fetchone()
        return dict(row) if row else None
    else:
        with _sq_conn() as conn:
            row = conn.execute(
                "SELECT * FROM portal_users WHERE email = ? AND is_active = 1", (e,)
            ).fetchone()
        return dict(row) if row else None


def get_user_by_id(user_id: int) -> dict | None:
    """Return user row as dict, or None if not found / inactive."""
    if _USE_POSTGRES:
        with _pg_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT * FROM portal_users WHERE id = %s AND is_active = TRUE", (user_id,)
                )
                row = cur.fetchone()
        return dict(row) if row else None
    else:
        with _sq_conn() as conn:
            row = conn.execute(
                "SELECT * FROM portal_users WHERE id = ? AND is_active = 1", (user_id,)
            ).fetchone()
        return dict(row) if row else None


def list_users() -> list[dict]:
    """Return all users (passwords excluded — never log the returned dicts)."""
    if _USE_POSTGRES:
        with _pg_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT id, email, name, role, partner_id, is_active, created_at "
                    "FROM portal_users ORDER BY id"
                )
                return [dict(r) for r in cur.fetchall()]
    else:
        with _sq_conn() as conn:
            rows = conn.execute(
                "SELECT id, email, name, role, partner_id, is_active, created_at "
                "FROM portal_users ORDER BY id"
            ).fetchall()
        return [dict(r) for r in rows]
