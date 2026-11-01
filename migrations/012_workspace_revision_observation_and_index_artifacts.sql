-- IntentChord Plane B1 v0.6: immutable Workspace source revisions, predecessor-independent
-- Canonical Index Artifacts with stable logical entity identity, database-authoritative observation chronology,
-- transition-scoped lineage evidence, deterministic derived Delta artifacts, and authoritative B1 Mapper binding.
-- Additive after 011. Historical V1 Snapshot rows remain readable and immutable.


-- B1 verified Root Object Authority. Historical workspaces remain readable as LEGACY_UNBOUND until
-- a governed re-verification records a proof-grade filesystem object identity. These fields bind
-- Workspace verification authority only; they do not participate in Workspace Source Revision identity.
ALTER TABLE intentchord.workspaces
  ADD COLUMN IF NOT EXISTS verified_root_real_path text,
  ADD COLUMN IF NOT EXISTS verified_root_device_id text,
  ADD COLUMN IF NOT EXISTS verified_root_file_id text,
  ADD COLUMN IF NOT EXISTS verified_root_identity_method text,
  ADD COLUMN IF NOT EXISTS verified_root_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS root_authority_state text NOT NULL DEFAULT 'LEGACY_UNBOUND',
  ADD COLUMN IF NOT EXISTS current_root_real_path text,
  ADD COLUMN IF NOT EXISTS current_root_device_id text,
  ADD COLUMN IF NOT EXISTS current_root_file_id text,
  ADD COLUMN IF NOT EXISTS current_root_identity_method text,
  ADD COLUMN IF NOT EXISTS root_authority_checked_at timestamptz;

ALTER TABLE intentchord.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_root_authority_state_ck;
ALTER TABLE intentchord.workspaces
  ADD CONSTRAINT workspaces_root_authority_state_ck CHECK (
    root_authority_state IN ('LEGACY_UNBOUND','VERIFIED_MATCH','STALE_MISMATCH','IDENTITY_UNPROVABLE')
  );

ALTER TABLE intentchord.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_verified_root_identity_shape_ck;
ALTER TABLE intentchord.workspaces
  ADD CONSTRAINT workspaces_verified_root_identity_shape_ck CHECK (
    (
      verified_root_real_path IS NULL AND verified_root_device_id IS NULL AND verified_root_file_id IS NULL
      AND verified_root_identity_method IS NULL AND verified_root_verified_at IS NULL
    )
    OR
    (
      verified_root_real_path IS NOT NULL AND btrim(verified_root_real_path)<>''
      AND verified_root_device_id ~ '^[0-9]+$'
      AND (
        (verified_root_identity_method='NODE_BIGINT_DEV_INO_V1' AND verified_root_file_id ~ '^[0-9]+$')
        OR
        (verified_root_identity_method='WINDOWS_FILE_ID_128_V1' AND verified_root_file_id ~ '^[0-9a-f]{32}$')
      )
      AND verified_root_verified_at IS NOT NULL
    )
  );

ALTER TABLE intentchord.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_current_root_identity_shape_ck;
ALTER TABLE intentchord.workspaces
  ADD CONSTRAINT workspaces_current_root_identity_shape_ck CHECK (
    (
      current_root_real_path IS NULL AND current_root_device_id IS NULL AND current_root_file_id IS NULL
      AND current_root_identity_method IS NULL
    )
    OR
    (
      current_root_real_path IS NOT NULL AND btrim(current_root_real_path)<>''
      AND current_root_device_id ~ '^[0-9]+$'
      AND (
        (current_root_identity_method='NODE_BIGINT_DEV_INO_V1' AND current_root_file_id ~ '^[0-9]+$')
        OR
        (current_root_identity_method='WINDOWS_FILE_ID_128_V1' AND current_root_file_id ~ '^[0-9a-f]{32}$')
      )
      AND root_authority_checked_at IS NOT NULL
    )
  );

ALTER TABLE intentchord.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_root_authority_binding_shape_ck;
ALTER TABLE intentchord.workspaces
  ADD CONSTRAINT workspaces_root_authority_binding_shape_ck CHECK (
    root_authority_state='LEGACY_UNBOUND'
    OR
    (
      root_authority_state='VERIFIED_MATCH'
      AND verification_status='VERIFIED'
      AND verified_root_device_id IS NOT NULL AND verified_root_file_id IS NOT NULL AND verified_root_identity_method IS NOT NULL
      AND current_root_device_id IS NOT NULL AND current_root_file_id IS NOT NULL AND current_root_identity_method IS NOT NULL
      AND verified_root_device_id=current_root_device_id
      AND verified_root_file_id=current_root_file_id
      AND verified_root_identity_method=current_root_identity_method
    )
    OR
    (
      root_authority_state='STALE_MISMATCH'
      AND verification_status='STALE'
      AND verified_root_device_id IS NOT NULL AND verified_root_file_id IS NOT NULL AND verified_root_identity_method IS NOT NULL
      AND current_root_device_id IS NOT NULL AND current_root_file_id IS NOT NULL AND current_root_identity_method IS NOT NULL
      AND (
        verified_root_device_id<>current_root_device_id
        OR verified_root_file_id<>current_root_file_id
        OR verified_root_identity_method<>current_root_identity_method
      )
    )
    OR
    (root_authority_state='IDENTITY_UNPROVABLE' AND verification_status='STALE')
  );

CREATE TABLE IF NOT EXISTS intentchord.workspace_source_revisions (
  id text PRIMARY KEY CHECK (id ~ '^wsr_[0-9a-f]{64}$'),
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  workspace_instance_id text NOT NULL CHECK (btrim(workspace_instance_id) <> ''),
  source_tree_fingerprint text NOT NULL CHECK (source_tree_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  source_state_summary jsonb NOT NULL CHECK (jsonb_typeof(source_state_summary)='object'),
  first_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_source_revisions_state_uq UNIQUE (workspace_registration_id, source_tree_fingerprint),
  CONSTRAINT workspace_source_revisions_registration_id_uq UNIQUE (workspace_registration_id, id)
);

-- Pre-launch V2 Rebase: canonical_index_artifacts and workspace_index_delta_artifacts retired.
-- Final authority model is HBSP-V2 / WEA ONLY.

CREATE TABLE IF NOT EXISTS intentchord.workspace_observations (
  id uuid PRIMARY KEY,
  authority_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  snapshot_operation_id uuid NOT NULL UNIQUE REFERENCES intentchord.workspace_index_snapshots(id) ON DELETE RESTRICT,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  workspace_revision_id text NOT NULL,
  canonical_index_artifact_id text,
  previous_observation_id uuid,
  delta_artifact_id text,
  observation_result text NOT NULL CHECK (observation_result IN (
    'FIRST_INDEXED',
    'SOURCE_UNCHANGED',
    'SOURCE_CHANGED',
    'KNOWN_STATE_RESTORED',
    'SOURCE_UNCHANGED_INDEX_REFRESHED',
    'SOURCE_PROVEN_INDEX_FAILED'
  )),
  index_configuration_sha256 text NOT NULL CHECK (index_configuration_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  source_tree_fingerprint text NOT NULL CHECK (source_tree_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  source_binding_json jsonb NOT NULL CHECK (jsonb_typeof(source_binding_json)='object'),
  owner_reference text NOT NULL CHECK (btrim(owner_reference) <> ''),
  -- Informational application evidence only; never authoritative for chronology/head selection.
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_observations_artifact_shape_ck CHECK (
    canonical_index_artifact_id IS NULL OR canonical_index_artifact_id ~ '^cia_[0-9a-f]{64}$'
  ),
  CONSTRAINT workspace_observations_registration_id_uq UNIQUE (workspace_registration_id,id),
  CONSTRAINT workspace_observations_registration_revision_fk
    FOREIGN KEY (workspace_registration_id,workspace_revision_id)
    REFERENCES intentchord.workspace_source_revisions(workspace_registration_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_observations_previous_same_workspace_fk
    FOREIGN KEY (workspace_registration_id,previous_observation_id)
    REFERENCES intentchord.workspace_observations(workspace_registration_id,id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS workspace_observations_workspace_authority_idx
  ON intentchord.workspace_observations(workspace_registration_id, authority_sequence DESC);
CREATE INDEX IF NOT EXISTS workspace_observations_revision_authority_idx
  ON intentchord.workspace_observations(workspace_revision_id, authority_sequence DESC);
CREATE INDEX IF NOT EXISTS workspace_observations_informational_time_idx
  ON intentchord.workspace_observations(workspace_registration_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS intentchord.workspace_revision_transitions (
  id uuid PRIMARY KEY,
  observation_id uuid NOT NULL UNIQUE,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  from_workspace_revision_id text NOT NULL,
  to_workspace_revision_id text NOT NULL,
  delta_artifact_id text,
  lineage_evidence_json jsonb NOT NULL CHECK (
    jsonb_typeof(lineage_evidence_json)='object'
    AND lineage_evidence_json->>'schema'='intentchord.workspace-transition-lineage-evidence/v1'
    AND jsonb_typeof(lineage_evidence_json->'renamed_or_moved')='array'
  ),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_revision_transitions_distinct_revision_ck CHECK (from_workspace_revision_id <> to_workspace_revision_id),
  CONSTRAINT workspace_revision_transitions_observation_workspace_fk
    FOREIGN KEY (workspace_registration_id,observation_id)
    REFERENCES intentchord.workspace_observations(workspace_registration_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_revision_transitions_from_revision_fk
    FOREIGN KEY (workspace_registration_id,from_workspace_revision_id)
    REFERENCES intentchord.workspace_source_revisions(workspace_registration_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_revision_transitions_to_revision_fk
    FOREIGN KEY (workspace_registration_id,to_workspace_revision_id)
    REFERENCES intentchord.workspace_source_revisions(workspace_registration_id,id)
    ON DELETE RESTRICT
);

ALTER TABLE intentchord.workspace_revision_transitions
  ADD COLUMN IF NOT EXISTS lineage_evidence_json jsonb;
ALTER TABLE intentchord.workspace_revision_transitions
  ALTER COLUMN delta_artifact_id DROP NOT NULL;
ALTER TABLE intentchord.workspace_observations
  ALTER COLUMN canonical_index_artifact_id DROP NOT NULL;
ALTER TABLE intentchord.workspace_observations
  DROP CONSTRAINT IF EXISTS workspace_observations_artifact_shape_ck;
ALTER TABLE intentchord.workspace_observations
  ADD CONSTRAINT workspace_observations_artifact_shape_ck CHECK (
    canonical_index_artifact_id IS NULL OR canonical_index_artifact_id ~ '^cia_[0-9a-f]{64}$'
  );
ALTER TABLE intentchord.workspace_revision_transitions
  ALTER COLUMN lineage_evidence_json SET NOT NULL;
ALTER TABLE intentchord.workspace_revision_transitions
  DROP CONSTRAINT IF EXISTS workspace_revision_transitions_lineage_evidence_ck;
ALTER TABLE intentchord.workspace_revision_transitions
  ADD CONSTRAINT workspace_revision_transitions_lineage_evidence_ck CHECK (
    jsonb_typeof(lineage_evidence_json)='object'
    AND lineage_evidence_json->>'schema'='intentchord.workspace-transition-lineage-evidence/v1'
    AND jsonb_typeof(lineage_evidence_json->'renamed_or_moved')='array'
  );

ALTER TABLE intentchord.workspace_index_snapshots
  ADD COLUMN IF NOT EXISTS workspace_observation_id uuid,
  ADD COLUMN IF NOT EXISTS workspace_revision_id text,
  ADD COLUMN IF NOT EXISTS canonical_index_artifact_id text,
  ADD COLUMN IF NOT EXISTS index_configuration_sha256 text,
  ADD COLUMN IF NOT EXISTS observation_result text,
  ADD COLUMN IF NOT EXISTS delta_artifact_id text,
  -- Backend-resolved authoritative Observation head used as this indexing attempt's predecessor.
  -- It is immutable attempt/chronology evidence, not Canonical Artifact identity.
  ADD COLUMN IF NOT EXISTS scan_base_observation_id uuid,
  -- B1 semantic attempt state is distinct from proven Source Revision / Observation state.
  ADD COLUMN IF NOT EXISTS index_attempt_status text,
  ADD COLUMN IF NOT EXISTS index_attempt_evidence jsonb,
  ADD COLUMN IF NOT EXISTS index_attempt_candidate_json jsonb,
  ADD COLUMN IF NOT EXISTS index_attempt_candidate_sha256 text;

ALTER TABLE intentchord.context_mapping_runs
  ADD COLUMN IF NOT EXISTS canonical_index_artifact_id text,
  ADD COLUMN IF NOT EXISTS artifact_semantic_sha256 text;

ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_b1_artifact_binding_shape_ck;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_b1_artifact_binding_shape_ck CHECK (
    (canonical_index_artifact_id IS NULL AND artifact_semantic_sha256 IS NULL)
    OR
    (
      canonical_index_artifact_id IS NOT NULL
      AND artifact_semantic_sha256 IS NOT NULL
      AND artifact_semantic_sha256 ~ '^sha256:[0-9a-f]{64}$'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='workspace_index_snapshots_observation_fk'
      AND conrelid='intentchord.workspace_index_snapshots'::regclass
  ) THEN
    ALTER TABLE intentchord.workspace_index_snapshots
      ADD CONSTRAINT workspace_index_snapshots_observation_fk
      FOREIGN KEY (workspace_observation_id) REFERENCES intentchord.workspace_observations(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='workspace_index_snapshots_revision_fk'
      AND conrelid='intentchord.workspace_index_snapshots'::regclass
  ) THEN
    ALTER TABLE intentchord.workspace_index_snapshots
      ADD CONSTRAINT workspace_index_snapshots_revision_fk
      FOREIGN KEY (workspace_revision_id) REFERENCES intentchord.workspace_source_revisions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='workspace_index_snapshots_scan_base_same_workspace_fk'
      AND conrelid='intentchord.workspace_index_snapshots'::regclass
  ) THEN
    ALTER TABLE intentchord.workspace_index_snapshots
      ADD CONSTRAINT workspace_index_snapshots_scan_base_same_workspace_fk
      FOREIGN KEY (workspace_registration_id,scan_base_observation_id)
      REFERENCES intentchord.workspace_observations(workspace_registration_id,id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

ALTER TABLE intentchord.workspace_index_snapshots
  DROP CONSTRAINT IF EXISTS workspace_index_snapshots_scan_base_mode_ck;
ALTER TABLE intentchord.workspace_index_snapshots
  ADD CONSTRAINT workspace_index_snapshots_scan_base_mode_ck CHECK (
    scan_base_observation_id IS NULL OR source_mode='REGISTERED_WORKSPACE'
  );

ALTER TABLE intentchord.workspace_index_snapshots
  DROP CONSTRAINT IF EXISTS workspace_index_snapshots_observation_result_ck;
ALTER TABLE intentchord.workspace_index_snapshots
  ADD CONSTRAINT workspace_index_snapshots_observation_result_ck CHECK (
    observation_result IS NULL OR observation_result IN (
      'FIRST_INDEXED',
      'SOURCE_UNCHANGED',
      'SOURCE_CHANGED',
      'KNOWN_STATE_RESTORED',
      'SOURCE_UNCHANGED_INDEX_REFRESHED',
      'SOURCE_PROVEN_INDEX_FAILED'
    )
  );

ALTER TABLE intentchord.workspace_index_snapshots
  DROP CONSTRAINT IF EXISTS workspace_index_snapshots_attempt_status_ck;
ALTER TABLE intentchord.workspace_index_snapshots
  ADD CONSTRAINT workspace_index_snapshots_attempt_status_ck CHECK (
    index_attempt_status IS NULL OR index_attempt_status IN ('IN_PROGRESS','SUCCEEDED','FAILED_RETRYABLE','FAILED')
  );
ALTER TABLE intentchord.workspace_index_snapshots
  DROP CONSTRAINT IF EXISTS workspace_index_snapshots_attempt_hash_ck;
ALTER TABLE intentchord.workspace_index_snapshots
  ADD CONSTRAINT workspace_index_snapshots_attempt_hash_ck CHECK (
    index_attempt_candidate_sha256 IS NULL OR index_attempt_candidate_sha256 ~ '^sha256:[0-9a-f]{64}$'
  );

ALTER TABLE intentchord.workspace_index_snapshots
  DROP CONSTRAINT IF EXISTS workspace_index_snapshots_b1_binding_shape_ck;
ALTER TABLE intentchord.workspace_index_snapshots
  ADD CONSTRAINT workspace_index_snapshots_b1_binding_shape_ck CHECK (
    -- Historical / diagnostic / pre-terminal shape.
    (
      workspace_observation_id IS NULL
      AND workspace_revision_id IS NULL
      AND canonical_index_artifact_id IS NULL
      AND index_configuration_sha256 IS NULL
      AND observation_result IS NULL
      AND delta_artifact_id IS NULL
      AND index_attempt_candidate_json IS NULL
      AND index_attempt_candidate_sha256 IS NULL
    )
    OR
    -- Qualified Registered B1 canonicalization.
    (
      source_mode='REGISTERED_WORKSPACE'
      AND status='READY'
      AND workspace_observation_id IS NOT NULL
      AND workspace_revision_id IS NOT NULL
      AND canonical_index_artifact_id IS NOT NULL
      AND index_configuration_sha256 IS NOT NULL
      AND observation_result IS NOT NULL
      AND observation_result<>'SOURCE_PROVEN_INDEX_FAILED'
      AND index_attempt_status='SUCCEEDED'
      AND index_attempt_candidate_json IS NULL
      AND index_attempt_candidate_sha256 IS NULL
    )
    OR
    -- Proven Source Observation with a retryable semantic Index Attempt failure. No Canonical Artifact is minted.
    (
      source_mode='REGISTERED_WORKSPACE'
      AND status='FAILED'
      AND workspace_observation_id IS NOT NULL
      AND workspace_revision_id IS NOT NULL
      AND canonical_index_artifact_id IS NULL
      AND index_configuration_sha256 IS NOT NULL
      AND observation_result='SOURCE_PROVEN_INDEX_FAILED'
      AND delta_artifact_id IS NULL
      AND index_attempt_status='FAILED_RETRYABLE'
      AND index_attempt_evidence IS NOT NULL
      AND jsonb_typeof(index_attempt_evidence)='object'
      AND index_attempt_candidate_json IS NOT NULL
      AND jsonb_typeof(index_attempt_candidate_json)='object'
      AND index_attempt_candidate_sha256 IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION intentchord.workspace_observation_b1_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot_row intentchord.workspace_index_snapshots%ROWTYPE;
  revision_row intentchord.workspace_source_revisions%ROWTYPE;
  workspace_row intentchord.workspaces%ROWTYPE;
  latest_row intentchord.workspace_observations%ROWTYPE;
  delta_row RECORD;
  revision_seen_before boolean;
  expected_result text;
BEGIN
  SELECT * INTO snapshot_row
  FROM intentchord.workspace_index_snapshots
  WHERE id=NEW.snapshot_operation_id;

  IF NOT FOUND
     OR snapshot_row.source_mode<>'REGISTERED_WORKSPACE'
     OR snapshot_row.status<>'CREATING'
     OR snapshot_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_REGISTERED_CREATING_SNAPSHOT_REQUIRED';
  END IF;

  SELECT * INTO workspace_row
  FROM intentchord.workspaces
  WHERE id=NEW.workspace_registration_id
  FOR UPDATE;
  IF NOT FOUND
     OR workspace_row.reference_type IS DISTINCT FROM 'LOCAL_PATH'
     OR workspace_row.verification_status IS DISTINCT FROM 'VERIFIED'
     OR workspace_row.root_authority_state IS DISTINCT FROM 'VERIFIED_MATCH'
     OR workspace_row.verified_root_device_id IS NULL
     OR workspace_row.verified_root_file_id IS NULL
     OR workspace_row.verified_root_identity_method IS NULL
     OR workspace_row.current_root_device_id IS DISTINCT FROM workspace_row.verified_root_device_id
     OR workspace_row.current_root_file_id IS DISTINCT FROM workspace_row.verified_root_file_id
     OR workspace_row.current_root_identity_method IS DISTINCT FROM workspace_row.verified_root_identity_method
     OR workspace_row.revision IS DISTINCT FROM snapshot_row.workspace_registration_revision
     OR workspace_row.fingerprint IS DISTINCT FROM snapshot_row.workspace_registration_fingerprint
     OR lower(workspace_row.normalized_reference) IS DISTINCT FROM lower(NEW.source_binding_json->>'normalized_reference')
     OR NEW.source_binding_json->>'binding_type' IS DISTINCT FROM 'LOCAL_FILESYSTEM' THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_SOURCE_BINDING_AUTHORITY_MISMATCH';
  END IF;

  SELECT * INTO revision_row
  FROM intentchord.workspace_source_revisions
  WHERE id=NEW.workspace_revision_id;
  IF NOT FOUND
     OR revision_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR revision_row.workspace_instance_id IS DISTINCT FROM NEW.workspace_registration_id::text
     OR revision_row.source_tree_fingerprint IS DISTINCT FROM NEW.source_tree_fingerprint THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_REVISION_BINDING_MISMATCH';
  END IF;

  IF NEW.owner_reference IS DISTINCT FROM snapshot_row.owner_reference THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_OWNER_REFERENCE_MISMATCH';
  END IF;

  SELECT * INTO latest_row
  FROM intentchord.workspace_observations
  WHERE workspace_registration_id=NEW.workspace_registration_id
  ORDER BY authority_sequence DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    IF snapshot_row.scan_base_observation_id IS NOT NULL
       OR NEW.previous_observation_id IS NOT NULL
       OR NEW.delta_artifact_id IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_FIRST_OBSERVATION_CHAIN_VIOLATION';
    END IF;
    IF NEW.observation_result='SOURCE_PROVEN_INDEX_FAILED' THEN
      IF NEW.canonical_index_artifact_id IS NOT NULL THEN
        RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_FAILED_ATTEMPT_ARTIFACT_VIOLATION';
      END IF;
      RETURN NEW;
    END IF;
    expected_result := 'FIRST_INDEXED';
  ELSE
    IF snapshot_row.scan_base_observation_id IS DISTINCT FROM latest_row.id THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_SCAN_BASE_STALE';
    END IF;
    IF NEW.previous_observation_id IS DISTINCT FROM latest_row.id THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_PREVIOUS_OBSERVATION_NOT_CURRENT_HEAD';
    END IF;

    IF NEW.observation_result='SOURCE_PROVEN_INDEX_FAILED' THEN
      IF NEW.canonical_index_artifact_id IS NOT NULL OR NEW.delta_artifact_id IS NOT NULL THEN
        RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_FAILED_ATTEMPT_ARTIFACT_VIOLATION';
      END IF;
      RETURN NEW;
    END IF;

    IF latest_row.canonical_index_artifact_id IS NULL THEN
      IF NEW.delta_artifact_id IS NOT NULL THEN
        RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_DELTA_WITHOUT_PREVIOUS_ARTIFACT';
      END IF;
      IF latest_row.workspace_revision_id = NEW.workspace_revision_id THEN
        expected_result := 'SOURCE_UNCHANGED_INDEX_REFRESHED';
      ELSE
        SELECT EXISTS(
          SELECT 1 FROM intentchord.workspace_observations
          WHERE workspace_registration_id=NEW.workspace_registration_id
            AND workspace_revision_id=NEW.workspace_revision_id
        ) INTO revision_seen_before;
        expected_result := CASE WHEN revision_seen_before THEN 'KNOWN_STATE_RESTORED' ELSE 'SOURCE_CHANGED' END;
      END IF;
    ELSIF latest_row.canonical_index_artifact_id = NEW.canonical_index_artifact_id THEN
      IF NEW.delta_artifact_id IS NOT NULL THEN
        RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_UNCHANGED_ARTIFACT_DELTA_VIOLATION';
      END IF;
      expected_result := 'SOURCE_UNCHANGED';
    ELSE
      IF latest_row.workspace_revision_id = NEW.workspace_revision_id THEN
        expected_result := 'SOURCE_UNCHANGED_INDEX_REFRESHED';
      ELSE
        SELECT EXISTS(
          SELECT 1 FROM intentchord.workspace_observations
          WHERE workspace_registration_id=NEW.workspace_registration_id
            AND workspace_revision_id=NEW.workspace_revision_id
        ) INTO revision_seen_before;
        expected_result := CASE WHEN revision_seen_before THEN 'KNOWN_STATE_RESTORED' ELSE 'SOURCE_CHANGED' END;
      END IF;
    END IF;
  END IF;

  IF NEW.observation_result IS DISTINCT FROM expected_result THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_OBSERVATION_RESULT_MISMATCH:expected=% actual=%', expected_result, NEW.observation_result;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_observations_b1_insert_guard ON intentchord.workspace_observations;
CREATE TRIGGER workspace_observations_b1_insert_guard
BEFORE INSERT ON intentchord.workspace_observations
FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_observation_b1_insert_guard();

CREATE OR REPLACE FUNCTION intentchord.workspace_revision_transition_b1_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  observation_row intentchord.workspace_observations%ROWTYPE;
  previous_row intentchord.workspace_observations%ROWTYPE;
BEGIN
  SELECT * INTO observation_row FROM intentchord.workspace_observations WHERE id=NEW.observation_id;
  IF NOT FOUND
     OR observation_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR observation_row.workspace_revision_id IS DISTINCT FROM NEW.to_workspace_revision_id
     OR observation_row.delta_artifact_id IS DISTINCT FROM NEW.delta_artifact_id
     OR observation_row.previous_observation_id IS NULL
     OR NEW.lineage_evidence_json->>'schema' IS DISTINCT FROM 'intentchord.workspace-transition-lineage-evidence/v1'
     OR jsonb_typeof(NEW.lineage_evidence_json->'renamed_or_moved') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_TRANSITION_OBSERVATION_MISMATCH';
  END IF;

  SELECT * INTO previous_row FROM intentchord.workspace_observations WHERE id=observation_row.previous_observation_id;
  IF NOT FOUND
     OR previous_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR previous_row.workspace_revision_id IS DISTINCT FROM NEW.from_workspace_revision_id THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_TRANSITION_PREVIOUS_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_revision_transitions_b1_insert_guard ON intentchord.workspace_revision_transitions;
CREATE TRIGGER workspace_revision_transitions_b1_insert_guard
BEFORE INSERT ON intentchord.workspace_revision_transitions
FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_revision_transition_b1_insert_guard();

CREATE OR REPLACE FUNCTION intentchord.workspace_index_snapshot_governed_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  observation_row intentchord.workspace_observations%ROWTYPE;
BEGIN
  IF ROW(
    NEW.id,NEW.source_mode,NEW.workspace_registration_id,NEW.workspace_registration_revision,
    NEW.workspace_registration_fingerprint,NEW.project_context_id,NEW.governed_scope,NEW.scan_base_observation_id,
    NEW.snapshot_idempotency_key,NEW.snapshot_request_fingerprint_sha256,
    NEW.owner_reference,NEW.started_at,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.source_mode,OLD.workspace_registration_id,OLD.workspace_registration_revision,
    OLD.workspace_registration_fingerprint,OLD.project_context_id,OLD.governed_scope,OLD.scan_base_observation_id,
    OLD.snapshot_idempotency_key,OLD.snapshot_request_fingerprint_sha256,
    OLD.owner_reference,OLD.started_at,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_IMMUTABLE_BINDING';
  END IF;

  IF OLD.status='CREATING' AND NEW.status='CREATING' THEN
    IF ROW(
      NEW.canonical_contract_version,NEW.canonical_index_json,NEW.canonical_sha256,
      NEW.failure_code,NEW.safe_failure_evidence,NEW.completed_at,
      NEW.workspace_observation_id,NEW.workspace_revision_id,NEW.canonical_index_artifact_id,
      NEW.index_configuration_sha256,NEW.observation_result,NEW.delta_artifact_id,
      NEW.index_attempt_status,NEW.index_attempt_evidence,NEW.index_attempt_candidate_json,NEW.index_attempt_candidate_sha256
    ) IS DISTINCT FROM ROW(
      OLD.canonical_contract_version,OLD.canonical_index_json,OLD.canonical_sha256,
      OLD.failure_code,OLD.safe_failure_evidence,OLD.completed_at,
      OLD.workspace_observation_id,OLD.workspace_revision_id,OLD.canonical_index_artifact_id,
      OLD.index_configuration_sha256,OLD.observation_result,OLD.delta_artifact_id,
      OLD.index_attempt_status,OLD.index_attempt_evidence,OLD.index_attempt_candidate_json,OLD.index_attempt_candidate_sha256
    ) THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_PROGRESS_PAYLOAD_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('READY','FAILED') AND NEW.status=OLD.status
     AND (OLD.progress_phase IS NULL OR OLD.progress_evidence IS NULL OR OLD.heartbeat_at IS NULL) THEN
    IF ROW(
      NEW.canonical_contract_version,NEW.canonical_index_json,NEW.canonical_sha256,
      NEW.failure_code,NEW.safe_failure_evidence,NEW.completed_at,
      NEW.workspace_observation_id,NEW.workspace_revision_id,NEW.canonical_index_artifact_id,
      NEW.index_configuration_sha256,NEW.observation_result,NEW.delta_artifact_id,
      NEW.index_attempt_status,NEW.index_attempt_evidence,NEW.index_attempt_candidate_json,NEW.index_attempt_candidate_sha256
    ) IS DISTINCT FROM ROW(
      OLD.canonical_contract_version,OLD.canonical_index_json,OLD.canonical_sha256,
      OLD.failure_code,OLD.safe_failure_evidence,OLD.completed_at,
      OLD.workspace_observation_id,OLD.workspace_revision_id,OLD.canonical_index_artifact_id,
      OLD.index_configuration_sha256,OLD.observation_result,OLD.delta_artifact_id,
      OLD.index_attempt_status,OLD.index_attempt_evidence,OLD.index_attempt_candidate_json,OLD.index_attempt_candidate_sha256
    )
       OR NEW.progress_phase IS DISTINCT FROM OLD.status
       OR NEW.progress_evidence IS NULL
       OR NEW.heartbeat_at IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TERMINAL_BACKFILL_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status<>'CREATING' OR NEW.status NOT IN ('READY','FAILED') THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TRANSITION_BLOCKED:%->%', OLD.status, NEW.status;
  END IF;

  IF NEW.source_mode='ADVANCED_DIAGNOSTIC' THEN
    IF NEW.scan_base_observation_id IS NOT NULL
       OR NEW.workspace_observation_id IS NOT NULL
       OR NEW.workspace_revision_id IS NOT NULL
       OR NEW.canonical_index_artifact_id IS NOT NULL
       OR NEW.index_configuration_sha256 IS NOT NULL
       OR NEW.observation_result IS NOT NULL
       OR NEW.delta_artifact_id IS NOT NULL
       OR NEW.index_attempt_candidate_json IS NOT NULL
       OR NEW.index_attempt_candidate_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_ADVANCED_DIAGNOSTIC_B1_AUTHORITY_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status='FAILED' AND NEW.observation_result='SOURCE_PROVEN_INDEX_FAILED' THEN
    IF NEW.workspace_observation_id IS NULL
       OR NEW.workspace_revision_id IS NULL
       OR NEW.canonical_index_artifact_id IS NOT NULL
       OR NEW.index_configuration_sha256 IS NULL
       OR NEW.delta_artifact_id IS NOT NULL
       OR NEW.index_attempt_status IS DISTINCT FROM 'FAILED_RETRYABLE'
       OR NEW.index_attempt_evidence IS NULL
       OR NEW.index_attempt_candidate_json IS NULL
       OR NEW.index_attempt_candidate_sha256 IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_PROVEN_SOURCE_FAILED_ATTEMPT_BINDING_REQUIRED';
    END IF;
  ELSIF NEW.status='FAILED' THEN
    IF NEW.workspace_observation_id IS NOT NULL
       OR NEW.workspace_revision_id IS NOT NULL
       OR NEW.canonical_index_artifact_id IS NOT NULL
       OR NEW.index_configuration_sha256 IS NOT NULL
       OR NEW.observation_result IS NOT NULL
       OR NEW.delta_artifact_id IS NOT NULL
       OR NEW.index_attempt_candidate_json IS NOT NULL
       OR NEW.index_attempt_candidate_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_FAILED_SNAPSHOT_BINDING_VIOLATION';
    END IF;
    RETURN NEW;
  ELSE
    IF NEW.workspace_observation_id IS NULL
       OR NEW.workspace_revision_id IS NULL
       OR NEW.canonical_index_artifact_id IS NULL
       OR NEW.index_configuration_sha256 IS NULL
       OR NEW.observation_result IS NULL
       OR NEW.observation_result='SOURCE_PROVEN_INDEX_FAILED'
       OR NEW.index_attempt_status IS DISTINCT FROM 'SUCCEEDED'
       OR NEW.index_attempt_candidate_json IS NOT NULL
       OR NEW.index_attempt_candidate_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_REGISTERED_TERMINAL_BINDING_REQUIRED';
    END IF;
  END IF;

  SELECT * INTO observation_row
  FROM intentchord.workspace_observations
  WHERE id=NEW.workspace_observation_id;
  IF NOT FOUND
     OR observation_row.snapshot_operation_id IS DISTINCT FROM NEW.id
     OR observation_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR observation_row.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
     OR observation_row.canonical_index_artifact_id IS DISTINCT FROM NEW.canonical_index_artifact_id
     OR observation_row.index_configuration_sha256 IS DISTINCT FROM NEW.index_configuration_sha256
     OR observation_row.observation_result IS DISTINCT FROM NEW.observation_result
     OR observation_row.delta_artifact_id IS DISTINCT FROM NEW.delta_artifact_id THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_REGISTERED_TERMINAL_BINDING_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.workspace_b1_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_APPEND_ONLY:%', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS workspace_source_revisions_append_only_update ON intentchord.workspace_source_revisions;
CREATE TRIGGER workspace_source_revisions_append_only_update
BEFORE UPDATE OR DELETE ON intentchord.workspace_source_revisions
FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_b1_append_only();

DROP TRIGGER IF EXISTS workspace_observations_append_only_update ON intentchord.workspace_observations;
CREATE TRIGGER workspace_observations_append_only_update
BEFORE UPDATE OR DELETE ON intentchord.workspace_observations
FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_b1_append_only();

DROP TRIGGER IF EXISTS workspace_revision_transitions_append_only_update ON intentchord.workspace_revision_transitions;
CREATE TRIGGER workspace_revision_transitions_append_only_update
BEFORE UPDATE OR DELETE ON intentchord.workspace_revision_transitions
FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_b1_append_only();

-- B1 v0.3 Context Mapping authority: historical/diagnostic V1 remains canonical_sha256-bound;
-- new Registered Workspace B1 Snapshots are artifact_semantic_sha256-bound and cannot choose authority from browser payload.
CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_insert_snapshot_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot_row intentchord.workspace_index_snapshots%ROWTYPE;
  artifact_row RECORD;
  is_registered_b1 boolean := false;
BEGIN
  IF NEW.workspace_index_snapshot_id IS NULL
     OR NEW.mapping_idempotency_key IS NULL
     OR btrim(NEW.mapping_idempotency_key)=''
     OR NEW.mapping_request_fingerprint_sha256 IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED';
  END IF;

  SELECT * INTO snapshot_row
  FROM intentchord.workspace_index_snapshots
  WHERE id=NEW.workspace_index_snapshot_id;

  IF NOT FOUND OR snapshot_row.status<>'READY' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_READY_SNAPSHOT_REQUIRED';
  END IF;

  IF snapshot_row.source_mode='REGISTERED_WORKSPACE' AND snapshot_row.canonical_index_artifact_id IS NOT NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_B1_ARTIFACT_BINDING_REQUIRED';
  ELSE
    -- Historical pre-B1 REGISTERED_WORKSPACE and ADVANCED_DIAGNOSTIC retain the governed V1 path.
    IF NEW.canonical_index_artifact_id IS NOT NULL
       OR NEW.artifact_semantic_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_LEGACY_ARTIFACT_AUTHORITY_VIOLATION';
    END IF;
    IF NEW.workspace_index_sha256 IS DISTINCT FROM snapshot_row.canonical_sha256 THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_HASH_MISMATCH';
    END IF;
    IF NEW.mapping_input_snapshot->>'mapping_input_schema_version' IS DISTINCT FROM 'intentchord.ai-context-mapping-input.v1' THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_LEGACY_INPUT_VERSION_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_governed_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean := false;
  total_contexts integer;
  accepted_contexts integer;
  rejected_contexts integer;
BEGIN
  IF ROW(
    NEW.mapping_input_snapshot_id, NEW.mapping_input_sha256, NEW.mapping_input_snapshot,
    NEW.workspace_index_contract_version, NEW.workspace_snapshot_id, NEW.workspace_index_sha256,
    NEW.canonical_index_artifact_id, NEW.artifact_semantic_sha256,
    NEW.eligible_entry_count, NEW.excluded_entry_count, NEW.provider_neutral_estimated_tokens,
    NEW.primary_provider_id, NEW.primary_channel_id, NEW.primary_model_id,
    NEW.standby_provider_id, NEW.standby_channel_id, NEW.standby_model_id,
    NEW.standby_enabled, NEW.standby_governance_state, NEW.provider_configuration_snapshot,
    NEW.workspace_index_snapshot_id,NEW.mapping_idempotency_key,NEW.mapping_request_fingerprint_sha256,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.mapping_input_snapshot_id, OLD.mapping_input_sha256, OLD.mapping_input_snapshot,
    OLD.workspace_index_contract_version, OLD.workspace_snapshot_id, OLD.workspace_index_sha256,
    OLD.canonical_index_artifact_id, OLD.artifact_semantic_sha256,
    OLD.eligible_entry_count, OLD.excluded_entry_count, OLD.provider_neutral_estimated_tokens,
    OLD.primary_provider_id, OLD.primary_channel_id, OLD.primary_model_id,
    OLD.standby_provider_id, OLD.standby_channel_id, OLD.standby_model_id,
    OLD.standby_enabled, OLD.standby_governance_state, OLD.provider_configuration_snapshot,
    OLD.workspace_index_snapshot_id,OLD.mapping_idempotency_key,OLD.mapping_request_fingerprint_sha256,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_RUN_IMMUTABLE_BINDING';
  END IF;

  IF NEW.status = OLD.status THEN allowed := true;
  ELSIF OLD.status='CREATED' AND NEW.status='INPUT_VALIDATED' THEN allowed := true;
  ELSIF OLD.status='INPUT_VALIDATED' AND NEW.status='PRIMARY_RUNNING' THEN allowed := true;
  ELSIF OLD.status='PRIMARY_RUNNING' AND NEW.status IN ('VALIDATING','PRIMARY_FAILED_TECHNICAL','FAILED') THEN allowed := true;
  ELSIF OLD.status='PRIMARY_FAILED_TECHNICAL' AND NEW.status IN ('STANDBY_BLOCKED_GOVERNANCE','STANDBY_RUNNING') THEN allowed := true;
  ELSIF OLD.status='STANDBY_RUNNING' AND NEW.status IN ('VALIDATING','FAILED') THEN allowed := true;
  ELSIF OLD.status='VALIDATING' AND NEW.status IN ('AWAITING_OWNER_REVIEW','REJECTED_VALIDATION','FAILED') THEN allowed := true;
  ELSIF OLD.status='AWAITING_OWNER_REVIEW' AND NEW.status IN ('OWNER_ACCEPTED','OWNER_REJECTED') THEN allowed := true;
  END IF;
  IF NOT allowed THEN
    RAISE EXCEPTION 'AI_CONTEXT_MAPPING_RUN_TRANSITION_BLOCKED:%->%', OLD.status, NEW.status;
  END IF;

  IF OLD.final_attempt_id IS NOT NULL AND NEW.final_attempt_id IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_CANNOT_CLEAR';
  END IF;
  IF NEW.final_attempt_id IS NOT NULL AND NEW.final_attempt_id IS DISTINCT FROM OLD.final_attempt_id THEN
    IF OLD.final_attempt_id IS NOT NULL AND NOT (
      OLD.status IN ('STANDBY_RUNNING','VALIDATING')
      AND EXISTS (
        SELECT 1 FROM intentchord.context_mapping_attempts
        WHERE id=NEW.final_attempt_id AND mapping_run_id=NEW.id
          AND attempt_ordinal=2 AND status<>'RUNNING'
      )
    ) THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_REPLACEMENT_BLOCKED';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM intentchord.context_mapping_attempts
      WHERE id=NEW.final_attempt_id AND mapping_run_id=NEW.id AND status<>'RUNNING'
    ) THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_NOT_COMPLETED';
    END IF;
  END IF;

  IF NEW.status IN ('PRIMARY_FAILED_TECHNICAL','STANDBY_BLOCKED_GOVERNANCE','REJECTED_VALIDATION','FAILED','AWAITING_OWNER_REVIEW','OWNER_ACCEPTED','OWNER_REJECTED')
     AND NEW.final_attempt_id IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_REQUIRED';
  END IF;

  IF NEW.status='AWAITING_OWNER_REVIEW' AND NOT EXISTS (
    SELECT 1 FROM intentchord.context_catalog_proposals
    WHERE mapping_run_id=NEW.id AND source_attempt_id=NEW.final_attempt_id
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_VALIDATED_PROPOSAL_REQUIRED';
  END IF;

  IF NEW.status='OWNER_ACCEPTED' AND NEW.owner_verdict_state<>'ACCEPTED' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_STATE_MISMATCH';
  ELSIF NEW.status='OWNER_REJECTED' AND NEW.owner_verdict_state<>'REJECTED' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_STATE_MISMATCH';
  ELSIF NEW.status NOT IN ('OWNER_ACCEPTED','OWNER_REJECTED') AND NEW.owner_verdict_state<>'PENDING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_STATE_PREMATURE';
  END IF;

  IF NEW.status IN ('OWNER_ACCEPTED','OWNER_REJECTED') THEN
    IF NOT EXISTS (
      SELECT 1 FROM intentchord.context_mapping_owner_verdicts
      WHERE mapping_run_id=NEW.id
        AND verdict=CASE WHEN NEW.status='OWNER_ACCEPTED' THEN 'ACCEPT' ELSE 'REJECT' END
    ) THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_VERDICT_RECORD_REQUIRED';
    END IF;

    SELECT jsonb_array_length(proposal_json->'contexts') INTO total_contexts
    FROM intentchord.context_catalog_proposals WHERE mapping_run_id=NEW.id;
    SELECT
      count(*) FILTER (WHERE decision='ACCEPT'),
      count(*) FILTER (WHERE decision='REJECT')
    INTO accepted_contexts,rejected_contexts
    FROM intentchord.context_mapping_owner_context_decisions WHERE mapping_run_id=NEW.id;

    IF total_contexts IS NULL OR accepted_contexts+rejected_contexts<>total_contexts THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_INCOMPLETE';
    END IF;
    IF NEW.status='OWNER_ACCEPTED' AND accepted_contexts<1 THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_STATE_CONFLICT';
    END IF;
    IF NEW.status='OWNER_REJECTED' AND (accepted_contexts<>0 OR rejected_contexts<>total_contexts) THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_STATE_CONFLICT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

