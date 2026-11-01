-- Migration 018: Multi-Window Context Mapping Integrity & Authority Corrections
-- Additive after 017. Governed under IntentChord Multi-Window Implementation Completion & Correction Freeze V1.

-- 1. Defect 1: Cursor Authority Relational Enforcement ---------------------------

-- 1.1 Add cursor_section_schema_version to context_mapping_windows
ALTER TABLE intentchord.context_mapping_windows 
  ADD COLUMN IF NOT EXISTS cursor_section_schema_version text NOT NULL DEFAULT 'v2';

-- 1.2 Unique composite authority on workspace_evidence_sections
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_wes_cursor_composite') THEN
    ALTER TABLE intentchord.workspace_evidence_sections
      ADD CONSTRAINT uq_wes_cursor_composite UNIQUE (id, artifact_id, section_type, section_schema_version);
  END IF;
END $$;

-- 1.3 Unique WEA identity on context_mapping_traversals
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_traversals_id_wea') THEN
    ALTER TABLE intentchord.context_mapping_traversals
      ADD CONSTRAINT uq_traversals_id_wea UNIQUE (id, accepted_workspace_evidence_artifact_id);
  END IF;
END $$;

-- 1.4 Cursor checks and FKs on context_mapping_traversals
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_traversal_cursor_artifact_match') THEN
    ALTER TABLE intentchord.context_mapping_traversals
      ADD CONSTRAINT ck_traversal_cursor_artifact_match CHECK (cursor_artifact_id = accepted_workspace_evidence_artifact_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_traversal_cursor_section_type') THEN
    ALTER TABLE intentchord.context_mapping_traversals
      ADD CONSTRAINT ck_traversal_cursor_section_type CHECK (cursor_section_type = 'SEMANTIC_PROJECTION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_traversal_cursor_section') THEN
    ALTER TABLE intentchord.context_mapping_traversals
      ADD CONSTRAINT fk_traversal_cursor_section
      FOREIGN KEY (cursor_section_id, cursor_artifact_id, cursor_section_type, cursor_section_schema_version)
      REFERENCES intentchord.workspace_evidence_sections(id, artifact_id, section_type, section_schema_version)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- 1.5 Window cursor checks and FKs
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_window_cursor_section_type') THEN
    ALTER TABLE intentchord.context_mapping_windows
      ADD CONSTRAINT ck_window_cursor_section_type CHECK (cursor_section_type = 'SEMANTIC_PROJECTION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_window_traversal_wea') THEN
    ALTER TABLE intentchord.context_mapping_windows
      ADD CONSTRAINT fk_window_traversal_wea
      FOREIGN KEY (traversal_id, cursor_artifact_id)
      REFERENCES intentchord.context_mapping_traversals(id, accepted_workspace_evidence_artifact_id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_window_cursor_section') THEN
    ALTER TABLE intentchord.context_mapping_windows
      ADD CONSTRAINT fk_window_cursor_section
      FOREIGN KEY (cursor_section_id, cursor_artifact_id, cursor_section_type, cursor_section_schema_version)
      REFERENCES intentchord.workspace_evidence_sections(id, artifact_id, section_type, section_schema_version)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- 1.6 Window Cursor Integrity Guard
CREATE OR REPLACE FUNCTION intentchord.context_mapping_window_cursor_guard()
RETURNS trigger LANGUAGE plpgsql AS $wguard$
DECLARE
  v_sec intentchord.workspace_evidence_sections%ROWTYPE;
  v_trav intentchord.context_mapping_traversals%ROWTYPE;
BEGIN
  IF NEW.cursor_section_type <> 'SEMANTIC_PROJECTION' THEN
    RAISE EXCEPTION 'INTENTCHORD_WINDOW_CURSOR_SECTION_TYPE_INVALID: must be SEMANTIC_PROJECTION';
  END IF;

  SELECT * INTO v_sec
    FROM intentchord.workspace_evidence_sections
   WHERE id = NEW.cursor_section_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_WINDOW_CURSOR_SECTION_NOT_FOUND: %', NEW.cursor_section_id;
  END IF;

  IF v_sec.artifact_id IS DISTINCT FROM NEW.cursor_artifact_id
     OR v_sec.section_type IS DISTINCT FROM NEW.cursor_section_type
     OR v_sec.section_schema_version IS DISTINCT FROM NEW.cursor_section_schema_version THEN
    RAISE EXCEPTION 'INTENTCHORD_WINDOW_CURSOR_SECTION_METADATA_MISMATCH';
  END IF;

  SELECT * INTO v_trav
    FROM intentchord.context_mapping_traversals
   WHERE id = NEW.traversal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_WINDOW_TRAVERSAL_NOT_FOUND: %', NEW.traversal_id;
  END IF;

  IF v_trav.accepted_workspace_evidence_artifact_id IS DISTINCT FROM NEW.cursor_artifact_id
     OR v_trav.cursor_section_id IS DISTINCT FROM NEW.cursor_section_id
     OR v_trav.cursor_section_schema_version IS DISTINCT FROM NEW.cursor_section_schema_version THEN
    RAISE EXCEPTION 'INTENTCHORD_WINDOW_CURSOR_TRAVERSAL_MISMATCH: window cursor must match owning traversal';
  END IF;

  IF NEW.start_cursor_record_seq < 0 THEN
    RAISE EXCEPTION 'INTENTCHORD_WINDOW_START_SEQ_NEGATIVE: %', NEW.start_cursor_record_seq;
  END IF;

  IF NEW.end_cursor_record_seq < NEW.start_cursor_record_seq THEN
    RAISE EXCEPTION 'INTENTCHORD_WINDOW_SEQ_INVERTED: % > %', NEW.start_cursor_record_seq, NEW.end_cursor_record_seq;
  END IF;

  IF v_sec.record_count > 0 AND NEW.end_cursor_record_seq > v_sec.record_count THEN
    RAISE EXCEPTION 'INTENTCHORD_WINDOW_SEQ_EXCEEDS_SECTION_RECORD_COUNT: % > %', NEW.end_cursor_record_seq, v_sec.record_count;
  END IF;

  RETURN NEW;
END;
$wguard$;

DROP TRIGGER IF EXISTS context_mapping_window_cursor_guard ON intentchord.context_mapping_windows;
CREATE TRIGGER context_mapping_window_cursor_guard
BEFORE INSERT OR UPDATE ON intentchord.context_mapping_windows
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_window_cursor_guard();


-- 2. Defect 2: Candidate Processed Window Same Traversal --------------------------

-- 2.1 Replace single-column FK with composite same-traversal FK
ALTER TABLE intentchord.context_mapping_candidate_units
  DROP CONSTRAINT IF EXISTS context_mapping_candidate_units_processed_in_window_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_unit_processed_window') THEN
    ALTER TABLE intentchord.context_mapping_candidate_units
      ADD CONSTRAINT fk_candidate_unit_processed_window
      FOREIGN KEY (processed_in_window_id, traversal_id)
      REFERENCES intentchord.context_mapping_windows(id, traversal_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 2.2 Processed Window Phase Guard
CREATE OR REPLACE FUNCTION intentchord.context_mapping_candidate_unit_processed_window_guard()
RETURNS trigger LANGUAGE plpgsql AS $pwguard$
DECLARE
  v_win intentchord.context_mapping_windows%ROWTYPE;
BEGIN
  IF NEW.status = 'PROCESSED' THEN
    IF NEW.processed_in_window_id IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CANDIDATE_PROCESSED_WINDOW_REQUIRED: status is PROCESSED but processed_in_window_id is NULL';
    END IF;

    SELECT * INTO v_win
      FROM intentchord.context_mapping_windows
     WHERE id = NEW.processed_in_window_id AND traversal_id = NEW.traversal_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INTENTCHORD_CANDIDATE_PROCESSED_WINDOW_NOT_FOUND: %', NEW.processed_in_window_id;
    END IF;

    IF v_win.phase <> 'DRILLDOWN' THEN
      RAISE EXCEPTION 'INTENTCHORD_CANDIDATE_PROCESSED_ONLY_BY_DRILLDOWN_WINDOW: window % phase is %', v_win.id, v_win.phase;
    END IF;
  ELSE
    IF NEW.processed_in_window_id IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CANDIDATE_UNPROCESSED_MUST_NOT_HAVE_WINDOW: status is % but processed_in_window_id is set', NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$pwguard$;

DROP TRIGGER IF EXISTS context_mapping_candidate_unit_processed_window_guard ON intentchord.context_mapping_candidate_units;
CREATE TRIGGER context_mapping_candidate_unit_processed_window_guard
BEFORE INSERT OR UPDATE ON intentchord.context_mapping_candidate_units
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_candidate_unit_processed_window_guard();


-- 3. Defect 3: Candidate Source Authority Fully Bound to Traversal ---------------

-- 3.1 Composite unique constraint on context_mapping_traversals
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_traversals_candidate_authority') THEN
    ALTER TABLE intentchord.context_mapping_traversals
      ADD CONSTRAINT uq_traversals_candidate_authority
      UNIQUE (id, workspace_registration_id, workspace_revision_id, accepted_workspace_evidence_artifact_id);
  END IF;
END $$;

-- 3.2 Composite FK from candidate_units to traversals
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_unit_traversal_authority') THEN
    ALTER TABLE intentchord.context_mapping_candidate_units
      ADD CONSTRAINT fk_candidate_unit_traversal_authority
      FOREIGN KEY (traversal_id, workspace_registration_id, workspace_revision_id, accepted_workspace_evidence_artifact_id)
      REFERENCES intentchord.context_mapping_traversals(id, workspace_registration_id, workspace_revision_id, accepted_workspace_evidence_artifact_id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- 3.3 Index on SEMANTIC_PROJECTION records for instant lookup
CREATE INDEX IF NOT EXISTS idx_wesr_semantic_logical_unit
  ON intentchord.workspace_evidence_section_records (artifact_id, (record_json->>'logical_unit_id'))
  WHERE section_type = 'SEMANTIC_PROJECTION';

-- 3.4 Candidate Source Identity WEA Grounding Guard
CREATE OR REPLACE FUNCTION intentchord.context_mapping_candidate_unit_authority_guard()
RETURNS trigger LANGUAGE plpgsql AS $caguard$
BEGIN
  -- Verify source file revision and logical unit exist in WEA SEMANTIC_PROJECTION records
  IF NOT EXISTS (
    SELECT 1
      FROM intentchord.workspace_evidence_section_records
     WHERE artifact_id = NEW.accepted_workspace_evidence_artifact_id
       AND section_type = 'SEMANTIC_PROJECTION'
       AND (
         (record_json->>'logical_unit_id') = NEW.logical_unit_id
         OR source_file_revision_id = NEW.source_file_revision_id
       )
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CANDIDATE_SOURCE_IDENTITY_NOT_FOUND_IN_WEA: unit % or source_file % not under WEA %',
      NEW.logical_unit_id, NEW.source_file_revision_id, NEW.accepted_workspace_evidence_artifact_id;
  END IF;

  RETURN NEW;
END;
$caguard$;

DROP TRIGGER IF EXISTS context_mapping_candidate_unit_authority_guard ON intentchord.context_mapping_candidate_units;
CREATE TRIGGER context_mapping_candidate_unit_authority_guard
BEFORE INSERT OR UPDATE ON intentchord.context_mapping_candidate_units
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_candidate_unit_authority_guard();


-- 4. App <-> DB Authority Hash Equivalence ---------------------------------------

CREATE OR REPLACE FUNCTION intentchord.traversal_authority_canonical_payload(
  p_accepted_workspace_evidence_artifact_id text,
  p_artifact_semantic_sha256 text,
  p_authority_sequence bigint,
  p_context_assembly_revision_id uuid,
  p_index_configuration_sha256 text,
  p_workspace_index_snapshot_id uuid,
  p_workspace_observation_id uuid,
  p_workspace_registration_id uuid,
  p_workspace_revision_id text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"accepted_workspace_evidence_artifact_id":' || to_json(p_accepted_workspace_evidence_artifact_id)::text
      || ',"artifact_semantic_sha256":' || to_json(p_artifact_semantic_sha256)::text
      || ',"authority_sequence":' || p_authority_sequence::text
      || ',"context_assembly_revision_id":' || to_json(p_context_assembly_revision_id::text)::text
      || ',"index_configuration_sha256":' || to_json(p_index_configuration_sha256)::text
      || ',"workspace_index_snapshot_id":' || to_json(p_workspace_index_snapshot_id::text)::text
      || ',"workspace_observation_id":' || to_json(p_workspace_observation_id::text)::text
      || ',"workspace_registration_id":' || to_json(p_workspace_registration_id::text)::text
      || ',"workspace_revision_id":' || to_json(p_workspace_revision_id)::text
      || '}';
$$;

CREATE OR REPLACE FUNCTION intentchord.compute_traversal_authority_sha256(
  p_accepted_workspace_evidence_artifact_id text,
  p_artifact_semantic_sha256 text,
  p_authority_sequence bigint,
  p_context_assembly_revision_id uuid,
  p_index_configuration_sha256 text,
  p_workspace_index_snapshot_id uuid,
  p_workspace_observation_id uuid,
  p_workspace_registration_id uuid,
  p_workspace_revision_id text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'sha256:' || encode(sha256(convert_to(
    intentchord.traversal_authority_canonical_payload(
      p_accepted_workspace_evidence_artifact_id,
      p_artifact_semantic_sha256,
      p_authority_sequence,
      p_context_assembly_revision_id,
      p_index_configuration_sha256,
      p_workspace_index_snapshot_id,
      p_workspace_observation_id,
      p_workspace_registration_id,
      p_workspace_revision_id
    ),
    'UTF8'
  )), 'hex');
$$;

-- 4.1 Update Traversal Authority Guard to enforce exact database hash equivalence
CREATE OR REPLACE FUNCTION intentchord.context_mapping_traversal_authority_guard()
RETURNS trigger LANGUAGE plpgsql AS $tguard$
DECLARE
  v_wea intentchord.workspace_evidence_artifacts%ROWTYPE;
  v_snap intentchord.workspace_index_snapshots%ROWTYPE;
  v_obs intentchord.workspace_observations%ROWTYPE;
  v_cas intentchord.context_assembly_sources%ROWTYPE;
  v_expected_hash text;
BEGIN
  -- 0. Exact Database Authority Hash Equivalence
  v_expected_hash := intentchord.compute_traversal_authority_sha256(
    NEW.accepted_workspace_evidence_artifact_id,
    NEW.artifact_semantic_sha256,
    NEW.authority_sequence,
    NEW.context_assembly_revision_id,
    NEW.index_configuration_sha256,
    NEW.workspace_index_snapshot_id,
    NEW.workspace_observation_id,
    NEW.workspace_registration_id,
    NEW.workspace_revision_id
  );

  IF NEW.traversal_authority_sha256 IS DISTINCT FROM v_expected_hash THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_AUTHORITY_HASH_MISMATCH: received %, expected %',
      NEW.traversal_authority_sha256, v_expected_hash;
  END IF;

  -- 1. Validate WEA exists and matches frozen attributes
  SELECT * INTO v_wea FROM intentchord.workspace_evidence_artifacts WHERE id = NEW.accepted_workspace_evidence_artifact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_WEA_NOT_FOUND: %', NEW.accepted_workspace_evidence_artifact_id;
  END IF;
  IF v_wea.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR v_wea.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
     OR v_wea.artifact_semantic_sha256 IS DISTINCT FROM NEW.artifact_semantic_sha256
     OR v_wea.index_configuration_sha256 IS DISTINCT FROM NEW.index_configuration_sha256 THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_WEA_AUTHORITY_MISMATCH';
  END IF;

  -- 2. Validate Snapshot exists, is READY, and matches frozen attributes
  SELECT * INTO v_snap FROM intentchord.workspace_index_snapshots WHERE id = NEW.workspace_index_snapshot_id;
  IF NOT FOUND OR v_snap.status <> 'READY' THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_READY_SNAPSHOT_REQUIRED: %', NEW.workspace_index_snapshot_id;
  END IF;
  IF v_snap.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR v_snap.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
     OR v_snap.accepted_workspace_evidence_artifact_id IS DISTINCT FROM NEW.accepted_workspace_evidence_artifact_id
     OR v_snap.index_configuration_sha256 IS DISTINCT FROM NEW.index_configuration_sha256 THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_SNAPSHOT_AUTHORITY_MISMATCH';
  END IF;

  -- 3. Validate Observation exists and matches authority sequence
  SELECT * INTO v_obs FROM intentchord.workspace_observations WHERE id = NEW.workspace_observation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_OBSERVATION_NOT_FOUND: %', NEW.workspace_observation_id;
  END IF;
  IF v_obs.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR v_obs.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
     OR v_obs.authority_sequence IS DISTINCT FROM NEW.authority_sequence THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_OBSERVATION_AUTHORITY_MISMATCH';
  END IF;

  -- 4. Validate Context Assembly Source binding matches exact frozen authority
  SELECT * INTO v_cas FROM intentchord.context_assembly_sources
   WHERE context_assembly_revision_id = NEW.context_assembly_revision_id
     AND workspace_registration_id = NEW.workspace_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_CAS_SOURCE_NOT_FOUND';
  END IF;
  IF v_cas.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
     OR v_cas.workspace_index_snapshot_id IS DISTINCT FROM NEW.workspace_index_snapshot_id
     OR v_cas.accepted_workspace_evidence_artifact_id IS DISTINCT FROM NEW.accepted_workspace_evidence_artifact_id
     OR v_cas.artifact_semantic_sha256 IS DISTINCT FROM NEW.artifact_semantic_sha256
     OR v_cas.workspace_observation_id IS DISTINCT FROM NEW.workspace_observation_id
     OR v_cas.workspace_observation_authority_sequence IS DISTINCT FROM NEW.authority_sequence THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_CAS_AUTHORITY_MISMATCH';
  END IF;

  RETURN NEW;
END;
$tguard$;

DROP TRIGGER IF EXISTS context_mapping_traversal_authority_guard ON intentchord.context_mapping_traversals;
CREATE TRIGGER context_mapping_traversal_authority_guard
BEFORE INSERT ON intentchord.context_mapping_traversals
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_traversal_authority_guard();
