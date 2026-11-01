-- Migration 025: Engine Binding Vendor/Model Integration + Historical Revision Immutability
-- Additive after Migration 024. Governed under INTENTCHORD_INTERNAL_AI_VENDOR_LIFECYCLE_AND_DYNAMIC_PROVIDER_MANAGEMENT_V1 (ADR-001 §3.3, §11).
-- Engine Revision is the governed runnable binding composed from Vendor + Model + Endpoint + Credential Reference + Profiles.
-- HISTORICAL_ENGINE_REVISION_REWRITE = FORBIDDEN: configuration changes create new FUTURE revisions only.

-- 1. Seed current production Vendors/Models if absent (configuration entities, not channel IDs) -----
INSERT INTO intentchord.internal_ai_vendors (
  vendor_id, display_name, vendor_state, base_url, auth_type, protocol_profile, credential_reference
)
VALUES
  ('zai', 'Z.ai', 'ENABLED', 'https://api.z.ai', 'api_key', 'openai_chat_completions_v1', 'ZAI_API_KEY'),
  ('sambanova', 'SambaNova', 'ENABLED', 'https://api.sambanova.ai', 'api_key', 'openai_chat_completions_v1', 'SAMBANOVA_API_KEY')
ON CONFLICT (vendor_id) DO NOTHING;

INSERT INTO intentchord.internal_ai_models (
  vendor_id, model_id, display_name, model_state, provider_facing_model_id, capability_metadata, runtime_compatibility_metadata
)
VALUES
  ('zai', 'glm-4.7-flash', 'GLM-4.7 Flash', 'ENABLED', 'glm-4.7-flash', '{}'::jsonb, '{}'::jsonb),
  ('sambanova', 'gpt-oss-120b', 'GPT-OSS 120B', 'ENABLED', 'gpt-oss-120b', '{}'::jsonb, '{}'::jsonb)
ON CONFLICT (vendor_id, model_id) DO NOTHING;

-- 2. Vendor binding column on engine revisions (nullable only for pre-binding historical rows) ------
ALTER TABLE intentchord.internal_ai_engine_revisions
  ADD COLUMN IF NOT EXISTS vendor_id text
  REFERENCES intentchord.internal_ai_vendors(vendor_id) ON DELETE RESTRICT;

-- 3. Backfill Vendor binding from provider_id where a first-class Vendor already exists ------------
--    Metadata-only enrichment of a new column; does not alter any fingerprinted configuration field.
--    Must run BEFORE the immutability trigger is installed (qualify executes this file twice).
UPDATE intentchord.internal_ai_engine_revisions r
SET vendor_id = v.vendor_id
FROM intentchord.internal_ai_vendors v
WHERE r.provider_id = v.vendor_id
  AND r.vendor_id IS NULL;

-- 4. DB-enforced historical revision immutability (HISTORICAL_ENGINE_REVISION_REWRITE = FORBIDDEN) ---
-- Restrict fingerprint validation to INSERT so UPDATE always fails closed with the immutability error
-- (alphabetical BEFORE-trigger order would otherwise surface FINGERPRINT_MISMATCH first).
DROP TRIGGER IF EXISTS trg_internal_ai_engine_revision_fingerprint_guard ON intentchord.internal_ai_engine_revisions;
CREATE TRIGGER trg_internal_ai_engine_revision_fingerprint_guard
  BEFORE INSERT ON intentchord.internal_ai_engine_revisions
  FOR EACH ROW EXECUTE FUNCTION intentchord.trg_assert_internal_ai_engine_revision_fingerprint();

CREATE OR REPLACE FUNCTION intentchord.trg_assert_internal_ai_engine_revision_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HISTORICAL_ENGINE_REVISION_REWRITE_FORBIDDEN: Engine revision %.% is immutable after insert. Create a new FUTURE revision instead.',
    OLD.engine_id, OLD.engine_config_revision;
END;
$$;

DROP TRIGGER IF EXISTS trg_internal_ai_engine_revision_immutable_guard ON intentchord.internal_ai_engine_revisions;
CREATE TRIGGER trg_internal_ai_engine_revision_immutable_guard
  BEFORE UPDATE ON intentchord.internal_ai_engine_revisions
  FOR EACH ROW EXECUTE FUNCTION intentchord.trg_assert_internal_ai_engine_revision_immutable();

COMMENT ON COLUMN intentchord.internal_ai_engine_revisions.vendor_id IS
  'First-class Vendor binding for the Engine Revision (ADR-001 §3.3). Config changes create a new revision; this column is never rewritten after insert.';
COMMENT ON TRIGGER trg_internal_ai_engine_revision_immutable_guard ON intentchord.internal_ai_engine_revisions IS
  'HISTORICAL_ENGINE_REVISION_REWRITE = FORBIDDEN. All UPDATE paths fail closed.';
