import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256 } from "@/core/ai-context-mapper/prompt";
import {
  MAPPING_RESULT_SCHEMA_VERSION,
  PROMPT_TEMPLATE_ID,
  type CatalogValidationResult,
  type ContextMappingResultEnvelope,
  type MappingInputSnapshot,
  type ProviderAttemptResponse,
} from "@/core/ai-context-mapper/types";
import { validateModelProposedCatalog } from "@/core/ai-context-mapper/validator";
import { sampleInternalAiProviderConfiguration, sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";
import type { SuccessfulAttemptRecord } from "@/core/ai-context-mapper/orchestrator";
import { PostgresAiContextMappingRepository } from "@/server/ai-context-mapping-repository";
import { bindRollbackOnlyTestClient, databasePool, verifyDatabaseIdentity } from "@/server/db";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required for AI Context Mapper PostgreSQL tests.");
  process.env.DATABASE_URL = match[1].trim();
}

let suiteClient: PoolClient | undefined;
let unbindSuiteClient: (() => void) | undefined;
let suiteSavepointSequence = 0;

async function withRollback<T>(work: (client: PoolClient, repository: PostgresAiContextMappingRepository) => Promise<T>): Promise<T> {
  if (!suiteClient) throw new Error("AI_CONTEXT_MAPPER_PG_SUITE_CLIENT_NOT_READY");
  const savepoint = `ai_context_mapper_suite_${++suiteSavepointSequence}`;
  await suiteClient.query(`savepoint ${savepoint}`);
  try { return await work(suiteClient, new PostgresAiContextMappingRepository()); }
  finally {
    try {
      await suiteClient.query(`rollback to savepoint ${savepoint}`);
      await suiteClient.query(`release savepoint ${savepoint}`);
    } catch { /* preserve primary failure; outer transaction remains authoritative */ }
  }
}

function successfulRecord(
  input: MappingInputSnapshot,
  runId: string,
  attemptId: string,
  identity: {
    providerId?: string;
    channelId?: string;
    requestedModelId?: string;
    responseModelId?: string;
    providerRequestId?: string;
    providerSystemFingerprint?: string;
  } = {},
): SuccessfulAttemptRecord {
  const raw = JSON.stringify(validCatalog(input));
  const validation = validateModelProposedCatalog(raw, input);
  if (validation.status !== "PASS" || !validation.parsed_catalog || !validation.parsed_catalog_sha256) {
    throw new Error("TEST_FIXTURE_VALIDATION_FAILED");
  }
  const providerId = identity.providerId ?? "zai";
  const channelId = identity.channelId ?? "zai_direct_chat_completions_v4";
  const requestedModelId = identity.requestedModelId ?? "glm-4.7-flash";
  const responseModelId = identity.responseModelId ?? requestedModelId;
  const providerRequestId = identity.providerRequestId ?? "mock-request";
  const providerSystemFingerprint = identity.providerSystemFingerprint;
  const response: ProviderAttemptResponse = {
    raw_model_content: raw,
    raw_provider_body: JSON.stringify({ choices: [{ message: { content: raw } }] }),
    response_model_id: responseModelId,
    provider_request_id: providerRequestId,
    ...(providerSystemFingerprint ? { provider_system_fingerprint: providerSystemFingerprint } : {}),
    usage_metadata: { total_tokens: 42 },
    rate_limit_metadata: { "x-ratelimit-remaining": "99" },
  };
  const startedAt = "2026-08-04T10:00:00.000Z";
  const completedAt = "2026-08-04T10:00:01.000Z";
  const envelope: ContextMappingResultEnvelope = {
    schema_version: MAPPING_RESULT_SCHEMA_VERSION,
    mapping_run_id: runId,
    mapping_input_snapshot_id: input.mapping_input_snapshot_id,
    mapping_input_sha256: mapperSha256(input),
    attempt_id: attemptId,
    attempt_ordinal: 1,
    provider_id: providerId,
    channel_id: channelId,
    requested_model_id: requestedModelId,
    response_model_id: responseModelId,
    provider_request_id: providerRequestId,
    ...(providerSystemFingerprint ? { provider_system_fingerprint_if_available: providerSystemFingerprint } : {}),
    prompt_template_id: PROMPT_TEMPLATE_ID,
    prompt_template_sha256: AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256,
    raw_response_sha256: validation.raw_response_sha256,
    parsed_catalog_sha256: validation.parsed_catalog_sha256,
    started_at: startedAt,
    completed_at: completedAt,
    usage_metadata: response.usage_metadata,
    rate_limit_metadata: response.rate_limit_metadata,
    validation_result: validation,
    model_proposal: validation.parsed_catalog,
  };
  return {
    completion: { attemptId, status: "SUCCEEDED", response, validation, retryCount: 0, completedAt },
    proposal: {
      id: randomUUID(),
      runId,
      attemptId,
      catalog: validation.parsed_catalog,
      validation,
      createdAt: completedAt,
    },
    envelope,
  };
}

const enabled = process.env.INTENTCHORD_ENABLE_AI_CONTEXT_MAPPER_PG === "1";
const suite = enabled ? describe.sequential : describe.skip;

suite("AI Context Mapper PostgreSQL governed persistence", () => {
  beforeAll(async () => {
    process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
    loadDatabaseUrl();
    suiteClient = await databasePool().connect();
    await verifyDatabaseIdentity(suiteClient);
    await suiteClient.query("begin");
    const migration = await suiteClient.query("select 1 from intentchord.schema_migrations where id='009_ai_context_mapper_v1.sql'");
    if (!migration.rowCount) {
      const migrationSql = readFileSync("migrations/009_ai_context_mapper_v1.sql", "utf8");
      await suiteClient.query(migrationSql);
    }
    const migration013Sql = readFileSync("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql", "utf8");
    await suiteClient.query(migration013Sql);
    unbindSuiteClient = bindRollbackOnlyTestClient(suiteClient);
  });

  afterAll(async () => {
    unbindSuiteClient?.();
    if (suiteClient) {
      try { await suiteClient.query("rollback"); } catch { /* preserve test result */ }
      suiteClient.release();
      suiteClient = undefined;
    }
    delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
    await databasePool().end();
  });

  it("persists one run, one validated attempt, one proposal, and one immutable Owner verdict transactionally", async () => {
    await withRollback(async (client, repository) => {
      const input = sampleMappingInput();
      const runId = randomUUID();
      await repository.createRun({ id: runId, input, inputSha256: mapperSha256(input), providerConfigurationSnapshot: sampleInternalAiProviderConfiguration(), standbyEnabled: false, standbyGovernanceState: "BLOCKED_BY_GOVERNANCE" });
      await repository.transitionRunStatus(runId, "INPUT_VALIDATED");
      const attemptId = randomUUID();
      await repository.startAttempt({
        id: attemptId,
        runId,
        ordinal: 1,
        providerId: "zai",
        channelId: "zai_direct_chat_completions_v4",
        requestedModelId: "glm-4.7-flash",
        startedAt: "2026-08-04T10:00:00.000Z",
        runStatus: "PRIMARY_RUNNING",
      });
      await repository.finalizeSuccessfulAttempt(successfulRecord(input, runId, attemptId));
      const accepted = await repository.recordOwnerVerdict({ runId, verdict: "ACCEPT", note: "Owner accepts the validated proposal.", ownerAuthority: "owner-local:Hisham", createdAt: "2026-08-04T10:00:02.000Z" });
      expect(accepted.status).toBe("OWNER_ACCEPTED");
      expect(accepted.proposal?.attemptId).toBe(attemptId);
      expect(accepted.proposal?.resultEnvelope.provider_id).toBe("zai");
      expect(await repository.listAttempts(runId)).toHaveLength(1);

      await client.query("savepoint immutable_verdict_probe");
      await expect(client.query("update intentchord.context_mapping_owner_verdicts set note='tampered' where mapping_run_id=$1", [runId])).rejects.toThrow(/INTENTCHORD_CONTEXT_MAPPING_HISTORY_APPEND_ONLY/);
      await client.query("rollback to savepoint immutable_verdict_probe");
      await client.query("savepoint immutable_proposal_probe");
      await expect(client.query("delete from intentchord.context_catalog_proposals where mapping_run_id=$1", [runId])).rejects.toThrow(/INTENTCHORD_CONTEXT_MAPPING_HISTORY_APPEND_ONLY/);
      await client.query("rollback to savepoint immutable_proposal_probe");
    });
  });

  it("rolls back attempt completion, proposal insertion, and run transition together when provenance is invalid", async () => {
    await withRollback(async (client, repository) => {
      const input = sampleMappingInput();
      const runId = randomUUID();
      await repository.createRun({ id: runId, input, inputSha256: mapperSha256(input), providerConfigurationSnapshot: sampleInternalAiProviderConfiguration(), standbyEnabled: false, standbyGovernanceState: "BLOCKED_BY_GOVERNANCE" });
      await repository.transitionRunStatus(runId, "INPUT_VALIDATED");
      const attemptId = randomUUID();
      await repository.startAttempt({
        id: attemptId,
        runId,
        ordinal: 1,
        providerId: "zai",
        channelId: "zai_direct_chat_completions_v4",
        requestedModelId: "glm-4.7-flash",
        startedAt: "2026-08-04T10:00:00.000Z",
        runStatus: "PRIMARY_RUNNING",
      });
      const invalid = successfulRecord(input, randomUUID(), attemptId);
      await expect(repository.finalizeSuccessfulAttempt(invalid)).rejects.toThrow(/provenance/i);

      const attempt = await client.query("select status from intentchord.context_mapping_attempts where id=$1", [attemptId]);
      const run = await client.query("select status,final_attempt_id from intentchord.context_mapping_runs where id=$1", [runId]);
      const proposals = await client.query("select 1 from intentchord.context_catalog_proposals where source_attempt_id=$1", [attemptId]);
      expect(attempt.rows[0].status).toBe("RUNNING");
      expect(run.rows[0].status).toBe("PRIMARY_RUNNING");
      expect(run.rows[0].final_attempt_id).toBeNull();
      expect(proposals.rowCount).toBe(0);
    });
  });

  it("prevents orphan proposals, duplicate attempt ordinals, and unqualified standby attempts", async () => {
    await withRollback(async (client, repository) => {
      const input = sampleMappingInput();
      const runId = randomUUID();
      await repository.createRun({ id: runId, input, inputSha256: mapperSha256(input), providerConfigurationSnapshot: sampleInternalAiProviderConfiguration(), standbyEnabled: false, standbyGovernanceState: "BLOCKED_BY_GOVERNANCE" });
      await repository.transitionRunStatus(runId, "INPUT_VALIDATED");
      const attemptId = randomUUID();
      await repository.startAttempt({
        id: attemptId,
        runId,
        ordinal: 1,
        providerId: "zai",
        channelId: "zai_direct_chat_completions_v4",
        requestedModelId: "glm-4.7-flash",
        startedAt: "2026-08-04T10:00:00.000Z",
        runStatus: "PRIMARY_RUNNING",
      });

      await client.query("savepoint duplicate_attempt_probe");
      await expect(client.query(
        `insert into intentchord.context_mapping_attempts(
          id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,
          prompt_template_id,prompt_template_sha256,status,started_at
        ) values($1,$2,1,'zai','zai_direct_chat_completions_v4','glm-4.7-flash',$3,$4,'RUNNING',clock_timestamp())`,
        [randomUUID(), runId, PROMPT_TEMPLATE_ID, AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256],
      )).rejects.toThrow();
      await client.query("rollback to savepoint duplicate_attempt_probe");

      const successful = successfulRecord(input, runId, attemptId);
      await client.query("savepoint orphan_proposal_probe");
      await expect(client.query(
        `insert into intentchord.context_catalog_proposals(
          id,mapping_run_id,source_attempt_id,schema_version,proposal_json,proposal_sha256,
          deterministic_validation_evidence,result_envelope,created_at
        ) values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,
        [successful.proposal.id, runId, attemptId, "intentchord.model-proposed-context-catalog.v1", JSON.stringify(successful.proposal.catalog), mapperSha256(successful.proposal.catalog), JSON.stringify(successful.proposal.validation), JSON.stringify(successful.envelope)],
      )).rejects.toThrow(/REQUIRES_SUCCEEDED_ATTEMPT/);
      await client.query("rollback to savepoint orphan_proposal_probe");

      await client.query("savepoint standby_governance_probe");
      await expect(client.query(
        `insert into intentchord.context_mapping_attempts(
          id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,
          prompt_template_id,prompt_template_sha256,status,started_at
        ) values($1,$2,2,'sambanova','sambanova_direct_chat_completions_v1','gpt-oss-120b',$3,$4,'RUNNING',clock_timestamp())`,
        [randomUUID(), runId, PROMPT_TEMPLATE_ID, AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256],
      )).rejects.toThrow(/STANDBY_ATTEMPT_GOVERNANCE_BLOCKED|fixed_channel|check constraint/i);
      await client.query("rollback to savepoint standby_governance_probe");
    });
  });

  it("persists qualified non-pinned Provider/Model identities and preserves requested-vs-response provenance exactly", async () => {
    await withRollback(async (client, repository) => {
      const input = sampleMappingInput();
      const runId = randomUUID();
      const providerConfigurationSnapshot = sampleInternalAiProviderConfiguration({
        primaryProviderId: "qualified-provider-x",
        primaryChannelId: "qualified-chat-profile-v1",
        primaryModelId: "qualified-model-requested-v2",
      });
      await repository.createRun({
        id: runId,
        input,
        inputSha256: mapperSha256(input),
        providerConfigurationSnapshot,
        standbyEnabled: false,
        standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
      });
      await repository.transitionRunStatus(runId, "INPUT_VALIDATED");

      const attemptId = randomUUID();
      await repository.startAttempt({
        id: attemptId,
        runId,
        ordinal: 1,
        providerId: "qualified-provider-x",
        channelId: "qualified-chat-profile-v1",
        requestedModelId: "qualified-model-requested-v2",
        startedAt: "2026-08-04T10:00:00.000Z",
        runStatus: "PRIMARY_RUNNING",
      });

      const record = successfulRecord(input, runId, attemptId, {
        providerId: "qualified-provider-x",
        channelId: "qualified-chat-profile-v1",
        requestedModelId: "qualified-model-requested-v2",
        responseModelId: "qualified-model-response-v2.1",
        providerRequestId: "qualified-request-123",
        providerSystemFingerprint: "qualified-system-fingerprint",
      });
      await repository.finalizeSuccessfulAttempt(record);

      const persistedRun = await repository.readRun(runId);
      const attempts = await repository.listAttempts(runId);
      expect(persistedRun.primaryProviderId).toBe("qualified-provider-x");
      expect(persistedRun.primaryChannelId).toBe("qualified-chat-profile-v1");
      expect(persistedRun.primaryModelId).toBe("qualified-model-requested-v2");
      expect(persistedRun.providerConfigurationSnapshot).toEqual(providerConfigurationSnapshot);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        providerId: "qualified-provider-x",
        channelId: "qualified-chat-profile-v1",
        requestedModelId: "qualified-model-requested-v2",
        responseModelId: "qualified-model-response-v2.1",
        providerRequestId: "qualified-request-123",
        providerSystemFingerprint: "qualified-system-fingerprint",
      });
      expect(persistedRun.proposal?.resultEnvelope).toMatchObject({
        provider_id: "qualified-provider-x",
        channel_id: "qualified-chat-profile-v1",
        requested_model_id: "qualified-model-requested-v2",
        response_model_id: "qualified-model-response-v2.1",
      });

      const mismatchRunId = randomUUID();
      const mismatchConfig = sampleInternalAiProviderConfiguration({
        primaryProviderId: "qualified-provider-y",
        primaryChannelId: "qualified-channel-y",
        primaryModelId: "qualified-model-y",
      });
      await repository.createRun({
        id: mismatchRunId,
        input,
        inputSha256: mapperSha256(input),
        providerConfigurationSnapshot: mismatchConfig,
        standbyEnabled: false,
        standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
      });
      await repository.transitionRunStatus(mismatchRunId, "INPUT_VALIDATED");
      await repository.transitionRunStatus(mismatchRunId, "PRIMARY_RUNNING");
      await client.query("savepoint runtime_engine_mismatch_probe");
      await expect(client.query(
        `insert into intentchord.context_mapping_attempts(
          id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,
          prompt_template_id,prompt_template_sha256,status,started_at
        ) values($1,$2,1,'wrong-provider','qualified-channel-y','qualified-model-y',$3,$4,'RUNNING',clock_timestamp())`,
        [randomUUID(), mismatchRunId, PROMPT_TEMPLATE_ID, AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256],
      )).rejects.toThrow(/PRIMARY_ATTEMPT_ENGINE_MISMATCH/);
      await client.query("rollback to savepoint runtime_engine_mismatch_probe");
    });
  });

  it("requires the governed V3 exact-fingerprint selected-Engine snapshot for every new Mapping Run while leaving historical rows untouched", async () => {
    await withRollback(async (client) => {
      const input = sampleMappingInput();
      await expect(client.query(
        `insert into intentchord.context_mapping_runs(
          id,mapping_input_snapshot_id,mapping_input_sha256,mapping_input_snapshot,
          workspace_index_contract_version,workspace_snapshot_id,workspace_index_sha256,
          eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,status,
          primary_provider_id,primary_channel_id,primary_model_id,
          standby_provider_id,standby_channel_id,standby_model_id,standby_enabled,
          standby_governance_state,provider_configuration_snapshot
        ) values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,'CREATED',
          'legacy-direct-provider','legacy-direct-channel','legacy-direct-model',
          'legacy-direct-standby','legacy-direct-standby-channel','legacy-direct-standby-model',false,
          'BLOCKED_BY_GOVERNANCE','{}'::jsonb)`,
        [
          randomUUID(), input.mapping_input_snapshot_id, mapperSha256(input), JSON.stringify(input),
          input.workspace_index_contract_version, input.workspace_snapshot_id, input.workspace_index_sha256,
          input.eligible_entry_count, input.excluded_entry_count, input.provider_neutral_estimated_tokens,
        ],
      )).rejects.toThrow(/INTENTCHORD_CONTEXT_MAPPING_RUNTIME_CONFIGURATION_V3_EXACT_QUALIFICATION_REQUIRED/);
    });
  });

  it("K proves PostgreSQL recomputes the same exact Engine configuration fingerprint as the TypeScript runtime", async () => {
    await withRollback(async (client) => {
      const snapshot = sampleInternalAiProviderConfiguration();
      const result = await client.query<{ fingerprint: string }>(
        "select intentchord.internal_ai_engine_configuration_sha256_v1($1::jsonb) as fingerprint",
        [JSON.stringify(snapshot.active)],
      );
      expect(result.rows[0].fingerprint).toBe(snapshot.active.engine_configuration_sha256);
    });
  });

  it("K rejects Run snapshot tampering when Engine fields no longer match the frozen configuration fingerprint", async () => {
    await withRollback(async (client, repository) => {
      const input = sampleMappingInput();
      const snapshot = sampleInternalAiProviderConfiguration();
      const tampered = structuredClone(snapshot);
      tampered.active.model_id = "tampered-model-with-old-fingerprint";
      const runId = randomUUID();
      await client.query("savepoint engine_configuration_fingerprint_tamper_probe");
      await expect(repository.createRun({
        id: runId,
        input,
        inputSha256: mapperSha256(input),
        providerConfigurationSnapshot: tampered,
        standbyEnabled: false,
        standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
      })).rejects.toThrow(/check constraint|V3_EXACT_QUALIFICATION_REQUIRED|provider_configuration_snapshot_shape/i);
      await client.query("rollback to savepoint engine_configuration_fingerprint_tamper_probe");

      await client.query("savepoint qualification_fingerprint_tamper_probe");
      const qualificationTamper = structuredClone(snapshot);
      qualificationTamper.active.qualification!.engine_configuration_sha256 = `sha256:${"0".repeat(64)}`;
      await expect(repository.createRun({
        id: randomUUID(),
        input,
        inputSha256: mapperSha256(input),
        providerConfigurationSnapshot: qualificationTamper,
        standbyEnabled: false,
        standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
      })).rejects.toThrow(/check constraint|V3_EXACT_QUALIFICATION_REQUIRED|provider_configuration_snapshot_shape/i);
      await client.query("rollback to savepoint qualification_fingerprint_tamper_probe");
    });
  });

  it("can re-execute Migration 013 idempotently inside the rollback-only suite transaction", async () => {
    await withRollback(async (client) => {
      const migrationSql = readFileSync("migrations/013_internal_ai_engine_runtime_identity_decoupling.sql", "utf8");
      await expect(client.query(migrationSql)).resolves.toBeDefined();
      await expect(client.query(migrationSql)).resolves.toBeDefined();

      const constraints = await client.query<{ conname: string }>(
        `select conname from pg_constraint c
         join pg_class t on t.oid=c.conrelid
         join pg_namespace n on n.oid=t.relnamespace
         where n.nspname='intentchord'
           and t.relname in ('context_mapping_runs','context_mapping_attempts')`,
      );
      const names = new Set(constraints.rows.map((row: { conname: string }) => row.conname));
      expect(names.has("context_mapping_runs_primary_engine_identity_ck")).toBe(true);
      expect(names.has("context_mapping_runs_standby_engine_identity_ck")).toBe(true);
      expect(names.has("context_mapping_attempts_engine_identity_shape_ck")).toBe(true);
      expect(names.has("context_mapping_attempts_fixed_channel_ck")).toBe(false);
    });
  });
});
