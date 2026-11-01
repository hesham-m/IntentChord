-- IntentChord Sectioned Evidence / Incremental Workspace (SPEC V3 20260826-033058, Section 13).\r\n-- Additive after 014. Historical V1 rows remain readable and immutable.\r\n-- Materially identical to the machine-validated candidate\r\n--   IntentChord_MIGRATION_015_V3_VALIDATION_CANDIDATE_20260826-033058.sql\r\n-- (validation report: ..._FINAL_SPEC_V3_EXECUTABLE_VALIDATION_20260826-033058.txt).\r\n\r\n-- 13.1 T1 ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_artifacts (
  id text PRIMARY KEY CHECK (id ~ '^wea_[0-9a-f]{64}$'),
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  workspace_revision_id text NOT NULL,
  index_configuration_sha256 text NOT NULL CHECK (index_configuration_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  artifact_schema_version text NOT NULL DEFAULT 'intentchord.workspace-evidence-artifact/v2',
  header_json jsonb NOT NULL CHECK (jsonb_typeof(header_json)='object' AND octet_length(header_json::text)<=65536),
  section_manifest_json jsonb NOT NULL CHECK (jsonb_typeof(section_manifest_json)='array' AND octet_length(section_manifest_json::text)<=16384),
  section_manifest_digest text NOT NULL CHECK (section_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  artifact_manifest_sha256 text NOT NULL CHECK (artifact_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  artifact_semantic_sha256 text NOT NULL CHECK (artifact_semantic_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  canonical_compat_sha256 text NOT NULL CHECK (canonical_compat_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  engine_mode text NOT NULL DEFAULT 'V2_SECTIONED' CHECK (engine_mode='V2_SECTIONED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT wea_rev_cfg_uq UNIQUE (workspace_revision_id, index_configuration_sha256),
  CONSTRAINT wea_reg_rev_cfg_uq UNIQUE (workspace_registration_id, workspace_revision_id, index_configuration_sha256),
  CONSTRAINT wea_reg_id_uq UNIQUE (workspace_registration_id, id),
  CONSTRAINT wea_reg_rev_fk FOREIGN KEY (workspace_registration_id, workspace_revision_id)
    REFERENCES intentchord.workspace_source_revisions(workspace_registration_id, id) ON DELETE RESTRICT
);

-- Pre-launch V2 Rebase: Bind context_assembly_sources directly to workspace_evidence_artifacts
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='context_assembly_sources_wea_fk' AND conrelid='intentchord.context_assembly_sources'::regclass) THEN
    ALTER TABLE intentchord.context_assembly_sources
      ADD CONSTRAINT context_assembly_sources_wea_fk
      FOREIGN KEY (workspace_registration_id, accepted_workspace_evidence_artifact_id)
      REFERENCES intentchord.workspace_evidence_artifacts(workspace_registration_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- Pre-launch V2 Rebase: Replace context_assembly_source_insert_guard with strict V2 WEA validation
CREATE OR REPLACE FUNCTION intentchord.context_assembly_source_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s intentchord.workspace_index_snapshots%ROWTYPE;
  w intentchord.workspaces%ROWTYPE;
  wea intentchord.workspace_evidence_artifacts%ROWTYPE;
BEGIN
  SELECT * INTO w FROM intentchord.workspaces WHERE id=NEW.workspace_registration_id;
  IF NOT FOUND OR w.revision IS DISTINCT FROM NEW.workspace_registration_revision OR w.fingerprint IS DISTINCT FROM NEW.workspace_registration_fingerprint THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_WORKSPACE_REGISTRATION_BINDING_MISMATCH';
  END IF;

  SELECT * INTO s FROM intentchord.workspace_index_snapshots WHERE id=NEW.workspace_index_snapshot_id;
  IF NOT FOUND OR s.status<>'READY' OR s.source_mode<>'REGISTERED_WORKSPACE'
     OR s.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR s.workspace_registration_revision IS DISTINCT FROM NEW.workspace_registration_revision
     OR s.workspace_registration_fingerprint IS DISTINCT FROM NEW.workspace_registration_fingerprint
     OR s.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
     OR s.accepted_workspace_evidence_artifact_id IS DISTINCT FROM NEW.accepted_workspace_evidence_artifact_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_READY_INDEX_BINDING_REQUIRED';
  END IF;

  SELECT * INTO wea FROM intentchord.workspace_evidence_artifacts WHERE id=NEW.accepted_workspace_evidence_artifact_id;
  IF NOT FOUND
     OR wea.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR wea.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
     OR wea.artifact_semantic_sha256 IS DISTINCT FROM NEW.artifact_semantic_sha256
     OR wea.artifact_semantic_sha256 IS DISTINCT FROM NEW.workspace_index_sha256
     OR wea.engine_mode IS DISTINCT FROM 'V2_SECTIONED' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_WEA_ARTIFACT_BINDING_MISMATCH';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS context_assembly_sources_insert_guard ON intentchord.context_assembly_sources;
CREATE TRIGGER context_assembly_sources_insert_guard BEFORE INSERT ON intentchord.context_assembly_sources
FOR EACH ROW EXECUTE FUNCTION intentchord.context_assembly_source_insert_guard();

-- 13.2 T2 ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_sections (
  id bigserial PRIMARY KEY,
  workspace_registration_id uuid NOT NULL,
  artifact_id text NOT NULL,
  section_type text NOT NULL CHECK (section_type IN ('FILES','FACTS','RELATIONS','CONTENT_REFERENCES','FAILURES','SEMANTIC_PROJECTION','CONTINUITY_ATTESTATION','DERIVATION_ATTESTATION','DELTA_LINEAGE')),
  section_order integer NOT NULL CHECK (section_order BETWEEN 1 AND 9),
  section_schema_version text NOT NULL,
  section_digest text NOT NULL CHECK (section_digest ~ '^sha256:[0-9a-f]{64}$'),
  record_count integer NOT NULL CHECK (record_count>=0),
  segment_count integer NOT NULL CHECK (segment_count>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT wes_artifact_type_uq UNIQUE (artifact_id, section_type),
  CONSTRAINT wes_artifact_order_uq UNIQUE (artifact_id, section_order),
  CONSTRAINT wes_reg_type_key_uq UNIQUE (workspace_registration_id, id, artifact_id, section_type),
  CONSTRAINT wes_reg_id_uq UNIQUE (workspace_registration_id, id),
  CONSTRAINT wes_reg_artifact_fk FOREIGN KEY (workspace_registration_id, artifact_id)
    REFERENCES intentchord.workspace_evidence_artifacts(workspace_registration_id, id) ON DELETE RESTRICT
);

-- 13.3 T3 ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_section_records (
  workspace_registration_id uuid NOT NULL,
  artifact_id text NOT NULL,
  section_id bigint NOT NULL,
  section_type text NOT NULL CHECK (section_type IN ('FILES','FACTS','RELATIONS','CONTENT_REFERENCES','FAILURES','SEMANTIC_PROJECTION','CONTINUITY_ATTESTATION','DERIVATION_ATTESTATION','DELTA_LINEAGE')),
  record_seq integer NOT NULL CHECK (record_seq>=1),
  record_id text NOT NULL,
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_file_revision_id text NULL,
  record_json jsonb NOT NULL CHECK (octet_length(record_json::text)<=262144),
  CONSTRAINT wer_pk PRIMARY KEY (section_id, record_seq),
  CONSTRAINT wer_section_record_uq UNIQUE (section_id, record_id),
  CONSTRAINT wer_owner_ck CHECK (source_file_revision_id IS NOT NULL OR section_type NOT IN ('FACTS','RELATIONS')),
  CONSTRAINT wer_section_coherence_fk FOREIGN KEY (workspace_registration_id, section_id, artifact_id, section_type)
    REFERENCES intentchord.workspace_evidence_sections(workspace_registration_id, id, artifact_id, section_type) ON DELETE RESTRICT,
  CONSTRAINT wer_artifact_fk FOREIGN KEY (workspace_registration_id, artifact_id)
    REFERENCES intentchord.workspace_evidence_artifacts(workspace_registration_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS wer_source_file_idx ON intentchord.workspace_evidence_section_records(source_file_revision_id) WHERE source_file_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wer_artifact_idx ON intentchord.workspace_evidence_section_records(artifact_id);

-- 13.4 T4 + T7 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_segments (
  section_id bigint NOT NULL,
  segment_seq integer NOT NULL CHECK (segment_seq>=1),
  record_count integer NOT NULL CHECK (record_count BETWEEN 1 AND 512),
  first_record_seq integer NOT NULL CHECK (first_record_seq>=1),
  last_record_seq integer NOT NULL,
  segment_digest text NOT NULL CHECK (segment_digest ~ '^sha256:[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size>=0),
  CONSTRAINT wseg_pk PRIMARY KEY (section_id, segment_seq),
  CONSTRAINT wseg_span_ck CHECK (last_record_seq-first_record_seq+1=record_count),
  CONSTRAINT wseg_section_fk FOREIGN KEY (section_id) REFERENCES intentchord.workspace_evidence_sections(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS intentchord.workspace_file_object_identity_index (
  workspace_registration_id uuid NOT NULL,
  workspace_revision_id text NOT NULL,
  workspace_file_id text NOT NULL,
  relative_path text NOT NULL,
  prior_relative_path text,
  device_id text NOT NULL,
  volume_identity jsonb,
  object_file_id text NOT NULL,
  object_sequence bigint,
  proof_method text NOT NULL CHECK (proof_method IN ('NODE_BIGINT_DEV_INO_V1','WINDOWS_FILE_ID_128_V1')),
  provider_class text NOT NULL CHECK (provider_class IN ('STRONG_CONTINUITY_PROVIDER','METADATA_ONLY_PROVIDER','NO_CONTINUITY_PROVIDER')),
  lineage_state text NOT NULL CHECK (lineage_state IN ('NEW','CONTINUED','RENAMED_OR_MOVED','UNPROVEN')),
  move_proof text CHECK (move_proof IN ('USN_RENAME_PAIR_PROVEN','GIT_RENAME_HINT_PROVEN')),
  CONSTRAINT wsfoi_pk PRIMARY KEY (workspace_revision_id, workspace_file_id),
  CONSTRAINT wsfoi_path_uq UNIQUE (workspace_revision_id, relative_path),
  CONSTRAINT wsfoi_move_ck CHECK ((lineage_state='RENAMED_OR_MOVED') = (move_proof IS NOT NULL)),
  CONSTRAINT wsfoi_rev_fk FOREIGN KEY (workspace_registration_id, workspace_revision_id)
    REFERENCES intentchord.workspace_source_revisions(workspace_registration_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_wsfileobj_lookup ON intentchord.workspace_file_object_identity_index(workspace_registration_id, device_id, object_file_id, object_sequence);
CREATE INDEX IF NOT EXISTS idx_wsfileobj_rev ON intentchord.workspace_file_object_identity_index(workspace_registration_id, workspace_revision_id);

-- 13.10 TS1/TS2 (attempt identity = snapshot_operation_id; US-1) -------------------
CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_staging_records (
  snapshot_operation_id uuid NOT NULL REFERENCES intentchord.workspace_index_snapshots(id) ON DELETE CASCADE,
  section_type text NOT NULL CHECK (section_type IN ('FILES','FACTS','RELATIONS','CONTENT_REFERENCES','FAILURES','SEMANTIC_PROJECTION','CONTINUITY_ATTESTATION','DERIVATION_ATTESTATION','DELTA_LINEAGE')),
  record_seq integer NOT NULL CHECK (record_seq>=1),
  record_id text NOT NULL,
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_file_revision_id text NULL,
  record_json jsonb NOT NULL CHECK (octet_length(record_json::text)<=262144),
  CONSTRAINT wstg_r_pk PRIMARY KEY (snapshot_operation_id, section_type, record_seq),
  CONSTRAINT wstg_r_id_uq UNIQUE (snapshot_operation_id, section_type, record_id)
);
CREATE INDEX IF NOT EXISTS wstg_r_snap_idx ON intentchord.workspace_evidence_staging_records(snapshot_operation_id);

CREATE TABLE IF NOT EXISTS intentchord.workspace_evidence_staging_segments (
  snapshot_operation_id uuid NOT NULL REFERENCES intentchord.workspace_index_snapshots(id) ON DELETE CASCADE,
  section_type text NOT NULL CHECK (section_type IN ('FILES','FACTS','RELATIONS','CONTENT_REFERENCES','FAILURES','SEMANTIC_PROJECTION','CONTINUITY_ATTESTATION','DERIVATION_ATTESTATION','DELTA_LINEAGE')),
  segment_seq integer NOT NULL CHECK (segment_seq>=1),
  record_count integer NOT NULL CHECK (record_count BETWEEN 1 AND 512),
  first_record_seq integer NOT NULL,
  last_record_seq integer NOT NULL,
  segment_digest text NOT NULL CHECK (segment_digest ~ '^sha256:[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size>=0),
  CONSTRAINT wstg_s_pk PRIMARY KEY (snapshot_operation_id, section_type, segment_seq),
  CONSTRAINT wstg_s_span_ck CHECK (last_record_seq-first_record_seq+1=record_count)
);

CREATE TABLE IF NOT EXISTS intentchord.workspace_ingestion_progress (
  snapshot_operation_id uuid PRIMARY KEY REFERENCES intentchord.workspace_index_snapshots(id) ON DELETE CASCADE,
  phase text NOT NULL,
  counters_json jsonb NOT NULL CHECK (octet_length(counters_json::text)<=8192),
  heartbeat_at timestamptz NOT NULL,
  update_seq integer NOT NULL DEFAULT 0
);

-- 13.5 T5 + lifecycle guard (PB-1 TEXT refs; PB-5 rule B2) -------------------------
CREATE TABLE IF NOT EXISTS intentchord.workspace_source_continuity_attestations (
  id text PRIMARY KEY CHECK (id ~ '^wca_[0-9a-f]{64}$'),
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  provider_class text NOT NULL CHECK (provider_class IN ('STRONG_CONTINUITY_PROVIDER','METADATA_ONLY_PROVIDER','NO_CONTINUITY_PROVIDER')),
  provider_id text NOT NULL CHECK (provider_id IN ('WINDOWS_NTFS_USN_V1','GENERIC_METADATA_V1','NONE_V1')),
  claim_type text NOT NULL CHECK (claim_type IN ('SEALED_INTERVAL','ROLLING_EXACT_FILE_MANIFEST')),
  volume_identity_json jsonb NOT NULL CHECK (jsonb_typeof(volume_identity_json)='object'),
  journal_identity_json jsonb CHECK (journal_identity_json IS NULL OR jsonb_typeof(journal_identity_json)='object'),
  previous_trusted_boundary_usn bigint,
  opened_boundary_usn bigint NOT NULL,
  closed_boundary_usn bigint,
  bootstrap boolean NOT NULL DEFAULT false,
  reconciliation_passes integer NOT NULL DEFAULT 0 CHECK (reconciliation_passes BETWEEN 0 AND 2),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  continuity_evidence_json jsonb NOT NULL CHECK (jsonb_typeof(continuity_evidence_json)='object' AND octet_length(continuity_evidence_json::text)<=1048576),
  attestation_state text NOT NULL DEFAULT 'OPEN' CHECK (attestation_state IN ('OPEN','RECONCILING','SEALED','VOID')),
  void_reason text,
  attestation_sha256 text CHECK (attestation_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_operation_id uuid NOT NULL UNIQUE REFERENCES intentchord.workspace_index_snapshots(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT wca_provider_shape_ck CHECK (
    (provider_class='STRONG_CONTINUITY_PROVIDER' AND provider_id='WINDOWS_NTFS_USN_V1' AND journal_identity_json IS NOT NULL)
    OR (provider_class='METADATA_ONLY_PROVIDER' AND provider_id='GENERIC_METADATA_V1')
    OR (provider_class='NO_CONTINUITY_PROVIDER' AND provider_id='NONE_V1')),
  CONSTRAINT wca_no_false_boundary_ck CHECK (provider_class='STRONG_CONTINUITY_PROVIDER' OR closed_boundary_usn IS NULL),
  CONSTRAINT wca_sealed_shape_ck CHECK (attestation_state<>'SEALED' OR ((claim_type<>'SEALED_INTERVAL' OR closed_boundary_usn IS NOT NULL) AND attestation_sha256 IS NOT NULL)),
  CONSTRAINT wca_void_reason_ck CHECK (attestation_state<>'VOID' OR void_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS wca_reg_created_idx ON intentchord.workspace_source_continuity_attestations(workspace_registration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wca_sealed_idx ON intentchord.workspace_source_continuity_attestations(workspace_registration_id) WHERE attestation_state='SEALED';

CREATE OR REPLACE FUNCTION intentchord.wca_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $wca_guard$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INTENTCHORD_WCA_APPEND_ONLY'; END IF;
  IF OLD.attestation_state IN ('OPEN','RECONCILING') THEN
    IF ROW(NEW.id,NEW.workspace_registration_id,NEW.provider_class,NEW.provider_id,NEW.claim_type,
           NEW.volume_identity_json,NEW.journal_identity_json,NEW.previous_trusted_boundary_usn,
           NEW.opened_boundary_usn,NEW.bootstrap,NEW.policy_hash,NEW.snapshot_operation_id,
           NEW.observation_id,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.workspace_registration_id,OLD.provider_class,OLD.provider_id,OLD.claim_type,
           OLD.volume_identity_json,OLD.journal_identity_json,OLD.previous_trusted_boundary_usn,
           OLD.opened_boundary_usn,OLD.bootstrap,OLD.policy_hash,OLD.snapshot_operation_id,
           OLD.observation_id,OLD.created_at) THEN
      RAISE EXCEPTION 'INTENTCHORD_WCA_IMMUTABLE_BINDING:%', OLD.attestation_state;
    END IF;
    IF OLD.attestation_state='OPEN' AND NEW.attestation_state IN ('RECONCILING','VOID') THEN RETURN NEW; END IF;
    IF OLD.attestation_state='RECONCILING' AND NEW.attestation_state IN ('RECONCILING','SEALED','VOID') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'INTENTCHORD_WCA_TRANSITION_BLOCKED:%->%', OLD.attestation_state, NEW.attestation_state;
  END IF;
  IF OLD.attestation_state='SEALED' THEN
    -- B1 set-once observation link
    IF NEW.attestation_state='SEALED' AND OLD.observation_id IS NULL AND NEW.observation_id IS NOT NULL
       AND ROW(NEW.id,NEW.workspace_registration_id,NEW.provider_class,NEW.provider_id,NEW.claim_type,
               NEW.volume_identity_json,NEW.journal_identity_json,NEW.previous_trusted_boundary_usn,
               NEW.opened_boundary_usn,NEW.closed_boundary_usn,NEW.bootstrap,NEW.reconciliation_passes,
               NEW.policy_hash,NEW.continuity_evidence_json,NEW.void_reason,NEW.attestation_sha256,
               NEW.snapshot_operation_id,NEW.created_at)
          IS NOT DISTINCT FROM
          ROW(OLD.id,OLD.workspace_registration_id,OLD.provider_class,OLD.provider_id,OLD.claim_type,
              OLD.volume_identity_json,OLD.journal_identity_json,OLD.previous_trusted_boundary_usn,
              OLD.opened_boundary_usn,OLD.closed_boundary_usn,OLD.bootstrap,OLD.reconciliation_passes,
              OLD.policy_hash,OLD.continuity_evidence_json,OLD.void_reason,OLD.attestation_sha256,
              OLD.snapshot_operation_id,OLD.created_at) THEN
      RETURN NEW;
    END IF;
    -- B2 PB-5 RULE: maintenance invalidation of UNLINKED sealed evidence ONLY
    IF NEW.attestation_state='VOID' AND OLD.observation_id IS NULL AND NEW.observation_id IS NULL
       AND NEW.void_reason='UNLINKED'
       AND ROW(NEW.id,NEW.workspace_registration_id,NEW.provider_class,NEW.provider_id,NEW.claim_type,
               NEW.volume_identity_json,NEW.journal_identity_json,NEW.previous_trusted_boundary_usn,
               NEW.opened_boundary_usn,NEW.closed_boundary_usn,NEW.bootstrap,NEW.reconciliation_passes,
               NEW.policy_hash,NEW.continuity_evidence_json,NEW.attestation_sha256,
               NEW.snapshot_operation_id,NEW.observation_id,NEW.created_at)
          IS NOT DISTINCT FROM
          ROW(OLD.id,OLD.workspace_registration_id,OLD.provider_class,OLD.provider_id,OLD.claim_type,
              OLD.volume_identity_json,OLD.journal_identity_json,OLD.previous_trusted_boundary_usn,
              OLD.opened_boundary_usn,OLD.closed_boundary_usn,OLD.bootstrap,OLD.reconciliation_passes,
              OLD.policy_hash,OLD.continuity_evidence_json,OLD.attestation_sha256,
              OLD.snapshot_operation_id,OLD.observation_id,OLD.created_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'INTENTCHORD_WCA_TRANSITION_BLOCKED:SEALED->%', NEW.attestation_state;
  END IF;
  RAISE EXCEPTION 'INTENTCHORD_WCA_TRANSITION_BLOCKED:%->%', OLD.attestation_state, NEW.attestation_state;
END;
$wca_guard$;
DROP TRIGGER IF EXISTS wca_z_guard_update ON intentchord.workspace_source_continuity_attestations;
CREATE TRIGGER wca_z_guard_update BEFORE UPDATE ON intentchord.workspace_source_continuity_attestations FOR EACH ROW EXECUTE FUNCTION intentchord.wca_transition_guard();
DROP TRIGGER IF EXISTS wca_z_guard_delete ON intentchord.workspace_source_continuity_attestations;
CREATE TRIGGER wca_z_guard_delete BEFORE DELETE ON intentchord.workspace_source_continuity_attestations FOR EACH ROW EXECUTE FUNCTION intentchord.wca_transition_guard();

-- 13.6 observations ---------------------------------------------------------------
ALTER TABLE intentchord.workspace_observations
  ADD COLUMN IF NOT EXISTS accepted_workspace_evidence_artifact_id text,
  ADD COLUMN IF NOT EXISTS source_continuity_attestation_id text,
  ADD COLUMN IF NOT EXISTS observation_protocol_json jsonb;
ALTER TABLE intentchord.workspace_observations DROP CONSTRAINT IF EXISTS wo_protocol_bound_ck;
ALTER TABLE intentchord.workspace_observations ADD CONSTRAINT wo_protocol_bound_ck CHECK (
  observation_protocol_json IS NULL OR (jsonb_typeof(observation_protocol_json)='object' AND octet_length(observation_protocol_json::text)<=65536));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wo_wea_fk' AND conrelid='intentchord.workspace_observations'::regclass) THEN
    ALTER TABLE intentchord.workspace_observations ADD CONSTRAINT wo_wea_fk FOREIGN KEY (accepted_workspace_evidence_artifact_id) REFERENCES intentchord.workspace_evidence_artifacts(id) ON DELETE RESTRICT;
  END IF;
END $$;
ALTER TABLE intentchord.workspace_source_continuity_attestations ADD COLUMN IF NOT EXISTS observation_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wo_wca_fk' AND conrelid='intentchord.workspace_observations'::regclass) THEN
    ALTER TABLE intentchord.workspace_observations ADD CONSTRAINT wo_wca_fk FOREIGN KEY (source_continuity_attestation_id) REFERENCES intentchord.workspace_source_continuity_attestations(id) ON DELETE RESTRICT;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wca_observation_fk' AND conrelid='intentchord.workspace_source_continuity_attestations'::regclass) THEN
    ALTER TABLE intentchord.workspace_source_continuity_attestations ADD CONSTRAINT wca_observation_fk FOREIGN KEY (observation_id) REFERENCES intentchord.workspace_observations(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE intentchord.workspace_observations DROP CONSTRAINT IF EXISTS workspace_observations_artifact_shape_ck;
ALTER TABLE intentchord.workspace_observations ADD CONSTRAINT workspace_observations_artifact_shape_ck CHECK (
  ( observation_result='SOURCE_PROVEN_INDEX_FAILED'
    AND accepted_workspace_evidence_artifact_id IS NULL )
  OR
  ( observation_result<>'SOURCE_PROVEN_INDEX_FAILED'
    AND accepted_workspace_evidence_artifact_id IS NOT NULL ));

-- 13.6.5 COMPLETE REPLACEMENT of the migration-012 observation B1 insert guard (V2 ONLY) -------
CREATE OR REPLACE FUNCTION intentchord.workspace_observation_b1_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $obs_guard$
DECLARE
  snapshot_row intentchord.workspace_index_snapshots%ROWTYPE;
  workspace_row intentchord.workspaces%ROWTYPE;
  revision_row intentchord.workspace_source_revisions%ROWTYPE;
  latest_row intentchord.workspace_observations%ROWTYPE;
  wea_row intentchord.workspace_evidence_artifacts%ROWTYPE;
  att_row intentchord.workspace_source_continuity_attestations%ROWTYPE;
  revision_seen_before boolean;
  expected_result text;
  is_v2 boolean;
BEGIN
  SELECT * INTO snapshot_row FROM intentchord.workspace_index_snapshots WHERE id=NEW.snapshot_operation_id;
  IF NOT FOUND OR snapshot_row.source_mode<>'REGISTERED_WORKSPACE' OR snapshot_row.status<>'CREATING'
     OR snapshot_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_REGISTERED_CREATING_SNAPSHOT_REQUIRED';
  END IF;

  SELECT * INTO workspace_row FROM intentchord.workspaces WHERE id=NEW.workspace_registration_id FOR UPDATE;
  IF NOT FOUND
     OR workspace_row.reference_type IS DISTINCT FROM 'LOCAL_PATH'
     OR workspace_row.verification_status IS DISTINCT FROM 'VERIFIED'
     OR workspace_row.root_authority_state IS DISTINCT FROM 'VERIFIED_MATCH'
     OR workspace_row.verified_root_device_id IS NULL OR workspace_row.verified_root_file_id IS NULL
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

  SELECT * INTO revision_row FROM intentchord.workspace_source_revisions WHERE id=NEW.workspace_revision_id;
  IF NOT FOUND
     OR revision_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR revision_row.workspace_instance_id IS DISTINCT FROM NEW.workspace_registration_id::text
     OR revision_row.source_tree_fingerprint IS DISTINCT FROM NEW.source_tree_fingerprint THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_REVISION_BINDING_MISMATCH';
  END IF;

  IF NEW.owner_reference IS DISTINCT FROM snapshot_row.owner_reference THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_OWNER_REFERENCE_MISMATCH';
  END IF;

  is_v2 := (NEW.accepted_workspace_evidence_artifact_id IS NOT NULL)
        OR (NEW.source_continuity_attestation_id IS NOT NULL);

  IF NOT is_v2 THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_OBSERVATION_V2_AUTHORITY_REQUIRED';
  END IF;

  ---------------------------- V2 SECTIONED BRANCH ----------------------------
  IF NEW.canonical_index_artifact_id IS NOT NULL OR NEW.delta_artifact_id IS NOT NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_WO_V2_LEGACY_ARTIFACT_COLUMNS_FORBIDDEN';
  END IF;

  SELECT * INTO att_row FROM intentchord.workspace_source_continuity_attestations
   WHERE id=NEW.source_continuity_attestation_id;
  IF NEW.source_continuity_attestation_id IS NULL OR NOT FOUND
     OR att_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
     OR att_row.snapshot_operation_id IS DISTINCT FROM NEW.snapshot_operation_id THEN
    RAISE EXCEPTION 'INTENTCHORD_WO_V2_ATTESTATION_BINDING_MISMATCH';
  END IF;

  IF NEW.observation_result='SOURCE_PROVEN_INDEX_FAILED' THEN
    IF NEW.accepted_workspace_evidence_artifact_id IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WO_V2_FAILED_ATTEMPT_ARTIFACT_VIOLATION';
    END IF;
    IF att_row.attestation_state IS DISTINCT FROM 'VOID' THEN
      RAISE EXCEPTION 'INTENTCHORD_WO_V2_FAILED_ATTEMPT_ATTESTATION_MUST_BE_VOID';
    END IF;
    RETURN NEW;
  END IF;

  IF att_row.attestation_state IS DISTINCT FROM 'SEALED' OR att_row.observation_id IS NOT NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_WO_V2_ATTESTATION_NOT_SEALED_UNLINKED';
  END IF;

  SELECT * INTO wea_row FROM intentchord.workspace_evidence_artifacts
   WHERE id=NEW.accepted_workspace_evidence_artifact_id
     AND workspace_registration_id=NEW.workspace_registration_id
     AND workspace_revision_id=NEW.workspace_revision_id
     AND index_configuration_sha256=NEW.index_configuration_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_WO_V2_ARTIFACT_BINDING_MISMATCH';
  END IF;

  SELECT * INTO latest_row FROM intentchord.workspace_observations
   WHERE workspace_registration_id=NEW.workspace_registration_id
   ORDER BY authority_sequence DESC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    IF snapshot_row.scan_base_observation_id IS NOT NULL OR NEW.previous_observation_id IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_FIRST_OBSERVATION_CHAIN_VIOLATION';
    END IF;
    expected_result := 'FIRST_INDEXED';
  ELSE
    IF snapshot_row.scan_base_observation_id IS DISTINCT FROM latest_row.id THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_SCAN_BASE_STALE';
    END IF;
    IF NEW.previous_observation_id IS DISTINCT FROM latest_row.id THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_PREVIOUS_OBSERVATION_NOT_CURRENT_HEAD';
    END IF;
    IF latest_row.accepted_workspace_evidence_artifact_id IS NOT NULL
       AND latest_row.accepted_workspace_evidence_artifact_id = NEW.accepted_workspace_evidence_artifact_id THEN
      expected_result := 'SOURCE_UNCHANGED';
    ELSE
      SELECT EXISTS(SELECT 1 FROM intentchord.workspace_observations
                    WHERE workspace_registration_id=NEW.workspace_registration_id
                      AND workspace_revision_id=NEW.workspace_revision_id) INTO revision_seen_before;
      IF latest_row.workspace_revision_id = NEW.workspace_revision_id THEN
        expected_result := 'SOURCE_UNCHANGED_INDEX_REFRESHED';
      ELSE
        expected_result := CASE WHEN revision_seen_before THEN 'KNOWN_STATE_RESTORED' ELSE 'SOURCE_CHANGED' END;
      END IF;
    END IF;
  END IF;

  IF NEW.observation_result IS DISTINCT FROM expected_result THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_OBSERVATION_RESULT_MISMATCH:expected=% actual=%', expected_result, NEW.observation_result;
  END IF;
  RETURN NEW;
END;
$obs_guard$;

DROP TRIGGER IF EXISTS workspace_observations_b1_insert_guard ON intentchord.workspace_observations;
CREATE TRIGGER workspace_observations_b1_insert_guard BEFORE INSERT ON intentchord.workspace_observations
FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_observation_b1_insert_guard();

-- 13.7 snapshots ------------------------------------------------------------------
ALTER TABLE intentchord.workspace_index_snapshots
  ADD COLUMN IF NOT EXISTS accepted_workspace_evidence_artifact_id text,
  ADD COLUMN IF NOT EXISTS source_continuity_attestation_id text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wsnaps_wea_fk' AND conrelid='intentchord.workspace_index_snapshots'::regclass) THEN
    ALTER TABLE intentchord.workspace_index_snapshots ADD CONSTRAINT wsnaps_wea_fk FOREIGN KEY (accepted_workspace_evidence_artifact_id) REFERENCES intentchord.workspace_evidence_artifacts(id) ON DELETE RESTRICT;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wsnaps_wca_fk' AND conrelid='intentchord.workspace_index_snapshots'::regclass) THEN
    ALTER TABLE intentchord.workspace_index_snapshots ADD CONSTRAINT wsnaps_wca_fk FOREIGN KEY (source_continuity_attestation_id) REFERENCES intentchord.workspace_source_continuity_attestations(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE intentchord.workspace_index_snapshots DROP CONSTRAINT IF EXISTS workspace_index_snapshots_b1_binding_shape_ck;
ALTER TABLE intentchord.workspace_index_snapshots ADD CONSTRAINT workspace_index_snapshots_b1_binding_shape_ck CHECK (
  ( workspace_observation_id IS NULL AND workspace_revision_id IS NULL
    AND canonical_index_artifact_id IS NULL AND index_configuration_sha256 IS NULL
    AND observation_result IS NULL AND delta_artifact_id IS NULL
    AND accepted_workspace_evidence_artifact_id IS NULL
    AND source_continuity_attestation_id IS NULL
    AND index_attempt_candidate_json IS NULL AND index_attempt_candidate_sha256 IS NULL )
  OR
  ( source_mode='REGISTERED_WORKSPACE' AND status='READY'
    AND accepted_workspace_evidence_artifact_id IS NOT NULL
    AND source_continuity_attestation_id IS NOT NULL
    AND canonical_index_artifact_id IS NULL AND canonical_index_json IS NULL
    AND workspace_observation_id IS NOT NULL AND workspace_revision_id IS NOT NULL
    AND index_configuration_sha256 IS NOT NULL
    AND observation_result IS NOT NULL AND observation_result<>'SOURCE_PROVEN_INDEX_FAILED'
    AND index_attempt_status='SUCCEEDED'
    AND index_attempt_candidate_json IS NULL AND index_attempt_candidate_sha256 IS NULL )
  OR
  ( source_mode='REGISTERED_WORKSPACE' AND status='FAILED'
    AND workspace_observation_id IS NOT NULL AND workspace_revision_id IS NOT NULL
    AND index_configuration_sha256 IS NOT NULL
    AND observation_result='SOURCE_PROVEN_INDEX_FAILED'
    AND accepted_workspace_evidence_artifact_id IS NULL
    AND canonical_index_artifact_id IS NULL AND delta_artifact_id IS NULL
    AND canonical_index_json IS NULL AND canonical_sha256 IS NULL
    AND index_attempt_status='FAILED_RETRYABLE'
    AND index_attempt_evidence IS NOT NULL AND jsonb_typeof(index_attempt_evidence)='object'
    AND index_attempt_candidate_json IS NULL AND index_attempt_candidate_sha256 IS NULL
    AND source_continuity_attestation_id IS NOT NULL )
);

-- PB-3: complete state/payload constraint replacement (V2 ONLY)
ALTER TABLE intentchord.workspace_index_snapshots DROP CONSTRAINT IF EXISTS workspace_index_snapshots_state_payload_ck;
ALTER TABLE intentchord.workspace_index_snapshots ADD CONSTRAINT workspace_index_snapshots_state_payload_ck CHECK (
  (status='CREATING'
    AND canonical_contract_version IS NULL AND canonical_index_json IS NULL
    AND canonical_sha256 IS NULL AND failure_code IS NULL
    AND safe_failure_evidence IS NULL AND completed_at IS NULL)
  OR
  (status='READY' AND accepted_workspace_evidence_artifact_id IS NOT NULL
    AND canonical_contract_version IS NOT NULL AND btrim(canonical_contract_version)<>''
    AND canonical_index_json IS NULL AND canonical_sha256 IS NULL
    AND failure_code IS NULL AND safe_failure_evidence IS NULL AND completed_at IS NOT NULL)
  OR
  (status='FAILED'
    AND canonical_contract_version IS NULL AND canonical_index_json IS NULL
    AND canonical_sha256 IS NULL AND failure_code IS NOT NULL AND btrim(failure_code)<>''
    AND safe_failure_evidence IS NOT NULL AND jsonb_typeof(safe_failure_evidence)='object'
    AND completed_at IS NOT NULL)
);

ALTER TABLE intentchord.workspace_index_snapshots DROP CONSTRAINT IF EXISTS wsnaps_v2_no_payload_ck;
ALTER TABLE intentchord.workspace_index_snapshots ADD CONSTRAINT wsnaps_v2_no_payload_ck CHECK (
  accepted_workspace_evidence_artifact_id IS NULL OR
  (canonical_index_json IS NULL AND index_attempt_candidate_json IS NULL AND index_attempt_candidate_sha256 IS NULL));

-- 13.7.4 COMPLETE governed-update trigger replacement (US-4) -----------------------
CREATE OR REPLACE FUNCTION intentchord.workspace_index_snapshot_governed_update()
RETURNS trigger LANGUAGE plpgsql AS $snap_upd$
DECLARE
  observation_row intentchord.workspace_observations%ROWTYPE;
  wea_row intentchord.workspace_evidence_artifacts%ROWTYPE;
  att_row intentchord.workspace_source_continuity_attestations%ROWTYPE;
BEGIN
  IF ROW(NEW.id,NEW.source_mode,NEW.workspace_registration_id,NEW.workspace_registration_revision,
         NEW.workspace_registration_fingerprint,NEW.project_context_id,NEW.governed_scope,
         NEW.snapshot_idempotency_key,NEW.snapshot_request_fingerprint_sha256,
         NEW.owner_reference,NEW.started_at,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.source_mode,OLD.workspace_registration_id,OLD.workspace_registration_revision,
         OLD.workspace_registration_fingerprint,OLD.project_context_id,OLD.governed_scope,
         OLD.snapshot_idempotency_key,OLD.snapshot_request_fingerprint_sha256,
         OLD.owner_reference,OLD.started_at,OLD.created_at) THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_IMMUTABLE_BINDING';
  END IF;

  IF OLD.status='CREATING' AND NEW.status='CREATING' THEN
    IF ROW(NEW.canonical_contract_version,NEW.canonical_index_json,NEW.canonical_sha256,
           NEW.failure_code,NEW.safe_failure_evidence,NEW.completed_at,
           NEW.workspace_observation_id,NEW.workspace_revision_id,NEW.canonical_index_artifact_id,
           NEW.index_configuration_sha256,NEW.observation_result,NEW.delta_artifact_id,
           NEW.index_attempt_status,NEW.index_attempt_evidence,NEW.index_attempt_candidate_json,
           NEW.index_attempt_candidate_sha256,NEW.accepted_workspace_evidence_artifact_id,
           NEW.source_continuity_attestation_id)
       IS DISTINCT FROM ROW(OLD.canonical_contract_version,OLD.canonical_index_json,OLD.canonical_sha256,
           OLD.failure_code,OLD.safe_failure_evidence,OLD.completed_at,
           OLD.workspace_observation_id,OLD.workspace_revision_id,OLD.canonical_index_artifact_id,
           OLD.index_configuration_sha256,OLD.observation_result,OLD.delta_artifact_id,
           OLD.index_attempt_status,OLD.index_attempt_evidence,OLD.index_attempt_candidate_json,
           OLD.index_attempt_candidate_sha256,OLD.accepted_workspace_evidence_artifact_id,
           OLD.source_continuity_attestation_id) THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_PROGRESS_PAYLOAD_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('READY','FAILED') AND NEW.status=OLD.status
     AND (OLD.progress_phase IS NULL OR OLD.progress_evidence IS NULL OR OLD.heartbeat_at IS NULL) THEN
    IF ROW(NEW.canonical_contract_version,NEW.canonical_index_json,NEW.canonical_sha256,
           NEW.failure_code,NEW.safe_failure_evidence,NEW.completed_at,
           NEW.workspace_observation_id,NEW.workspace_revision_id,NEW.canonical_index_artifact_id,
           NEW.index_configuration_sha256,NEW.observation_result,NEW.delta_artifact_id,
           NEW.index_attempt_status,NEW.index_attempt_evidence,NEW.index_attempt_candidate_json,
           NEW.index_attempt_candidate_sha256,NEW.accepted_workspace_evidence_artifact_id,
           NEW.source_continuity_attestation_id)
       IS DISTINCT FROM ROW(OLD.canonical_contract_version,OLD.canonical_index_json,OLD.canonical_sha256,
           OLD.failure_code,OLD.safe_failure_evidence,OLD.completed_at,
           OLD.workspace_observation_id,OLD.workspace_revision_id,OLD.canonical_index_artifact_id,
           OLD.index_configuration_sha256,OLD.observation_result,OLD.delta_artifact_id,
           OLD.index_attempt_status,OLD.index_attempt_evidence,OLD.index_attempt_candidate_json,
           OLD.index_attempt_candidate_sha256,OLD.accepted_workspace_evidence_artifact_id,
           OLD.source_continuity_attestation_id)
       OR NEW.progress_phase IS DISTINCT FROM OLD.status
       OR NEW.progress_evidence IS NULL OR NEW.heartbeat_at IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TERMINAL_BACKFILL_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status<>'CREATING' OR NEW.status NOT IN ('READY','FAILED') THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TRANSITION_BLOCKED:%->%', OLD.status, NEW.status;
  END IF;

  IF NEW.source_mode='ADVANCED_DIAGNOSTIC' THEN
    IF NEW.scan_base_observation_id IS NOT NULL OR NEW.workspace_observation_id IS NOT NULL
       OR NEW.workspace_revision_id IS NOT NULL OR NEW.canonical_index_artifact_id IS NOT NULL
       OR NEW.index_configuration_sha256 IS NOT NULL OR NEW.observation_result IS NOT NULL
       OR NEW.delta_artifact_id IS NOT NULL
       OR NEW.accepted_workspace_evidence_artifact_id IS NOT NULL
       OR NEW.source_continuity_attestation_id IS NOT NULL
       OR NEW.index_attempt_candidate_json IS NOT NULL
       OR NEW.index_attempt_candidate_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_ADVANCED_DIAGNOSTIC_B1_AUTHORITY_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status='FAILED' THEN
    IF NEW.observation_result='SOURCE_PROVEN_INDEX_FAILED' THEN
      IF NEW.accepted_workspace_evidence_artifact_id IS NOT NULL THEN
        RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_PROVEN_SOURCE_FAILED_ATTEMPT_BINDING_REQUIRED';
      END IF;
      IF NEW.canonical_index_artifact_id IS NULL AND NEW.canonical_index_json IS NULL THEN
        -- V2 proven-source failure shape
        IF NEW.index_attempt_status IS DISTINCT FROM 'FAILED_RETRYABLE'
           OR NEW.index_attempt_evidence IS NULL OR NEW.workspace_observation_id IS NULL
           OR NEW.workspace_revision_id IS NULL OR NEW.index_configuration_sha256 IS NULL
           OR NEW.delta_artifact_id IS NOT NULL
           OR NEW.index_attempt_candidate_json IS NOT NULL
           OR NEW.index_attempt_candidate_sha256 IS NOT NULL
           OR NEW.source_continuity_attestation_id IS NULL THEN
          RAISE EXCEPTION 'INTENTCHORD_WSNAPS_V2_PROVEN_SOURCE_FAILED_BINDING_REQUIRED';
        END IF;
        SELECT * INTO att_row FROM intentchord.workspace_source_continuity_attestations
         WHERE id=NEW.source_continuity_attestation_id;
        IF NOT FOUND OR att_row.attestation_state IS DISTINCT FROM 'VOID' THEN
          RAISE EXCEPTION 'INTENTCHORD_WSNAPS_V2_FAILED_ATTESTATION_MUST_BE_VOID';
        END IF;
        RETURN NEW;
      END IF;
      -- Legacy proven-source failure shape (verbatim requirements)
      IF NEW.workspace_observation_id IS NULL OR NEW.workspace_revision_id IS NULL
         OR NEW.canonical_index_artifact_id IS NOT NULL OR NEW.index_configuration_sha256 IS NULL
         OR NEW.delta_artifact_id IS NOT NULL
         OR NEW.index_attempt_status IS DISTINCT FROM 'FAILED_RETRYABLE'
         OR NEW.index_attempt_evidence IS NULL
         OR NEW.index_attempt_candidate_json IS NULL
         OR NEW.index_attempt_candidate_sha256 IS NULL THEN
        RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_PROVEN_SOURCE_FAILED_ATTEMPT_BINDING_REQUIRED';
      END IF;
      RETURN NEW;
    END IF;
    -- plain FAILED
    IF NEW.workspace_observation_id IS NOT NULL OR NEW.workspace_revision_id IS NOT NULL
       OR NEW.canonical_index_artifact_id IS NOT NULL OR NEW.index_configuration_sha256 IS NOT NULL
       OR NEW.observation_result IS NOT NULL OR NEW.delta_artifact_id IS NOT NULL
       OR NEW.accepted_workspace_evidence_artifact_id IS NOT NULL
       OR NEW.source_continuity_attestation_id IS NOT NULL
       OR NEW.index_attempt_candidate_json IS NOT NULL
       OR NEW.index_attempt_candidate_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_B1_FAILED_SNAPSHOT_BINDING_VIOLATION';
    END IF;
    RETURN NEW;
  END IF;

  -- NEW.status='READY'
  IF NEW.accepted_workspace_evidence_artifact_id IS NOT NULL THEN
    IF NEW.canonical_index_artifact_id IS NOT NULL OR NEW.canonical_index_json IS NOT NULL
       OR NEW.canonical_sha256 IS NOT NULL OR NEW.delta_artifact_id IS NOT NULL
       OR NEW.index_attempt_candidate_json IS NOT NULL
       OR NEW.index_attempt_candidate_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WSNAPS_V2_TERMINAL_PAYLOAD_FORBIDDEN';
    END IF;
    IF NEW.workspace_observation_id IS NULL OR NEW.workspace_revision_id IS NULL
       OR NEW.index_configuration_sha256 IS NULL OR NEW.observation_result IS NULL
       OR NEW.observation_result='SOURCE_PROVEN_INDEX_FAILED'
       OR NEW.index_attempt_status IS DISTINCT FROM 'SUCCEEDED'
       OR NEW.source_continuity_attestation_id IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_WSNAPS_V2_TERMINAL_BINDING_REQUIRED';
    END IF;
    SELECT * INTO observation_row FROM intentchord.workspace_observations WHERE id=NEW.workspace_observation_id;
    IF NOT FOUND
       OR observation_row.snapshot_operation_id IS DISTINCT FROM NEW.id
       OR observation_row.workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id
       OR observation_row.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id
       OR observation_row.accepted_workspace_evidence_artifact_id IS DISTINCT FROM NEW.accepted_workspace_evidence_artifact_id
       OR observation_row.index_configuration_sha256 IS DISTINCT FROM NEW.index_configuration_sha256
       OR observation_row.observation_result IS DISTINCT FROM NEW.observation_result
       OR observation_row.source_continuity_attestation_id IS DISTINCT FROM NEW.source_continuity_attestation_id THEN
      RAISE EXCEPTION 'INTENTCHORD_WSNAPS_V2_TERMINAL_BINDING_MISMATCH';
    END IF;
    SELECT * INTO att_row FROM intentchord.workspace_source_continuity_attestations
     WHERE id=NEW.source_continuity_attestation_id;
    IF NOT FOUND OR att_row.attestation_state IS DISTINCT FROM 'SEALED'
       OR att_row.observation_id IS DISTINCT FROM NEW.workspace_observation_id THEN
      RAISE EXCEPTION 'INTENTCHORD_WSNAPS_V2_ATTESTATION_LINK_MISMATCH';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'INTENTCHORD_WSNAPS_V2_TERMINAL_BINDING_REQUIRED';
END;
$snap_upd$;

-- 13.8 context mapping guards ------------------------------------------------------
ALTER TABLE intentchord.context_mapping_runs DROP CONSTRAINT IF EXISTS context_mapping_runs_b1_artifact_fk;

CREATE OR REPLACE FUNCTION intentchord.context_mapping_artifact_guard() RETURNS trigger AS $cmg$
BEGIN
  IF NEW.canonical_index_artifact_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM intentchord.workspace_evidence_artifacts w WHERE w.id=NEW.canonical_index_artifact_id AND NEW.artifact_semantic_sha256=w.artifact_semantic_sha256)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ARTIFACT_BINDING_INVALID';
END $cmg$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS context_mapping_runs_artifact_guard ON intentchord.context_mapping_runs;
CREATE TRIGGER context_mapping_runs_artifact_guard BEFORE INSERT OR UPDATE OF canonical_index_artifact_id, artifact_semantic_sha256
ON intentchord.context_mapping_runs FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_artifact_guard();

CREATE OR REPLACE FUNCTION intentchord.wea_cm_delete_guard() RETURNS trigger AS $wdg$
BEGIN
  IF EXISTS (SELECT 1 FROM intentchord.context_mapping_runs r WHERE r.canonical_index_artifact_id=OLD.id)
  THEN RAISE EXCEPTION 'INTENTCHORD_WEA_REFERENCED_BY_CONTEXT_MAPPING'; END IF;
  RETURN OLD;
END $wdg$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wea_cm_delete_guard ON intentchord.workspace_evidence_artifacts;
CREATE TRIGGER wea_cm_delete_guard BEFORE DELETE ON intentchord.workspace_evidence_artifacts FOR EACH ROW EXECUTE FUNCTION intentchord.wea_cm_delete_guard();

-- Snapshot-insert guard replacement: V2 branch.
CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_insert_snapshot_guard()
RETURNS trigger LANGUAGE plpgsql AS $cisg$
DECLARE
  snapshot_row intentchord.workspace_index_snapshots%ROWTYPE;
  wea_row intentchord.workspace_evidence_artifacts%ROWTYPE;
  is_registered_v2 boolean := false;
BEGIN
  IF NEW.workspace_index_snapshot_id IS NULL OR NEW.mapping_idempotency_key IS NULL
     OR btrim(NEW.mapping_idempotency_key)='' OR NEW.mapping_request_fingerprint_sha256 IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED';
  END IF;
  SELECT * INTO snapshot_row FROM intentchord.workspace_index_snapshots WHERE id=NEW.workspace_index_snapshot_id;
  IF NOT FOUND OR snapshot_row.status<>'READY' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_READY_SNAPSHOT_REQUIRED';
  END IF;
  is_registered_v2 := snapshot_row.source_mode='REGISTERED_WORKSPACE' AND snapshot_row.accepted_workspace_evidence_artifact_id IS NOT NULL;
  IF is_registered_v2 THEN
    SELECT * INTO wea_row FROM intentchord.workspace_evidence_artifacts WHERE id=snapshot_row.accepted_workspace_evidence_artifact_id;
    IF NOT FOUND
       OR NEW.canonical_index_artifact_id IS DISTINCT FROM wea_row.id
       OR NEW.artifact_semantic_sha256 IS DISTINCT FROM wea_row.artifact_semantic_sha256
       OR NEW.workspace_index_sha256 IS DISTINCT FROM wea_row.artifact_semantic_sha256
       OR NEW.workspace_snapshot_id IS DISTINCT FROM snapshot_row.workspace_revision_id
       OR NEW.mapping_input_snapshot->>'mapping_input_schema_version' IS DISTINCT FROM 'intentchord.ai-context-mapping-input.v2'
       OR NEW.mapping_input_snapshot->>'source_authority' IS DISTINCT FROM 'CANONICAL_INDEX_ARTIFACT'
       OR NEW.mapping_input_snapshot->>'canonical_index_artifact_id' IS DISTINCT FROM wea_row.id
       OR NEW.mapping_input_snapshot->>'artifact_semantic_sha256' IS DISTINCT FROM wea_row.artifact_semantic_sha256
       OR NEW.mapping_input_snapshot->>'workspace_index_sha256' IS DISTINCT FROM wea_row.artifact_semantic_sha256
       OR NEW.mapping_input_snapshot->>'workspace_snapshot_id' IS DISTINCT FROM snapshot_row.workspace_revision_id THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_ARTIFACT_HASH_MISMATCH';
    END IF;
  ELSE
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED';
  END IF;
  RETURN NEW;
END;
$cisg$;

-- 13.9 append-only enforcement -----------------------------------------------------
CREATE OR REPLACE FUNCTION intentchord.workspace_evidence_append_only() RETURNS trigger AS $ao$
BEGIN RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_EVIDENCE_APPEND_ONLY:%', TG_TABLE_NAME; END;
$ao$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wea_append_only ON intentchord.workspace_evidence_artifacts;
CREATE TRIGGER wea_append_only BEFORE UPDATE OR DELETE ON intentchord.workspace_evidence_artifacts FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_evidence_append_only();
DROP TRIGGER IF EXISTS wes_append_only ON intentchord.workspace_evidence_sections;
CREATE TRIGGER wes_append_only BEFORE UPDATE OR DELETE ON intentchord.workspace_evidence_sections FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_evidence_append_only();
DROP TRIGGER IF EXISTS wer_append_only ON intentchord.workspace_evidence_section_records;
CREATE TRIGGER wer_append_only BEFORE UPDATE OR DELETE ON intentchord.workspace_evidence_section_records FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_evidence_append_only();
DROP TRIGGER IF EXISTS wseg_append_only ON intentchord.workspace_evidence_segments;
CREATE TRIGGER wseg_append_only BEFORE UPDATE OR DELETE ON intentchord.workspace_evidence_segments FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_evidence_append_only();
DROP TRIGGER IF EXISTS wsfoi_append_only ON intentchord.workspace_file_object_identity_index;
CREATE TRIGGER wsfoi_append_only BEFORE UPDATE OR DELETE ON intentchord.workspace_file_object_identity_index FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_evidence_append_only();

-- 13.11 maintenance functions -------------------------------------------------------
CREATE OR REPLACE FUNCTION intentchord.workspace_evidence_staging_reaper(p_before timestamptz, p_batch integer DEFAULT 10000)
RETURNS integer LANGUAGE plpgsql AS $reap$
DECLARE n1 integer; n2 integer;
BEGIN
  CREATE TEMP TABLE __reaper_victims ON COMMIT DROP AS
    SELECT DISTINCT s.snapshot_operation_id
    FROM intentchord.workspace_evidence_staging_records s
    JOIN intentchord.workspace_index_snapshots sn ON sn.id=s.snapshot_operation_id
    WHERE sn.status IN ('READY','FAILED') AND sn.completed_at IS NOT NULL AND sn.completed_at < p_before
    LIMIT p_batch;
  DELETE FROM intentchord.workspace_evidence_staging_records r USING __reaper_victims v WHERE r.snapshot_operation_id=v.snapshot_operation_id;
  GET DIAGNOSTICS n1=ROW_COUNT;
  DELETE FROM intentchord.workspace_evidence_staging_segments g USING __reaper_victims v WHERE g.snapshot_operation_id=v.snapshot_operation_id;
  GET DIAGNOSTICS n2=ROW_COUNT;
  DROP TABLE __reaper_victims;
  RETURN n1+n2;
END;
$reap$;

CREATE OR REPLACE FUNCTION intentchord.void_unlinked_sealed_attestations(p_registration uuid)
RETURNS integer LANGUAGE plpgsql AS $vusa$
DECLARE affected integer;
BEGIN
  UPDATE intentchord.workspace_source_continuity_attestations
     SET attestation_state='VOID', void_reason='UNLINKED'
   WHERE workspace_registration_id=p_registration
     AND attestation_state='SEALED' AND observation_id IS NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END;
$vusa$;

