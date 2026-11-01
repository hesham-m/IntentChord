import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const historical009 = readFileSync("migrations/009_ai_context_mapper_v1.sql", "utf8");
const migration013 = readFileSync("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql", "utf8");

describe("Migration 013 Internal AI exact configuration qualification binding", () => {
  it("preserves Migration 009 as historical evidence and removes only current literal engine pinning additively", () => {
    expect(historical009).toContain("primary_model_id='glm-4.7-flash'");
    expect(historical009).toContain("standby_model_id='gpt-oss-120b'");

    expect(migration013).toContain("DROP CONSTRAINT IF EXISTS context_mapping_runs_primary_provider_id_check");
    expect(migration013).toContain("DROP CONSTRAINT IF EXISTS context_mapping_runs_primary_model_id_check");
    expect(migration013).toContain("DROP CONSTRAINT IF EXISTS context_mapping_attempts_fixed_channel_ck");
    expect(migration013).toContain("context_mapping_runs_primary_engine_identity_ck");
    expect(migration013).toContain("context_mapping_runs_standby_engine_identity_ck");
    expect(migration013).toContain("ALTER COLUMN standby_provider_id DROP NOT NULL");
    expect(migration013).toContain("ALTER COLUMN standby_channel_id DROP NOT NULL");
    expect(migration013).toContain("ALTER COLUMN standby_model_id DROP NOT NULL");
    expect(migration013).toContain("context_mapping_attempts_engine_identity_shape_ck");

    expect(migration013).not.toMatch(/glm-4\.7-flash|gpt-oss-120b|zai_direct_chat|sambanova_direct_chat/i);
    expect(migration013).not.toMatch(/provider_id\s+IN\s*\(\s*'zai'|provider_id\s*=\s*'zai'|provider_id\s*=\s*'sambanova'/i);
  });


  it("binds the V3 Engine Registry + exact configuration qualification fingerprint while preserving historical snapshots", () => {
    expect(migration013).toContain("context_mapping_runs_provider_configuration_snapshot_shape_ck");
    expect(migration013).toContain("NOT (provider_configuration_snapshot ? 'schema_version')");
    expect(migration013).toContain("intentchord.internal-ai-provider-configuration.v2");
    expect(migration013).toContain("intentchord.internal-ai-engine-registry.v1");
    expect(migration013).toContain("intentchord.internal-ai-provider-configuration.v3");
    expect(migration013).toContain("intentchord.internal-ai-engine-registry.v2");
    expect(migration013).toContain("internal_ai_engine_configuration_sha256_v1");
    expect(migration013).toContain("intentchord.internal-ai-engine-configuration-identity.v1");
    expect(migration013).toContain("selected_engine_configuration_sha256");
    expect(migration013).toContain("engine_configuration_sha256");
    expect(migration013).toContain("selected_engine_id");
    expect(migration013).toContain("selected_engine_config_revision");
    expect(migration013).toContain("qualification_scope");
    expect(migration013).toContain("AI_CONTEXT_MAPPING_V1");
    expect(migration013).toContain("selection_mode");
    expect(migration013).toContain("SINGLE");
    expect(migration013).toContain("(provider_configuration_snapshot->'active'->>'provider_id') IS NOT DISTINCT FROM primary_provider_id");
    expect(migration013).toContain("(provider_configuration_snapshot->'active'->>'model_id') IS NOT DISTINCT FROM primary_model_id");
    expect(migration013).toContain("(provider_configuration_snapshot->'standby'->>'provider_id') IS NOT DISTINCT FROM standby_provider_id");
    expect(migration013).toContain("provider_configuration_snapshot->'failover_policy'->>'validation_failure_failover') IS NOT DISTINCT FROM 'false'");
    expect(migration013).toContain("[[:space:]]");
  });

  it("K requires the governed V3 exact-fingerprint selected-Engine snapshot for every future Mapping Run insert", () => {
    expect(migration013).toContain("CREATE OR REPLACE FUNCTION intentchord.context_mapping_run_insert_guard_v013()");
    expect(migration013).toContain("INTENTCHORD_CONTEXT_MAPPING_RUNTIME_CONFIGURATION_V3_EXACT_QUALIFICATION_REQUIRED");
    expect(migration013).toContain("context_mapping_runs_runtime_configuration_v013");
    expect(migration013).toContain("intentchord.internal-ai-provider-configuration.v3");
    expect(migration013).toContain("provider_configuration_snapshot->'active'->>'engine_configuration_sha256' IS DISTINCT FROM intentchord.internal_ai_engine_configuration_sha256_v1");
  });

  it("binds every future Attempt to the exact runtime engine identity frozen on its Mapping Run", () => {
    expect(migration013).toContain("INTENTCHORD_CONTEXT_MAPPING_PRIMARY_ATTEMPT_ENGINE_MISMATCH");
    expect(migration013).toContain("INTENTCHORD_CONTEXT_MAPPING_STANDBY_ATTEMPT_ENGINE_MISMATCH");
    expect(migration013).toContain("NEW.provider_id IS DISTINCT FROM run_row.primary_provider_id");
    expect(migration013).toContain("NEW.channel_id IS DISTINCT FROM run_row.primary_channel_id");
    expect(migration013).toContain("NEW.requested_model_id IS DISTINCT FROM run_row.primary_model_id");
    expect(migration013).toContain("NEW.provider_id IS DISTINCT FROM run_row.standby_provider_id");
    expect(migration013).toContain("NEW.requested_model_id IS DISTINCT FROM run_row.standby_model_id");
  });

  it("keeps result-envelope provenance exact including requested and response model identity", () => {
    expect(migration013).toContain("CREATE OR REPLACE FUNCTION intentchord.context_catalog_proposal_insert_guard()");
    expect(migration013).toContain("(NEW.result_envelope->>'requested_model_id') IS DISTINCT FROM attempt_row.requested_model_id");
    expect(migration013).toContain("(NEW.result_envelope->>'response_model_id') IS DISTINCT FROM attempt_row.response_model_id");
    expect(migration013).toContain("(NEW.result_envelope->>'provider_request_id') IS DISTINCT FROM attempt_row.provider_request_id");
    expect(migration013).toContain("(NEW.result_envelope->>'provider_system_fingerprint_if_available') IS DISTINCT FROM attempt_row.provider_system_fingerprint");
    expect(migration013).toContain("NEW.result_envelope->'validation_result' IS DISTINCT FROM NEW.deterministic_validation_evidence");
  });

  it("does not touch external Task Execution schema or destructive database scope", () => {
    expect(migration013).not.toMatch(/execution_provider|selected_model|task_execution|provider_registry/i);
    expect(migration013).not.toMatch(/\bDROP\s+TABLE\b|\bTRUNCATE\b|\beit_/i);
    expect(migration013).not.toMatch(/ALTER TABLE\s+intentchord\.(tasks|runs|contracts)\b/i);
  });
});
