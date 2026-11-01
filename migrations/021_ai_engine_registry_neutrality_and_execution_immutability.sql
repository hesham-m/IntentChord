-- Migration 021: AI Engine Registry Profile Neutrality and Traversal AI Execution Immutability
-- Author: Hisham (Owner)
-- Date: 2026-09-08
-- Governance: IntentChord Stable Governance

-- ============================================================================
-- 1. Remove provider-specific profile enumeration constraints from
--    internal_ai_engine_revisions and replace with safe generic identifier checks
--    (Closure Area 1: Provider / Adapter Neutrality)
-- ============================================================================

ALTER TABLE intentchord.internal_ai_engine_revisions
  DROP CONSTRAINT IF EXISTS internal_ai_engine_revisions_transport_profile_id_check,
  DROP CONSTRAINT IF EXISTS internal_ai_engine_revisions_behavior_profile_id_check;

ALTER TABLE intentchord.internal_ai_engine_revisions
  ADD CONSTRAINT internal_ai_engine_revisions_transport_profile_id_check
    CHECK (btrim(transport_profile_id) <> '' AND length(transport_profile_id) <= 200 AND transport_profile_id !~ '[[:space:]]'),
  ADD CONSTRAINT internal_ai_engine_revisions_behavior_profile_id_check
    CHECK (btrim(behavior_profile_id) <> '' AND length(behavior_profile_id) <= 200 AND behavior_profile_id !~ '[[:space:]]');

-- ============================================================================
-- 2. DB-Enforced Immutability for Traversal AI Execution Authority
--    (Closure Area 2: Frozen AI Execution Authority DB Immutability)
--
-- Preserves existing 9-field traversal_authority_sha256 unchanged as Source/Workspace authority.
-- Enforces that once a traversal is inserted, all ai_execution_* columns are WRITE-ON-INSERT and IMMUTABLE.
-- Legacy historical rows containing NULL AI execution authority remain readable and operational
-- updates (status, counts, cursor, lease) are allowed, but modifying any ai_execution_* field fails closed.
-- ============================================================================

CREATE OR REPLACE FUNCTION intentchord.context_mapping_traversal_ai_execution_immutability_guard()
RETURNS trigger LANGUAGE plpgsql AS $ai_immut$
BEGIN
  IF OLD.ai_execution_authority_sha256 IS DISTINCT FROM NEW.ai_execution_authority_sha256
     OR OLD.ai_execution_active_engine_id IS DISTINCT FROM NEW.ai_execution_active_engine_id
     OR OLD.ai_execution_active_engine_config_revision IS DISTINCT FROM NEW.ai_execution_active_engine_config_revision
     OR OLD.ai_execution_active_engine_configuration_sha256 IS DISTINCT FROM NEW.ai_execution_active_engine_configuration_sha256
     OR OLD.ai_execution_active_qualification_id IS DISTINCT FROM NEW.ai_execution_active_qualification_id
     OR OLD.ai_execution_active_capability_profile_version IS DISTINCT FROM NEW.ai_execution_active_capability_profile_version
     OR OLD.ai_execution_standby_engine_id IS DISTINCT FROM NEW.ai_execution_standby_engine_id
     OR OLD.ai_execution_standby_engine_config_revision IS DISTINCT FROM NEW.ai_execution_standby_engine_config_revision
     OR OLD.ai_execution_standby_engine_configuration_sha256 IS DISTINCT FROM NEW.ai_execution_standby_engine_configuration_sha256
     OR OLD.ai_execution_standby_qualification_id IS DISTINCT FROM NEW.ai_execution_standby_qualification_id
     OR OLD.ai_execution_standby_capability_profile_version IS DISTINCT FROM NEW.ai_execution_standby_capability_profile_version
     OR OLD.ai_execution_qualification_scope IS DISTINCT FROM NEW.ai_execution_qualification_scope
     OR OLD.ai_execution_selection_authority_sequence IS DISTINCT FROM NEW.ai_execution_selection_authority_sequence
     OR OLD.ai_execution_provider_configuration_snapshot IS DISTINCT FROM NEW.ai_execution_provider_configuration_snapshot THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE: frozen AI execution authority fields cannot be modified after insertion.';
  END IF;
  RETURN NEW;
END;
$ai_immut$;

DROP TRIGGER IF EXISTS context_mapping_traversal_ai_execution_immutability_guard ON intentchord.context_mapping_traversals;
CREATE TRIGGER context_mapping_traversal_ai_execution_immutability_guard
  BEFORE UPDATE ON intentchord.context_mapping_traversals
  FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_traversal_ai_execution_immutability_guard();
