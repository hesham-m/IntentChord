import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256 } from "@/core/ai-context-mapper/prompt";
import {
  MAPPING_RESULT_SCHEMA_VERSION,
  PROMPT_TEMPLATE_ID,
  type ContextMappingResultEnvelope,
  type MappingInputSnapshot,
  type ProviderAttemptResponse,
} from "@/core/ai-context-mapper/types";
import { sampleInternalAiProviderConfiguration, sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";
import { validateModelProposedCatalog } from "@/core/ai-context-mapper/validator";
import type { SuccessfulAttemptRecord } from "@/core/ai-context-mapper/orchestrator";
import { PostgresAiContextMappingRepository } from "@/server/ai-context-mapping-repository";
import { bindRollbackOnlyTestClient, databasePool, verifyDatabaseIdentity } from "@/server/db";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required for Workspace Analysis PostgreSQL tests.");
  process.env.DATABASE_URL = match[1].trim();
}

type SchemaMigrationStateRow = {
  id: string;
  applied_at_epoch: string;
};

const REQUIRED_CURRENT_SCHEMA_MIGRATIONS = [
  "001_intentchord_vertical_slice.sql",
  "002_backend_authoritative_lifecycle.sql",
  "003_owner_decision_ledger.sql",
  "004_trust_invariants_and_authoritative_projection.sql",
  "005_semantic_trust_hardening.sql",
  "006_intelligence_and_evidence_semantics.sql",
  "007_project_context_and_truth_registry.sql",
  "008_project_truth_database_clock_authority.sql",
  "009_ai_context_mapper_v1.sql",
  "010_workspace_index_snapshots_and_context_decisions.sql",
  "011_workspace_index_runtime_governance.sql",
  "012_workspace_revision_observation_and_index_artifacts.sql",
  "013_internal_ai_engine_runtime_identity_decoupling.sql",
  "014_governed_context_assembly_and_ai_context_mapping_v2.sql",
] as const;

let client: PoolClient | undefined;
let unbind: (() => void) | undefined;
let savepointSequence = 0;
let schemaMigrationStateBefore: SchemaMigrationStateRow[] | undefined;
let outerTransactionStarted = false;

async function readSchemaMigrationState(suiteClient: PoolClient): Promise<SchemaMigrationStateRow[]> {
  const result = await suiteClient.query<SchemaMigrationStateRow>(
    `select id,extract(epoch from applied_at)::text as applied_at_epoch
     from intentchord.schema_migrations
     order by id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    applied_at_epoch: row.applied_at_epoch,
  }));
}

function assertCurrentWorkspaceAnalysisSchema(state: readonly SchemaMigrationStateRow[]): void {
  const applied = new Set(state.map((row) => row.id));
  const missing = REQUIRED_CURRENT_SCHEMA_MIGRATIONS.filter((id) => !applied.has(id));
  if (missing.length) {
    throw new Error(`WORKSPACE_ANALYSIS_CURRENT_SCHEMA_REQUIRED:${missing.join(",")}`);
  }
}

async function withRollback<T>(work: (suiteClient: PoolClient) => Promise<T>): Promise<T> {
  if (!client) throw new Error("WORKSPACE_ANALYSIS_PG_CLIENT_NOT_READY");
  const savepoint = `workspace_analysis_${++savepointSequence}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    return await work(client);
  } finally {
    try {
      await client.query(`rollback to savepoint ${savepoint}`);
      await client.query(`release savepoint ${savepoint}`);
    } catch {
      // Preserve the primary assertion failure; the outer transaction is authoritative.
    }
  }
}

async function insertReadySnapshot(
  suiteClient: PoolClient,
  canonicalSha256: string,
  idempotencyKey = `snapshot-${randomUUID()}`,
): Promise<string> {
  const id = randomUUID();
  const requestFingerprint = `sha256:${"1".repeat(64)}`;
  await suiteClient.query(
    `insert into intentchord.workspace_index_snapshots(
      id,source_mode,status,governed_scope,snapshot_idempotency_key,snapshot_request_fingerprint_sha256,
      canonical_contract_version,canonical_index_json,canonical_sha256,owner_reference,started_at,completed_at,
      progress_phase,progress_evidence,heartbeat_at
    ) values($1,'ADVANCED_DIAGNOSTIC','READY','{"filesystemRead":false}'::jsonb,$2,$3,'1.0.0','{}'::jsonb,$4,
      'owner-local:Hisham',clock_timestamp(),clock_timestamp(),'READY','{}'::jsonb,clock_timestamp())`,
    [id, idempotencyKey, requestFingerprint, canonicalSha256],
  );
  return id;
}

function successfulRecord(input: MappingInputSnapshot, runId: string, attemptId: string): SuccessfulAttemptRecord {
  const catalog = validCatalog(input);
  catalog.contexts.push({
    ...structuredClone(catalog.contexts[0]),
    context_id: "ctx_secondary",
    display_name: "Secondary Context",
    summary: "A second independently reviewable Context for partial acceptance testing.",
    rationale: "The same governed evidence may support a distinct candidate Context, subject to Owner review.",
  });
  const raw = JSON.stringify(catalog);
  const validation = validateModelProposedCatalog(raw, input);
  if (validation.status !== "PASS" || !validation.parsed_catalog || !validation.parsed_catalog_sha256) {
    throw new Error("WORKSPACE_ANALYSIS_TEST_CATALOG_INVALID");
  }
  const response: ProviderAttemptResponse = {
    raw_model_content: raw,
    raw_provider_body: JSON.stringify({ choices: [{ message: { content: raw } }] }),
    response_model_id: "glm-4.7-flash",
    provider_request_id: "workspace-analysis-mock-request",
    usage_metadata: { total_tokens: 42 },
    rate_limit_metadata: {},
  };
  const startedAt = "2026-08-05T09:00:00.000Z";
  const completedAt = "2026-08-05T09:00:01.000Z";
  const envelope: ContextMappingResultEnvelope = {
    schema_version: MAPPING_RESULT_SCHEMA_VERSION,
    mapping_run_id: runId,
    mapping_input_snapshot_id: input.mapping_input_snapshot_id,
    mapping_input_sha256: mapperSha256(input),
    attempt_id: attemptId,
    attempt_ordinal: 1,
    provider_id: "zai",
    channel_id: "zai_direct_chat_completions_v4",
    requested_model_id: "glm-4.7-flash",
    response_model_id: "glm-4.7-flash",
    provider_request_id: "workspace-analysis-mock-request",
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

const enabled = process.env.INTENTCHORD_ENABLE_WORKSPACE_ANALYSIS_PG === "1";
const suite = enabled ? describe.sequential : describe.skip;

suite("Workspace Analysis PostgreSQL rollback-only integrity", () => {
  beforeAll(async () => {
    loadDatabaseUrl();
    client = await databasePool().connect();
    await verifyDatabaseIdentity(client);

    schemaMigrationStateBefore = await readSchemaMigrationState(client);
    assertCurrentWorkspaceAnalysisSchema(schemaMigrationStateBefore);

    await client.query("begin");
    outerTransactionStarted = true;
    unbind = bindRollbackOnlyTestClient(client);
  });

  afterAll(async () => {
    unbind?.();
    let cleanupError: unknown;
    if (client) {
      try {
        if (outerTransactionStarted) {
          await client.query("rollback");
          outerTransactionStarted = false;
        }
        if (schemaMigrationStateBefore) {
          const schemaMigrationStateAfter = await readSchemaMigrationState(client);
          if (JSON.stringify(schemaMigrationStateAfter) !== JSON.stringify(schemaMigrationStateBefore)) {
            throw new Error("WORKSPACE_ANALYSIS_SCHEMA_MIGRATION_STATE_CHANGED");
          }
        }
      } catch (error) {
        cleanupError = error;
      } finally {
        client.release();
        client = undefined;
      }
    }
    await databasePool().end();
    if (cleanupError) throw cleanupError;
  });

  it("keeps READY Snapshots immutable and enforces Snapshot idempotency uniqueness", async () => {
    await withRollback(async suiteClient => {
      const snapshotId = await insertReadySnapshot(suiteClient, `sha256:${"0".repeat(64)}`, "snapshot-idempotency-test");
      await suiteClient.query("savepoint snapshot_update_probe");
      await expect(suiteClient.query(
        "update intentchord.workspace_index_snapshots set canonical_sha256=$2 where id=$1",
        [snapshotId, `sha256:${"2".repeat(64)}`],
      )).rejects.toThrow(/INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TRANSITION_BLOCKED/);
      await suiteClient.query("rollback to savepoint snapshot_update_probe");

      await expect(insertReadySnapshot(
        suiteClient,
        `sha256:${"0".repeat(64)}`,
        "snapshot-idempotency-test",
      )).rejects.toThrow(/workspace_index_snapshots_idempotency_uq/);
    });
  });

  it("binds a Mapping Run to the persisted READY Snapshot and exact canonical SHA", async () => {
    await withRollback(async suiteClient => {
      const input = sampleMappingInput();
      const snapshotId = await insertReadySnapshot(suiteClient, input.workspace_index_sha256);
      const repository = new PostgresAiContextMappingRepository({
        workspaceIndexSnapshotId: snapshotId,
        idempotencyKey: `mapping-${randomUUID()}`,
        requestFingerprintSha256: `sha256:${"3".repeat(64)}`,
      });
      const runId = randomUUID();
      const run = await repository.createRun({
        id: runId,
        input,
        inputSha256: mapperSha256(input),
        providerConfigurationSnapshot: sampleInternalAiProviderConfiguration(),
        standbyEnabled: false,
        standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
      });
      expect(run.workspaceIndexSnapshotId).toBe(snapshotId);
      expect(run.workspaceIndexSha256).toBe(input.workspace_index_sha256);

      const stored = await suiteClient.query(
        `select workspace_index_snapshot_id,workspace_index_sha256,
          standby_provider_id,standby_channel_id,standby_model_id,standby_enabled
         from intentchord.context_mapping_runs where id=$1`,
        [runId],
      );
      expect(stored.rows[0].workspace_index_snapshot_id).toBe(snapshotId);
      expect(stored.rows[0].workspace_index_sha256).toBe(input.workspace_index_sha256);
      expect(stored.rows[0]).toMatchObject({
        standby_provider_id: null,
        standby_channel_id: null,
        standby_model_id: null,
        standby_enabled: false,
      });
    });
  });

  it("returns the existing Mapping Run for the same idempotency key and rejects fingerprint drift", async () => {
    await withRollback(async suiteClient => {
      const input = sampleMappingInput();
      const snapshotId = await insertReadySnapshot(suiteClient, input.workspace_index_sha256);
      const idempotencyKey = `mapping-idempotency-${randomUUID()}`;
      const requestFingerprint = `sha256:${"6".repeat(64)}`;
      const repository = new PostgresAiContextMappingRepository({
        workspaceIndexSnapshotId: snapshotId,
        idempotencyKey,
        requestFingerprintSha256: requestFingerprint,
      });
      const run = await repository.createRun({
        id: randomUUID(),
        input,
        inputSha256: mapperSha256(input),
        providerConfigurationSnapshot: sampleInternalAiProviderConfiguration(),
        standbyEnabled: false,
        standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
      });
      const replay = await repository.findIdempotentRun(idempotencyKey, requestFingerprint);
      expect(replay?.id).toBe(run.id);
      await expect(repository.findIdempotentRun(
        idempotencyKey,
        `sha256:${"7".repeat(64)}`,
      )).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    });
  });

  it("rejects a Mapping Run whose input hash differs from its persisted Snapshot", async () => {
    await withRollback(async suiteClient => {
      const input = sampleMappingInput();
      const snapshotId = await insertReadySnapshot(suiteClient, `sha256:${"9".repeat(64)}`);
      const repository = new PostgresAiContextMappingRepository({
        workspaceIndexSnapshotId: snapshotId,
        idempotencyKey: `mapping-${randomUUID()}`,
        requestFingerprintSha256: `sha256:${"4".repeat(64)}`,
      });
      await expect(repository.createRun({
        id: randomUUID(),
        input,
        inputSha256: mapperSha256(input),
        providerConfigurationSnapshot: sampleInternalAiProviderConfiguration(),
        standbyEnabled: false,
        standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
      })).rejects.toThrow(/INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_HASH_MISMATCH/);
    });
  });

  it("persists partial Owner acceptance atomically and keeps AI Proposal separate", async () => {
    await withRollback(async suiteClient => {
      const input = sampleMappingInput();
      const snapshotId = await insertReadySnapshot(suiteClient, input.workspace_index_sha256);
      const repository = new PostgresAiContextMappingRepository({
        workspaceIndexSnapshotId: snapshotId,
        idempotencyKey: `mapping-${randomUUID()}`,
        requestFingerprintSha256: `sha256:${"5".repeat(64)}`,
      });
      const runId = randomUUID();
      await repository.createRun({
        id: runId,
        input,
        inputSha256: mapperSha256(input),
        providerConfigurationSnapshot: sampleInternalAiProviderConfiguration(),
        standbyEnabled: false,
        standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
      });
      await repository.transitionRunStatus(runId, "INPUT_VALIDATED");
      const attemptId = randomUUID();
      await repository.startAttempt({
        id: attemptId,
        runId,
        ordinal: 1,
        providerId: "zai",
        channelId: "zai_direct_chat_completions_v4",
        requestedModelId: "glm-4.7-flash",
        startedAt: "2026-08-05T09:00:00.000Z",
        runStatus: "PRIMARY_RUNNING",
      });
      await repository.finalizeSuccessfulAttempt(successfulRecord(input, runId, attemptId));
      const reviewed = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
          { contextId: "ctx_secondary", decision: "REJECT", note: "Not applicable." },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-05T09:00:02.000Z",
      });
      expect(reviewed.status).toBe("OWNER_ACCEPTED");
      expect(reviewed.ownerContextDecisions.filter(item => item.decision === "ACCEPT")).toHaveLength(1);
      expect(reviewed.ownerContextDecisions.filter(item => item.decision === "REJECT")).toHaveLength(1);

      const projectFactMutation = await suiteClient.query(
        "select count(*)::int as count from intentchord.project_fact_revisions where provenance_json->>'source'='AI_CONTEXT_MAPPER'",
      );
      expect(projectFactMutation.rows[0].count).toBe(0);

      await suiteClient.query("savepoint decision_mutation_probe");
      await expect(suiteClient.query(
        "update intentchord.context_mapping_owner_context_decisions set decision='REJECT' where mapping_run_id=$1",
        [runId],
      )).rejects.toThrow(/INTENTCHORD_CONTEXT_MAPPING_HISTORY_APPEND_ONLY/);
      await suiteClient.query("rollback to savepoint decision_mutation_probe");
    });
  });
});
