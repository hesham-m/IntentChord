-- IntentChord Internal AI Engine exact-configuration qualification binding root correction.
-- Additive after Migration 012. Internal AI Context Mapper only.
-- Historical migrations remain immutable; external Task Execution constraints are untouched.
-- Migration 013 has not been persistently applied and is corrected in-place by v1.0.2.

ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_primary_provider_id_check,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_primary_channel_id_check,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_primary_model_id_check,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_standby_provider_id_check,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_standby_channel_id_check,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_standby_model_id_check;

ALTER TABLE intentchord.context_mapping_runs
  ALTER COLUMN standby_provider_id DROP NOT NULL,
  ALTER COLUMN standby_channel_id DROP NOT NULL,
  ALTER COLUMN standby_model_id DROP NOT NULL;

ALTER TABLE intentchord.context_mapping_runs
  DROP CONSTRAINT IF EXISTS context_mapping_runs_primary_engine_identity_ck,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_standby_engine_identity_ck,
  DROP CONSTRAINT IF EXISTS context_mapping_runs_provider_configuration_snapshot_shape_ck;

-- Exact cross-runtime Engine configuration identity. This ordered length-prefixed UTF-8
-- representation MUST remain in sync with internalAiEngineConfigurationIdentityMaterial().
-- Secret credential VALUES are not inputs; only credential_reference is bound.
CREATE OR REPLACE FUNCTION intentchord.internal_ai_engine_configuration_sha256_v1(engine jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT 'sha256:' || encode(sha256(convert_to(
    'intentchord.internal-ai-engine-configuration-identity.v1' || E'\n' ||
    'engineId=' || octet_length(convert_to(COALESCE(engine->>'engine_id',''),'UTF8'))::text || ':' || COALESCE(engine->>'engine_id','') || E'\n' ||
    'engineConfigRevision=' || octet_length(convert_to(COALESCE(engine->>'engine_config_revision',''),'UTF8'))::text || ':' || COALESCE(engine->>'engine_config_revision','') || E'\n' ||
    'providerId=' || octet_length(convert_to(COALESCE(engine->>'provider_id',''),'UTF8'))::text || ':' || COALESCE(engine->>'provider_id','') || E'\n' ||
    'channelId=' || octet_length(convert_to(COALESCE(engine->>'channel_id',''),'UTF8'))::text || ':' || COALESCE(engine->>'channel_id','') || E'\n' ||
    'modelId=' || octet_length(convert_to(COALESCE(engine->>'model_id',''),'UTF8'))::text || ':' || COALESCE(engine->>'model_id','') || E'\n' ||
    'endpoint=' || octet_length(convert_to(COALESCE(engine->>'endpoint',''),'UTF8'))::text || ':' || COALESCE(engine->>'endpoint','') || E'\n' ||
    'credentialReference=' || octet_length(convert_to(COALESCE(engine->>'credential_reference',''),'UTF8'))::text || ':' || COALESCE(engine->>'credential_reference','') || E'\n' ||
    'transportProfileId=' || octet_length(convert_to(COALESCE(engine->>'transport_profile_id',''),'UTF8'))::text || ':' || COALESCE(engine->>'transport_profile_id','') || E'\n' ||
    'behaviorProfileId=' || octet_length(convert_to(COALESCE(engine->>'behavior_profile_id',''),'UTF8'))::text || ':' || COALESCE(engine->>'behavior_profile_id','') || E'\n' ||
    'capabilityProfileVersion=' || octet_length(convert_to(COALESCE(engine->>'capability_profile_version',''),'UTF8'))::text || ':' || COALESCE(engine->>'capability_profile_version','') || E'\n' ||
    'timeoutMs=' || octet_length(convert_to(COALESCE(engine->>'timeout_ms',''),'UTF8'))::text || ':' || COALESCE(engine->>'timeout_ms',''),
    'UTF8'
  )), 'hex');
$$;

ALTER TABLE intentchord.context_mapping_runs
  ADD CONSTRAINT context_mapping_runs_primary_engine_identity_ck CHECK (
    btrim(primary_provider_id) <> '' AND length(primary_provider_id) <= 200 AND primary_provider_id !~ '[[:space:]]'
    AND btrim(primary_channel_id) <> '' AND length(primary_channel_id) <= 200 AND primary_channel_id !~ '[[:space:]]'
    AND btrim(primary_model_id) <> '' AND length(primary_model_id) <= 200 AND primary_model_id !~ '[[:space:]]'
  ),
  ADD CONSTRAINT context_mapping_runs_standby_engine_identity_ck CHECK (
    (standby_provider_id IS NULL AND standby_channel_id IS NULL AND standby_model_id IS NULL AND standby_enabled=false)
    OR (
      standby_provider_id IS NOT NULL AND btrim(standby_provider_id) <> '' AND length(standby_provider_id) <= 200 AND standby_provider_id !~ '[[:space:]]'
      AND standby_channel_id IS NOT NULL AND btrim(standby_channel_id) <> '' AND length(standby_channel_id) <= 200 AND standby_channel_id !~ '[[:space:]]'
      AND standby_model_id IS NOT NULL AND btrim(standby_model_id) <> '' AND length(standby_model_id) <= 200 AND standby_model_id !~ '[[:space:]]'
    )
  ),
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
        AND (provider_configuration_snapshot->'active'->'qualification'->>'qualification_scope') IS NOT DISTINCT FROM 'AI_CONTEXT_MAPPING_V1'
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
                AND (provider_configuration_snapshot->'candidate'->'qualification'->>'qualification_scope') IS NOT DISTINCT FROM 'AI_CONTEXT_MAPPING_V1'
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
            AND (provider_configuration_snapshot->'standby'->'qualification'->>'qualification_scope') IS NOT DISTINCT FROM 'AI_CONTEXT_MAPPING_V1'
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
  );

ALTER TABLE intentchord.context_mapping_attempts
  DROP CONSTRAINT IF EXISTS context_mapping_attempts_provider_id_check,
  DROP CONSTRAINT IF EXISTS context_mapping_attempts_fixed_channel_ck,
  DROP CONSTRAINT IF EXISTS context_mapping_attempts_engine_identity_shape_ck;

ALTER TABLE intentchord.context_mapping_attempts
  ADD CONSTRAINT context_mapping_attempts_engine_identity_shape_ck CHECK (
    btrim(provider_id) <> '' AND length(provider_id) <= 200 AND provider_id !~ '[[:space:]]'
    AND btrim(channel_id) <> '' AND length(channel_id) <= 200 AND channel_id !~ '[[:space:]]'
    AND btrim(requested_model_id) <> '' AND length(requested_model_id) <= 200 AND requested_model_id !~ '[[:space:]]'
    AND (response_model_id IS NULL OR (
      btrim(response_model_id) <> '' AND length(response_model_id) <= 200 AND response_model_id !~ '[[:space:]]'
    ))
  );

CREATE OR REPLACE FUNCTION intentchord.context_mapping_attempt_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row intentchord.context_mapping_runs%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM intentchord.context_mapping_runs WHERE id=NEW.mapping_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_ORPHAN';
  END IF;

  IF NEW.attempt_ordinal=1 THEN
    IF run_row.status<>'PRIMARY_RUNNING' THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_PRIMARY_ATTEMPT_STATE_BLOCKED';
    END IF;
    IF NEW.provider_id IS DISTINCT FROM run_row.primary_provider_id
       OR NEW.channel_id IS DISTINCT FROM run_row.primary_channel_id
       OR NEW.requested_model_id IS DISTINCT FROM run_row.primary_model_id THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_PRIMARY_ATTEMPT_ENGINE_MISMATCH';
    END IF;
  ELSIF NEW.attempt_ordinal=2 THEN
    IF run_row.status<>'STANDBY_RUNNING' OR run_row.standby_enabled=false OR run_row.standby_governance_state<>'QUALIFIED' THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_STANDBY_ATTEMPT_GOVERNANCE_BLOCKED';
    END IF;
    IF NEW.provider_id IS DISTINCT FROM run_row.standby_provider_id
       OR NEW.channel_id IS DISTINCT FROM run_row.standby_channel_id
       OR NEW.requested_model_id IS DISTINCT FROM run_row.standby_model_id THEN
      RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_STANDBY_ATTEMPT_ENGINE_MISMATCH';
    END IF;
  ELSE
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_ATTEMPT_ORDINAL_INVALID';
  END IF;

  RETURN NEW;
END;
$$;

-- Preserve and strengthen immutable result-envelope-to-attempt provenance for runtime-configured engines.
-- Historical rows are untouched; this guard governs future Proposal inserts.
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
     OR (NEW.result_envelope->>'response_model_id') IS DISTINCT FROM attempt_row.response_model_id
     OR (NEW.result_envelope->>'provider_request_id') IS DISTINCT FROM attempt_row.provider_request_id
     OR (NEW.result_envelope->>'provider_system_fingerprint_if_available') IS DISTINCT FROM attempt_row.provider_system_fingerprint
     OR (NEW.result_envelope->>'attempt_ordinal') IS DISTINCT FROM attempt_row.attempt_ordinal::text
     OR (NEW.result_envelope->>'prompt_template_id') IS DISTINCT FROM attempt_row.prompt_template_id
     OR (NEW.result_envelope->>'prompt_template_sha256') IS DISTINCT FROM attempt_row.prompt_template_sha256
     OR (NEW.result_envelope->>'raw_response_sha256') IS DISTINCT FROM attempt_row.raw_response_sha256
     OR (NEW.result_envelope->>'parsed_catalog_sha256') IS DISTINCT FROM NEW.proposal_sha256
     OR NEW.result_envelope->'model_proposal' IS DISTINCT FROM NEW.proposal_json
     OR NEW.result_envelope->'validation_result' IS DISTINCT FROM NEW.deterministic_validation_evidence
     OR NEW.result_envelope->'usage_metadata' IS DISTINCT FROM attempt_row.usage_metadata
     OR NEW.result_envelope->'rate_limit_metadata' IS DISTINCT FROM attempt_row.rate_limit_metadata
     OR NEW.deterministic_validation_evidence IS DISTINCT FROM attempt_row.validation_summary
  THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_PROVENANCE_MISMATCH';
  END IF;

  RETURN NEW;
END;
$$;



-- Existing historical Mapping Runs retain their persisted snapshot truth.
-- Every new Mapping Run after this correction must freeze V3 exact Engine-configuration identity.
CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_insert_guard_v013()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_configuration_snapshot->>'schema_version' IS DISTINCT FROM 'intentchord.internal-ai-provider-configuration.v3'
     OR NEW.provider_configuration_snapshot->>'registry_schema_version' IS DISTINCT FROM 'intentchord.internal-ai-engine-registry.v2'
     OR NEW.provider_configuration_snapshot->'selection_policy'->>'selection_mode' IS DISTINCT FROM 'SINGLE'
     OR NEW.provider_configuration_snapshot->'active'->'qualification'->>'qualification_scope' IS DISTINCT FROM 'AI_CONTEXT_MAPPING_V1'
     OR NEW.provider_configuration_snapshot->'active'->'qualification'->>'qualification_status' IS DISTINCT FROM 'QUALIFIED'
     OR NEW.provider_configuration_snapshot->>'selected_engine_id' IS DISTINCT FROM NEW.provider_configuration_snapshot->'active'->>'engine_id'
     OR NEW.provider_configuration_snapshot->>'selected_engine_config_revision' IS DISTINCT FROM NEW.provider_configuration_snapshot->'active'->>'engine_config_revision'
     OR NEW.provider_configuration_snapshot->>'selected_engine_configuration_sha256' IS DISTINCT FROM NEW.provider_configuration_snapshot->'active'->>'engine_configuration_sha256'
     OR NEW.provider_configuration_snapshot->'active'->'qualification'->>'engine_configuration_sha256' IS DISTINCT FROM NEW.provider_configuration_snapshot->'active'->>'engine_configuration_sha256'
     OR NEW.provider_configuration_snapshot->'active'->>'engine_configuration_sha256' IS DISTINCT FROM intentchord.internal_ai_engine_configuration_sha256_v1(NEW.provider_configuration_snapshot->'active')
  THEN
    RAISE EXCEPTION 'INTENTCHORD_CONTEXT_MAPPING_RUNTIME_CONFIGURATION_V3_EXACT_QUALIFICATION_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS context_mapping_runs_runtime_configuration_v013 ON intentchord.context_mapping_runs;
CREATE TRIGGER context_mapping_runs_runtime_configuration_v013
BEFORE INSERT ON intentchord.context_mapping_runs
FOR EACH ROW EXECUTE FUNCTION intentchord.context_mapping_run_insert_guard_v013();
