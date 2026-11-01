-- Migration 022: Owner Authentication Foundation — Single Owner Account Authority
-- Author: Hisham (Owner)
-- Date: 2026-09-14
-- Governance: IntentChord Stable Governance

-- ============================================================================
-- Single Owner Account Table
--
-- Provides PostgreSQL-backed authority for the single Owner identity.
-- Replaces the hardcoded owner-local:Hisham principal with a real account
-- that supports password-based authentication and session versioning.
-- ============================================================================

CREATE TABLE intentchord.owner_accounts (
  owner_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_name        text NOT NULL UNIQUE,
  display_name      text NOT NULL,
  password_hash     bytea NOT NULL,
  password_salt     bytea NOT NULL,
  password_kdf      text NOT NULL DEFAULT 'scrypt-v1',
  account_state     text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (account_state IN ('ACTIVE', 'DISABLED')),
  session_version   integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Ensure exactly one ACTIVE Owner at a time via partial unique index
CREATE UNIQUE INDEX owner_accounts_active_unique
  ON intentchord.owner_accounts ((1))
  WHERE account_state = 'ACTIVE';

COMMENT ON TABLE intentchord.owner_accounts IS 'Single Owner account authority for IntentChord authentication.';
COMMENT ON COLUMN intentchord.owner_accounts.owner_id IS 'Stable Owner identifier used in session tokens.';
COMMENT ON COLUMN intentchord.owner_accounts.login_name IS 'Unique login identifier for Owner authentication.';
COMMENT ON COLUMN intentchord.owner_accounts.password_hash IS 'Scrypt-derived password hash. Never stores plaintext.';
COMMENT ON COLUMN intentchord.owner_accounts.password_salt IS 'Cryptographically random salt for password KDF.';
COMMENT ON COLUMN intentchord.owner_accounts.password_kdf IS 'KDF contract identifier (currently scrypt-v1).';
COMMENT ON COLUMN intentchord.owner_accounts.session_version IS 'Monotonically increasing version for global session invalidation.';
