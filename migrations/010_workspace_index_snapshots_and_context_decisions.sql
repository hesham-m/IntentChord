-- IntentChord Workspace Analysis governed snapshots and Owner context decisions.
-- Additive migration after 009. Migration 009 remains immutable.

CREATE TABLE IF NOT EXISTS intentchord.workspace_index_snapshots (
  id uuid PRIMARY KEY,
  source_mode text NOT NULL CHECK (source_mode IN ('REGISTERED_WORKSPACE','ADVANCED_DIAGNOSTIC')),
  status text NOT NULL CHECK (status IN ('CREATING','READY','FAILED')),
  workspace_registration_id uuid REFERENCES intentchord.workspaces(id) ON DELETE RESTRICT,
  workspace_registration_revision bigint,
  workspace_registration_fingerprint text CHECK (
    workspace_registration_fingerprint IS NULL OR btrim(workspace_registration_fingerprint) <> ''
  ),
  project_context_id uuid REFERENCES intentchord.project_contexts(id) ON DELETE RESTRICT,
  governed_scope jsonb NOT NULL CHECK (jsonb_typeof(governed_scope)='object'),
  snapshot_idempotency_key text NOT NULL CHECK (
    btrim(snapshot_idempotency_key) <> '' AND char_length(snapshot_idempotency_key) <= 200
  ),
  snapshot_request_fingerprint_sha256 text NOT NULL CHECK (snapshot_request_fingerprint_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  canonical_contract_version text,
  canonical_index_json jsonb CHECK (
    canonical_index_json IS NULL OR jsonb_typeof(canonical_index_json)='object'
  ),
  canonical_sha256 text CHECK (canonical_sha256 IS NULL OR canonical_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  failure_code text,
  safe_failure_evidence jsonb,
  owner_reference text NOT NULL CHECK (btrim(owner_reference) <> ''),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_index_snapshots_time_ck CHECK (
    completed_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT workspace_index_snapshots_source_binding_ck CHECK (
    (source_mode='REGISTERED_WORKSPACE'
      AND workspace_registration_id IS NOT NULL
      AND workspace_registration_revision IS NOT NULL
      AND workspace_registration_fingerprint IS NOT NULL)
    OR
    (source_mode='ADVANCED_DIAGNOSTIC'
      AND (
        (workspace_registration_id IS NULL
          AND workspace_registration_revision IS NULL
          AND workspace_registration_fingerprint IS NULL)
        OR
        (workspace_registration_id IS NOT NULL
          AND workspace_registration_revision IS NOT NULL
          AND workspace_registration_fingerprint IS NOT NULL)
      ))
  ),
  CONSTRAINT workspace_index_snapshots_state_payload_ck CHECK (
    (status='CREATING'
      AND canonical_contract_version IS NULL
      AND canonical_index_json IS NULL
      AND canonical_sha256 IS NULL
      AND failure_code IS NULL
      AND safe_failure_evidence IS NULL
      AND completed_at IS NULL)
    OR
    (status='READY'
      AND canonical_contract_version IS NOT NULL
      AND btrim(canonical_contract_version) <> ''
      AND canonical_index_json IS NOT NULL
      AND canonical_sha256 IS NOT NULL
      AND failure_code IS NULL
      AND safe_failure_evidence IS NULL
      AND completed_at IS NOT NULL)
    OR
    (status='FAILED'
      AND canonical_contract_version IS NULL
      AND canonical_index_json IS NULL
      AND canonical_sha256 IS NULL
      AND failure_code IS NOT NULL
      AND btrim(failure_code) <> ''
      AND safe_failure_evidence IS NOT NULL
      AND jsonb_typeof(safe_failure_evidence)='object'
      AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_index_snapshots_idempotency_uq
  ON intentchord.workspace_index_snapshots(snapshot_idempotency_key);
CREATE INDEX IF NOT EXISTS workspace_index_snapshots_workspace_idx
  ON intentchord.workspace_index_snapshots(workspace_registration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_index_snapshots_project_idx
  ON intentchord.workspace_index_snapshots(project_context_id, created_at DESC)
  WHERE project_context_id IS NOT NULL;

ALTER TABLE intentchord.context_mapping_runs
  ADD COLUMN IF NOT EXISTS workspace_index_snapshot_id uuid,
  ADD COLUMN IF NOT EXISTS mapping_idempotency_key text,
  ADD COLUMN IF NOT EXISTS mapping_request_fingerprint_sha256 text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='context_mapping_runs_workspace_snapshot_fk'
      AND conrelid='intentchord.context_mapping_runs'::regclass
  ) THEN
    ALTER TABLE intentchord.context_mapping_runs
      ADD CONSTRAINT context_mapping_runs_workspace_snapshot_fk
      FOREIGN KEY (workspace_index_snapshot_id)
      REFERENCES intentchord.workspace_index_snapshots(id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_mapping_fingerprint_ck;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_mapping_fingerprint_ck CHECK (
    mapping_request_fingerprint_sha256 IS NULL
    OR mapping_request_fingerprint_sha256 ~ '^sha256:[0-9a-f]{64}$'
  );

ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_snapshot_binding_shape_ck;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_snapshot_binding_shape_ck CHECK (
    (
      workspace_index_snapshot_id IS NULL
      AND mapping_idempotency_key IS NULL
      AND mapping_request_fingerprint_sha256 IS NULL
    )
    OR
    (
      workspace_index_snapshot_id IS NOT NULL
      AND mapping_idempotency_key IS NOT NULL
      AND btrim(mapping_idempotency_key) <> ''
      AND char_length(mapping_idempotency_key) <= 200
      AND mapping_request_fingerprint_sha256 IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS context_mapping_runs_mapping_idempotency_uq
  ON intentchord.context_mapping_runs(mapping_idempotency_key)
  WHERE mapping_idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='context_catalog_proposals_id_run_uq'
      AND conrelid='intentchord.context_catalog_proposals'::regclass
  ) THEN
    ALTER TABLE intentchord.context_catalog_proposals
      ADD CONSTRAINT context_catalog_proposals_id_run_uq UNIQUE (id, mapping_run_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS intentchord.context_mapping_owner_context_decisions (
  id uuid PRIMARY KEY,
  mapping_run_id uuid NOT NULL REFERENCES intentchord.context_mapping_runs(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL,
  context_id text NOT NULL CHECK (btrim(context_id) <> '' AND char_length(context_id) <= 200),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('ACCEPT','REJECT')),
  note text,
  owner_reference text NOT NULL CHECK (btrim(owner_reference) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_mapping_owner_context_decisions_proposal_run_fk
    FOREIGN KEY (proposal_id, mapping_run_id)
    REFERENCES intentchord.context_catalog_proposals(id, mapping_run_id)
    ON DELETE RESTRICT,
  CONSTRAINT context_mapping_owner_context_decisions_run_context_uq
    UNIQUE (mapping_run_id, context_id)
);

CREATE INDEX IF NOT EXISTS context_mapping_owner_context_decisions_run_idx
  ON intentchord.context_mapping_owner_context_decisions(mapping_run_id, context_id);

CREATE OR REPLACE FUNCTION intentchord.workspace_index_snapshot_governed_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.id,NEW.source_mode,NEW.workspace_registration_id,NEW.workspace_registration_revision,
    NEW.workspace_registration_fingerprint,NEW.project_context_id,NEW.governed_scope,
    NEW.snapshot_idempotency_key,NEW.snapshot_request_fingerprint_sha256,
    NEW.owner_reference,NEW.started_at,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.source_mode,OLD.workspace_registration_id,OLD.workspace_registration_revision,
    OLD.workspace_registration_fingerprint,OLD.project_context_id,OLD.governed_scope,
    OLD.snapshot_idempotency_key,OLD.snapshot_request_fingerprint_sha256,
    OLD.owner_reference,OLD.started_at,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_IMMUTABLE_BINDING';
  END IF;

  IF OLD.status<>'CREATING' OR NEW.status NOT IN ('READY','FAILED') THEN
    RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TRANSITION_BLOCKED:%->%', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.workspace_index_snapshot_history_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS workspace_index_snapshots_governed_update ON intentchord.workspace_index_snapshots;
CREATE TRIGGER workspace_index_snapshots_governed_update
BEFORE UPDATE ON intentchord.workspace_index_snapshots
FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_index_snapshot_governed_update();

DROP TRIGGER IF EXISTS workspace_index_snapshots_append_only_delete ON intentchord.workspace_index_snapshots;
CREATE TRIGGER workspace_index_snapshots_append_only_delete
BEFORE DELETE ON intentchord.workspace_index_snapshots
FOR EACH ROW EXECUTE FUNCTION intentchord.workspace_index_snapshot_history_append_only();

CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_insert_snapshot_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot_row intentchord.workspace_index_snapshots%ROWTYPE;
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
  IF NEW.workspace_index_sha256 IS DISTINCT FROM snapshot_row.canonical_sha256 THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_HASH_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS context_mapping_runs_snapshot_insert_guard ON intentchord.context_mapping_runs;
CREATE TRIGGER context_mapping_runs_snapshot_insert_guard
BEFORE INSERT ON intentchord.context_mapping_runs
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_run_insert_snapshot_guard();

CREATE OR REPLACE FUNCTION intentchord.context_mapping_owner_context_decision_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row intentchord.context_mapping_runs%ROWTYPE;
  proposal_row intentchord.context_catalog_proposals%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND OR run_row.status<>'AWAITING_OWNER_REVIEW' OR run_row.owner_verdict_state<>'PENDING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_DECISION_RUN_STATE_BLOCKED';
  END IF;

  SELECT * INTO proposal_row
  FROM intentchord.context_catalog_proposals
  WHERE id=NEW.proposal_id AND mapping_run_id=NEW.mapping_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_DECISION_PROPOSAL_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(proposal_row.proposal_json->'contexts') item
    WHERE item->>'context_id'=NEW.context_id
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_DECISION_UNKNOWN_CONTEXT';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS context_mapping_owner_context_decisions_insert_guard
  ON intentchord.context_mapping_owner_context_decisions;
CREATE TRIGGER context_mapping_owner_context_decisions_insert_guard
BEFORE INSERT ON intentchord.context_mapping_owner_context_decisions
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_owner_context_decision_insert_guard();

DROP TRIGGER IF EXISTS context_mapping_owner_context_decisions_append_only
  ON intentchord.context_mapping_owner_context_decisions;
CREATE TRIGGER context_mapping_owner_context_decisions_append_only
BEFORE UPDATE OR DELETE ON intentchord.context_mapping_owner_context_decisions
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_history_append_only();

CREATE OR REPLACE FUNCTION intentchord.context_mapping_owner_verdict_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row intentchord.context_mapping_runs%ROWTYPE;
  total_contexts integer;
  accepted_contexts integer;
  rejected_contexts integer;
BEGIN
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND OR run_row.status<>'AWAITING_OWNER_REVIEW' OR run_row.owner_verdict_state<>'PENDING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_VERDICT_STATE_BLOCKED';
  END IF;

  SELECT jsonb_array_length(proposal_json->'contexts') INTO total_contexts
  FROM intentchord.context_catalog_proposals
  WHERE mapping_run_id=NEW.mapping_run_id;

  SELECT
    count(*) FILTER (WHERE decision='ACCEPT'),
    count(*) FILTER (WHERE decision='REJECT')
  INTO accepted_contexts,rejected_contexts
  FROM intentchord.context_mapping_owner_context_decisions
  WHERE mapping_run_id=NEW.mapping_run_id;

  IF total_contexts IS NULL OR accepted_contexts+rejected_contexts<>total_contexts THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_INCOMPLETE';
  END IF;
  IF NEW.verdict='ACCEPT' AND accepted_contexts<1 THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_STATE_CONFLICT';
  END IF;
  IF NEW.verdict='REJECT' AND (accepted_contexts<>0 OR rejected_contexts<>total_contexts) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_REVIEW_STATE_CONFLICT';
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
    NEW.eligible_entry_count, NEW.excluded_entry_count, NEW.provider_neutral_estimated_tokens,
    NEW.primary_provider_id, NEW.primary_channel_id, NEW.primary_model_id,
    NEW.standby_provider_id, NEW.standby_channel_id, NEW.standby_model_id,
    NEW.standby_enabled, NEW.standby_governance_state, NEW.provider_configuration_snapshot,
    NEW.workspace_index_snapshot_id,NEW.mapping_idempotency_key,NEW.mapping_request_fingerprint_sha256,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.mapping_input_snapshot_id, OLD.mapping_input_sha256, OLD.mapping_input_snapshot,
    OLD.workspace_index_contract_version, OLD.workspace_snapshot_id, OLD.workspace_index_sha256,
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
