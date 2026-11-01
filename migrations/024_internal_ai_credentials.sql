-- Migration 024: Internal AI Credential Lifecycle (non-secret metadata only)
-- Additive after Migration 023. Governed under INTENTCHORD_INTERNAL_AI_VENDOR_LIFECYCLE_AND_DYNAMIC_PROVIDER_MANAGEMENT_V1 (ADR-001 §5).
-- Stores only governed non-secret credential metadata. Secret values never enter PostgreSQL.
-- Lifecycle: ACTIVE (add/replace/rotate) → REVOKED (revoke) → row removed (delete).
-- UI may display only Credential Reference / PRESENT / MISSING / REVOKED / Last Updated.

CREATE TABLE IF NOT EXISTS intentchord.internal_ai_credentials (
  credential_reference text PRIMARY KEY
    CHECK (credential_reference ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND length(credential_reference) <= 200),
  vendor_id text NOT NULL
    REFERENCES intentchord.internal_ai_vendors(vendor_id) ON DELETE RESTRICT,
  credential_state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (credential_state IN ('ACTIVE', 'REVOKED')),
  last_rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_internal_ai_credential_revocation_shape CHECK (
    (credential_state = 'REVOKED' AND revoked_at IS NOT NULL)
    OR (credential_state = 'ACTIVE' AND revoked_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_internal_ai_credentials_vendor
  ON intentchord.internal_ai_credentials (vendor_id);

CREATE INDEX IF NOT EXISTS idx_internal_ai_credentials_state
  ON intentchord.internal_ai_credentials (credential_state);

COMMENT ON TABLE intentchord.internal_ai_credentials IS
  'Governed credential lifecycle metadata only. DATABASE_STORES_SECRET_VALUE = NO. Secret authority is OS-backed resolver.';
COMMENT ON COLUMN intentchord.internal_ai_credentials.credential_reference IS
  'Non-secret resolver key (Windows Credential Manager target IntentChord/InternalAI/<reference>). Never stores a secret value.';
COMMENT ON COLUMN intentchord.internal_ai_credentials.credential_state IS
  'ACTIVE = governed credential row present. REVOKED = credential revoked; secret removed from resolver; row preserved for provenance.';
