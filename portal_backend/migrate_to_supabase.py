"""
migrate_to_supabase.py — One-time migration from local SQLite to Supabase PostgreSQL.

Usage:
    DATABASE_URL="postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres" \\
        python migrate_to_supabase.py

Prerequisites:
    1. Run create_supabase_table.sql in the Supabase SQL editor first.
    2. pip install psycopg2-binary  (if not already installed)

What it does:
    1. Reads all users from local portal_users.db (SQLite)
    2. Connects to Supabase via DATABASE_URL
    3. Inserts each user — ON CONFLICT (email) DO NOTHING (safe to re-run)
    4. Prints a per-user result and a summary

Password hashes are PBKDF2-SHA256 and are fully portable — they work identically
in PostgreSQL, so users keep their existing passwords after migration.
"""

import os
import sqlite3
from pathlib import Path

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise SystemExit(
        "ERROR: DATABASE_URL env var is not set.\n\n"
        "Usage:\n"
        '  DATABASE_URL="postgresql://postgres:<pass>@db.<proj>.supabase.co:5432/postgres" \\\n'
        "      python migrate_to_supabase.py"
    )

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    raise SystemExit(
        "ERROR: psycopg2 is not installed.\n"
        "Run: pip install psycopg2-binary"
    )

_DB_PATH = Path(__file__).resolve().parent / "portal_users.db"
if not _DB_PATH.exists():
    raise SystemExit(
        f"ERROR: SQLite DB not found at {_DB_PATH}\n"
        "Make sure you are running this from the portal_backend/ directory."
    )


def migrate() -> None:
    print("=== SQLite → Supabase PostgreSQL Migration ===\n")

    # 1. Read all users from SQLite
    print(f"1. Reading from SQLite: {_DB_PATH}")
    sq = sqlite3.connect(str(_DB_PATH))
    sq.row_factory = sqlite3.Row
    users = [
        dict(r)
        for r in sq.execute(
            "SELECT email, password_hash, name, role, partner_id, is_active FROM portal_users"
        ).fetchall()
    ]
    sq.close()
    print(f"   Found {len(users)} user(s)\n")

    if not users:
        print("Nothing to migrate.")
        return

    # 2. Connect to Supabase
    print("2. Connecting to PostgreSQL...")
    pg = psycopg2.connect(DATABASE_URL)
    cur = pg.cursor()
    print("   Connected\n")

    # 3. Insert each user
    print("3. Migrating users...")
    inserted = skipped = errors = 0
    for u in users:
        try:
            cur.execute(
                """
                INSERT INTO portal_users
                    (email, password_hash, name, role, partner_id, is_active)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (email) DO NOTHING
                """,
                (
                    u["email"],
                    u["password_hash"],
                    u["name"],
                    u["role"],
                    u["partner_id"],
                    bool(u["is_active"]),
                ),
            )
            if cur.rowcount:
                print(f"   OK      {u['email']}  role={u['role']}  partner_id={u['partner_id']}")
                inserted += 1
            else:
                print(f"   SKIP    {u['email']}  (already exists in PostgreSQL)")
                skipped += 1
        except Exception as exc:
            print(f"   ERROR   {u['email']}  {exc}")
            errors += 1

    pg.commit()
    cur.close()
    pg.close()

    print(f"\n=== Done: {inserted} inserted, {skipped} skipped, {errors} errors ===")

    if inserted:
        print("\nPasswords migrated as-is — existing passwords continue to work.")
    print("\nNext steps:")
    print("  1. Set DATABASE_URL in your Render / Railway environment variables.")
    print("  2. Remove DATABASE_URL from local .env (keep it empty for SQLite dev).")
    print("  3. Verify login works in production before sharing credentials.")


if __name__ == "__main__":
    migrate()
