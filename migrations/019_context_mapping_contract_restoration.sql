-- Migration 019: Context Mapping Contract Restoration
-- Addresses:
-- 1. Candidate Unit Authority Guard: enforce same-record coherence (AND instead of OR) between logical_unit_id and source_file_revision_id in WEA SEMANTIC_PROJECTION records.
-- 2. Hierarchical Reduction Windows: add distinct input_estimated_tokens and output_estimated_tokens columns.

-- ============================================================================
-- 1. Candidate Unit Authority Guard Coherence Correction (DEFECT 5)
-- ============================================================================

CREATE OR REPLACE FUNCTION intentchord.context_mapping_candidate_unit_authority_guard()
RETURNS trigger LANGUAGE plpgsql AS $caguard$
BEGIN
  -- Verify source file revision and logical unit exist COHERENTLY on the same SEMANTIC_PROJECTION record in WEA
  IF NOT EXISTS (
    SELECT 1
      FROM intentchord.workspace_evidence_section_records
     WHERE artifact_id = NEW.accepted_workspace_evidence_artifact_id
       AND section_type = 'SEMANTIC_PROJECTION'
       AND (record_json->>'logical_unit_id') = NEW.logical_unit_id
       AND source_file_revision_id = NEW.source_file_revision_id
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CANDIDATE_SOURCE_IDENTITY_NOT_FOUND_IN_WEA: unit % with source_file % not coherently found in WEA %',
      NEW.logical_unit_id, NEW.source_file_revision_id, NEW.accepted_workspace_evidence_artifact_id;
  END IF;

  RETURN NEW;
END;
$caguard$;

DROP TRIGGER IF EXISTS context_mapping_candidate_unit_authority_guard ON intentchord.context_mapping_candidate_units;
CREATE TRIGGER context_mapping_candidate_unit_authority_guard
BEFORE INSERT OR UPDATE ON intentchord.context_mapping_candidate_units
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_candidate_unit_authority_guard();

-- Composite index to ensure rapid lookups on (artifact_id, source_file_revision_id, logical_unit_id)
CREATE INDEX IF NOT EXISTS idx_wesr_semantic_coherence_guard
  ON intentchord.workspace_evidence_section_records (artifact_id, source_file_revision_id, (record_json->>'logical_unit_id'))
  WHERE section_type = 'SEMANTIC_PROJECTION';


-- ============================================================================
-- 2. Hierarchical Reduction Separate Input/Output Token Tracking (DEFECT 7)
-- ============================================================================

ALTER TABLE intentchord.context_mapping_reduction_windows
  ADD COLUMN IF NOT EXISTS input_estimated_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_estimated_tokens integer NOT NULL DEFAULT 0;

-- Backfill existing rows: output_estimated_tokens gets token_count
UPDATE intentchord.context_mapping_reduction_windows
   SET output_estimated_tokens = token_count
 WHERE output_estimated_tokens = 0 AND token_count > 0;
