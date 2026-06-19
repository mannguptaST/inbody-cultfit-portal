"""
portal_db.py — Portal user store.

Dev (no SUPABASE_URL set):   SQLite file at portal_users.db
Production (SUPABASE_URL set): Supabase REST API over HTTPS — no direct PostgreSQL
                                connection needed, works on any host including Vercel.
"""

import hashlib
import logging
import os
import secrets
import sqlite3
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# ── Backend selection ─────────────────────────────────────────────────────────
_SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
_SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
_USE_SUPABASE = bool(_SUPABASE_URL and _SUPABASE_KEY)

if _USE_SUPABASE:
    logger.info("portal_db: Supabase REST API mode")
else:
    _DB_PATH = Path(__file__).resolve().parent.parent.parent / "portal_users.db"
    logger.info("portal_db: SQLite mode at %s", _DB_PATH)

PBKDF2_ITERATIONS = 260_000
PBKDF2_ALGO       = "sha256"
SALT_BYTES        = 16

TABLE = "portal_users"


# ── Password helpers ──────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    salt = secrets.token_hex(SALT_BYTES)
    dk   = hashlib.pbkdf2_hmac(PBKDF2_ALGO, password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    return f"pbkdf2:{PBKDF2_ALGO}:{PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        meta, salt, dk_stored = stored.split("$")
        _, algo, iters_str    = meta.split(":")
        dk_check = hashlib.pbkdf2_hmac(algo, password.encode(), salt.encode(), int(iters_str))
        return secrets.compare_digest(dk_check.hex(), dk_stored)
    except Exception:
        return False


# ── Supabase REST helpers ─────────────────────────────────────────────────────

def _headers(prefer: str = "") -> dict:
    h = {
        "apikey": _SUPABASE_KEY,
        "Authorization": f"Bearer {_SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


def _rest(path: str = "") -> str:
    return f"{_SUPABASE_URL}/rest/v1/{TABLE}{path}"


# ── SQLite helpers ────────────────────────────────────────────────────────────

def _sq_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# ── Schema (SQLite only — Supabase table created via SQL editor) ──────────────

def init_db() -> None:
    if _USE_SUPABASE:
        logger.info("Supabase mode — skipping init_db (table created via SQL editor)")
        return
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
    logger.info("portal_users SQLite table ready")


# ── CRUD ──────────────────────────────────────────────────────────────────────

def create_user(email: str, password: str, name: str, role: str, partner_id: int = 0) -> int:
    hashed = hash_password(password)
    e = email.lower().strip()
    if _USE_SUPABASE:
        with httpx.Client(timeout=10) as client:
            resp = client.post(
                _rest(),
                headers=_headers("return=representation"),
                json={"email": e, "password_hash": hashed, "name": name,
                      "role": role, "partner_id": partner_id},
            )
            resp.raise_for_status()
            return resp.json()[0]["id"]
    else:
        with _sq_conn() as conn:
            cur = conn.execute(
                "INSERT INTO portal_users (email, password_hash, name, role, partner_id) "
                "VALUES (?, ?, ?, ?, ?)", (e, hashed, name, role, partner_id),
            )
            conn.commit()
            return cur.lastrowid


def get_user_by_email(email: str) -> dict | None:
    e = email.lower().strip()
    if _USE_SUPABASE:
        with httpx.Client(timeout=10) as client:
            resp = client.get(
                _rest(),
                headers=_headers(),
                params={"email": f"eq.{e}", "is_active": "eq.true", "select": "*"},
            )
            resp.raise_for_status()
            rows = resp.json()
            return rows[0] if rows else None
    else:
        with _sq_conn() as conn:
            row = conn.execute(
                "SELECT * FROM portal_users WHERE email = ? AND is_active = 1", (e,)
            ).fetchone()
        return dict(row) if row else None


def get_user_by_id(user_id: int) -> dict | None:
    if _USE_SUPABASE:
        with httpx.Client(timeout=10) as client:
            resp = client.get(
                _rest(),
                headers=_headers(),
                params={"id": f"eq.{user_id}", "is_active": "eq.true", "select": "*"},
            )
            resp.raise_for_status()
            rows = resp.json()
            return rows[0] if rows else None
    else:
        with _sq_conn() as conn:
            row = conn.execute(
                "SELECT * FROM portal_users WHERE id = ? AND is_active = 1", (user_id,)
            ).fetchone()
        return dict(row) if row else None


def list_users() -> list[dict]:
    if _USE_SUPABASE:
        with httpx.Client(timeout=10) as client:
            resp = client.get(
                _rest(),
                headers=_headers(),
                params={"select": "id,email,name,role,partner_id,is_active,created_at",
                        "order": "id"},
            )
            resp.raise_for_status()
            return resp.json()
    else:
        with _sq_conn() as conn:
            rows = conn.execute(
                "SELECT id, email, name, role, partner_id, is_active, created_at "
                "FROM portal_users ORDER BY id"
            ).fetchall()
        return [dict(r) for r in rows]
