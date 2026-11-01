-- Migration 023: First-class Internal AI Vendor and Model Domain
-- Additive after Migration 022. Governed under INTENTCHORD_INTERNAL_AI_VENDOR_LIFECYCLE_AND_DYNAMIC_PROVIDER_MANAGEMENT_V1 (ADR-001).
-- Introduces Vendor as a first-class governed entity separate from Engine.
-- Models are managed under Vendor. Engine remains the runnable governed binding.
-- No secret values are stored. credential_reference is a non-secret resolver key only (lifecycle in Gate 3).

-- 1. Internal AI Vendor -------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.internal_ai_vendors (
  vendor_id text PRIMARY KEY CHECK (btrim(vendor_id) <> '' AND length(vendor_id) <= 200 AND vendor_id !~ '[[:space:]]'),
  display_name text NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 200),
  vendor_state text NOT NULL DEFAULT 'ENABLED' CHECK (vendor_state IN ('ENABLED', 'DISABLED', 'RETIRED')),
  base_url text NOT NULL CHECK (base_url ~ '^https://' AND length(base_url) <= 2048),
  auth_type text NOT NULL CHECK (btrim(auth_type) <> '' AND length(auth_type) <= 64 AND auth_type !~ '[[:space:]]'),
  protocol_profile text NOT NULL CHECK (btrim(protocol_profile) <> '' AND length(protocol_profile) <= 200 AND protocol_profile !~ '[[:space:]]'),
  credential_reference text CHECK (credential_reference IS NULL OR credential_reference ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  retirement_reason text,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_internal_ai_vendor_retirement_shape CHECK (
    (vendor_state = 'RETIRED' AND retired_at IS NOT NULL)
    OR (vendor_state <> 'RETIRED' AND retired_at IS NULL)
  )
);

-- 2. Internal AI Model (under Vendor) ----------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.internal_ai_models (
  vendor_id text NOT NULL REFERENCES intentchord.internal_ai_vendors(vendor_id) ON DELETE RESTRICT,
  model_id text NOT NULL CHECK (btrim(model_id) <> '' AND length(model_id) <= 200 AND model_id !~ '[[:space:]]'),
  display_name text NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 200),
  model_state text NOT NULL DEFAULT 'ENABLED' CHECK (model_state IN ('ENABLED', 'DISABLED')),
  provider_facing_model_id text NOT NULL CHECK (btrim(provider_facing_model_id) <> '' AND length(provider_facing_model_id) <= 300),
  capability_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  runtime_compatibility_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_internal_ai_models PRIMARY KEY (vendor_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_ai_models_vendor
  ON intentchord.internal_ai_models (vendor_id);

CREATE INDEX IF NOT EXISTS idx_internal_ai_vendors_state
  ON intentchord.internal_ai_vendors (vendor_state);

COMMENT ON TABLE intentchord.internal_ai_vendors IS 'First-class Internal AI Vendor entity. Vendor is not Engine. Credential lifecycle is governed separately (Gate 3).';
COMMENT ON TABLE intentchord.internal_ai_models IS 'Models managed under a Vendor. Adding or disabling a model does not replace the Vendor.';
COMMENT ON COLUMN intentchord.internal_ai_vendors.credential_reference IS 'Non-secret credential resolver key only. Never stores secret values.';
