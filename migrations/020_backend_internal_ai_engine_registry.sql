-- Migration 020: Backend-Authoritative Internal AI Engine Registry and Admin Authority Foundation
-- Additive after Migration 019. Governed under INTENTCHORD_BACKEND_AI_ENGINE_REGISTRY_AND_ADMIN_AUTHORITY_V1.
-- Authoritative forward execution model: PostgreSQL -> Engine Registry -> Admin Selection -> Qualification -> Context Mapper V2.

-- 1. Internal AI Engine Logical Identity Table --------------------------------
CREATE TABLE IF NOT EXISTS intentchord.internal_ai_engines (
  engine_id text PRIMARY KEY CHECK (btrim(engine_id) <> '' AND length(engine_id) <= 200 AND engine_id !~ '[[:space:]]'),
  display_name text NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 200),
  engine_state text NOT NULL CHECK (engine_state IN ('ENABLED', 'DISABLED')) DEFAULT 'ENABLED',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 2. Internal AI Engine Configuration Revisions Table ------------------------
CREATE TABLE IF NOT EXISTS intentchord.internal_ai_engine_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engine_id text NOT NULL REFERENCES intentchord.internal_ai_engines(engine_id) ON DELETE RESTRICT,
  engine_config_revision text NOT NULL CHECK (btrim(engine_config_revision) <> '' AND length(engine_config_revision) <= 200 AND engine_config_revision !~ '[[:space:]]'),
  provider_id text NOT NULL CHECK (btrim(provider_id) <> '' AND length(provider_id) <= 200 AND provider_id !~ '[[:space:]]'),
  channel_id text NOT NULL CHECK (btrim(channel_id) <> '' AND length(channel_id) <= 200 AND channel_id !~ '[[:space:]]'),
  model_id text NOT NULL CHECK (btrim(model_id) <> '' AND length(model_id) <= 200 AND model_id !~ '[[:space:]]'),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://' AND length(endpoint) <= 2048),
  credential_reference text NOT NULL CHECK (credential_reference ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  transport_profile_id text NOT NULL CHECK (transport_profile_id IN ('chat_completions_json_object_v1', 'chat_completions_json_schema_v1')),
  behavior_profile_id text NOT NULL CHECK (behavior_profile_id IN ('zai_error_semantics_v1', 'sambanova_error_semantics_v1')),
  capability_profile_version text NOT NULL CHECK (btrim(capability_profile_version) <> '' AND length(capability_profile_version) <= 200 AND capability_profile_version !~ '[[:space:]]'),
  timeout_ms integer NOT NULL CHECK (timeout_ms >= 1000 AND timeout_ms <= 600000) DEFAULT 60000,
  engine_configuration_sha256 text NOT NULL CHECK (engine_configuration_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_engine_revisions_key UNIQUE (engine_id, engine_config_revision),
  CONSTRAINT uq_engine_revisions_fingerprint UNIQUE (engine_id, engine_configuration_sha256),
  CONSTRAINT uq_engine_revisions_composite_authority UNIQUE (engine_id, engine_config_revision, engine_configuration_sha256)
);

-- Trigger: DB-enforced exact fingerprint derivation using canonical migration 013 algorithm
CREATE OR REPLACE FUNCTION intentchord.trg_assert_internal_ai_engine_revision_fingerprint()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected text;
BEGIN
  expected := intentchord.internal_ai_engine_configuration_sha256_v1(jsonb_build_object(
    'engine_id', NEW.engine_id,
    'engine_config_revision', NEW.engine_config_revision,
    'provider_id', NEW.provider_id,
    'channel_id', NEW.channel_id,
    'model_id', NEW.model_id,
    'endpoint', NEW.endpoint,
    'credential_reference', NEW.credential_reference,
    'transport_profile_id', NEW.transport_profile_id,
    'behavior_profile_id', NEW.behavior_profile_id,
    'capability_profile_version', NEW.capability_profile_version,
    'timeout_ms', NEW.timeout_ms
  ));
  IF NEW.engine_configuration_sha256 IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'INTERNAL_AI_ENGINE_REVISION_FINGERPRINT_MISMATCH: Computed sha256 % does not match provided %', expected, NEW.engine_configuration_sha256;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_internal_ai_engine_revision_fingerprint_guard ON intentchord.internal_ai_engine_revisions;
CREATE TRIGGER trg_internal_ai_engine_revision_fingerprint_guard
  BEFORE INSERT OR UPDATE ON intentchord.internal_ai_engine_revisions
  FOR EACH ROW EXECUTE FUNCTION intentchord.trg_assert_internal_ai_engine_revision_fingerprint();

-- 3. Internal AI Qualifications Table ----------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.internal_ai_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id text NOT NULL UNIQUE CHECK (btrim(qualification_id) <> '' AND length(qualification_id) <= 200 AND qualification_id !~ '[[:space:]]'),
  engine_id text NOT NULL,
  engine_config_revision text NOT NULL,
  engine_configuration_sha256 text NOT NULL,
  qualification_status text NOT NULL CHECK (qualification_status IN ('QUALIFIED', 'REVOKED', 'EXPIRED')),
  qualification_scope text NOT NULL CHECK (qualification_scope IN ('AI_CONTEXT_MAPPING_V1', 'AI_CONTEXT_MAPPING_V2')),
  qualified_at timestamptz NOT NULL,
  qualified_by text NOT NULL CHECK (btrim(qualified_by) <> '' AND length(qualified_by) <= 200),
  evidence_reference text NOT NULL CHECK (btrim(evidence_reference) <> '' AND length(evidence_reference) <= 200),
  capability_profile_version text NOT NULL CHECK (btrim(capability_profile_version) <> '' AND length(capability_profile_version) <= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Composite FK: binds exactly to the registered engine revision tuple
  CONSTRAINT fk_qualifications_engine_revision FOREIGN KEY (engine_id, engine_config_revision, engine_configuration_sha256)
    REFERENCES intentchord.internal_ai_engine_revisions(engine_id, engine_config_revision, engine_configuration_sha256)
    ON DELETE RESTRICT,
  -- Composite Authority UNIQUE constraint suitable for Admin Selection composite FK
  CONSTRAINT uq_qualifications_composite_authority UNIQUE (qualification_id, engine_id, engine_config_revision, engine_configuration_sha256, qualification_scope)
);

-- Partial unique index per Correction 5: At most one currently QUALIFIED record per engine revision + scope.
-- Historical records (REVOKED / EXPIRED) are fully preserved.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qualifications_current_qualified
  ON intentchord.internal_ai_qualifications (engine_id, engine_config_revision, qualification_scope)
  WHERE qualification_status = 'QUALIFIED';

-- 4. Internal AI Admin Selection Authority Table -----------------------------
CREATE TABLE IF NOT EXISTS intentchord.internal_ai_admin_selections (
  qualification_scope text PRIMARY KEY CHECK (qualification_scope IN ('AI_CONTEXT_MAPPING_V1', 'AI_CONTEXT_MAPPING_V2')),
  active_engine_id text NOT NULL,
  active_engine_config_revision text NOT NULL,
  active_engine_configuration_sha256 text NOT NULL,
  active_qualification_id text NOT NULL,
  standby_engine_id text,
  standby_engine_config_revision text,
  standby_engine_configuration_sha256 text,
  standby_qualification_id text,
  standby_enabled boolean NOT NULL DEFAULT false,
  selection_authority_sequence bigint NOT NULL DEFAULT 1 CHECK (selection_authority_sequence > 0),
  selected_by text NOT NULL CHECK (btrim(selected_by) <> '' AND length(selected_by) <= 200),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Composite FK ensuring Active references exact qualification authority (Correction 2)
  CONSTRAINT fk_admin_selection_active_qualification FOREIGN KEY (
    active_qualification_id, active_engine_id, active_engine_config_revision, active_engine_configuration_sha256, qualification_scope
  ) REFERENCES intentchord.internal_ai_qualifications(
    qualification_id, engine_id, engine_config_revision, engine_configuration_sha256, qualification_scope
  ) ON DELETE RESTRICT,
  -- Composite FK ensuring Standby references exact qualification authority (Correction 2)
  CONSTRAINT fk_admin_selection_standby_qualification FOREIGN KEY (
    standby_qualification_id, standby_engine_id, standby_engine_config_revision, standby_engine_configuration_sha256, qualification_scope
  ) REFERENCES intentchord.internal_ai_qualifications(
    qualification_id, engine_id, engine_config_revision, engine_configuration_sha256, qualification_scope
  ) ON DELETE RESTRICT,
  -- Coherence check for Standby
  CONSTRAINT ck_admin_selection_standby_coherence CHECK (
    (standby_enabled = false AND standby_engine_id IS NULL AND standby_engine_config_revision IS NULL AND standby_engine_configuration_sha256 IS NULL AND standby_qualification_id IS NULL)
    OR (
      standby_enabled = true
      AND standby_engine_id IS NOT NULL
      AND standby_engine_config_revision IS NOT NULL
      AND standby_engine_configuration_sha256 IS NOT NULL
      AND standby_qualification_id IS NOT NULL
      AND (active_engine_id <> standby_engine_id OR active_engine_config_revision <> standby_engine_config_revision)
    )
  )
);

-- Trigger: Ensure Active engine is ENABLED in internal_ai_engines, and Active qualification is currently QUALIFIED
CREATE OR REPLACE FUNCTION intentchord.trg_assert_admin_selection_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  active_state text;
  active_q_status text;
  standby_state text;
  standby_q_status text;
BEGIN
  SELECT engine_state INTO active_state FROM intentchord.internal_ai_engines WHERE engine_id = NEW.active_engine_id;
  IF active_state IS DISTINCT FROM 'ENABLED' THEN
    RAISE EXCEPTION 'ADMIN_SELECTION_ACTIVE_ENGINE_NOT_ENABLED: Active engine % is not ENABLED (current: %)', NEW.active_engine_id, active_state;
  END IF;

  SELECT qualification_status INTO active_q_status FROM intentchord.internal_ai_qualifications WHERE qualification_id = NEW.active_qualification_id;
  IF active_q_status IS DISTINCT FROM 'QUALIFIED' THEN
    RAISE EXCEPTION 'ADMIN_SELECTION_ACTIVE_QUALIFICATION_NOT_VALID: Active qualification % is not QUALIFIED (current: %)', NEW.active_qualification_id, active_q_status;
  END IF;

  IF NEW.standby_enabled THEN
    SELECT engine_state INTO standby_state FROM intentchord.internal_ai_engines WHERE engine_id = NEW.standby_engine_id;
    IF standby_state IS DISTINCT FROM 'ENABLED' THEN
      RAISE EXCEPTION 'ADMIN_SELECTION_STANDBY_ENGINE_NOT_ENABLED: Standby engine % is not ENABLED (current: %)', NEW.standby_engine_id, standby_state;
    END IF;

    SELECT qualification_status INTO standby_q_status FROM intentchord.internal_ai_qualifications WHERE qualification_id = NEW.standby_qualification_id;
    IF standby_q_status IS DISTINCT FROM 'QUALIFIED' THEN
      RAISE EXCEPTION 'ADMIN_SELECTION_STANDBY_QUALIFICATION_NOT_VALID: Standby qualification % is not QUALIFIED (current: %)', NEW.standby_qualification_id, standby_q_status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_selection_state_guard ON intentchord.internal_ai_admin_selections;
CREATE TRIGGER trg_admin_selection_state_guard
  BEFORE INSERT OR UPDATE ON intentchord.internal_ai_admin_selections
  FOR EACH ROW EXECUTE FUNCTION intentchord.trg_assert_admin_selection_state();

-- 5. Additive AI Execution Authority Columns on context_mapping_traversals (Correction 3)
-- Existing 9-field traversal_authority_sha256 remains 100% UNCHANGED as Source/Workspace authority.
ALTER TABLE intentchord.context_mapping_traversals
  ADD COLUMN IF NOT EXISTS ai_execution_authority_sha256 text CHECK (ai_execution_authority_sha256 IS NULL OR ai_execution_authority_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS ai_execution_active_engine_id text,
  ADD COLUMN IF NOT EXISTS ai_execution_active_engine_config_revision text,
  ADD COLUMN IF NOT EXISTS ai_execution_active_engine_configuration_sha256 text,
  ADD COLUMN IF NOT EXISTS ai_execution_active_qualification_id text,
  ADD COLUMN IF NOT EXISTS ai_execution_active_capability_profile_version text,
  ADD COLUMN IF NOT EXISTS ai_execution_standby_engine_id text,
  ADD COLUMN IF NOT EXISTS ai_execution_standby_engine_config_revision text,
  ADD COLUMN IF NOT EXISTS ai_execution_standby_engine_configuration_sha256 text,
  ADD COLUMN IF NOT EXISTS ai_execution_standby_qualification_id text,
  ADD COLUMN IF NOT EXISTS ai_execution_standby_capability_profile_version text,
  ADD COLUMN IF NOT EXISTS ai_execution_qualification_scope text,
  ADD COLUMN IF NOT EXISTS ai_execution_selection_authority_sequence bigint,
  ADD COLUMN IF NOT EXISTS ai_execution_provider_configuration_snapshot jsonb;
