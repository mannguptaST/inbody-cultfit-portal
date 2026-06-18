# InBody Customer Portal — Deployment Guide

## Architecture

```
CultFit user / InBody admin
        |
        v
[ Vercel — Next.js frontend ]  (portal_frontend/)
        |
        v (HTTPS API calls)
[ Render / Railway — FastAPI backend ]  (portal_backend/)
        |
        |-- XML-RPC --> [ Odoo ERP — your production server ]
        |
        `-- SQL -------> [ Supabase PostgreSQL — portal_users table ]
```

---

## Step 1 — Supabase (database)

1. Create a free project at https://supabase.com
2. Go to **SQL Editor** and run the contents of `portal_backend/create_supabase_table.sql`
3. Go to **Settings → Database** and copy the **Connection string** (URI format):
   ```
   postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
   ```
4. Keep this URL — you will need it in Steps 2 and 3.

### Migrate existing users from local SQLite

If you have seeded users locally (admin, Guru, Vijay), migrate them:

```bash
cd portal_backend
DATABASE_URL="postgresql://postgres:<pass>@db.<ref>.supabase.co:5432/postgres" \
    python migrate_to_supabase.py
```

The script is safe to re-run. Password hashes are portable — existing passwords keep working.

---

## Step 2 — FastAPI backend (Render or Railway)

### Option A: Render (recommended free tier)

1. Connect your GitHub repo at https://render.com
2. Create a new **Web Service** pointing to the `portal_backend/` directory
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
5. Set environment variables (see table below)

### Option B: Railway

1. Connect repo at https://railway.app
2. Add a new service → select `portal_backend/` as the root
3. Railway auto-detects the `requirements.txt`; set start command as above
4. Set environment variables

### Required backend environment variables

| Variable | Production value |
|---|---|
| `ODOO_BASE_URL` | `https://odoo.yourdomain.com` |
| `ODOO_API_USER` | Odoo service account username |
| `ODOO_API_PASS` | Odoo service account password |
| `JWT_SECRET` | Same 64-char random string as Odoo's `ir.config_parameter` |
| `DATABASE_URL` | Supabase PostgreSQL URI (from Step 1) |
| `DEBUG` | `false` |
| `ALLOWED_ORIGINS` | `["https://your-portal.vercel.app"]` |
| `APP_HOST` | `0.0.0.0` |
| `APP_PORT` | leave blank — Render/Railway set `$PORT` automatically |

Generate a strong JWT secret:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## Step 3 — Next.js frontend (Vercel)

1. Connect repo at https://vercel.com
2. Set **Root Directory** to `portal_frontend`
3. Framework: Next.js (auto-detected)
4. Add one environment variable:
   - `NEXT_PUBLIC_API_URL` = `https://your-backend.onrender.com/api/v1`
5. Deploy

---

## Step 4 — Odoo production setup

1. **JWT secret** — in Odoo admin go to Settings → Technical → Parameters → System Parameters.
   Find `inbody_portal_api.jwt_secret` and set it to the same value as `JWT_SECRET` above.

2. **Service user** — create a dedicated Odoo user for the portal backend:
   - Minimal permissions: read `sale.order`, `sale.order.line`, `stock.picking`, `account.move`
   - Write permission only on: `inbody_payment_status`, `inbody_installation_status`,
     `inbody_vendor_portal_status`, `inbody_confirmation_mail_sent`, `inbody_md_approval_status`,
     `inbody_internal_notes` fields of `sale.order`
   - Set `ODOO_API_USER` / `ODOO_API_PASS` to this user's credentials

3. **CORS on Odoo** — if using Odoo's own JWT endpoint, whitelist your Vercel domain in Odoo's
   system parameters or nginx config.

---

## Step 5 — Change customer passwords

The dev seed script creates users with **test passwords** (`Guru@2024`, etc.).
Before sharing portal access with CultFit contacts:

1. Log in as admin to the portal
2. Use an admin route (or direct DB update in Supabase) to set strong passwords
3. Communicate new credentials securely (not by email plain text)

The admin portal-user management endpoints are not yet built — for now update via
the Supabase dashboard (Table Editor → portal_users → edit row → paste a new
`hash_password()` output).

---

## Smoke test checklist (after deployment)

- [ ] `GET https://your-backend.onrender.com/ping` returns `{"status": "ok"}`
- [ ] `POST /api/v1/portal/auth/login` with admin credentials returns a JWT
- [ ] `GET /api/v1/portal/cultfit/orders` with that JWT returns orders from Odoo
- [ ] Customer login (Guru) returns orders filtered to CultFit partner only
- [ ] `PATCH /api/v1/admin/cultfit/orders/{id}/deal_status` with admin JWT updates Odoo
- [ ] Customer JWT → 403 on admin write endpoint
- [ ] More than 5 login attempts in one minute → 429 Too Many Requests
- [ ] `https://your-backend.onrender.com/docs` → 404 (docs disabled in production)
- [ ] Vercel preview URL loads the login page

---

## What InBody needs to provide before going live

| Item | Status |
|---|---|
| Production Odoo URL (`https://odoo.yourdomain.com`) | Need from InBody |
| Odoo service account username + password | Need from InBody |
| Odoo JWT secret (ir.config_parameter value) | Need from InBody |
| CultFit real contact emails + initial passwords | Need to set |
| Vercel domain (custom or `.vercel.app`) | Available after Step 3 |
| Render/Railway backend URL | Available after Step 2 |

---

## Files added / changed in this hosting prep

| File | Change |
|---|---|
| `portal_backend/app/config.py` | Added `ODOO_API_USER`, `ODOO_API_PASS`, `DATABASE_URL` settings |
| `portal_backend/app/services/odoo_xmlrpc.py` | Reads credentials from settings (not hardcoded) |
| `portal_backend/app/db/portal_db.py` | Dual-mode: SQLite (dev) or PostgreSQL when `DATABASE_URL` set |
| `portal_backend/app/limiter.py` | New — shared slowapi Limiter instance |
| `portal_backend/app/main.py` | Registers limiter; disables /docs when `DEBUG=false` |
| `portal_backend/app/routes/portal_auth.py` | Rate limit 5/min on login endpoint |
| `portal_backend/requirements.txt` | Added `slowapi`, `psycopg2-binary` |
| `portal_backend/.env` | Added `ODOO_API_USER`, `ODOO_API_PASS`, `DATABASE_URL` |
| `portal_backend/.env.example` | Full production template with inline notes |
| `portal_backend/seed_portal_users.py` | Added dev-only warning about weak passwords |
| `portal_backend/create_supabase_table.sql` | New — PostgreSQL table DDL for Supabase |
| `portal_backend/migrate_to_supabase.py` | New — one-time SQLite → Supabase migration script |
| `portal_frontend/.env.example` | New — shows `NEXT_PUBLIC_API_URL` for Vercel |
