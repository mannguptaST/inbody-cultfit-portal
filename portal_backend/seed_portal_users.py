"""
seed_portal_users.py — Create initial portal users.

Run once from the portal_backend directory:
    python seed_portal_users.py

What it does:
  1. Initialises the portal_users SQLite DB (creates table if missing)
  2. Looks up the CultFit commercial partner_id from Odoo via XML-RPC
     (so customer users get the correct order filter)
  3. Creates or updates the test users listed in USERS below

Safe to re-run: existing users are skipped (not duplicated or overwritten).
"""

# *** DEV ONLY — DO NOT USE IN PRODUCTION WITHOUT READING THIS ***
#
# This script seeds DEVELOPMENT users with WEAK, well-known passwords.
# Before sharing portal access with CultFit or going live:
#
#   1. Change admin@inbody.com password — use your admin panel or DB update.
#   2. Set strong unique passwords for all customer accounts.
#   3. NEVER run this script against the production DATABASE_URL.
#   4. Remove or update the test emails to real CultFit contact addresses.
#
# *** END DEV WARNING ***

import sqlite3
import sys
import xmlrpc.client

# ── Add app to path so we can import portal_db ───────────────────────────────
sys.path.insert(0, ".")

from app.db.portal_db import check_password, create_user, get_user_by_email, init_db

# ── Odoo connection (local dev only) ─────────────────────────────────────────
ODOO_URL  = "http://localhost:8069"
ODOO_DB   = "inbody_dev"
ODOO_USER = "admin"
ODOO_PASS = "admin"


def find_cultfit_partner_id() -> int:
    """
    Look up the Odoo commercial partner_id for CultFit India Pvt Ltd.
    Returns the partner id, or 0 if Odoo is unreachable.
    """
    try:
        common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
        uid    = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASS, {})
        if not uid:
            print("  [WARN] Could not authenticate to Odoo — partner_id will be 0")
            return 0
        models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
        # Search for CultFit commercial partner
        results = models.execute_kw(
            ODOO_DB, uid, ODOO_PASS, "res.partner", "search_read",
            [[["name", "ilike", "cultfit"]]],
            {"fields": ["id", "name", "is_company"], "limit": 10},
        )
        companies = [r for r in results if r.get("is_company")]
        if companies:
            partner = companies[0]
            print(f"  [OK] Found CultFit partner: id={partner['id']} name={partner['name']}")
            return partner["id"]
        # Fallback: any match
        if results:
            partner = results[0]
            print(f"  [OK] Found CultFit partner (non-company): id={partner['id']} name={partner['name']}")
            return partner["id"]
        print("  [WARN] No CultFit partner found in Odoo — partner_id will be 0")
        return 0
    except Exception as e:
        print(f"  [WARN] Could not reach Odoo: {e} — partner_id will be 0")
        return 0


def seed():
    print("=== Portal Users Seed Script ===\n")

    # 1. Init DB
    print("1. Initialising portal_users database...")
    init_db()
    print("   Done.\n")

    # 2. Find CultFit partner_id
    print("2. Looking up CultFit partner_id from Odoo...")
    cultfit_partner_id = find_cultfit_partner_id()
    print()

    # 3. Define users to create
    users = [
        {
            "email":      "admin@inbody.com",
            "password":   "InBody@2024",
            "name":       "InBody Admin",
            "role":       "admin",
            "partner_id": 0,              # admin sees all CultFit orders
        },
        {
            "email":      "guru@cultfittest.in",
            "password":   "Guru@2024",
            "name":       "Guru",
            "role":       "customer",
            "partner_id": cultfit_partner_id,
        },
        {
            "email":      "vijay@cultfittest.in",
            "password":   "Vijay@2024",
            "name":       "Vijay",
            "role":       "customer",
            "partner_id": cultfit_partner_id,
        },
    ]

    # 4. Insert (skip if already exists)
    print("3. Creating portal users...")
    for u in users:
        existing = get_user_by_email(u["email"])
        if existing:
            print(f"   SKIP  {u['email']} — already exists (role={existing['role']})")
            continue
        try:
            new_id = create_user(
                email=u["email"],
                password=u["password"],
                name=u["name"],
                role=u["role"],
                partner_id=u["partner_id"],
            )
            print(f"   OK    {u['email']} — id={new_id} role={u['role']} partner_id={u['partner_id']}")
        except sqlite3.IntegrityError as e:
            print(f"   ERROR {u['email']} — {e}")

    print("\n=== Done ===")
    print("\nTest credentials:")
    print("  Admin : admin@inbody.com      / InBody@2024")
    print("  Guru  : guru@cultfittest.in   / Guru@2024")
    print("  Vijay : vijay@cultfittest.in  / Vijay@2024")
    print(f"\nCultFit partner_id used for customer users: {cultfit_partner_id}")
    if cultfit_partner_id == 0:
        print("  WARNING: partner_id=0 means customers will see ALL CultFit orders.")
        print("  To fix: update portal_users SET partner_id=<real_id> WHERE role='customer'")


if __name__ == "__main__":
    seed()
