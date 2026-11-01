-- IntentChord Governed Context Assembly + AI Context Mapping V2.
-- Additive after 013. Migrations 001-013 remain immutable.
-- V1 qualification/data remain valid under their historical semantics.

CREATE TABLE IF NOT EXISTS intentchord.context_assemblies (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES intentchord.tasks(id) ON DELETE RESTRICT,
  contract_version text NOT NULL CHECK (contract_version='intentchord.context-assembly.v1'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS intentchord.context_assembly_revisions (
  id uuid PRIMARY KEY,
  context_assembly_id uuid NOT NULL REFERENCES intentchord.context_assemblies(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  previous_revision_id uuid REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  assembly_schema_version text NOT NULL CHECK (assembly_schema_version='intentchord.context-assembly.v1'),
  assembly_sha256 text NOT NULL CHECK (assembly_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_assembly_revisions_revision_uq UNIQUE (context_assembly_id,revision),
  CONSTRAINT context_assembly_revisions_id_assembly_uq UNIQUE (id,context_assembly_id)
);


CREATE OR REPLACE FUNCTION intentchord.context_assembly_revision_lineage_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_row intentchord.context_assembly_revisions%ROWTYPE;
BEGIN
  IF NEW.revision = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_FIRST_REVISION_PREVIOUS_FORBIDDEN';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.previous_revision_id IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_PREVIOUS_REVISION_REQUIRED';
  END IF;

  SELECT * INTO previous_row
    FROM intentchord.context_assembly_revisions
   WHERE id=NEW.previous_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_PREVIOUS_REVISION_NOT_FOUND';
  END IF;
  IF previous_row.context_assembly_id IS DISTINCT FROM NEW.context_assembly_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_PREVIOUS_REVISION_CROSS_ASSEMBLY';
  END IF;
  IF previous_row.revision IS DISTINCT FROM NEW.revision - 1 THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_PREVIOUS_REVISION_NOT_SEQUENTIAL';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_assembly_revisions_lineage_guard ON intentchord.context_assembly_revisions;
CREATE TRIGGER context_assembly_revisions_lineage_guard
BEFORE INSERT ON intentchord.context_assembly_revisions
FOR EACH ROW EXECUTE FUNCTION intentchord.context_assembly_revision_lineage_guard();

CREATE TABLE IF NOT EXISTS intentchord.context_assembly_sources (
  id uuid PRIMARY KEY,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  ordering integer NOT NULL CHECK (ordering >= 0),
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  workspace_registration_revision bigint NOT NULL CHECK (workspace_registration_revision >= 0),
  workspace_registration_fingerprint text NOT NULL CHECK (btrim(workspace_registration_fingerprint) <> ''),
  workspace_revision_id text NOT NULL,
  workspace_observation_id uuid NOT NULL REFERENCES intentchord.workspace_observations(id) ON DELETE RESTRICT,
  workspace_observation_authority_sequence bigint NOT NULL CHECK (workspace_observation_authority_sequence > 0),
  workspace_index_snapshot_id uuid NOT NULL REFERENCES intentchord.workspace_index_snapshots(id) ON DELETE RESTRICT,
  accepted_workspace_evidence_artifact_id text NOT NULL CHECK (accepted_workspace_evidence_artifact_id ~ '^wea_[0-9a-f]{64}$'),
  workspace_index_sha256 text NOT NULL CHECK (workspace_index_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  artifact_semantic_sha256 text NOT NULL CHECK (artifact_semantic_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_assembly_sources_revision_order_uq UNIQUE (context_assembly_revision_id,ordering),
  CONSTRAINT context_assembly_sources_revision_workspace_uq UNIQUE (context_assembly_revision_id,workspace_registration_id),
  CONSTRAINT context_assembly_sources_registration_revision_fk
    FOREIGN KEY (workspace_registration_id,workspace_revision_id)
    REFERENCES intentchord.workspace_source_revisions(workspace_registration_id,id)
    ON DELETE RESTRICT
);

-- Version every Mapping Run explicitly. Historical rows become V1 without semantic reinterpretation.
ALTER TABLE intentchord.context_mapping_runs
  ADD COLUMN IF NOT EXISTS qualification_scope text NOT NULL DEFAULT 'AI_CONTEXT_MAPPING_V1',
  ADD COLUMN IF NOT EXISTS context_assembly_revision_id uuid,
  ADD COLUMN IF NOT EXISTS context_assembly_sha256 text,
  ADD COLUMN IF NOT EXISTS execution_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS deadline_policy_version text,
  ADD COLUMN IF NOT EXISTS terminal_reason_code text;

-- Reconcile the inherited Migration 010 Snapshot binding shape with explicit V1/V2 qualification semantics.
-- Historical V1 all-null rows remain readable; governed V1 remains Snapshot-bound; V2 is Context-Assembly-bound
-- while retaining non-null idempotency and request-fingerprint identity.
ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_snapshot_binding_shape_ck;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_snapshot_binding_shape_ck CHECK (
    (
      qualification_scope='AI_CONTEXT_MAPPING_V1'
      AND workspace_index_snapshot_id IS NULL
      AND mapping_idempotency_key IS NULL
      AND mapping_request_fingerprint_sha256 IS NULL
    )
    OR
    (
      qualification_scope='AI_CONTEXT_MAPPING_V1'
      AND workspace_index_snapshot_id IS NOT NULL
      AND mapping_idempotency_key IS NOT NULL
      AND btrim(mapping_idempotency_key) <> ''
      AND char_length(mapping_idempotency_key) <= 200
      AND mapping_request_fingerprint_sha256 IS NOT NULL
    )
    OR
    (
      qualification_scope='AI_CONTEXT_MAPPING_V2'
      AND workspace_index_snapshot_id IS NULL
      AND mapping_idempotency_key IS NOT NULL
      AND btrim(mapping_idempotency_key) <> ''
      AND char_length(mapping_idempotency_key) <= 200
      AND mapping_request_fingerprint_sha256 IS NOT NULL
    )
  );

ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_qualification_scope_ck,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_context_assembly_shape_ck,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_context_assembly_fk;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_qualification_scope_ck CHECK (
    qualification_scope IN ('AI_CONTEXT_MAPPING_V1','AI_CONTEXT_MAPPING_V2')
  ),
  ADD CONSTRAINT context_mapping_runs_context_assembly_shape_ck CHECK (
    (
      qualification_scope='AI_CONTEXT_MAPPING_V1'
      AND context_assembly_revision_id IS NULL
      AND context_assembly_sha256 IS NULL
      AND execution_deadline_at IS NULL
      AND deadline_policy_version IS NULL
    )
    OR
    (
      qualification_scope='AI_CONTEXT_MAPPING_V2'
      AND context_assembly_revision_id IS NOT NULL
      AND context_assembly_sha256 ~ '^sha256:[0-9a-f]{64}$'
      AND workspace_index_snapshot_id IS NULL
      AND execution_deadline_at IS NOT NULL
      AND execution_deadline_at > created_at
      AND deadline_policy_version='intentchord.context-mapping-execution-deadline.v1'
    )
  ),
  ADD CONSTRAINT context_mapping_runs_context_assembly_fk
    FOREIGN KEY (context_assembly_revision_id)
    REFERENCES intentchord.context_assembly_revisions(id)
    ON DELETE RESTRICT;

ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_terminal_reason_v014_ck;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_terminal_reason_v014_ck CHECK (
    terminal_reason_code IS NULL OR (qualification_scope='AI_CONTEXT_MAPPING_V2' AND terminal_reason_code='ORPHANED_ACTIVE_MAPPING_EXECUTION')
  );

-- V2 has backend-terminal analysis states; V1 lifecycle remains unchanged.
ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_status_check;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_status_check CHECK (status IN (
    'CREATED','INPUT_VALIDATED','PRIMARY_RUNNING','PRIMARY_FAILED_TECHNICAL',
    'STANDBY_BLOCKED_GOVERNANCE','STANDBY_RUNNING','VALIDATING',
    'AWAITING_OWNER_REVIEW','REJECTED_VALIDATION','FAILED',
    'OWNER_ACCEPTED','OWNER_REJECTED',
    'ANALYSIS_COMPLETE','ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE'
  ));


-- Migration 013 froze the v3 provider snapshot shape to the historical V1 semantic scope.
-- Replace that exact full check (do not weaken it) so V1/V2 runs require the qualification
-- frozen inside each Engine snapshot to match the run's explicit semantic qualification_scope.
ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_provider_configuration_snapshot_shape_ck;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_provider_configuration_snapshot_shape_ck CHECK (
    jsonb_typeof(provider_configuration_snapshot)='object'
    AND (
      -- Historical legacy rows remain readable and are never reinterpreted from current configuration.
      NOT (provider_configuration_snapshot ? 'schema_version')
      -- Historical v1.0.1 candidate snapshot identity is retained as persisted historical truth if encountered.
      OR (
        provider_configuration_snapshot->>'schema_version'='intentchord.internal-ai-provider-configuration.v2'
        AND provider_configuration_snapshot->>'registry_schema_version'='intentchord.internal-ai-engine-registry.v1'
      )
      -- v1.0.2 current snapshot: exact selected Engine config fingerprint is frozen and recomputable.
      OR (
        provider_configuration_snapshot->>'schema_version'='intentchord.internal-ai-provider-configuration.v3'
        AND provider_configuration_snapshot->>'registry_schema_version'='intentchord.internal-ai-engine-registry.v2'
        AND jsonb_typeof(provider_configuration_snapshot->'selection_policy')='object'
        AND (provider_configuration_snapshot->'selection_policy'->>'selection_mode') IS NOT DISTINCT FROM 'SINGLE'
        AND btrim(provider_configuration_snapshot->'selection_policy'->>'selection_policy_id') <> ''
        AND btrim(provider_configuration_snapshot->'selection_policy'->>'selection_policy_version') <> ''
        AND jsonb_typeof(provider_configuration_snapshot->'active')='object'
        AND jsonb_typeof(provider_configuration_snapshot->'failover_policy')='object'
        AND (provider_configuration_snapshot->>'selected_engine_id') IS NOT DISTINCT FROM (provider_configuration_snapshot->'active'->>'engine_id')
        AND (provider_configuration_snapshot->>'selected_engine_config_revision') IS NOT DISTINCT FROM (provider_configuration_snapshot->'active'->>'engine_config_revision')
        AND (provider_configuration_snapshot->>'selected_engine_configuration_sha256') IS NOT DISTINCT FROM (provider_configuration_snapshot->'active'->>'engine_configuration_sha256')
        AND (provider_configuration_snapshot->>'selected_engine_configuration_sha256') ~ '^sha256:[a-f0-9]{64}$'
        AND (provider_configuration_snapshot->'active'->>'engine_configuration_sha256') IS NOT DISTINCT FROM intentchord.internal_ai_engine_configuration_sha256_v1(provider_configuration_snapshot->'active')
        AND (provider_configuration_snapshot->'active'->>'role') IS NOT DISTINCT FROM 'ACTIVE'
        AND (provider_configuration_snapshot->'active'->>'owner_enabled') IS NOT DISTINCT FROM 'true'
        AND btrim(provider_configuration_snapshot->'active'->>'engine_id') <> ''
        AND btrim(provider_configuration_snapshot->'active'->>'engine_config_revision') <> ''
        AND btrim(provider_configuration_snapshot->'active'->>'capability_profile_version') <> ''
        AND jsonb_typeof(provider_configuration_snapshot->'active'->'qualification')='object'
        AND (provider_configuration_snapshot->'active'->'qualification'->>'qualification_status') IS NOT DISTINCT FROM 'QUALIFIED'
        AND (provider_configuration_snapshot->'active'->'qualification'->>'qualification_scope') IS NOT DISTINCT FROM qualification_scope
        AND (provider_configuration_snapshot->'active'->'qualification'->>'engine_id') IS NOT DISTINCT FROM (provider_configuration_snapshot->'active'->>'engine_id')
        AND (provider_configuration_snapshot->'active'->'qualification'->>'engine_config_revision') IS NOT DISTINCT FROM (provider_configuration_snapshot->'active'->>'engine_config_revision')
        AND (provider_configuration_snapshot->'active'->'qualification'->>'engine_configuration_sha256') IS NOT DISTINCT FROM (provider_configuration_snapshot->'active'->>'engine_configuration_sha256')
        AND (provider_configuration_snapshot->'active'->'qualification'->>'capability_profile_version') IS NOT DISTINCT FROM (provider_configuration_snapshot->'active'->>'capability_profile_version')
        AND btrim(provider_configuration_snapshot->'active'->'qualification'->>'qualification_id') <> ''
        AND btrim(provider_configuration_snapshot->'active'->'qualification'->>'qualified_at') <> ''
        AND btrim(provider_configuration_snapshot->'active'->'qualification'->>'qualified_by') <> ''
        AND btrim(provider_configuration_snapshot->'active'->'qualification'->>'evidence_reference') <> ''
        AND (provider_configuration_snapshot->'active'->>'provider_id') IS NOT DISTINCT FROM primary_provider_id
        AND (provider_configuration_snapshot->'active'->>'channel_id') IS NOT DISTINCT FROM primary_channel_id
        AND (provider_configuration_snapshot->'active'->>'model_id') IS NOT DISTINCT FROM primary_model_id
        AND (
          NOT (provider_configuration_snapshot ? 'candidate')
          OR (
            jsonb_typeof(provider_configuration_snapshot->'candidate')='object'
            AND (provider_configuration_snapshot->'candidate'->>'role') IS NOT DISTINCT FROM 'CANDIDATE'
            AND (provider_configuration_snapshot->'candidate'->>'engine_configuration_sha256') IS NOT DISTINCT FROM intentchord.internal_ai_engine_configuration_sha256_v1(provider_configuration_snapshot->'candidate')
            AND (
              NOT (provider_configuration_snapshot->'candidate' ? 'qualification')
              OR (
                (provider_configuration_snapshot->'candidate'->'qualification'->>'qualification_status') IS NOT DISTINCT FROM 'QUALIFIED'
                AND (provider_configuration_snapshot->'candidate'->'qualification'->>'qualification_scope') IS NOT DISTINCT FROM qualification_scope
                AND (provider_configuration_snapshot->'candidate'->'qualification'->>'engine_id') IS NOT DISTINCT FROM (provider_configuration_snapshot->'candidate'->>'engine_id')
                AND (provider_configuration_snapshot->'candidate'->'qualification'->>'engine_config_revision') IS NOT DISTINCT FROM (provider_configuration_snapshot->'candidate'->>'engine_config_revision')
                AND (provider_configuration_snapshot->'candidate'->'qualification'->>'engine_configuration_sha256') IS NOT DISTINCT FROM (provider_configuration_snapshot->'candidate'->>'engine_configuration_sha256')
                AND (provider_configuration_snapshot->'candidate'->'qualification'->>'capability_profile_version') IS NOT DISTINCT FROM (provider_configuration_snapshot->'candidate'->>'capability_profile_version')
              )
            )
          )
        )
        AND (
          (standby_enabled=false AND NOT (provider_configuration_snapshot ? 'standby'))
          OR (
            standby_enabled=true
            AND jsonb_typeof(provider_configuration_snapshot->'standby')='object'
            AND (provider_configuration_snapshot->'standby'->>'role') IS NOT DISTINCT FROM 'STANDBY'
            AND (provider_configuration_snapshot->'standby'->>'engine_configuration_sha256') IS NOT DISTINCT FROM intentchord.internal_ai_engine_configuration_sha256_v1(provider_configuration_snapshot->'standby')
            AND (provider_configuration_snapshot->'standby'->>'provider_id') IS NOT DISTINCT FROM standby_provider_id
            AND (provider_configuration_snapshot->'standby'->>'channel_id') IS NOT DISTINCT FROM standby_channel_id
            AND (provider_configuration_snapshot->'standby'->>'model_id') IS NOT DISTINCT FROM standby_model_id
            AND jsonb_typeof(provider_configuration_snapshot->'standby'->'qualification')='object'
            AND (provider_configuration_snapshot->'standby'->'qualification'->>'qualification_status') IS NOT DISTINCT FROM 'QUALIFIED'
            AND (provider_configuration_snapshot->'standby'->'qualification'->>'qualification_scope') IS NOT DISTINCT FROM qualification_scope
            AND (provider_configuration_snapshot->'standby'->'qualification'->>'engine_id') IS NOT DISTINCT FROM (provider_configuration_snapshot->'standby'->>'engine_id')
            AND (provider_configuration_snapshot->'standby'->'qualification'->>'engine_config_revision') IS NOT DISTINCT FROM (provider_configuration_snapshot->'standby'->>'engine_config_revision')
            AND (provider_configuration_snapshot->'standby'->'qualification'->>'engine_configuration_sha256') IS NOT DISTINCT FROM (provider_configuration_snapshot->'standby'->>'engine_configuration_sha256')
            AND (provider_configuration_snapshot->'standby'->'qualification'->>'capability_profile_version') IS NOT DISTINCT FROM (provider_configuration_snapshot->'standby'->>'capability_profile_version')
          )
        )
        AND ((provider_configuration_snapshot->'failover_policy'->>'enabled')::boolean) IS NOT DISTINCT FROM standby_enabled
        AND ((provider_configuration_snapshot->'failover_policy'->>'governance_qualified')::boolean) IS NOT DISTINCT FROM (standby_governance_state='QUALIFIED')
        AND (provider_configuration_snapshot->'failover_policy'->>'technical_failure_only') IS NOT DISTINCT FROM 'true'
        AND (provider_configuration_snapshot->'failover_policy'->>'validation_failure_failover') IS NOT DISTINCT FROM 'false'
      )
    )
  );;

ALTER TABLE intentchord.context_mapping_attempts
  ADD COLUMN IF NOT EXISTS qualification_scope text NOT NULL DEFAULT 'AI_CONTEXT_MAPPING_V1';
ALTER TABLE intentchord.context_mapping_attempts
  DROP CONSTRAINT IF EXISTS context_mapping_attempts_qualification_scope_ck,
  DROP CONSTRAINT IF EXISTS context_mapping_attempts_prompt_identity_ck,
  DROP CONSTRAINT IF EXISTS context_mapping_attempts_validation_ck;
ALTER TABLE intentchord.context_mapping_attempts
  ADD CONSTRAINT context_mapping_attempts_qualification_scope_ck CHECK (
    qualification_scope IN ('AI_CONTEXT_MAPPING_V1','AI_CONTEXT_MAPPING_V2')
  ),
  ADD CONSTRAINT context_mapping_attempts_prompt_identity_ck CHECK (
    (
      qualification_scope='AI_CONTEXT_MAPPING_V1'
      AND prompt_template_id='intentchord_ai_context_mapper_system_v1'
      AND prompt_template_sha256='sha256:b7349b1636adaf04291f2bfdde7d34a0ebc91753865cd5e7c06c795ee5bfd477'
    )
    OR
    (
      qualification_scope='AI_CONTEXT_MAPPING_V2'
      AND prompt_template_id='intentchord_ai_context_mapper_system_v2'
      AND prompt_template_sha256='sha256:f55a2bd82ad59aa91bd9818737872bf33d0db0e72f4aeac07b011db9d0192b81'
    )
  ),
  ADD CONSTRAINT context_mapping_attempts_validation_ck CHECK (
    (
      status='SUCCEEDED'
      AND normalized_error_code IS NULL
      AND validation_summary IS NOT NULL
      AND jsonb_typeof(validation_summary)='object'
      AND validation_summary->>'status'='PASS'
      AND jsonb_typeof(validation_summary->'gates')='array'
      AND raw_response_sha256 IS NOT NULL
      AND raw_response_body IS NOT NULL
      AND parsed_catalog_sha256 IS NOT NULL
      AND validation_summary->>'raw_response_sha256'=raw_response_sha256
      AND (
        (qualification_scope='AI_CONTEXT_MAPPING_V1' AND validation_summary->>'parsed_catalog_sha256'=parsed_catalog_sha256)
        OR
        (qualification_scope='AI_CONTEXT_MAPPING_V2' AND validation_summary->>'parsed_analysis_sha256'=parsed_catalog_sha256)
      )
    )
    OR
    (
      status='FAILED_VALIDATION'
      AND normalized_error_code IS NOT NULL
      AND validation_summary IS NOT NULL
      AND jsonb_typeof(validation_summary)='object'
      AND validation_summary->>'status'='FAIL'
      AND jsonb_typeof(validation_summary->'gates')='array'
      AND raw_response_sha256 IS NOT NULL
      AND raw_response_body IS NOT NULL
      AND validation_summary->>'raw_response_sha256'=raw_response_sha256
      AND (
        parsed_catalog_sha256 IS NULL
        OR (qualification_scope='AI_CONTEXT_MAPPING_V1' AND validation_summary->>'parsed_catalog_sha256'=parsed_catalog_sha256)
        OR (qualification_scope='AI_CONTEXT_MAPPING_V2' AND validation_summary->>'parsed_analysis_sha256'=parsed_catalog_sha256)
      )
    )
    OR
    (
      status='FAILED_TECHNICAL'
      AND normalized_error_code IS NOT NULL
      AND validation_summary IS NULL
      AND raw_response_sha256 IS NULL
      AND raw_response_body IS NULL
      AND parsed_catalog_sha256 IS NULL
    )
    OR
    (
      status='RUNNING'
      AND normalized_error_code IS NULL
      AND validation_summary IS NULL
      AND raw_response_sha256 IS NULL
      AND raw_response_body IS NULL
      AND parsed_catalog_sha256 IS NULL
    )
  );

CREATE TABLE IF NOT EXISTS intentchord.context_mapping_v2_results (
  id uuid PRIMARY KEY,
  mapping_run_id uuid NOT NULL UNIQUE REFERENCES intentchord.context_mapping_runs(id) ON DELETE RESTRICT,
  source_attempt_id uuid NOT NULL UNIQUE,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  schema_version text NOT NULL CHECK (schema_version='intentchord.model-context-analysis.v2'),
  analysis_outcome text NOT NULL CHECK (analysis_outcome IN (
    'ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP','ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE'
  )),
  analysis_json jsonb NOT NULL CHECK (jsonb_typeof(analysis_json)='object'),
  analysis_sha256 text NOT NULL CHECK (analysis_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  deterministic_validation_evidence jsonb NOT NULL CHECK (jsonb_typeof(deterministic_validation_evidence)='object'),
  result_envelope jsonb NOT NULL CHECK (jsonb_typeof(result_envelope)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_mapping_v2_results_attempt_run_fk
    FOREIGN KEY (source_attempt_id,mapping_run_id)
    REFERENCES intentchord.context_mapping_attempts(id,mapping_run_id)
    ON DELETE RESTRICT,
  CONSTRAINT context_mapping_v2_results_schema_ck CHECK (
    result_envelope->>'schema_version'='intentchord.context-mapping-result.v2'
    AND result_envelope->>'qualification_scope'='AI_CONTEXT_MAPPING_V2'
  )
);

CREATE TABLE IF NOT EXISTS intentchord.context_assembly_mapping_iterations (
  id uuid PRIMARY KEY,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  mapping_run_id uuid NOT NULL UNIQUE REFERENCES intentchord.context_mapping_runs(id) ON DELETE RESTRICT,
  v2_result_id uuid NOT NULL UNIQUE REFERENCES intentchord.context_mapping_v2_results(id) ON DELETE RESTRICT,
  iteration_ordinal integer NOT NULL CHECK (iteration_ordinal > 0),
  analysis_outcome text NOT NULL CHECK (analysis_outcome IN (
    'ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP','ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_assembly_mapping_iterations_ordinal_uq UNIQUE (context_assembly_revision_id,iteration_ordinal)
);

CREATE TABLE IF NOT EXISTS intentchord.context_missing_evidence_requests (
  id uuid PRIMARY KEY,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  mapping_iteration_id uuid NOT NULL REFERENCES intentchord.context_assembly_mapping_iterations(id) ON DELETE RESTRICT,
  model_gap_id text NOT NULL CHECK (btrim(model_gap_id) <> ''),
  gap_type text NOT NULL CHECK (gap_type IN ('INTERNAL_SOURCE','EXTERNAL_DEPENDENCY','NON_BLOCKING_UNRESOLVED','OPTIONAL_CONTEXT_GAP')),
  materiality text NOT NULL CHECK (materiality IN ('BLOCKING','NON_BLOCKING')),
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
  affected_component_ids jsonb NOT NULL CHECK (jsonb_typeof(affected_component_ids)='array'),
  affected_relationship_ids jsonb NOT NULL CHECK (jsonb_typeof(affected_relationship_ids)='array'),
  known_evidence_entry_ids jsonb NOT NULL CHECK (jsonb_typeof(known_evidence_entry_ids)='array'),
  missing_evidence_description text NOT NULL CHECK (btrim(missing_evidence_description) <> ''),
  required_evidence_kind text NOT NULL CHECK (btrim(required_evidence_kind) <> ''),
  source_hint text,
  blocking_reason text NOT NULL CHECK (btrim(blocking_reason) <> ''),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_missing_evidence_requests_gap_uq UNIQUE (context_assembly_revision_id,mapping_iteration_id,model_gap_id)
);

CREATE TABLE IF NOT EXISTS intentchord.context_gap_classifications (
  id uuid PRIMARY KEY,
  missing_evidence_request_id uuid NOT NULL UNIQUE REFERENCES intentchord.context_missing_evidence_requests(id) ON DELETE RESTRICT,
  classification text NOT NULL CHECK (classification IN ('BLOCKING_INTERNAL_SOURCE_GAP','EXTERNAL_DEPENDENCY','NON_BLOCKING_UNRESOLVED','OPTIONAL_CONTEXT_GAP')),
  candidate_workspace_registration_id uuid REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  classification_evidence jsonb NOT NULL CHECK (jsonb_typeof(classification_evidence)='object'),
  classification_sha256 text NOT NULL CHECK (classification_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  classified_by text NOT NULL DEFAULT 'BACKEND_DETERMINISTIC_VALIDATOR' CHECK (classified_by='BACKEND_DETERMINISTIC_VALIDATOR'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS intentchord.context_material_contradictions (
  id uuid PRIMARY KEY,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  mapping_iteration_id uuid NOT NULL REFERENCES intentchord.context_assembly_mapping_iterations(id) ON DELETE RESTRICT,
  model_contradiction_id text NOT NULL CHECK (btrim(model_contradiction_id)<>''),
  affected_component_ids jsonb NOT NULL CHECK (jsonb_typeof(affected_component_ids)='array'),
  affected_relationship_ids jsonb NOT NULL CHECK (jsonb_typeof(affected_relationship_ids)='array'),
  evidence_entry_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_entry_ids)='array'),
  summary text NOT NULL CHECK (btrim(summary)<>''),
  materiality text NOT NULL CHECK (materiality IN ('BLOCKING','NON_BLOCKING')),
  contradiction_sha256 text NOT NULL CHECK (contradiction_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_material_contradictions_identity_uq UNIQUE(context_assembly_revision_id,mapping_iteration_id,model_contradiction_id)
);

CREATE TABLE IF NOT EXISTS intentchord.context_resolution_requirements (
  id uuid PRIMARY KEY,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  mapping_iteration_id uuid NOT NULL REFERENCES intentchord.context_assembly_mapping_iterations(id) ON DELETE RESTRICT,
  requirement_type text NOT NULL CHECK (requirement_type IN ('MISSING_INTERNAL_EVIDENCE','SOURCE_TRUTH_CONFLICT')),
  originating_missing_evidence_request_id uuid REFERENCES intentchord.context_missing_evidence_requests(id) ON DELETE RESTRICT,
  originating_material_contradiction_id uuid REFERENCES intentchord.context_material_contradictions(id) ON DELETE RESTRICT,
  requirement_sha256 text NOT NULL UNIQUE CHECK (requirement_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_by text NOT NULL DEFAULT 'BACKEND_DETERMINISTIC_VALIDATOR' CHECK (created_by='BACKEND_DETERMINISTIC_VALIDATOR'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_resolution_requirement_origin_ck CHECK (
    (requirement_type='MISSING_INTERNAL_EVIDENCE' AND originating_missing_evidence_request_id IS NOT NULL AND originating_material_contradiction_id IS NULL)
    OR (requirement_type='SOURCE_TRUTH_CONFLICT' AND originating_missing_evidence_request_id IS NULL AND originating_material_contradiction_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS intentchord.context_source_authorizations (
  id uuid PRIMARY KEY,
  resolution_requirement_id uuid NOT NULL REFERENCES intentchord.context_resolution_requirements(id) ON DELETE RESTRICT,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  missing_evidence_request_id uuid NOT NULL REFERENCES intentchord.context_missing_evidence_requests(id) ON DELETE RESTRICT,
  workspace_registration_id uuid NOT NULL REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  workspace_registration_revision bigint NOT NULL CHECK (workspace_registration_revision >= 0),
  workspace_registration_fingerprint text NOT NULL CHECK (workspace_registration_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE RESTRICT,
  task_revision bigint NOT NULL CHECK (task_revision >= 0),
  decision text NOT NULL CHECK (decision IN ('APPROVE','DENY')),
  owner_reference text NOT NULL CHECK (btrim(owner_reference) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_source_authorizations_requirement_workspace_uq UNIQUE (resolution_requirement_id,workspace_registration_id)
);

CREATE TABLE IF NOT EXISTS intentchord.context_forward_authority_consumptions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES intentchord.tasks(id) ON DELETE RESTRICT,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  task_draft_revision_id uuid NOT NULL REFERENCES intentchord.task_draft_revisions(id) ON DELETE RESTRICT,
  scope_authority_input_sha256 text NOT NULL CHECK (scope_authority_input_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_scope_sha256 text NOT NULL CHECK (candidate_scope_sha256 ~ '^(?:sha256:)?[0-9a-f]{64}$'),
  contract_revision_id uuid NOT NULL REFERENCES intentchord.contract_revisions(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL UNIQUE REFERENCES intentchord.runs(id) ON DELETE RESTRICT,
  consumption_type text NOT NULL CHECK (consumption_type='SOURCE_MUTATING_RUN_STARTED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_forward_authority_consumptions_identity_uq UNIQUE(
    task_id,context_assembly_revision_id,contract_revision_id,run_id,consumption_type
  )
);

CREATE TABLE IF NOT EXISTS intentchord.context_resolution_events (
  id uuid PRIMARY KEY,
  resolution_requirement_id uuid NOT NULL REFERENCES intentchord.context_resolution_requirements(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('CANDIDATE_SOURCE_IDENTIFIED','OWNER_AUTHORIZED_SOURCE','OWNER_DENIED_SOURCE','SOURCE_UNAVAILABLE','SOURCE_TRUTH_CORRECTION_REQUIRED','SUPERSEDED_BY_NEW_ASSEMBLY')),
  actor_authority text NOT NULL CHECK (btrim(actor_authority)<>''),
  source_authorization_id uuid REFERENCES intentchord.context_source_authorizations(id) ON DELETE RESTRICT,
  related_workspace_registration_id uuid REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  successor_context_assembly_revision_id uuid REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS intentchord.context_closure_evaluations (
  id uuid PRIMARY KEY,
  context_assembly_revision_id uuid NOT NULL REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  mapping_iteration_id uuid NOT NULL REFERENCES intentchord.context_assembly_mapping_iterations(id) ON DELETE RESTRICT,
  contract_version text NOT NULL CHECK (contract_version='intentchord.context-closure.v1'),
  evaluation_input_sha256 text NOT NULL CHECK (evaluation_input_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('PASS','BLOCKED')),
  reason_code text NOT NULL CHECK (btrim(reason_code) <> ''),
  gate_evidence jsonb NOT NULL CHECK (jsonb_typeof(gate_evidence)='object'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  decided_by text NOT NULL DEFAULT 'BACKEND_DETERMINISTIC_VALIDATOR' CHECK (decided_by='BACKEND_DETERMINISTIC_VALIDATOR'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_closure_evaluations_input_uq UNIQUE(context_assembly_revision_id,mapping_iteration_id,evaluation_input_sha256)
);

CREATE TABLE IF NOT EXISTS intentchord.context_catalog_revisions (
  id uuid PRIMARY KEY,
  context_assembly_revision_id uuid NOT NULL UNIQUE REFERENCES intentchord.context_assembly_revisions(id) ON DELETE RESTRICT,
  mapping_iteration_id uuid NOT NULL REFERENCES intentchord.context_assembly_mapping_iterations(id) ON DELETE RESTRICT,
  closure_evaluation_id uuid NOT NULL UNIQUE REFERENCES intentchord.context_closure_evaluations(id) ON DELETE RESTRICT,
  schema_version text NOT NULL CHECK (schema_version='intentchord.accepted-context-catalog.v1'),
  catalog_json jsonb NOT NULL CHECK (jsonb_typeof(catalog_json)='object'),
  catalog_sha256 text NOT NULL CHECK (catalog_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS context_assembly_revisions_assembly_idx ON intentchord.context_assembly_revisions(context_assembly_id,revision DESC);
CREATE INDEX IF NOT EXISTS context_assembly_sources_revision_idx ON intentchord.context_assembly_sources(context_assembly_revision_id,ordering);
CREATE INDEX IF NOT EXISTS context_missing_evidence_revision_idx ON intentchord.context_missing_evidence_requests(context_assembly_revision_id,created_at);
CREATE INDEX IF NOT EXISTS context_resolution_requirements_revision_idx ON intentchord.context_resolution_requirements(context_assembly_revision_id,created_at);
CREATE INDEX IF NOT EXISTS context_resolution_events_requirement_idx ON intentchord.context_resolution_events(resolution_requirement_id,created_at);
CREATE INDEX IF NOT EXISTS context_source_authorizations_revision_idx ON intentchord.context_source_authorizations(context_assembly_revision_id,created_at);
CREATE INDEX IF NOT EXISTS context_source_authorizations_task_revision_idx ON intentchord.context_source_authorizations(task_id,task_revision,created_at);
CREATE INDEX IF NOT EXISTS context_forward_authority_consumptions_context_idx
  ON intentchord.context_forward_authority_consumptions(task_id,context_assembly_revision_id,created_at);
CREATE INDEX IF NOT EXISTS context_forward_authority_consumptions_contract_idx
  ON intentchord.context_forward_authority_consumptions(contract_revision_id,created_at);

CREATE OR REPLACE FUNCTION intentchord.context_assembly_history_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_HISTORY_APPEND_ONLY';
END;
$$;


DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'context_assemblies','context_assembly_revisions','context_assembly_sources','context_mapping_v2_results','context_assembly_mapping_iterations',
    'context_missing_evidence_requests','context_gap_classifications','context_material_contradictions','context_resolution_requirements',
    'context_source_authorizations','context_forward_authority_consumptions','context_resolution_events','context_closure_evaluations','context_catalog_revisions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only ON intentchord.%I',t,t);
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON intentchord.%I FOR EACH ROW EXECUTE FUNCTION intentchord.context_assembly_history_append_only()',t,t);
  END LOOP;
END;
$$;

-- V2 source binding guard: validates workspace and snapshot truth (extended in 015 to validate WEA).
CREATE OR REPLACE FUNCTION intentchord.context_assembly_source_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s intentchord.workspace_index_snapshots%ROWTYPE;
  w intentchord.workspaces%ROWTYPE;
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
     OR s.workspace_revision_id IS DISTINCT FROM NEW.workspace_revision_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_ASSEMBLY_READY_INDEX_BINDING_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_assembly_sources_insert_guard ON intentchord.context_assembly_sources;
CREATE TRIGGER context_assembly_sources_insert_guard BEFORE INSERT ON intentchord.context_assembly_sources
FOR EACH ROW EXECUTE FUNCTION intentchord.context_assembly_source_insert_guard();

-- Replace the single-Snapshot V1 insert guard with version-aware source authority.
CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_insert_snapshot_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_row intentchord.workspace_index_snapshots%ROWTYPE; revision_row intentchord.context_assembly_revisions%ROWTYPE;
BEGIN
  IF NEW.qualification_scope='AI_CONTEXT_MAPPING_V1' THEN
    IF NEW.workspace_index_snapshot_id IS NULL OR NEW.mapping_idempotency_key IS NULL OR btrim(NEW.mapping_idempotency_key)='' OR NEW.mapping_request_fingerprint_sha256 IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED';
    END IF;
    SELECT * INTO snapshot_row FROM intentchord.workspace_index_snapshots WHERE id=NEW.workspace_index_snapshot_id;
    IF NOT FOUND OR snapshot_row.status<>'READY' THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_READY_SNAPSHOT_REQUIRED'; END IF;
    IF NEW.workspace_index_sha256 IS DISTINCT FROM snapshot_row.canonical_sha256 THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_HASH_MISMATCH'; END IF;
  ELSIF NEW.qualification_scope='AI_CONTEXT_MAPPING_V2' THEN
    IF NEW.context_assembly_revision_id IS NULL OR NEW.context_assembly_sha256 IS NULL OR NEW.workspace_index_snapshot_id IS NOT NULL
       OR NEW.mapping_idempotency_key IS NULL OR btrim(NEW.mapping_idempotency_key)='' OR NEW.mapping_request_fingerprint_sha256 IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_ASSEMBLY_BINDING_REQUIRED';
    END IF;
    SELECT * INTO revision_row FROM intentchord.context_assembly_revisions WHERE id=NEW.context_assembly_revision_id FOR UPDATE;
    IF NOT FOUND OR revision_row.assembly_sha256 IS DISTINCT FROM NEW.context_assembly_sha256 THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_ASSEMBLY_IDENTITY_MISMATCH';
    END IF;
  ELSE
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_QUALIFICATION_SCOPE_UNSUPPORTED';
  END IF;
  RETURN NEW;
END;
$$;

-- Exact qualification remains mandatory and now matches the run's explicit semantic scope.
CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_insert_guard_v014()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_configuration_snapshot->>'schema_version' IS DISTINCT FROM 'intentchord.internal-ai-provider-configuration.v3'
     OR NEW.provider_configuration_snapshot->>'registry_schema_version' IS DISTINCT FROM 'intentchord.internal-ai-engine-registry.v2'
     OR NEW.provider_configuration_snapshot->'selection_policy'->>'selection_mode' IS DISTINCT FROM 'SINGLE'
     OR NEW.provider_configuration_snapshot->'active'->'qualification'->>'qualification_scope' IS DISTINCT FROM NEW.qualification_scope
     OR NEW.provider_configuration_snapshot->'active'->'qualification'->>'qualification_status' IS DISTINCT FROM 'QUALIFIED'
     OR NEW.provider_configuration_snapshot->>'selected_engine_id' IS DISTINCT FROM NEW.provider_configuration_snapshot->'active'->>'engine_id'
     OR NEW.provider_configuration_snapshot->>'selected_engine_config_revision' IS DISTINCT FROM NEW.provider_configuration_snapshot->'active'->>'engine_config_revision'
     OR NEW.provider_configuration_snapshot->>'selected_engine_configuration_sha256' IS DISTINCT FROM NEW.provider_configuration_snapshot->'active'->>'engine_configuration_sha256'
     OR NEW.provider_configuration_snapshot->'active'->'qualification'->>'engine_configuration_sha256' IS DISTINCT FROM NEW.provider_configuration_snapshot->'active'->>'engine_configuration_sha256'
     OR NEW.provider_configuration_snapshot->'active'->>'engine_configuration_sha256' IS DISTINCT FROM intentchord.internal_ai_engine_configuration_sha256_v1(NEW.provider_configuration_snapshot->'active')
  THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_RUNTIME_CONFIGURATION_EXACT_QUALIFICATION_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_mapping_runs_runtime_configuration_v013 ON intentchord.context_mapping_runs;
DROP TRIGGER IF EXISTS context_mapping_runs_runtime_configuration_v014 ON intentchord.context_mapping_runs;
CREATE TRIGGER context_mapping_runs_runtime_configuration_v014
BEFORE INSERT ON intentchord.context_mapping_runs
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_run_insert_guard_v014();

CREATE OR REPLACE FUNCTION intentchord.context_mapping_attempt_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_row intentchord.context_mapping_runs%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_ORPHAN'; END IF;
  IF NEW.qualification_scope IS DISTINCT FROM run_row.qualification_scope THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_SCOPE_MISMATCH';
  END IF;
  IF NEW.attempt_ordinal=1 THEN
    IF run_row.status<>'PRIMARY_RUNNING' THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_PRIMARY_ATTEMPT_STATE_BLOCKED'; END IF;
    IF NEW.provider_id IS DISTINCT FROM run_row.primary_provider_id OR NEW.channel_id IS DISTINCT FROM run_row.primary_channel_id OR NEW.requested_model_id IS DISTINCT FROM run_row.primary_model_id THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_PRIMARY_ATTEMPT_ENGINE_MISMATCH';
    END IF;
  ELSIF NEW.attempt_ordinal=2 THEN
    IF run_row.status<>'STANDBY_RUNNING' OR run_row.standby_enabled=false OR run_row.standby_governance_state<>'QUALIFIED' THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_STANDBY_ATTEMPT_GOVERNANCE_BLOCKED';
    END IF;
    IF NEW.provider_id IS DISTINCT FROM run_row.standby_provider_id OR NEW.channel_id IS DISTINCT FROM run_row.standby_channel_id OR NEW.requested_model_id IS DISTINCT FROM run_row.standby_model_id THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_STANDBY_ATTEMPT_ENGINE_MISMATCH';
    END IF;
  ELSE RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_ORDINAL_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.context_mapping_v2_result_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt_row intentchord.context_mapping_attempts%ROWTYPE; run_row intentchord.context_mapping_runs%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row FROM intentchord.context_mapping_attempts WHERE id=NEW.source_attempt_id AND mapping_run_id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.status<>'SUCCEEDED' OR attempt_row.qualification_scope<>'AI_CONTEXT_MAPPING_V2' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_RESULT_REQUIRES_SUCCEEDED_V2_ATTEMPT';
  END IF;
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND OR run_row.status<>'VALIDATING' OR run_row.qualification_scope<>'AI_CONTEXT_MAPPING_V2'
     OR run_row.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_RESULT_RUN_BINDING_MISMATCH';
  END IF;
  IF NEW.deterministic_validation_evidence->>'status' IS DISTINCT FROM 'PASS'
     OR NEW.deterministic_validation_evidence->>'parsed_analysis_sha256' IS DISTINCT FROM NEW.analysis_sha256
     OR NEW.result_envelope->>'mapping_run_id' IS DISTINCT FROM NEW.mapping_run_id::text
     OR NEW.result_envelope->>'attempt_id' IS DISTINCT FROM NEW.source_attempt_id::text
     OR NEW.result_envelope->>'context_assembly_revision_id' IS DISTINCT FROM NEW.context_assembly_revision_id::text
     OR NEW.result_envelope->>'prompt_template_id' IS DISTINCT FROM attempt_row.prompt_template_id
     OR NEW.result_envelope->>'prompt_template_sha256' IS DISTINCT FROM attempt_row.prompt_template_sha256
     OR NEW.result_envelope->>'raw_response_sha256' IS DISTINCT FROM attempt_row.raw_response_sha256
     OR NEW.result_envelope->>'parsed_analysis_sha256' IS DISTINCT FROM NEW.analysis_sha256
     OR NEW.result_envelope->'model_analysis' IS DISTINCT FROM NEW.analysis_json
     OR NEW.result_envelope->'validation_result' IS DISTINCT FROM NEW.deterministic_validation_evidence THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_RESULT_PROVENANCE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_mapping_v2_results_insert_guard ON intentchord.context_mapping_v2_results;
CREATE TRIGGER context_mapping_v2_results_insert_guard BEFORE INSERT ON intentchord.context_mapping_v2_results
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_v2_result_insert_guard();


-- A Mapping Iteration is admitted understanding, not execution history. It may only bind
-- an exact successfully validated V2 result/run for the same immutable Assembly Revision.
CREATE OR REPLACE FUNCTION intentchord.context_mapping_iteration_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_row intentchord.context_mapping_runs%ROWTYPE; result_row intentchord.context_mapping_v2_results%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  SELECT * INTO result_row FROM intentchord.context_mapping_v2_results WHERE id=NEW.v2_result_id;
  IF run_row.id IS NULL OR result_row.id IS NULL
     OR run_row.status<>'VALIDATING'
     OR run_row.qualification_scope<>'AI_CONTEXT_MAPPING_V2'
     OR run_row.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id
     OR result_row.mapping_run_id IS DISTINCT FROM NEW.mapping_run_id
     OR result_row.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id
     OR result_row.analysis_outcome IS DISTINCT FROM NEW.analysis_outcome
     OR result_row.deterministic_validation_evidence->>'status' IS DISTINCT FROM 'PASS'
  THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ITERATION_VALIDATED_RESULT_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_assembly_mapping_iterations_insert_guard ON intentchord.context_assembly_mapping_iterations;
CREATE TRIGGER context_assembly_mapping_iterations_insert_guard BEFORE INSERT ON intentchord.context_assembly_mapping_iterations
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_iteration_insert_guard();

-- Missing Evidence and Material Contradiction provenance must be exact members of the
-- admitted V2 analysis. Frontend/arbitrary text cannot manufacture either authority fact.
CREATE OR REPLACE FUNCTION intentchord.context_missing_evidence_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i intentchord.context_assembly_mapping_iterations%ROWTYPE; r intentchord.context_mapping_v2_results%ROWTYPE; model_gap jsonb;
BEGIN
  SELECT * INTO i FROM intentchord.context_assembly_mapping_iterations WHERE id=NEW.mapping_iteration_id;
  IF NOT FOUND OR i.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MISSING_EVIDENCE_ITERATION_MISMATCH';
  END IF;
  SELECT * INTO r FROM intentchord.context_mapping_v2_results WHERE id=i.v2_result_id;
  SELECT value INTO model_gap FROM jsonb_array_elements(r.analysis_json->'missing_evidence_requests') value WHERE value->>'gap_id'=NEW.model_gap_id LIMIT 1;
  IF model_gap IS NULL
     OR model_gap->>'gap_type' IS DISTINCT FROM NEW.gap_type
     OR model_gap->>'materiality' IS DISTINCT FROM NEW.materiality
     OR model_gap->>'confidence' IS DISTINCT FROM NEW.confidence
     OR model_gap->'affected_component_ids' IS DISTINCT FROM NEW.affected_component_ids
     OR model_gap->'affected_relationship_ids' IS DISTINCT FROM NEW.affected_relationship_ids
     OR model_gap->'known_evidence_entry_ids' IS DISTINCT FROM NEW.known_evidence_entry_ids
     OR model_gap->>'missing_evidence_description' IS DISTINCT FROM NEW.missing_evidence_description
     OR model_gap->>'required_evidence_kind' IS DISTINCT FROM NEW.required_evidence_kind
     OR nullif(model_gap->>'source_hint','') IS DISTINCT FROM NEW.source_hint
     OR model_gap->>'blocking_reason' IS DISTINCT FROM NEW.blocking_reason
  THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MISSING_EVIDENCE_MODEL_PROVENANCE_MISMATCH'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_missing_evidence_requests_insert_guard ON intentchord.context_missing_evidence_requests;
CREATE TRIGGER context_missing_evidence_requests_insert_guard BEFORE INSERT ON intentchord.context_missing_evidence_requests
FOR EACH ROW EXECUTE FUNCTION intentchord.context_missing_evidence_insert_guard();

CREATE OR REPLACE FUNCTION intentchord.context_material_contradiction_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i intentchord.context_assembly_mapping_iterations%ROWTYPE; r intentchord.context_mapping_v2_results%ROWTYPE; model_ctr jsonb;
BEGIN
  SELECT * INTO i FROM intentchord.context_assembly_mapping_iterations WHERE id=NEW.mapping_iteration_id;
  IF NOT FOUND OR i.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CONTRADICTION_ITERATION_MISMATCH';
  END IF;
  SELECT * INTO r FROM intentchord.context_mapping_v2_results WHERE id=i.v2_result_id;
  SELECT value INTO model_ctr FROM jsonb_array_elements(r.analysis_json->'material_contradictions') value WHERE value->>'contradiction_id'=NEW.model_contradiction_id LIMIT 1;
  IF model_ctr IS NULL
     OR model_ctr->'affected_component_ids' IS DISTINCT FROM NEW.affected_component_ids
     OR model_ctr->'affected_relationship_ids' IS DISTINCT FROM NEW.affected_relationship_ids
     OR model_ctr->'evidence_entry_ids' IS DISTINCT FROM NEW.evidence_entry_ids
     OR model_ctr->>'summary' IS DISTINCT FROM NEW.summary
     OR model_ctr->>'materiality' IS DISTINCT FROM NEW.materiality
  THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CONTRADICTION_MODEL_PROVENANCE_MISMATCH'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_material_contradictions_insert_guard ON intentchord.context_material_contradictions;
CREATE TRIGGER context_material_contradictions_insert_guard BEFORE INSERT ON intentchord.context_material_contradictions
FOR EACH ROW EXECUTE FUNCTION intentchord.context_material_contradiction_insert_guard();

CREATE OR REPLACE FUNCTION intentchord.context_catalog_revision_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evaluation_row intentchord.context_closure_evaluations%ROWTYPE; iteration_row intentchord.context_assembly_mapping_iterations%ROWTYPE; assembly_task_id uuid; assembly_id uuid;
BEGIN
  SELECT * INTO evaluation_row FROM intentchord.context_closure_evaluations WHERE id=NEW.closure_evaluation_id;
  IF NOT FOUND OR evaluation_row.decision<>'PASS' OR evaluation_row.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id OR evaluation_row.mapping_iteration_id IS DISTINCT FROM NEW.mapping_iteration_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_REQUIRES_EXACT_PASS_CLOSURE_EVALUATION';
  END IF;
  SELECT * INTO iteration_row FROM intentchord.context_assembly_mapping_iterations WHERE id=NEW.mapping_iteration_id;
  IF NOT FOUND OR iteration_row.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_MAPPING_ITERATION_MISMATCH';
  END IF;
  IF NEW.catalog_json->>'context_assembly_revision_id' IS DISTINCT FROM NEW.context_assembly_revision_id::text
     OR NEW.catalog_json->>'mapping_iteration_id' IS DISTINCT FROM NEW.mapping_iteration_id::text
     OR NEW.catalog_json->>'closure_evaluation_id' IS DISTINCT FROM NEW.closure_evaluation_id::text THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_JSON_PROVENANCE_MISMATCH';
  END IF;
  SELECT a.task_id,ar.context_assembly_id INTO assembly_task_id,assembly_id
    FROM intentchord.context_assembly_revisions ar
    JOIN intentchord.context_assemblies a ON a.id=ar.context_assembly_id
   WHERE ar.id=NEW.context_assembly_revision_id;
  IF assembly_task_id IS NULL OR assembly_id IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_CURRENT_EFFECTIVE_CONTEXT_REQUIRED';
  END IF;
  -- Same global forward-authority lock order as Closure PASS and Backend commands.
  PERFORM 1 FROM intentchord.tasks WHERE id=assembly_task_id FOR UPDATE;
  PERFORM 1 FROM intentchord.context_assemblies WHERE id=assembly_id FOR UPDATE;
  PERFORM w.id
    FROM intentchord.workspaces w
   WHERE w.id IN (
     SELECT cas.workspace_registration_id
       FROM intentchord.context_assembly_sources cas
      WHERE cas.context_assembly_revision_id=NEW.context_assembly_revision_id
     UNION
     SELECT tws.workspace_registration_id
       FROM intentchord.task_workspace_snapshots tws
      WHERE tws.draft_revision_id=(
        SELECT dr.id FROM intentchord.task_draft_revisions dr
         WHERE dr.task_id=assembly_task_id ORDER BY dr.revision DESC LIMIT 1
      )
   )
   ORDER BY w.id
   FOR UPDATE OF w;
  IF intentchord.current_effective_context_authority_status(assembly_task_id,NEW.context_assembly_revision_id)<>'CURRENT' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_CURRENT_EFFECTIVE_CONTEXT_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_catalog_revisions_insert_guard ON intentchord.context_catalog_revisions;
CREATE TRIGGER context_catalog_revisions_insert_guard BEFORE INSERT ON intentchord.context_catalog_revisions
FOR EACH ROW EXECUTE FUNCTION intentchord.context_catalog_revision_insert_guard();

-- Version-aware run transition authority. V1 semantics are retained byte-for-byte in effect;
-- V2 terminates in backend-owned analysis outcomes and never enters Owner proposal review.
CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_governed_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean := false; total_contexts integer; accepted_contexts integer; rejected_contexts integer;
BEGIN
  IF ROW(
    NEW.mapping_input_snapshot_id,NEW.mapping_input_sha256,NEW.mapping_input_snapshot,
    NEW.workspace_index_contract_version,NEW.workspace_snapshot_id,NEW.workspace_index_sha256,
    NEW.eligible_entry_count,NEW.excluded_entry_count,NEW.provider_neutral_estimated_tokens,
    NEW.primary_provider_id,NEW.primary_channel_id,NEW.primary_model_id,
    NEW.standby_provider_id,NEW.standby_channel_id,NEW.standby_model_id,
    NEW.standby_enabled,NEW.standby_governance_state,NEW.provider_configuration_snapshot,
    NEW.workspace_index_snapshot_id,NEW.mapping_idempotency_key,NEW.mapping_request_fingerprint_sha256,
    NEW.qualification_scope,NEW.context_assembly_revision_id,NEW.context_assembly_sha256,NEW.execution_deadline_at,NEW.deadline_policy_version,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.mapping_input_snapshot_id,OLD.mapping_input_sha256,OLD.mapping_input_snapshot,
    OLD.workspace_index_contract_version,OLD.workspace_snapshot_id,OLD.workspace_index_sha256,
    OLD.eligible_entry_count,OLD.excluded_entry_count,OLD.provider_neutral_estimated_tokens,
    OLD.primary_provider_id,OLD.primary_channel_id,OLD.primary_model_id,
    OLD.standby_provider_id,OLD.standby_channel_id,OLD.standby_model_id,
    OLD.standby_enabled,OLD.standby_governance_state,OLD.provider_configuration_snapshot,
    OLD.workspace_index_snapshot_id,OLD.mapping_idempotency_key,OLD.mapping_request_fingerprint_sha256,
    OLD.qualification_scope,OLD.context_assembly_revision_id,OLD.context_assembly_sha256,OLD.execution_deadline_at,OLD.deadline_policy_version,OLD.created_at
  ) THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_RUN_IMMUTABLE_BINDING'; END IF;

  IF NEW.status=OLD.status THEN allowed:=true;
  ELSIF OLD.status='CREATED' AND NEW.status='INPUT_VALIDATED' THEN allowed:=true;
  ELSIF OLD.status='INPUT_VALIDATED' AND NEW.status='PRIMARY_RUNNING' THEN allowed:=true;
  ELSIF OLD.status='PRIMARY_RUNNING' AND NEW.status IN ('VALIDATING','PRIMARY_FAILED_TECHNICAL','FAILED') THEN allowed:=true;
  ELSIF OLD.status='PRIMARY_FAILED_TECHNICAL' AND NEW.status IN ('STANDBY_BLOCKED_GOVERNANCE','STANDBY_RUNNING') THEN allowed:=true;
  ELSIF OLD.status='STANDBY_RUNNING' AND NEW.status IN ('VALIDATING','FAILED') THEN allowed:=true;
  ELSIF OLD.status='VALIDATING' AND NEW.qualification_scope='AI_CONTEXT_MAPPING_V1' AND NEW.status IN ('AWAITING_OWNER_REVIEW','REJECTED_VALIDATION','FAILED') THEN allowed:=true;
  ELSIF OLD.status='VALIDATING' AND NEW.qualification_scope='AI_CONTEXT_MAPPING_V2' AND NEW.status IN ('ANALYSIS_COMPLETE','ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE','REJECTED_VALIDATION','FAILED') THEN allowed:=true;
  ELSIF NEW.qualification_scope='AI_CONTEXT_MAPPING_V2' AND NEW.status='FAILED' AND NEW.terminal_reason_code='ORPHANED_ACTIVE_MAPPING_EXECUTION' AND OLD.status IN ('CREATED','INPUT_VALIDATED','PRIMARY_RUNNING','PRIMARY_FAILED_TECHNICAL','STANDBY_RUNNING','VALIDATING') AND OLD.execution_deadline_at IS NOT NULL AND clock_timestamp()>OLD.execution_deadline_at THEN allowed:=true;
  ELSIF OLD.status='AWAITING_OWNER_REVIEW' AND NEW.qualification_scope='AI_CONTEXT_MAPPING_V1' AND NEW.status IN ('OWNER_ACCEPTED','OWNER_REJECTED') THEN allowed:=true;
  END IF;
  IF NOT allowed THEN RAISE EXCEPTION 'AI_CONTEXT_MAPPING_RUN_TRANSITION_BLOCKED:%->%',OLD.status,NEW.status; END IF;

  IF OLD.terminal_reason_code IS NOT NULL AND NEW.terminal_reason_code IS DISTINCT FROM OLD.terminal_reason_code THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_TERMINAL_REASON_IMMUTABLE'; END IF;
  IF NEW.terminal_reason_code IS NOT NULL AND NEW.status NOT IN ('FAILED','REJECTED_VALIDATION','STANDBY_BLOCKED_GOVERNANCE') THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_TERMINAL_REASON_STATE_INVALID'; END IF;
  IF OLD.final_attempt_id IS NOT NULL AND NEW.final_attempt_id IS NULL THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_CANNOT_CLEAR'; END IF;
  IF NEW.final_attempt_id IS NOT NULL AND NEW.final_attempt_id IS DISTINCT FROM OLD.final_attempt_id THEN
    IF OLD.final_attempt_id IS NOT NULL AND NOT (OLD.status IN ('STANDBY_RUNNING','VALIDATING') AND EXISTS(
      SELECT 1 FROM intentchord.context_mapping_attempts WHERE id=NEW.final_attempt_id AND mapping_run_id=NEW.id AND attempt_ordinal=2 AND status<>'RUNNING'
    )) THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_REPLACEMENT_BLOCKED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM intentchord.context_mapping_attempts WHERE id=NEW.final_attempt_id AND mapping_run_id=NEW.id AND status<>'RUNNING') THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_NOT_COMPLETED';
    END IF;
  END IF;

  IF NEW.status IN ('PRIMARY_FAILED_TECHNICAL','STANDBY_BLOCKED_GOVERNANCE','REJECTED_VALIDATION','FAILED','AWAITING_OWNER_REVIEW','OWNER_ACCEPTED','OWNER_REJECTED','ANALYSIS_COMPLETE','ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE')
     AND NEW.final_attempt_id IS NULL AND NOT (NEW.qualification_scope='AI_CONTEXT_MAPPING_V2' AND NEW.status='FAILED' AND NEW.terminal_reason_code='ORPHANED_ACTIVE_MAPPING_EXECUTION') THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_FINAL_ATTEMPT_REQUIRED'; END IF;

  IF NEW.qualification_scope='AI_CONTEXT_MAPPING_V1' AND NEW.status='AWAITING_OWNER_REVIEW' AND NOT EXISTS(
    SELECT 1 FROM intentchord.context_catalog_proposals WHERE mapping_run_id=NEW.id AND source_attempt_id=NEW.final_attempt_id
  ) THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_VALIDATED_PROPOSAL_REQUIRED'; END IF;

  IF NEW.qualification_scope='AI_CONTEXT_MAPPING_V2' AND NEW.status IN ('ANALYSIS_COMPLETE','ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE') AND NOT EXISTS(
    SELECT 1 FROM intentchord.context_mapping_v2_results WHERE mapping_run_id=NEW.id AND source_attempt_id=NEW.final_attempt_id
  ) THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_VALIDATED_RESULT_REQUIRED'; END IF;

  IF NEW.qualification_scope='AI_CONTEXT_MAPPING_V2' AND NEW.owner_verdict_state<>'PENDING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_V2_OWNER_VERDICT_FORBIDDEN';
  END IF;

  IF NEW.qualification_scope='AI_CONTEXT_MAPPING_V1' THEN
    IF NEW.status='OWNER_ACCEPTED' AND NEW.owner_verdict_state<>'ACCEPTED' THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_STATE_MISMATCH';
    ELSIF NEW.status='OWNER_REJECTED' AND NEW.owner_verdict_state<>'REJECTED' THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_STATE_MISMATCH';
    ELSIF NEW.status NOT IN ('OWNER_ACCEPTED','OWNER_REJECTED') AND NEW.owner_verdict_state<>'PENDING' THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_STATE_PREMATURE';
    END IF;
    IF NEW.status IN ('OWNER_ACCEPTED','OWNER_REJECTED') THEN
      IF NOT EXISTS(SELECT 1 FROM intentchord.context_mapping_owner_verdicts WHERE mapping_run_id=NEW.id AND verdict=CASE WHEN NEW.status='OWNER_ACCEPTED' THEN 'ACCEPT' ELSE 'REJECT' END) THEN
        RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_VERDICT_RECORD_REQUIRED';
      END IF;
      SELECT jsonb_array_length(proposal_json->'contexts') INTO total_contexts FROM intentchord.context_catalog_proposals WHERE mapping_run_id=NEW.id;
      SELECT count(*) FILTER(WHERE decision='ACCEPT'),count(*) FILTER(WHERE decision='REJECT') INTO accepted_contexts,rejected_contexts
      FROM intentchord.context_mapping_owner_context_decisions WHERE mapping_run_id=NEW.id;
      IF total_contexts IS NULL OR accepted_contexts+rejected_contexts<>total_contexts THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_INCOMPLETE'; END IF;
      IF NEW.status='OWNER_ACCEPTED' AND accepted_contexts<1 THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_STATE_CONFLICT'; END IF;
      IF NEW.status='OWNER_REJECTED' AND (accepted_contexts<>0 OR rejected_contexts<>total_contexts) THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_STATE_CONFLICT'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Closure is an immutable evaluation over an exact admitted Mapping Iteration and governance fact-set.
CREATE OR REPLACE FUNCTION intentchord.context_closure_evaluation_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  iteration_row intentchord.context_assembly_mapping_iterations%ROWTYPE;
  run_row intentchord.context_mapping_runs%ROWTYPE;
  result_row intentchord.context_mapping_v2_results%ROWTYPE;
  missing_request_count integer;
  backend_classification_count integer;
  unclassified_missing_evidence_count integer;
  assembly_task_id uuid;
  assembly_id uuid;
BEGIN
  SELECT * INTO iteration_row FROM intentchord.context_assembly_mapping_iterations WHERE id=NEW.mapping_iteration_id;
  IF NOT FOUND OR iteration_row.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CLOSURE_EXACT_ITERATION_REQUIRED'; END IF;
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=iteration_row.mapping_run_id;
  SELECT * INTO result_row FROM intentchord.context_mapping_v2_results WHERE id=iteration_row.v2_result_id;
  IF run_row.id IS NULL OR result_row.id IS NULL OR run_row.qualification_scope<>'AI_CONTEXT_MAPPING_V2' OR run_row.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id OR result_row.mapping_run_id IS DISTINCT FROM run_row.id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CLOSURE_MAPPING_PROVENANCE_MISMATCH';
  END IF;
  SELECT count(*)::integer,
         count(c.id)::integer,
         count(*) FILTER (WHERE c.id IS NULL)::integer
    INTO missing_request_count,backend_classification_count,unclassified_missing_evidence_count
    FROM intentchord.context_missing_evidence_requests r
    LEFT JOIN intentchord.context_gap_classifications c ON c.missing_evidence_request_id=r.id
   WHERE r.mapping_iteration_id=NEW.mapping_iteration_id;
  IF NEW.decision='PASS' AND (
       missing_request_count <> backend_classification_count
       OR unclassified_missing_evidence_count <> 0
     ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CLOSURE_EXACT_MISSING_EVIDENCE_CLASSIFICATION_REQUIRED';
  END IF;
  IF NEW.decision='PASS' THEN
    SELECT a.task_id,ar.context_assembly_id INTO assembly_task_id,assembly_id
      FROM intentchord.context_assembly_revisions ar
      JOIN intentchord.context_assemblies a ON a.id=ar.context_assembly_id
     WHERE ar.id=NEW.context_assembly_revision_id;
    IF assembly_task_id IS NULL OR assembly_id IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CLOSURE_CURRENT_EFFECTIVE_CONTEXT_REQUIRED';
    END IF;
    -- Global forward-authority lock order defense-in-depth:
    -- TASK -> CONTEXT ASSEMBLY PARENT -> ALL current/frozen Workspace Registrations by global ID.
    PERFORM 1 FROM intentchord.tasks WHERE id=assembly_task_id FOR UPDATE;
    PERFORM 1 FROM intentchord.context_assemblies WHERE id=assembly_id FOR UPDATE;
    PERFORM w.id
      FROM intentchord.workspaces w
     WHERE w.id IN (
       SELECT cas.workspace_registration_id
         FROM intentchord.context_assembly_sources cas
        WHERE cas.context_assembly_revision_id=NEW.context_assembly_revision_id
       UNION
       SELECT tws.workspace_registration_id
         FROM intentchord.task_workspace_snapshots tws
        WHERE tws.draft_revision_id=(
          SELECT dr.id FROM intentchord.task_draft_revisions dr
           WHERE dr.task_id=assembly_task_id ORDER BY dr.revision DESC LIMIT 1
        )
     )
     ORDER BY w.id
     FOR UPDATE OF w;
    IF intentchord.current_effective_context_authority_status(assembly_task_id,NEW.context_assembly_revision_id)<>'CURRENT' THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CLOSURE_CURRENT_EFFECTIVE_CONTEXT_REQUIRED';
    END IF;
  END IF;
  IF NEW.gate_evidence->>'context_assembly_revision_id' IS DISTINCT FROM NEW.context_assembly_revision_id::text
     OR NEW.gate_evidence->>'mapping_iteration_id' IS DISTINCT FROM NEW.mapping_iteration_id::text
     OR NEW.gate_evidence->>'evaluation_input_sha256' IS DISTINCT FROM NEW.evaluation_input_sha256
     OR NEW.gate_evidence->>'decision' IS DISTINCT FROM NEW.decision THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CLOSURE_EVALUATION_EVIDENCE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_closure_evaluations_insert_guard ON intentchord.context_closure_evaluations;
CREATE TRIGGER context_closure_evaluations_insert_guard BEFORE INSERT ON intentchord.context_closure_evaluations
FOR EACH ROW EXECUTE FUNCTION intentchord.context_closure_evaluation_insert_guard();

-- Keep Mapping Attempt semantic scope immutable after creation. Migration 009 predates qualification_scope,
-- so replace the existing function without changing the trigger identity.
CREATE OR REPLACE FUNCTION intentchord.context_mapping_attempt_update_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.mapping_run_id,NEW.attempt_ordinal,NEW.provider_id,NEW.channel_id,NEW.requested_model_id,
         NEW.prompt_template_id,NEW.prompt_template_sha256,NEW.qualification_scope,NEW.started_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.mapping_run_id,OLD.attempt_ordinal,OLD.provider_id,OLD.channel_id,OLD.requested_model_id,
         OLD.prompt_template_id,OLD.prompt_template_sha256,OLD.qualification_scope,OLD.started_at) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status<>'RUNNING' OR NEW.status='RUNNING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_COMPLETE_ONCE';
  END IF;
  RETURN NEW;
END;
$$;

-- Historical V1 Catalog proposals remain V1-only. A V2 analysis result is persisted only in
-- context_mapping_v2_results and can never be reinterpreted as a V1 Owner-review proposal.
CREATE OR REPLACE FUNCTION intentchord.context_catalog_proposal_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_row intentchord.context_mapping_attempts%ROWTYPE;
  run_row intentchord.context_mapping_runs%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row FROM intentchord.context_mapping_attempts
    WHERE id=NEW.source_attempt_id AND mapping_run_id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.status<>'SUCCEEDED' OR attempt_row.qualification_scope<>'AI_CONTEXT_MAPPING_V1' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_REQUIRES_SUCCEEDED_V1_ATTEMPT';
  END IF;
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND OR run_row.status<>'VALIDATING' OR run_row.qualification_scope<>'AI_CONTEXT_MAPPING_V1' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_V1_RUN_STATE_BLOCKED';
  END IF;
  IF (NEW.result_envelope->>'mapping_run_id') IS DISTINCT FROM NEW.mapping_run_id::text
     OR (NEW.result_envelope->>'attempt_id') IS DISTINCT FROM NEW.source_attempt_id::text
     OR (NEW.result_envelope->>'mapping_input_sha256') IS DISTINCT FROM run_row.mapping_input_sha256
     OR (NEW.result_envelope->>'mapping_input_snapshot_id') IS DISTINCT FROM run_row.mapping_input_snapshot_id
     OR (NEW.result_envelope->>'provider_id') IS DISTINCT FROM attempt_row.provider_id
     OR (NEW.result_envelope->>'channel_id') IS DISTINCT FROM attempt_row.channel_id
     OR (NEW.result_envelope->>'requested_model_id') IS DISTINCT FROM attempt_row.requested_model_id
     OR (NEW.result_envelope->>'attempt_ordinal') IS DISTINCT FROM attempt_row.attempt_ordinal::text
     OR (NEW.result_envelope->>'prompt_template_id') IS DISTINCT FROM attempt_row.prompt_template_id
     OR (NEW.result_envelope->>'prompt_template_sha256') IS DISTINCT FROM attempt_row.prompt_template_sha256
     OR (NEW.result_envelope->>'raw_response_sha256') IS DISTINCT FROM attempt_row.raw_response_sha256
     OR (NEW.result_envelope->>'parsed_catalog_sha256') IS DISTINCT FROM NEW.proposal_sha256
     OR NEW.result_envelope->'model_proposal' IS DISTINCT FROM NEW.proposal_json
     OR NEW.result_envelope->'validation_result' IS DISTINCT FROM NEW.deterministic_validation_evidence
     OR NEW.deterministic_validation_evidence IS DISTINCT FROM attempt_row.validation_summary
  THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_PROVENANCE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION intentchord.context_resolution_requirement_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i intentchord.context_assembly_mapping_iterations%ROWTYPE; r intentchord.context_missing_evidence_requests%ROWTYPE; c intentchord.context_material_contradictions%ROWTYPE;
BEGIN
  SELECT * INTO i FROM intentchord.context_assembly_mapping_iterations WHERE id=NEW.mapping_iteration_id;
  IF NOT FOUND OR i.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_RESOLUTION_REQUIREMENT_ITERATION_MISMATCH'; END IF;
  IF NEW.requirement_type='MISSING_INTERNAL_EVIDENCE' THEN SELECT * INTO r FROM intentchord.context_missing_evidence_requests WHERE id=NEW.originating_missing_evidence_request_id; IF NOT FOUND OR r.mapping_iteration_id IS DISTINCT FROM NEW.mapping_iteration_id THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_RESOLUTION_REQUIREMENT_MISSING_EVIDENCE_MISMATCH'; END IF;
  ELSE SELECT * INTO c FROM intentchord.context_material_contradictions WHERE id=NEW.originating_material_contradiction_id; IF NOT FOUND OR c.mapping_iteration_id IS DISTINCT FROM NEW.mapping_iteration_id THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_RESOLUTION_REQUIREMENT_CONTRADICTION_MISMATCH'; END IF; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_resolution_requirements_insert_guard ON intentchord.context_resolution_requirements;
CREATE TRIGGER context_resolution_requirements_insert_guard BEFORE INSERT ON intentchord.context_resolution_requirements FOR EACH ROW EXECUTE FUNCTION intentchord.context_resolution_requirement_insert_guard();


CREATE OR REPLACE FUNCTION intentchord.context_resolution_event_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  req intentchord.context_resolution_requirements%ROWTYPE;
  auth intentchord.context_source_authorizations%ROWTYPE;
  old_assembly uuid;
  successor_assembly uuid;
  old_revision integer;
  successor_revision integer;
BEGIN
  SELECT * INTO req FROM intentchord.context_resolution_requirements WHERE id=NEW.resolution_requirement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTENTCHORD_CONTEXT_RESOLUTION_EVENT_REQUIREMENT_REQUIRED'; END IF;
  IF NEW.event_type IN ('OWNER_AUTHORIZED_SOURCE','OWNER_DENIED_SOURCE') THEN
    SELECT * INTO auth FROM intentchord.context_source_authorizations WHERE id=NEW.source_authorization_id;
    IF NOT FOUND OR auth.resolution_requirement_id IS DISTINCT FROM NEW.resolution_requirement_id
       OR (NEW.event_type='OWNER_AUTHORIZED_SOURCE' AND auth.decision<>'APPROVE')
       OR (NEW.event_type='OWNER_DENIED_SOURCE' AND auth.decision<>'DENY') THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_RESOLUTION_EVENT_OWNER_AUTHORITY_MISMATCH';
    END IF;
  END IF;
  IF NEW.event_type='SUPERSEDED_BY_NEW_ASSEMBLY' THEN
    IF NEW.successor_context_assembly_revision_id IS NULL THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_RESOLUTION_EVENT_SUCCESSOR_ASSEMBLY_REQUIRED';
    END IF;
    SELECT context_assembly_id,revision INTO old_assembly,old_revision
      FROM intentchord.context_assembly_revisions WHERE id=req.context_assembly_revision_id;
    SELECT context_assembly_id,revision INTO successor_assembly,successor_revision
      FROM intentchord.context_assembly_revisions WHERE id=NEW.successor_context_assembly_revision_id;
    IF old_assembly IS NULL OR successor_assembly IS NULL
       OR successor_assembly IS DISTINCT FROM old_assembly
       OR successor_revision <= old_revision THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_RESOLUTION_EVENT_SUCCESSOR_LINEAGE_MISMATCH';
    END IF;
  ELSIF NEW.successor_context_assembly_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_RESOLUTION_EVENT_SUCCESSOR_NOT_ALLOWED';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_resolution_events_insert_guard ON intentchord.context_resolution_events;
CREATE TRIGGER context_resolution_events_insert_guard BEFORE INSERT ON intentchord.context_resolution_events
FOR EACH ROW EXECUTE FUNCTION intentchord.context_resolution_event_insert_guard();

-- Owner Source authorization is valid only for a Backend-classified blocking internal source gap
-- in the exact Assembly revision. The AI request itself cannot grant source authority.
-- One DB defense-in-depth interpretation of CURRENT EFFECTIVE CONTEXT AUTHORITY.
-- The Assembly must be the immutable lineage Head, the current Task Draft source-set must
-- exactly match it, and each Assembly source must match the ACTUAL Observation authority head.
CREATE OR REPLACE FUNCTION intentchord.current_effective_context_authority_status(
  p_task_id uuid,
  p_context_assembly_revision_id uuid
) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  assembly_id uuid;
  assembly_task_id uuid;
  head_revision_id uuid;
  v_draft_revision_id uuid;
  expected_count integer;
  assembly_count integer;
  unproven_count integer;
  drift_count integer;
BEGIN
  SELECT ar.context_assembly_id,a.task_id
    INTO assembly_id,assembly_task_id
    FROM intentchord.context_assembly_revisions ar
    JOIN intentchord.context_assemblies a ON a.id=ar.context_assembly_id
   WHERE ar.id=p_context_assembly_revision_id;
  IF assembly_id IS NULL OR assembly_task_id IS DISTINCT FROM p_task_id THEN
    RETURN 'UNPROVEN';
  END IF;

  SELECT id INTO head_revision_id
    FROM intentchord.context_assembly_revisions
   WHERE context_assembly_id=assembly_id
   ORDER BY revision DESC LIMIT 1;
  IF head_revision_id IS NULL THEN RETURN 'UNPROVEN'; END IF;

  SELECT id INTO v_draft_revision_id
    FROM intentchord.task_draft_revisions
   WHERE task_id=p_task_id
   ORDER BY revision DESC
   LIMIT 1;
  IF v_draft_revision_id IS NULL THEN RETURN 'UNPROVEN'; END IF;

  SELECT count(*)::int INTO expected_count
    FROM intentchord.task_workspace_snapshots
   WHERE draft_revision_id=v_draft_revision_id;
  IF expected_count=0 THEN RETURN 'UNPROVEN'; END IF;

  -- STEP 1: establish current authority for the ACTUAL current Task source set.
  SELECT count(*)::int INTO unproven_count
    FROM intentchord.task_workspace_snapshots tws
    LEFT JOIN intentchord.workspaces w ON w.id=tws.workspace_registration_id
    LEFT JOIN LATERAL (
      SELECT o.id,o.authority_sequence,o.observation_result,o.workspace_revision_id,
             o.canonical_index_artifact_id,o.index_configuration_sha256,o.snapshot_operation_id
        FROM intentchord.workspace_observations o
       WHERE o.workspace_registration_id=tws.workspace_registration_id
       ORDER BY o.authority_sequence DESC
       LIMIT 1
    ) h ON true
    LEFT JOIN intentchord.workspace_index_snapshots s
      ON s.id=h.snapshot_operation_id
     AND s.workspace_registration_id=tws.workspace_registration_id
     AND s.workspace_observation_id=h.id
     AND s.workspace_revision_id=h.workspace_revision_id
     AND s.index_configuration_sha256=h.index_configuration_sha256
     AND s.observation_result=h.observation_result
   WHERE tws.draft_revision_id=v_draft_revision_id
     AND (
       w.id IS NULL
       OR w.verification_status IS DISTINCT FROM 'VERIFIED'
       OR h.id IS NULL
       OR h.observation_result='SOURCE_PROVEN_INDEX_FAILED'
       OR s.id IS NULL
       OR s.status IS DISTINCT FROM 'READY'
       OR s.index_attempt_status IS DISTINCT FROM 'SUCCEEDED'
       OR s.workspace_registration_revision IS DISTINCT FROM w.revision
       OR s.workspace_registration_fingerprint IS DISTINCT FROM w.fingerprint
       OR s.workspace_revision_id IS DISTINCT FROM h.workspace_revision_id
     );
  IF unproven_count<>0 THEN RETURN 'UNPROVEN'; END IF;

  IF EXISTS(
    SELECT 1 FROM intentchord.context_forward_authority_consumptions c
     WHERE c.task_id=p_task_id
       AND c.context_assembly_revision_id=p_context_assembly_revision_id
       AND c.consumption_type='SOURCE_MUTATING_RUN_STARTED'
  ) THEN
    RETURN 'UNPROVEN';
  END IF;

  -- STEP 2: current authority is proven. Compare it with the frozen Assembly authority.
  IF head_revision_id IS DISTINCT FROM p_context_assembly_revision_id THEN
    RETURN 'DRIFT';
  END IF;

  SELECT count(*)::int INTO assembly_count
    FROM intentchord.context_assembly_sources
   WHERE context_assembly_revision_id=p_context_assembly_revision_id;
  IF expected_count IS DISTINCT FROM assembly_count THEN RETURN 'DRIFT'; END IF;

  SELECT count(*)::int INTO drift_count
    FROM intentchord.task_workspace_snapshots tws
    FULL JOIN intentchord.context_assembly_sources cas
      ON cas.context_assembly_revision_id=p_context_assembly_revision_id
     AND cas.workspace_registration_id=tws.workspace_registration_id
   WHERE tws.draft_revision_id=v_draft_revision_id
     AND (
       cas.id IS NULL
       OR tws.workspace_registration_id IS NULL
       OR tws.ordering IS DISTINCT FROM cas.ordering
       OR tws.fingerprint IS DISTINCT FROM cas.workspace_registration_fingerprint
     );
  IF drift_count<>0 THEN RETURN 'DRIFT'; END IF;

  SELECT count(*)::int INTO drift_count
    FROM intentchord.context_assembly_sources cas
    JOIN intentchord.workspaces w ON w.id=cas.workspace_registration_id
    JOIN LATERAL (
      SELECT o.id,o.authority_sequence,o.observation_result,o.workspace_revision_id,
             o.canonical_index_artifact_id,o.index_configuration_sha256,o.snapshot_operation_id
        FROM intentchord.workspace_observations o
       WHERE o.workspace_registration_id=cas.workspace_registration_id
       ORDER BY o.authority_sequence DESC
       LIMIT 1
    ) h ON true
    JOIN intentchord.workspace_index_snapshots s
      ON s.id=h.snapshot_operation_id
     AND s.workspace_registration_id=cas.workspace_registration_id
     AND s.workspace_observation_id=h.id
     AND s.workspace_revision_id=h.workspace_revision_id
     AND s.index_configuration_sha256=h.index_configuration_sha256
     AND s.observation_result=h.observation_result
   WHERE cas.context_assembly_revision_id=p_context_assembly_revision_id
     AND (
       w.revision IS DISTINCT FROM cas.workspace_registration_revision
       OR w.fingerprint IS DISTINCT FROM cas.workspace_registration_fingerprint
       OR h.id IS DISTINCT FROM cas.workspace_observation_id
       OR h.authority_sequence IS DISTINCT FROM cas.workspace_observation_authority_sequence
       OR h.workspace_revision_id IS DISTINCT FROM cas.workspace_revision_id
       OR s.id IS DISTINCT FROM cas.workspace_index_snapshot_id
     );
  IF drift_count<>0 THEN RETURN 'DRIFT'; END IF;
  RETURN 'CURRENT';
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.context_forward_authority_consumption_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row intentchord.runs%ROWTYPE;
  contract_row intentchord.contract_revisions%ROWTYPE;
  draft_row intentchord.task_draft_revisions%ROWTYPE;
  assembly_id uuid;
BEGIN
  -- Defense-in-depth uses the same global forward-authority lock order as Backend commands:
  -- TASK -> CONTEXT -> ordered Workspaces -> CONTRACT -> RUN -> dependent receipt.
  PERFORM 1 FROM intentchord.tasks WHERE id=NEW.task_id FOR UPDATE;
  SELECT ar.context_assembly_id INTO assembly_id
    FROM intentchord.context_assembly_revisions ar
    JOIN intentchord.context_assemblies a ON a.id=ar.context_assembly_id
   WHERE ar.id=NEW.context_assembly_revision_id AND a.task_id=NEW.task_id;
  IF assembly_id IS NULL THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CONSUMPTION_CONTEXT_BINDING_MISMATCH';
  END IF;
  PERFORM 1 FROM intentchord.context_assemblies WHERE id=assembly_id FOR UPDATE;
  PERFORM w.id
    FROM intentchord.workspaces w
   WHERE w.id IN (
     SELECT cas.workspace_registration_id
       FROM intentchord.context_assembly_sources cas
      WHERE cas.context_assembly_revision_id=NEW.context_assembly_revision_id
     UNION
     SELECT tws.workspace_registration_id
       FROM intentchord.task_workspace_snapshots tws
      WHERE tws.draft_revision_id=(
        SELECT dr.id FROM intentchord.task_draft_revisions dr
         WHERE dr.task_id=NEW.task_id ORDER BY dr.revision DESC LIMIT 1
      )
   )
   ORDER BY w.id
   FOR UPDATE OF w;

  SELECT * INTO contract_row FROM intentchord.contract_revisions WHERE id=NEW.contract_revision_id FOR UPDATE;
  IF NOT FOUND
     OR contract_row.task_id IS DISTINCT FROM NEW.task_id
     OR contract_row.task_draft_revision_id IS DISTINCT FROM NEW.task_draft_revision_id
     OR coalesce((contract_row.contract_content->'authorization'->>'modifySource')::boolean,false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CONSUMPTION_SOURCE_MUTATING_CONTRACT_REQUIRED';
  END IF;

  SELECT * INTO run_row FROM intentchord.runs WHERE id=NEW.run_id FOR UPDATE;
  IF NOT FOUND
     OR run_row.task_id IS DISTINCT FROM NEW.task_id
     OR run_row.contract_revision_id IS DISTINCT FROM NEW.contract_revision_id
     OR run_row.source='SYNTHETIC_FIXTURE' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CONSUMPTION_RUN_BINDING_MISMATCH';
  END IF;

  SELECT * INTO draft_row FROM intentchord.task_draft_revisions WHERE id=NEW.task_draft_revision_id;
  IF NOT FOUND OR draft_row.task_id IS DISTINCT FROM NEW.task_id
     OR draft_row.draft_projection->>'orchestrationVersion' IS DISTINCT FROM 'UNIFIED_V1'
     OR draft_row.draft_projection#>>'{scopeConfirmation,candidateIdentity,authorityVersion}' IS DISTINCT FROM 'CONTEXT_ASSEMBLY_V2'
     OR draft_row.draft_projection#>>'{scopeConfirmation,candidateIdentity,contextAssemblyRevisionId}' IS DISTINCT FROM NEW.context_assembly_revision_id::text
     OR draft_row.draft_projection#>>'{scopeConfirmation,authorityInputSha256}' IS DISTINCT FROM NEW.scope_authority_input_sha256
     OR draft_row.draft_projection#>>'{scopeConfirmation,candidateIdentity,candidateScopeSha256}' IS DISTINCT FROM NEW.candidate_scope_sha256 THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CONSUMPTION_SCOPE_AUTHORITY_MISMATCH';
  END IF;

  IF intentchord.current_effective_context_authority_status(NEW.task_id,NEW.context_assembly_revision_id)<>'CURRENT' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CONSUMPTION_CURRENT_EFFECTIVE_CONTEXT_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_forward_authority_consumptions_insert_guard ON intentchord.context_forward_authority_consumptions;
CREATE TRIGGER context_forward_authority_consumptions_insert_guard
BEFORE INSERT ON intentchord.context_forward_authority_consumptions
FOR EACH ROW EXECUTE FUNCTION intentchord.context_forward_authority_consumption_insert_guard();

CREATE OR REPLACE FUNCTION intentchord.context_source_authorization_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_row intentchord.context_missing_evidence_requests%ROWTYPE;
  classification_row intentchord.context_gap_classifications%ROWTYPE;
  requirement_row intentchord.context_resolution_requirements%ROWTYPE;
  assembly_id uuid;
  assembly_task_id uuid;
  head_revision_id uuid;
  task_current_revision bigint;
  current_workspace_revision bigint;
  current_workspace_fingerprint text;
BEGIN
  SELECT * INTO requirement_row FROM intentchord.context_resolution_requirements WHERE id=NEW.resolution_requirement_id;
  IF NOT FOUND OR requirement_row.requirement_type<>'MISSING_INTERNAL_EVIDENCE'
     OR requirement_row.context_assembly_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id
     OR requirement_row.originating_missing_evidence_request_id IS DISTINCT FROM NEW.missing_evidence_request_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_REQUIREMENT_MISMATCH';
  END IF;

  SELECT ar.context_assembly_id,a.task_id INTO assembly_id,assembly_task_id
    FROM intentchord.context_assembly_revisions ar
    JOIN intentchord.context_assemblies a ON a.id=ar.context_assembly_id
   WHERE ar.id=NEW.context_assembly_revision_id;
  IF assembly_id IS NULL OR assembly_task_id IS DISTINCT FROM NEW.task_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_TASK_AUTHORITY_MISMATCH';
  END IF;

  -- Use the same lock order as Backend forward-authority commands: Task first, then stable
  -- Context Assembly parent. This avoids a Task/Context lock-order inversion while keeping the
  -- current-Head check and authorization insert inside one serialized transaction.
  SELECT revision INTO task_current_revision FROM intentchord.tasks WHERE id=NEW.task_id FOR UPDATE;
  IF task_current_revision IS NULL OR task_current_revision IS DISTINCT FROM NEW.task_revision THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_TASK_REVISION_STALE';
  END IF;

  PERFORM 1 FROM intentchord.context_assemblies WHERE id=assembly_id FOR UPDATE;
  SELECT id INTO head_revision_id
    FROM intentchord.context_assembly_revisions
   WHERE context_assembly_id=assembly_id
   ORDER BY revision DESC LIMIT 1;
  IF head_revision_id IS DISTINCT FROM NEW.context_assembly_revision_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_STALE_CONTEXT_HEAD';
  END IF;
  -- Lock all currently frozen source Registration rows before evaluating the same effective
  -- Context authority proof used by Backend commands. This is defense-in-depth against
  -- stale source/Observation authority even when the Assembly remains the max lineage Head.
  -- Lock the UNION(current Context source registrations + target registration) once, globally ordered.
  PERFORM w.id
    FROM intentchord.workspaces w
   WHERE w.id IN (
     SELECT cas.workspace_registration_id
       FROM intentchord.context_assembly_sources cas
      WHERE cas.context_assembly_revision_id=NEW.context_assembly_revision_id
     UNION
     SELECT NEW.workspace_registration_id
   )
   ORDER BY w.id
   FOR UPDATE OF w;
  IF intentchord.current_effective_context_authority_status(NEW.task_id,NEW.context_assembly_revision_id)<>'CURRENT' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_CURRENT_EFFECTIVE_CONTEXT_REQUIRED';
  END IF;
  IF EXISTS(
    SELECT 1 FROM intentchord.context_resolution_events e
     WHERE e.resolution_requirement_id=NEW.resolution_requirement_id
       AND e.event_type='SUPERSEDED_BY_NEW_ASSEMBLY'
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_REQUIREMENT_SUPERSEDED';
  END IF;

  SELECT * INTO request_row FROM intentchord.context_missing_evidence_requests WHERE id=NEW.missing_evidence_request_id;
  SELECT * INTO classification_row FROM intentchord.context_gap_classifications WHERE missing_evidence_request_id=NEW.missing_evidence_request_id;
  IF NOT FOUND OR classification_row.classification<>'BLOCKING_INTERNAL_SOURCE_GAP' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_BLOCKING_INTERNAL_GAP_REQUIRED';
  END IF;
  IF classification_row.candidate_workspace_registration_id IS NOT NULL
     AND classification_row.candidate_workspace_registration_id IS DISTINCT FROM NEW.workspace_registration_id THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_CANDIDATE_MISMATCH';
  END IF;
  SELECT revision,fingerprint INTO current_workspace_revision,current_workspace_fingerprint
    FROM intentchord.workspaces WHERE id=NEW.workspace_registration_id;
  IF current_workspace_revision IS NULL
     OR current_workspace_revision IS DISTINCT FROM NEW.workspace_registration_revision
     OR current_workspace_fingerprint IS DISTINCT FROM NEW.workspace_registration_fingerprint THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_WORKSPACE_REGISTRATION_STALE';
  END IF;
  IF EXISTS(
    SELECT 1 FROM intentchord.context_assembly_sources s
     WHERE s.context_assembly_revision_id=NEW.context_assembly_revision_id
       AND s.workspace_registration_id=NEW.workspace_registration_id
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_SOURCE_AUTHORIZATION_WORKSPACE_ALREADY_PRESENT';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS context_source_authorizations_insert_guard ON intentchord.context_source_authorizations;
CREATE TRIGGER context_source_authorizations_insert_guard BEFORE INSERT ON intentchord.context_source_authorizations FOR EACH ROW EXECUTE FUNCTION intentchord.context_source_authorization_insert_guard();
