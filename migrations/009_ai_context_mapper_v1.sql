-- IntentChord AI Context Mapper V1 governed persistence.
-- Additive migration after 008. IntentChord database/schema only.

CREATE TABLE IF NOT EXISTS intentchord.context_mapping_runs (
  id uuid PRIMARY KEY,
  mapping_input_snapshot_id text NOT NULL,
  mapping_input_sha256 text NOT NULL CHECK (mapping_input_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  mapping_input_snapshot jsonb NOT NULL,
  workspace_index_contract_version text NOT NULL,
  workspace_snapshot_id text NOT NULL,
  workspace_index_sha256 text NOT NULL CHECK (workspace_index_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  eligible_entry_count integer NOT NULL CHECK (eligible_entry_count >= 0),
  excluded_entry_count integer NOT NULL CHECK (excluded_entry_count >= 0),
  provider_neutral_estimated_tokens integer NOT NULL CHECK (provider_neutral_estimated_tokens >= 0),
  status text NOT NULL CHECK (status IN (
    'CREATED','INPUT_VALIDATED','PRIMARY_RUNNING','PRIMARY_FAILED_TECHNICAL',
    'STANDBY_BLOCKED_GOVERNANCE','STANDBY_RUNNING','VALIDATING',
    'AWAITING_OWNER_REVIEW','REJECTED_VALIDATION','FAILED',
    'OWNER_ACCEPTED','OWNER_REJECTED'
  )),
  primary_provider_id text NOT NULL CHECK (primary_provider_id='zai'),
  primary_channel_id text NOT NULL CHECK (primary_channel_id='zai_direct_chat_completions_v4'),
  primary_model_id text NOT NULL CHECK (primary_model_id='glm-4.7-flash'),
  standby_provider_id text NOT NULL CHECK (standby_provider_id='sambanova'),
  standby_channel_id text NOT NULL CHECK (standby_channel_id='sambanova_direct_chat_completions_v1'),
  standby_model_id text NOT NULL CHECK (standby_model_id='gpt-oss-120b'),
  standby_enabled boolean NOT NULL DEFAULT false,
  standby_governance_state text NOT NULL CHECK (standby_governance_state IN ('BLOCKED_BY_GOVERNANCE','QUALIFIED')),
  provider_configuration_snapshot jsonb NOT NULL,
  final_attempt_id uuid,
  owner_verdict_state text NOT NULL DEFAULT 'PENDING' CHECK (owner_verdict_state IN ('PENDING','ACCEPTED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_mapping_runs_standby_governance_ck CHECK (
    standby_enabled = false OR standby_governance_state = 'QUALIFIED'
  )
);

CREATE TABLE IF NOT EXISTS intentchord.context_mapping_attempts (
  id uuid PRIMARY KEY,
  mapping_run_id uuid NOT NULL REFERENCES intentchord.context_mapping_runs(id) ON DELETE CASCADE,
  attempt_ordinal integer NOT NULL CHECK (attempt_ordinal IN (1,2)),
  provider_id text NOT NULL CHECK (provider_id IN ('zai','sambanova')),
  channel_id text NOT NULL,
  requested_model_id text NOT NULL,
  response_model_id text,
  provider_request_id text,
  provider_system_fingerprint text,
  prompt_template_id text NOT NULL DEFAULT 'intentchord_ai_context_mapper_system_v1',
  prompt_template_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED_TECHNICAL','FAILED_VALIDATION')),
  normalized_error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  usage_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  rate_limit_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_response_sha256 text CHECK (raw_response_sha256 IS NULL OR raw_response_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  raw_response_body text,
  parsed_catalog_sha256 text CHECK (parsed_catalog_sha256 IS NULL OR parsed_catalog_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  validation_summary jsonb,
  CONSTRAINT context_mapping_attempts_run_ordinal_uq UNIQUE (mapping_run_id, attempt_ordinal),
  CONSTRAINT context_mapping_attempts_id_run_uq UNIQUE (id, mapping_run_id),
  CONSTRAINT context_mapping_attempts_fixed_channel_ck CHECK (
    (attempt_ordinal=1 AND provider_id='zai' AND channel_id='zai_direct_chat_completions_v4' AND requested_model_id='glm-4.7-flash')
    OR
    (attempt_ordinal=2 AND provider_id='sambanova' AND channel_id='sambanova_direct_chat_completions_v1' AND requested_model_id='gpt-oss-120b')
  ),
  CONSTRAINT context_mapping_attempts_prompt_identity_ck CHECK (
    prompt_template_id='intentchord_ai_context_mapper_system_v1'
    AND prompt_template_sha256='sha256:b7349b1636adaf04291f2bfdde7d34a0ebc91753865cd5e7c06c795ee5bfd477'
  ),
  CONSTRAINT context_mapping_attempts_completion_ck CHECK (
    (status='RUNNING' AND completed_at IS NULL AND duration_ms IS NULL)
    OR
    (status<>'RUNNING' AND completed_at IS NOT NULL AND duration_ms IS NOT NULL)
  ),
  CONSTRAINT context_mapping_attempts_validation_ck CHECK (
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
      AND validation_summary->>'parsed_catalog_sha256'=parsed_catalog_sha256
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
        OR validation_summary->>'parsed_catalog_sha256'=parsed_catalog_sha256
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
  )
);

ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_final_attempt_fk;
ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_final_attempt_fk
  FOREIGN KEY (final_attempt_id, id)
  REFERENCES intentchord.context_mapping_attempts(id, mapping_run_id)
  ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS intentchord.context_catalog_proposals (
  id uuid PRIMARY KEY,
  mapping_run_id uuid NOT NULL UNIQUE REFERENCES intentchord.context_mapping_runs(id) ON DELETE CASCADE,
  source_attempt_id uuid NOT NULL UNIQUE,
  schema_version text NOT NULL CHECK (schema_version='intentchord.model-proposed-context-catalog.v1'),
  proposal_json jsonb NOT NULL,
  proposal_sha256 text NOT NULL CHECK (proposal_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  deterministic_validation_evidence jsonb NOT NULL,
  result_envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT context_catalog_proposals_attempt_run_fk
    FOREIGN KEY (source_attempt_id, mapping_run_id)
    REFERENCES intentchord.context_mapping_attempts(id, mapping_run_id)
    ON DELETE RESTRICT,
  CONSTRAINT context_catalog_proposals_validation_ck CHECK (
    deterministic_validation_evidence IS NOT NULL
    AND jsonb_typeof(deterministic_validation_evidence)='object'
    AND deterministic_validation_evidence->>'status'='PASS'
    AND jsonb_typeof(deterministic_validation_evidence->'gates')='array'
    AND deterministic_validation_evidence->>'parsed_catalog_sha256'=proposal_sha256
  ),
  CONSTRAINT context_catalog_proposals_envelope_schema_ck CHECK (
    result_envelope IS NOT NULL
    AND jsonb_typeof(result_envelope)='object'
    AND result_envelope->>'schema_version'='intentchord.context-mapping-result.v1'
  )
);

CREATE TABLE IF NOT EXISTS intentchord.context_mapping_owner_verdicts (
  id uuid PRIMARY KEY,
  mapping_run_id uuid NOT NULL UNIQUE REFERENCES intentchord.context_mapping_runs(id) ON DELETE RESTRICT,
  verdict text NOT NULL CHECK (verdict IN ('ACCEPT','REJECT')),
  note text,
  owner_reference text NOT NULL CHECK (btrim(owner_reference) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS context_mapping_runs_status_idx
  ON intentchord.context_mapping_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS context_mapping_attempts_run_idx
  ON intentchord.context_mapping_attempts(mapping_run_id, attempt_ordinal);

CREATE OR REPLACE FUNCTION intentchord.context_mapping_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.context_mapping_history_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_HISTORY_APPEND_ONLY';
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_governed_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF ROW(
    NEW.mapping_input_snapshot_id, NEW.mapping_input_sha256, NEW.mapping_input_snapshot,
    NEW.workspace_index_contract_version, NEW.workspace_snapshot_id, NEW.workspace_index_sha256,
    NEW.eligible_entry_count, NEW.excluded_entry_count, NEW.provider_neutral_estimated_tokens,
    NEW.primary_provider_id, NEW.primary_channel_id, NEW.primary_model_id,
    NEW.standby_provider_id, NEW.standby_channel_id, NEW.standby_model_id,
    NEW.standby_enabled, NEW.standby_governance_state, NEW.provider_configuration_snapshot,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.mapping_input_snapshot_id, OLD.mapping_input_sha256, OLD.mapping_input_snapshot,
    OLD.workspace_index_contract_version, OLD.workspace_snapshot_id, OLD.workspace_index_sha256,
    OLD.eligible_entry_count, OLD.excluded_entry_count, OLD.provider_neutral_estimated_tokens,
    OLD.primary_provider_id, OLD.primary_channel_id, OLD.primary_model_id,
    OLD.standby_provider_id, OLD.standby_channel_id, OLD.standby_model_id,
    OLD.standby_enabled, OLD.standby_governance_state, OLD.provider_configuration_snapshot,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_RUN_IMMUTABLE_BINDING';
  END IF;

  IF NEW.status = OLD.status THEN
    allowed := true;
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
        WHERE id=NEW.final_attempt_id
          AND mapping_run_id=NEW.id
          AND attempt_ordinal=2
          AND status<>'RUNNING'
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

  IF NEW.status IN ('OWNER_ACCEPTED','OWNER_REJECTED') AND NOT EXISTS (
    SELECT 1 FROM intentchord.context_mapping_owner_verdicts
    WHERE mapping_run_id=NEW.id
      AND verdict=CASE WHEN NEW.status='OWNER_ACCEPTED' THEN 'ACCEPT' ELSE 'REJECT' END
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_VERDICT_RECORD_REQUIRED';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.context_mapping_attempt_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row intentchord.context_mapping_runs%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_ORPHAN';
  END IF;
  IF NEW.attempt_ordinal=1 AND run_row.status<>'PRIMARY_RUNNING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_PRIMARY_ATTEMPT_STATE_BLOCKED';
  END IF;
  IF NEW.attempt_ordinal=2 AND (
    run_row.status<>'STANDBY_RUNNING' OR run_row.standby_enabled=false OR run_row.standby_governance_state<>'QUALIFIED'
  ) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_STANDBY_ATTEMPT_GOVERNANCE_BLOCKED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.context_mapping_attempt_update_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.mapping_run_id,NEW.attempt_ordinal,NEW.provider_id,NEW.channel_id,NEW.requested_model_id,
         NEW.prompt_template_id,NEW.prompt_template_sha256,NEW.started_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.mapping_run_id,OLD.attempt_ordinal,OLD.provider_id,OLD.channel_id,OLD.requested_model_id,
         OLD.prompt_template_id,OLD.prompt_template_sha256,OLD.started_at) THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status<>'RUNNING' OR NEW.status='RUNNING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_COMPLETE_ONCE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION intentchord.context_catalog_proposal_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_row intentchord.context_mapping_attempts%ROWTYPE;
  run_row intentchord.context_mapping_runs%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row FROM intentchord.context_mapping_attempts
    WHERE id=NEW.source_attempt_id AND mapping_run_id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND OR attempt_row.status<>'SUCCEEDED' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_REQUIRES_SUCCEEDED_ATTEMPT';
  END IF;
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF run_row.status<>'VALIDATING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_RUN_STATE_BLOCKED';
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

CREATE OR REPLACE FUNCTION intentchord.context_mapping_owner_verdict_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row intentchord.context_mapping_runs%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND OR run_row.status<>'AWAITING_OWNER_REVIEW' OR run_row.owner_verdict_state<>'PENDING' THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_OWNER_VERDICT_STATE_BLOCKED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS context_mapping_runs_governed_update ON intentchord.context_mapping_runs;
CREATE TRIGGER context_mapping_runs_governed_update
BEFORE UPDATE ON intentchord.context_mapping_runs
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_run_governed_update();

DROP TRIGGER IF EXISTS context_mapping_runs_touch_updated_at ON intentchord.context_mapping_runs;
CREATE TRIGGER context_mapping_runs_touch_updated_at
BEFORE UPDATE ON intentchord.context_mapping_runs
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_touch_updated_at();

DROP TRIGGER IF EXISTS context_mapping_attempts_insert_guard ON intentchord.context_mapping_attempts;
CREATE TRIGGER context_mapping_attempts_insert_guard
BEFORE INSERT ON intentchord.context_mapping_attempts
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_attempt_insert_guard();

DROP TRIGGER IF EXISTS context_mapping_attempts_update_guard ON intentchord.context_mapping_attempts;
CREATE TRIGGER context_mapping_attempts_update_guard
BEFORE UPDATE ON intentchord.context_mapping_attempts
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_attempt_update_guard();

DROP TRIGGER IF EXISTS context_catalog_proposals_insert_guard ON intentchord.context_catalog_proposals;
CREATE TRIGGER context_catalog_proposals_insert_guard
BEFORE INSERT ON intentchord.context_catalog_proposals
FOR EACH ROW EXECUTE FUNCTION intentchord.context_catalog_proposal_insert_guard();

DROP TRIGGER IF EXISTS context_catalog_proposals_append_only_update ON intentchord.context_catalog_proposals;
CREATE TRIGGER context_catalog_proposals_append_only_update
BEFORE UPDATE OR DELETE ON intentchord.context_catalog_proposals
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_history_append_only();

DROP TRIGGER IF EXISTS context_mapping_owner_verdicts_insert_guard ON intentchord.context_mapping_owner_verdicts;
CREATE TRIGGER context_mapping_owner_verdicts_insert_guard
BEFORE INSERT ON intentchord.context_mapping_owner_verdicts
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_owner_verdict_insert_guard();

DROP TRIGGER IF EXISTS context_mapping_owner_verdicts_append_only_update ON intentchord.context_mapping_owner_verdicts;
CREATE TRIGGER context_mapping_owner_verdicts_append_only_update
BEFORE UPDATE OR DELETE ON intentchord.context_mapping_owner_verdicts
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_history_append_only();
