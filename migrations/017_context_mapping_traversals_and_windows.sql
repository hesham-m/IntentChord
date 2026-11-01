-- Migration 017: Multi-Window Context Mapping Traversals, Windows, Normalized Candidates, and Hierarchical Reduction Lineage
-- Additive after 016. Governed under IntentChord Final Multi-Window Execution Integrity Freeze V1.

-- 1. Root Traversal Table --------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.context_mapping_traversals (
  id uuid PRIMARY KEY,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  workspace_revision_id text NOT NULL,
  workspace_index_snapshot_id uuid NOT NULL REFERENCES intentchord.workspace_index_snapshots(id) ON DELETE RESTRICT,
  accepted_workspace_evidence_artifact_id text NOT NULL REFERENCES intentchord.workspace_evidence_artifacts(id) ON DELETE RESTRICT,
  artifact_semantic_sha256 text NOT NULL CHECK (artifact_semantic_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  workspace_observation_id uuid NOT NULL REFERENCES intentchord.workspace_observations(id) ON DELETE RESTRICT,
  authority_sequence bigint NOT NULL CHECK (authority_sequence > 0),
  index_configuration_sha256 text NOT NULL CHECK (index_configuration_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  traversal_authority_sha256 text NOT NULL CHECK (traversal_authority_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  traversal_status text NOT NULL CHECK (traversal_status IN (
    'TOPOLOGY_IN_PROGRESS', 'TOPOLOGY_COMPLETE',
    'DRILLDOWN_IN_PROGRESS', 'DRILLDOWN_COMPLETE',
    'SYNTHESIS_IN_PROGRESS', 'SYNTHESIS_REDUCING', 'SYNTHESIS_COMPLETE',
    'FAILED', 'STALE_AUTHORITY', 'CANCELLED'
  )),
  current_phase text NOT NULL CHECK (current_phase IN ('TOPOLOGY', 'DRILLDOWN', 'SYNTHESIS')),
  active_window_ordinal integer NOT NULL DEFAULT 1 CHECK (active_window_ordinal >= 1),
  cursor_artifact_id text NOT NULL,
  cursor_section_id bigint NOT NULL DEFAULT 0,
  cursor_section_type text NOT NULL DEFAULT 'SEMANTIC_PROJECTION',
  cursor_section_schema_version text NOT NULL DEFAULT 'v2',
  cursor_record_seq bigint NOT NULL DEFAULT 0 CHECK (cursor_record_seq >= 0),
  topology_window_count integer NOT NULL DEFAULT 0 CHECK (topology_window_count >= 0),
  drilldown_window_count integer NOT NULL DEFAULT 0 CHECK (drilldown_window_count >= 0),
  reduction_level_count integer NOT NULL DEFAULT 0 CHECK (reduction_level_count >= 0),
  executor_lease_owner text,
  executor_lease_epoch bigint NOT NULL DEFAULT 0 CHECK (executor_lease_epoch >= 0),
  executor_lease_acquired_at timestamptz,
  executor_lease_expires_at timestamptz,
  executor_heartbeat_at timestamptz,
  failure_code text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_traversals_revision UNIQUE (context_assembly_revision_id),
  CONSTRAINT uq_traversals_id_authority UNIQUE (id, traversal_authority_sha256),
  CONSTRAINT uq_traversals_id_lease UNIQUE (id, executor_lease_owner, executor_lease_epoch),
  CONSTRAINT fk_traversal_wea_workspace FOREIGN KEY (workspace_registration_id, accepted_workspace_evidence_artifact_id)
    REFERENCES intentchord.workspace_evidence_artifacts(workspace_registration_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_traversal_wea_rev_cfg FOREIGN KEY (workspace_registration_id, workspace_revision_id, index_configuration_sha256)
    REFERENCES intentchord.workspace_evidence_artifacts(workspace_registration_id, workspace_revision_id, index_configuration_sha256) ON DELETE RESTRICT,
  CONSTRAINT fk_traversal_observation_workspace FOREIGN KEY (workspace_registration_id, workspace_observation_id)
    REFERENCES intentchord.workspace_observations(workspace_registration_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_traversal_cas_source FOREIGN KEY (context_assembly_revision_id, workspace_registration_id)
    REFERENCES intentchord.context_assembly_sources(context_assembly_revision_id, workspace_registration_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_traversals_recovery ON intentchord.context_mapping_traversals(traversal_status, executor_lease_expires_at);

-- 2. Evidence Windows Table (Topology & Drilldown ONLY) ---------------------------
CREATE TABLE IF NOT EXISTS intentchord.context_mapping_windows (
  id uuid PRIMARY KEY,
  traversal_id uuid NOT NULL REFERENCES intentchord.context_mapping_traversals(id) ON DELETE CASCADE,
  traversal_authority_sha256 text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('TOPOLOGY', 'DRILLDOWN')),
  window_ordinal integer NOT NULL CHECK (window_ordinal >= 1),
  cursor_artifact_id text NOT NULL,
  cursor_section_id bigint NOT NULL,
  cursor_section_type text NOT NULL,
  start_cursor_record_seq bigint NOT NULL CHECK (start_cursor_record_seq >= 0),
  end_cursor_record_seq bigint NOT NULL CHECK (end_cursor_record_seq >= start_cursor_record_seq),
  token_count integer NOT NULL CHECK (token_count >= 0),
  window_input_sha256 text NOT NULL CHECK (window_input_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('READY', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt_id uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_result_json jsonb,
  window_result_sha256 text CHECK (window_result_sha256 IS NULL OR window_result_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT uq_mapping_windows_ord UNIQUE (traversal_id, phase, window_ordinal),
  CONSTRAINT uq_mapping_windows_id_trav UNIQUE (id, traversal_id),
  CONSTRAINT uq_mapping_windows_id_hash UNIQUE (id, window_result_sha256),
  CONSTRAINT fk_window_traversal_authority FOREIGN KEY (traversal_id, traversal_authority_sha256)
    REFERENCES intentchord.context_mapping_traversals(id, traversal_authority_sha256) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_windows_traversal_phase ON intentchord.context_mapping_windows(traversal_id, phase, window_ordinal);

-- 3. Candidate Batches Table -----------------------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.context_mapping_candidate_batches (
  id uuid PRIMARY KEY,
  traversal_id uuid NOT NULL REFERENCES intentchord.context_mapping_traversals(id) ON DELETE CASCADE,
  traversal_authority_sha256 text NOT NULL,
  batch_ordinal integer NOT NULL CHECK (batch_ordinal >= 1),
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  token_count integer NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT uq_candidate_batches_ord UNIQUE (traversal_id, batch_ordinal),
  CONSTRAINT uq_candidate_batches_id_trav UNIQUE (id, traversal_id),
  CONSTRAINT fk_candidate_batch_traversal_authority FOREIGN KEY (traversal_id, traversal_authority_sha256)
    REFERENCES intentchord.context_mapping_traversals(id, traversal_authority_sha256) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_candidate_batches_traversal ON intentchord.context_mapping_candidate_batches(traversal_id, batch_ordinal);

-- 4. Candidate Units Table (Normalized relational candidates) ---------------------
CREATE TABLE IF NOT EXISTS intentchord.context_mapping_candidate_units (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL,
  traversal_id uuid NOT NULL REFERENCES intentchord.context_mapping_traversals(id) ON DELETE CASCADE,
  candidate_ordinal integer NOT NULL CHECK (candidate_ordinal >= 1),
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  workspace_revision_id text NOT NULL,
  accepted_workspace_evidence_artifact_id text NOT NULL REFERENCES intentchord.workspace_evidence_artifacts(id) ON DELETE RESTRICT,
  source_file_revision_id text NOT NULL,
  logical_unit_id text NOT NULL,
  source_anchor_signature text,
  fact_ref text,
  relation_ref text,
  status text NOT NULL DEFAULT 'SELECTED' CHECK (status IN ('SELECTED', 'PROCESSED', 'DISQUALIFIED')),
  processed_in_window_id uuid REFERENCES intentchord.context_mapping_windows(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_candidate_units_batch_ord UNIQUE (batch_id, candidate_ordinal),
  CONSTRAINT uq_candidate_units_trav_unit UNIQUE (traversal_id, logical_unit_id),
  CONSTRAINT fk_candidate_unit_batch_traversal FOREIGN KEY (batch_id, traversal_id)
    REFERENCES intentchord.context_mapping_candidate_batches(id, traversal_id) ON DELETE CASCADE,
  CONSTRAINT fk_candidate_unit_wea FOREIGN KEY (workspace_registration_id, accepted_workspace_evidence_artifact_id)
    REFERENCES intentchord.workspace_evidence_artifacts(workspace_registration_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_candidate_units_batch ON intentchord.context_mapping_candidate_units(batch_id, candidate_ordinal);
CREATE INDEX IF NOT EXISTS idx_candidate_units_lookup ON intentchord.context_mapping_candidate_units(traversal_id, logical_unit_id);

-- 5. Hierarchical Reduction Windows Table ----------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.context_mapping_reduction_windows (
  id uuid PRIMARY KEY,
  traversal_id uuid NOT NULL REFERENCES intentchord.context_mapping_traversals(id) ON DELETE CASCADE,
  traversal_authority_sha256 text NOT NULL,
  reduction_level integer NOT NULL CHECK (reduction_level >= 1),
  reduction_ordinal integer NOT NULL CHECK (reduction_ordinal >= 1),
  input_set_sha256 text NOT NULL CHECK (input_set_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  input_item_count integer NOT NULL CHECK (input_item_count > 0),
  token_count integer NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  status text NOT NULL CHECK (status IN ('READY', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt_id uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  output_sha256 text CHECK (output_sha256 IS NULL OR output_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  output_summary jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT uq_reduction_windows_level_ord UNIQUE (traversal_id, reduction_level, reduction_ordinal),
  CONSTRAINT uq_reduction_windows_id_trav UNIQUE (id, traversal_id),
  CONSTRAINT uq_reduction_windows_id_level UNIQUE (id, reduction_level),
  CONSTRAINT uq_reduction_windows_id_hash UNIQUE (id, output_sha256),
  CONSTRAINT fk_reduction_window_traversal_authority FOREIGN KEY (traversal_id, traversal_authority_sha256)
    REFERENCES intentchord.context_mapping_traversals(id, traversal_authority_sha256) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reduction_windows_lookup ON intentchord.context_mapping_reduction_windows(traversal_id, reduction_level, reduction_ordinal);

-- 6. Reduction Inputs Table (Normalized XOR Provenance Lineage) ------------------
CREATE TABLE IF NOT EXISTS intentchord.context_mapping_reduction_inputs (
  id uuid PRIMARY KEY,
  reduction_window_id uuid NOT NULL,
  traversal_id uuid NOT NULL REFERENCES intentchord.context_mapping_traversals(id) ON DELETE CASCADE,
  input_ordinal integer NOT NULL CHECK (input_ordinal >= 1),
  source_mapping_window_id uuid,
  source_reduction_window_id uuid,
  source_output_sha256 text NOT NULL CHECK (source_output_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT cmri_xor_source_ck CHECK (
    (source_mapping_window_id IS NOT NULL AND source_reduction_window_id IS NULL)
    OR
    (source_mapping_window_id IS NULL AND source_reduction_window_id IS NOT NULL)
  ),
  CONSTRAINT uq_reduction_inputs_ord UNIQUE (reduction_window_id, input_ordinal),
  CONSTRAINT fk_reduction_input_parent_window FOREIGN KEY (reduction_window_id, traversal_id)
    REFERENCES intentchord.context_mapping_reduction_windows(id, traversal_id) ON DELETE CASCADE,
  CONSTRAINT fk_reduction_input_source_mapping_window FOREIGN KEY (source_mapping_window_id, traversal_id)
    REFERENCES intentchord.context_mapping_windows(id, traversal_id) ON DELETE RESTRICT,
  CONSTRAINT fk_reduction_input_source_reduction_window FOREIGN KEY (source_reduction_window_id, traversal_id)
    REFERENCES intentchord.context_mapping_reduction_windows(id, traversal_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_reduction_inputs_parent ON intentchord.context_mapping_reduction_inputs(reduction_window_id, input_ordinal);

-- 7. Guards & Invariant Triggers -------------------------------------------------

-- Invariant 1: Frozen Authority Immutability
CREATE OR REPLACE FUNCTION intentchord.context_mapping_traversal_immutability_guard()
RETURNS trigger LANGUAGE plpgsql AS $immut$
BEGIN
  IF OLD.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id
     OR OLD.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR OLD.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
     OR OLD.workspace_index_snapshot_id IS DISTINCT FROM NEW.workspace_index_snapshot_id
     OR OLD.accepted_workspace_evidence_artifact_id IS DISTINCT FROM NEW.accepted_workspace_evidence_artifact_id
     OR OLD.artifact_semantic_sha256 IS DISTINCT FROM NEW.artifact_semantic_sha256
     OR OLD.workspace_observation_id IS DISTINCT FROM NEW.workspace_observation_id
     OR OLD.authority_sequence IS DISTINCT FROM NEW.authority_sequence
     OR OLD.index_configuration_sha256 IS DISTINCT FROM NEW.index_configuration_sha256
     OR OLD.traversal_authority_sha256 IS DISTINCT FROM NEW.traversal_authority_sha256 THEN
    RAISE EXCEPTION 'INTENTCHORD_TRAVERSAL_FROZEN_AUTHORITY_IMMUTABLE: frozen authority fields cannot be modified after insertion.';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$immut$;

DROP TRIGGER IF EXISTS context_mapping_traversal_immutability_guard ON intentchord.context_mapping_traversals;
CREATE TRIGGER context_mapping_traversal_immutability_guard
BEFORE UPDATE ON intentchord.context_mapping_traversals
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_traversal_immutability_guard();

-- Full Authority Tuple Validation Guard on Traversal Creation
CREATE OR REPLACE FUNCTION intentchord.context_mapping_traversal_authority_guard()
RETURNS trigger LANGUAGE plpgsql AS $tguard$
DECLARE
  v_wea intentchord.workspace_evidence_artifacts%ROWTYPE;
  v_snap intentchord.workspace_index_snapshots%ROWTYPE;
  v_obs intentchord.workspace_observations%ROWTYPE;
  v_cas intentchord.context_assembly_sources%ROWTYPE;
BEGIN
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

-- Invariant 2: Cryptographically True Reduction Lineage Guard
CREATE OR REPLACE FUNCTION intentchord.context_mapping_reduction_input_lineage_guard()
RETURNS trigger LANGUAGE plpgsql AS $riguard$
DECLARE
  v_target_reduction intentchord.context_mapping_reduction_windows%ROWTYPE;
  v_source_mapping intentchord.context_mapping_windows%ROWTYPE;
  v_source_reduction intentchord.context_mapping_reduction_windows%ROWTYPE;
BEGIN
  -- Validate target reduction window
  SELECT * INTO v_target_reduction
    FROM intentchord.context_mapping_reduction_windows
   WHERE id = NEW.reduction_window_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_TARGET_NOT_FOUND: %', NEW.reduction_window_id;
  END IF;

  IF v_target_reduction.traversal_id IS DISTINCT FROM NEW.traversal_id THEN
    RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_CROSS_TRAVERSAL_TARGET';
  END IF;

  IF NEW.source_mapping_window_id IS NOT NULL THEN
    -- Mapping window source validation
    SELECT * INTO v_source_mapping
      FROM intentchord.context_mapping_windows
     WHERE id = NEW.source_mapping_window_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_SOURCE_MAPPING_NOT_FOUND: %', NEW.source_mapping_window_id;
    END IF;

    IF v_source_mapping.traversal_id IS DISTINCT FROM NEW.traversal_id THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_CROSS_TRAVERSAL_MAPPING_SOURCE';
    END IF;

    IF v_source_mapping.status <> 'SUCCEEDED' THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_SOURCE_NOT_SUCCEEDED: mapping window % status is %',
        v_source_mapping.id, v_source_mapping.status;
    END IF;

    IF v_source_mapping.window_result_sha256 IS NULL
       OR v_source_mapping.window_result_sha256 IS DISTINCT FROM NEW.source_output_sha256 THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_HASH_MISMATCH: expected % but received %',
        v_source_mapping.window_result_sha256, NEW.source_output_sha256;
    END IF;

  ELSIF NEW.source_reduction_window_id IS NOT NULL THEN
    -- Reduction window source validation
    IF NEW.source_reduction_window_id = NEW.reduction_window_id THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_SELF_REFERENCE_FORBIDDEN';
    END IF;

    SELECT * INTO v_source_reduction
      FROM intentchord.context_mapping_reduction_windows
     WHERE id = NEW.source_reduction_window_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_SOURCE_REDUCTION_NOT_FOUND: %', NEW.source_reduction_window_id;
    END IF;

    IF v_source_reduction.traversal_id IS DISTINCT FROM NEW.traversal_id THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_CROSS_TRAVERSAL_REDUCTION_SOURCE';
    END IF;

    IF v_source_reduction.status <> 'SUCCEEDED' THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_SOURCE_NOT_SUCCEEDED: reduction window % status is %',
        v_source_reduction.id, v_source_reduction.status;
    END IF;

    -- Strict DAG: source level must be strictly less than target level
    IF v_source_reduction.reduction_level >= v_target_reduction.reduction_level THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_LEVEL_DIRECTION_VIOLATION: source level % must be < target level %',
        v_source_reduction.reduction_level, v_target_reduction.reduction_level;
    END IF;

    IF v_source_reduction.output_sha256 IS NULL
       OR v_source_reduction.output_sha256 IS DISTINCT FROM NEW.source_output_sha256 THEN
      RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_HASH_MISMATCH: expected % but received %',
        v_source_reduction.output_sha256, NEW.source_output_sha256;
    END IF;
  ELSE
    RAISE EXCEPTION 'INTENTCHORD_REDUCTION_INPUT_SOURCE_REQUIRED';
  END IF;

  RETURN NEW;
END;
$riguard$;

DROP TRIGGER IF EXISTS context_mapping_reduction_input_lineage_guard ON intentchord.context_mapping_reduction_inputs;
CREATE TRIGGER context_mapping_reduction_input_lineage_guard
BEFORE INSERT OR UPDATE ON intentchord.context_mapping_reduction_inputs
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_reduction_input_lineage_guard();
