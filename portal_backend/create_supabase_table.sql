-- create_supabase_table.sql
-- Run this once in the Supabase SQL editor before deploying the backend.
-- Safe to re-run (uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS portal_users (
    id            SERIAL PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'customer')),
    partner_id    INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Partial index: login lookups only touch active accounts
CREATE INDEX IF NOT EXISTS idx_portal_users_email
    ON portal_users (email)
    WHERE is_active = TRUE;

COMMENT ON TABLE portal_users IS
    'InBody Customer Portal users. Passwords are PBKDF2-SHA256 (260k iters). Never store plain text.';

COMMENT ON COLUMN portal_users.partner_id IS
    '0 = InBody staff (sees all CultFit orders). Positive int = Odoo commercial_partner_id (customer filter).';

COMMENT ON COLUMN portal_users.password_hash IS
    'Format: pbkdf2:sha256:260000$<hex-salt>$<hex-hash>. Portable from SQLite — hashes migrate as-is.';
