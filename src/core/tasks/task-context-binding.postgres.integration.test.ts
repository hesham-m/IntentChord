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
import { sampleCanonicalWorkspaceIndex, sampleInternalAiProviderConfiguration, sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";
import { buildMappingInputSnapshot } from "@/core/ai-context-mapper/input-builder";
import type { CanonicalWorkspaceIndexContract } from "@/core/workspace-index/types";
import { finalizeWorkspaceIndexContract } from "@/core/workspace-index/canonical";
import { validateModelProposedCatalog } from "@/core/ai-context-mapper/validator";
import type { SuccessfulAttemptRecord } from "@/core/ai-context-mapper/orchestrator";
import { PostgresAiContextMappingRepository } from "@/server/ai-context-mapping-repository";
import { bindRollbackOnlyTestClient, databasePool, verifyDatabaseIdentity } from "@/server/db";
import { readDatabaseCommandTime } from "@/server/database-clock";
import { validateAndResolveTaskContextBinding } from "@/server/task-context-binding-service";
import {
  applyOwnerScopeConfirmation,
  resolveCandidateScopeFromMappingInput,
  TaskContextBindingError,
} from "@/core/tasks/candidate-scope";
import {
  assertContractReadyTaskDraft,
  createBlankContractInput,
  createBlankTaskDraft,
  type LegacyTaskCandidateScope,
  type TaskCandidateScope,
  type TaskContextAnalysisBinding,
  type TaskDraftInput,
  type TaskScopeConfirmation,
  type WorkspaceReference,
} from "@/core/tasks/task-input";
import {
  createTask,
  reviseTask,
  confirmTaskScope,
  readTaskLifecycle,
} from "@/server/lifecycle";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required for Task Context Binding PostgreSQL tests.");
  process.env.DATABASE_URL = match[1].trim();
}

let client: PoolClient | undefined;
let unbind: (() => void) | undefined;
let savepointSequence = 0;

type HistoricalV1CandidateScope = LegacyTaskCandidateScope & { authorityVersion: "MAPPING_V1" };

function requireHistoricalV1CandidateScope(scope: TaskCandidateScope): HistoricalV1CandidateScope {
  if (scope.authorityVersion === "CONTEXT_ASSEMBLY_V2") {
    throw new Error("HISTORICAL_V1_REGRESSION_EXPECTED_MAPPING_V1_SCOPE");
  }
  return { ...scope, authorityVersion: "MAPPING_V1" };
}

async function withRollback<T>(work: (suiteClient: PoolClient, repository: PostgresAiContextMappingRepository) => Promise<T>): Promise<T> {
  if (!client) throw new Error("TASK_CONTEXT_BINDING_PG_CLIENT_NOT_READY");
  const savepoint = `task_context_binding_${++savepointSequence}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    return await work(client, new PostgresAiContextMappingRepository());
  } finally {
    try {
      await client.query(`rollback to savepoint ${savepoint}`);
      await client.query(`release savepoint ${savepoint}`);
    } catch {
      // Preserve primary assertion failure; outer transaction is authoritative.
    }
  }
}

async function insertReadySnapshot(
  suiteClient: PoolClient,
  canonicalIndex = sampleCanonicalWorkspaceIndex(),
): Promise<string> {
  const id = randomUUID();
  const canonicalJson = JSON.stringify(canonicalIndex);
  const canonicalSha = canonicalIndex.integrity.canonical_payload_hash;
  const requestFingerprint = `sha256:${"1".repeat(64)}`;
  await suiteClient.query(
    `insert into intentchord.workspace_index_snapshots(
      id,source_mode,status,governed_scope,snapshot_idempotency_key,snapshot_request_fingerprint_sha256,
      canonical_contract_version,canonical_index_json,canonical_sha256,owner_reference,started_at,completed_at
    ) values($1,'ADVANCED_DIAGNOSTIC','READY','{"filesystemRead":false}'::jsonb,$2,$3,'1.0.0',$4::jsonb,$5,
      'owner-local:Hisham',clock_timestamp(),clock_timestamp())`,
    [id, `snapshot-${randomUUID()}`, requestFingerprint, canonicalJson, canonicalSha],
  );
  return id;
}

function makeSuccessfulRecord(input: MappingInputSnapshot, runId: string, attemptId: string): SuccessfulAttemptRecord {
  const catalog = validCatalog(input);
  const raw = JSON.stringify(catalog);
  const validation = validateModelProposedCatalog(raw, input);
  if (validation.status !== "PASS" || !validation.parsed_catalog || !validation.parsed_catalog_sha256) {
    throw new Error("TASK_CONTEXT_BINDING_CATALOG_INVALID");
  }
  const response: ProviderAttemptResponse = {
    raw_model_content: raw,
    raw_provider_body: JSON.stringify({ choices: [{ message: { content: raw } }] }),
    response_model_id: "glm-4.7-flash",
    provider_request_id: "mock-request",
    usage_metadata: { total_tokens: 42 },
    rate_limit_metadata: {},
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
    provider_id: "zai",
    channel_id: "zai_direct_chat_completions_v4",
    requested_model_id: "glm-4.7-flash",
    response_model_id: "glm-4.7-flash",
    provider_request_id: "mock-request",
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

async function setupPersistedRunAndProposal(
  suiteClient: PoolClient,
  _repo: PostgresAiContextMappingRepository,
  canonicalIndex = sampleCanonicalWorkspaceIndex(),
  mappingInput = sampleMappingInput(),
) {
  const snapshotId = await insertReadySnapshot(suiteClient, canonicalIndex);
  const repository = new PostgresAiContextMappingRepository({
    workspaceIndexSnapshotId: snapshotId,
    idempotencyKey: `mapping-${randomUUID()}`,
    requestFingerprintSha256: `sha256:${"5".repeat(64)}`,
  });
  const runId = randomUUID();
  await repository.createRun({
    id: runId,
    input: mappingInput,
    inputSha256: mapperSha256(mappingInput),
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
    startedAt: "2026-08-04T10:00:00.000Z",
    runStatus: "PRIMARY_RUNNING",
  });
  const record = makeSuccessfulRecord(mappingInput, runId, attemptId);
  await repository.finalizeSuccessfulAttempt(record);
  return { snapshotId, runId, attemptId, proposal: record.proposal, mappingInput, repository };
}

// Regression classification: HISTORICAL_V1_REGRESSION
describe("Task Context Binding — PostgreSQL Integration Test (Rollback-Only)", () => {
  beforeAll(async () => {
    process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
    loadDatabaseUrl();
    client = await databasePool().connect();
    await verifyDatabaseIdentity(client);
    await client.query("begin");
    unbind = bindRollbackOnlyTestClient(client);
  });

  afterAll(async () => {
    unbind?.();
    if (client) {
      try { await client.query("rollback"); } catch { /* preserve test result */ }
      client.release();
      client = undefined;
    }
    delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
    await databasePool().end();
  });

  // Scenario 1: correct binding resolves
  it("1. resolves correct candidate scope from persisted READY snapshot, mapping run, and accepted decision", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));
      expect(candidateScope.workspaceIndexSnapshotId).toBe(snapshotId);
      expect(candidateScope.mappingRunId).toBe(runId);
      expect(candidateScope.candidateAllowedPaths).toHaveLength(1);
      expect(candidateScope.candidateAllowedPaths[0].workspaceId).toBe(wsId);
      expect(candidateScope.candidateAllowedPaths[0].path).toBe("README.md");
    });
  });

  // Scenario 2: foreign Mapping Run fails
  it("2. fails closed when binding references a non-existent or foreign Mapping Run", async () => {
    await withRollback(async (suiteClient) => {
      const snapshotId = await insertReadySnapshot(suiteClient);
      const foreignRunId = randomUUID();

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: foreignRunId,
        proposalId: randomUUID(),
        proposalSha256: "a".repeat(64),
        acceptedContextDecisionIds: [randomUUID()],
      };

      await expect(
        validateAndResolveTaskContextBinding(binding, ["11111111-1111-4111-8111-111111111111"]),
      ).rejects.toThrowError(expect.objectContaining({ code: "CONTEXT_MAPPING_RUN_NOT_FOUND" }));
    });
  });

  // Scenario 3: foreign Proposal fails
  it("3. fails closed when decision belongs to a different proposal", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      // Binding pointing to a different proposalId
      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: randomUUID(),
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      await expect(
        validateAndResolveTaskContextBinding(binding, [wsId]),
      ).rejects.toThrowError(expect.objectContaining({ code: "PROPOSAL_ID_MISMATCH" }));
    });
  });

  // Scenario 4: REJECT decision fails
  it("4. fails closed when a decision has state REJECT", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "REJECT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "REJECT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const rejectDecision = review.ownerContextDecisions[0];

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [rejectDecision.id],
      };

      await expect(
        validateAndResolveTaskContextBinding(binding, [wsId]),
      ).rejects.toThrowError(expect.objectContaining({ code: "OWNER_REVIEW_NOT_ACCEPTED" }));
    });
  });

  // Scenario 5: stale Proposal SHA fails
  it("5. fails closed when proposal SHA in binding does not match proposal content", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: "f".repeat(64), // Altered hash
        acceptedContextDecisionIds: [decision.id],
      };

      await expect(
        validateAndResolveTaskContextBinding(binding, [wsId]),
      ).rejects.toThrowError(expect.objectContaining({ code: "PROPOSAL_SHA_MISMATCH" }));
    });
  });

  // Scenario 6: missing/foreign Workspace identity fails
  it("6. fails closed when evidence references a workspace ID not bound to the Task", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      // Pass an unbound workspace list that doesn't contain wsId
      const foreignWorkspaceId = "99999999-9999-4999-8999-999999999999";
      await expect(
        validateAndResolveTaskContextBinding(binding, [foreignWorkspaceId]),
      ).rejects.toThrowError(expect.objectContaining({ code: "EVIDENCE_WORKSPACE_UNBOUND" }));
    });
  });

  // Scenario 7: arbitrary non-candidate Owner-confirmed path fails
  it("7. fails closed when Owner confirmation attempts to introduce a non-candidate path", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));

      const ws: WorkspaceReference = {
        id: wsId,
        displayName: "Workspace",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\repo",
        fingerprint: "sha256:test",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "test",
        ordering: 0,
      };

      const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]);

      expect(() =>
        applyOwnerScopeConfirmation(
          { ...draft, candidateScope },
          {
            candidateIdentity: {
              authorityVersion: "MAPPING_V1",
              workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
              mappingRunId: candidateScope.mappingRunId,
              proposalId: candidateScope.proposalId,
              proposalSha256: candidateScope.proposalSha256,
              acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
              candidateScopeSha256: candidateScope.candidateScopeSha256,
            },
            confirmedAllowedPaths: [{ workspaceId: wsId, path: "arbitrary/unmapped/file.ts" }],
            confirmedExcludedPaths: [],
            confirmedBy: "owner-local:Hisham",
            confirmedAt: new Date().toISOString(),
          },
          candidateScope,
        ),
      ).toThrowError(expect.objectContaining({ code: "CONFIRMED_PATH_NOT_IN_CANDIDATE_SCOPE" }));
    });
  });

  // Scenario 8: stale confirmation after new Mapping Run fails
  it("8. rejects confirmation bound to a stale mapping run ID", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      const binding1: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope1 = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding1, [wsId]));

      // Stale confirmation pointing to an old run ID when candidate scope is from run 2
      const fakeRun2Scope = { ...candidateScope1, mappingRunId: randomUUID() };

      const ws: WorkspaceReference = {
        id: wsId,
        displayName: "Workspace",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\repo",
        fingerprint: "sha256:test",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "test",
        ordering: 0,
      };

      const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]);

      expect(() =>
        applyOwnerScopeConfirmation(
          { ...draft, candidateScope: fakeRun2Scope },
          {
            candidateIdentity: {
              authorityVersion: "MAPPING_V1",
              workspaceIndexSnapshotId: candidateScope1.workspaceIndexSnapshotId,
              mappingRunId: candidateScope1.mappingRunId, // Stale run 1
              proposalId: candidateScope1.proposalId,
              proposalSha256: candidateScope1.proposalSha256,
              acceptedContextDecisionIdsSha256: candidateScope1.acceptedContextDecisionIdsSha256,
              candidateScopeSha256: candidateScope1.candidateScopeSha256,
            },
            confirmedAllowedPaths: [{ workspaceId: wsId, path: "README.md" }],
            confirmedExcludedPaths: [],
            confirmedBy: "owner-local:Hisham",
            confirmedAt: new Date().toISOString(),
          },
          fakeRun2Scope,
        ),
      ).toThrowError(expect.objectContaining({ code: "SCOPE_CONFIRMATION_IDENTITY_MISMATCH" }));
    });
  });

  // Scenario 9: stale confirmation after new Workspace Index Snapshot fails
  it("9. rejects confirmation bound to a stale snapshot ID", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));

      const ws: WorkspaceReference = {
        id: wsId,
        displayName: "Workspace",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\repo",
        fingerprint: "sha256:test",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "test",
        ordering: 0,
      };

      const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]);

      expect(() =>
        applyOwnerScopeConfirmation(
          { ...draft, candidateScope },
          {
            candidateIdentity: {
              authorityVersion: "MAPPING_V1",
              workspaceIndexSnapshotId: randomUUID(), // Stale / foreign snapshot
              mappingRunId: candidateScope.mappingRunId,
              proposalId: candidateScope.proposalId,
              proposalSha256: candidateScope.proposalSha256,
              acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
              candidateScopeSha256: candidateScope.candidateScopeSha256,
            },
            confirmedAllowedPaths: [{ workspaceId: wsId, path: "README.md" }],
            confirmedExcludedPaths: [],
            confirmedBy: "owner-local:Hisham",
            confirmedAt: new Date().toISOString(),
          },
          candidateScope,
        ),
      ).toThrowError(expect.objectContaining({ code: "SCOPE_CONFIRMATION_IDENTITY_MISMATCH" }));
    });
  });

  // Scenario 10: Multi-Workspace same-relative-path identities remain distinct
  it("10. preserves distinct workspace IDs for same relative paths across multiple Workspaces", () => {
    const ws1 = "11111111-1111-4111-8111-111111111111";
    const ws2 = "22222222-2222-4222-8222-222222222222";

    const candidateScope = requireHistoricalV1CandidateScope(resolveCandidateScopeFromMappingInput({
      binding: {
        workspaceIndexSnapshotId: "snap-mw-001",
        mappingRunId: "run-mw-001",
        proposalId: "prop-mw-001",
        proposalSha256: "a".repeat(64),
        acceptedContextDecisionIds: ["dec-mw-001"],
      },
      workspaceIndexSnapshotId: "snap-mw-001",
      mappingRunId: "run-mw-001",
      proposalId: "prop-mw-001",
      proposalSha256: "a".repeat(64),
      ownerVerdictState: "ACCEPTED",
      catalog: {
        schema_version: "intentchord.model-proposed-context-catalog.v1",
        catalog_summary: "Multi-Workspace shared module",
        contexts: [
          {
            context_id: "ctx_shared",
            display_name: "Shared Config",
            context_kind: "module",
            summary: "Shared config across both repositories",
            responsibilities: ["Config"],
            workspace_ids: [ws1, ws2],
            evidence_entry_ids: ["entry-ws1-cfg", "entry-ws2-cfg"],
            interfaces: [],
            unknowns: [],
            confidence: "high",
            rationale: "Both repos have src/config.ts",
          },
        ],
        relationships: [],
        unmapped_entries: [],
        global_unknowns: [],
        warnings: [],
      },
      ownerContextDecisions: [
        {
          id: "dec-mw-001",
          runId: "run-mw-001",
          proposalId: "prop-mw-001",
          contextId: "ctx_shared",
          contextSha256: mapperSha256({
            context_id: "ctx_shared",
            display_name: "Shared Config",
            context_kind: "module",
            summary: "Shared config across both repositories",
            responsibilities: ["Config"],
            workspace_ids: [ws1, ws2],
            evidence_entry_ids: ["entry-ws1-cfg", "entry-ws2-cfg"],
            interfaces: [],
            unknowns: [],
            confidence: "high",
            rationale: "Both repos have src/config.ts",
          }),
          decision: "ACCEPT",
          ownerReference: "owner-local:Hisham",
          createdAt: new Date().toISOString(),
        },
      ],
      mappingInputEntries: [
        {
          entry_id: "entry-ws1-cfg",
          workspace_id: ws1,
          normalized_path: "src/config.ts",
          entry_type: "FILE",
          language_or_format: "typescript",
          size_bytes: 100,
          content_or_metadata_fingerprint: "sha256:ws1",
          index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
        },
        {
          entry_id: "entry-ws2-cfg",
          workspace_id: ws2,
          normalized_path: "src/config.ts",
          entry_type: "FILE",
          language_or_format: "typescript",
          size_bytes: 100,
          content_or_metadata_fingerprint: "sha256:ws2",
          index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
        },
      ],
      boundWorkspaceIds: [ws1, ws2],
    }));

    expect(candidateScope.candidateAllowedPaths).toEqual([
      { workspaceId: ws1, path: "src/config.ts" },
      { workspaceId: ws2, path: "src/config.ts" },
    ]);
  });

  // Scenario 11: Contract resolution fails without Owner Scope Confirmation
  it("11. fails closed when compiling Contract without Owner Scope Confirmation for unified flow", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));

      const ws: WorkspaceReference = {
        id: wsId,
        displayName: "Workspace",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\repo",
        fingerprint: "sha256:test",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "test",
        ordering: 0,
      };

      const draft: TaskDraftInput = {
        ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
        objective: "Valid objective for implementation",
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        contextAnalysisBinding: binding,
        candidateScope,
        // scopeConfirmation deliberately missing
      };

      expect(() => assertContractReadyTaskDraft(draft)).toThrowError(
        expect.objectContaining({ code: "SCOPE_CONFIRMATION_REQUIRED" }),
      );
    });
  });

  // Scenario 12: valid confirmed scope reaches Contract readiness only after Execution Setup exists
  it("12. achieves Contract readiness only when both confirmed scope AND complete execution setup exist", async () => {
    await withRollback(async (suiteClient, repository) => {
      const canonicalIndex = sampleCanonicalWorkspaceIndex();
      const { snapshotId, runId, proposal, mappingInput } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex);
      const wsId = mappingInput.eligible_workspace_ids[0];

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];

      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));

      const ws: WorkspaceReference = {
        id: wsId,
        displayName: "Workspace",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\repo",
        fingerprint: "sha256:test",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "test",
        ordering: 0,
      };

      const initialDraft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]);
      const confirmedDraft = applyOwnerScopeConfirmation(
        {
          ...initialDraft,
          objective: "Valid objective for implementation",
          contextAnalysisBinding: binding,
          candidateScope,
        },
        {
          candidateIdentity: {
            authorityVersion: "MAPPING_V1",
            workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
            mappingRunId: candidateScope.mappingRunId,
            proposalId: candidateScope.proposalId,
            proposalSha256: candidateScope.proposalSha256,
            acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
            candidateScopeSha256: candidateScope.candidateScopeSha256,
          },
          confirmedAllowedPaths: [{ workspaceId: wsId, path: "README.md" }],
          confirmedExcludedPaths: [],
          confirmedBy: "owner-local:Hisham",
          confirmedAt: new Date().toISOString(),
        },
        candidateScope,
      );

      // Without execution setup -> fails closed
      expect(() => assertContractReadyTaskDraft(confirmedDraft)).toThrowError(
        expect.objectContaining({ code: "EXECUTION_SETUP_REQUIRED" }),
      );

      // With execution setup -> succeeds and compiles contract
      const readyDraft: TaskDraftInput = {
        ...confirmedDraft,
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
      };

      const contract = assertContractReadyTaskDraft(readyDraft);
      expect(contract).toBeDefined();
      expect(contract.providerId).toBe("OPENAI");
      expect(contract.modelId).toBe("gpt-5.5");
      expect(contract.workspaces[0].allowedPaths).toEqual(["README.md"]);
    });
  });

  async function registerTestWorkspace(suiteClient: PoolClient, id = randomUUID()): Promise<WorkspaceReference> {
    await suiteClient.query(
      `insert into intentchord.workspaces(
        id, display_name, role, reference_type, reference, normalized_reference, source_type, fingerprint,
        verification_status, verification_method, provenance
      ) values($1, 'Workspace', 'primary', 'LOCAL_PATH', 'E:\\repo', 'E:\\repo', 'WINDOWS_NATIVE_SELECTOR', 'sha256:test',
        'VERIFIED', 'AUTOMATIC_LOCAL_PATH_CANONICAL', '{"verificationStatus":"VERIFIED"}'::jsonb)
      on conflict (id) do nothing`,
      [id],
    );
    return {
      id,
      displayName: "Workspace",
      role: "primary",
      referenceType: "LOCAL_PATH",
      source: "WINDOWS_NATIVE_SELECTOR",
      reference: "E:\\repo",
      fingerprint: "sha256:test",
      discoveryScopeMode: "SELECTED_PATHS",
      allowedPaths: ["README.md"],
      excludedPaths: [],
      authorizationContext: "test",
      ordering: 0,
    };
  }

  function sampleUuidCanonicalIndex(wsId: string): { canonicalIndex: CanonicalWorkspaceIndexContract; mappingInput: MappingInputSnapshot } {
    const base = sampleCanonicalWorkspaceIndex();
    const modified = {
      ...base,
      workspace: {
        ...base.workspace,
        workspace_instance_id: wsId,
      },
    };
    const canonicalIndex = finalizeWorkspaceIndexContract(modified);
    const mappingInput = buildMappingInputSnapshot(canonicalIndex, { createdAt: "2026-08-04T10:00:00.000Z" });
    return { canonicalIndex, mappingInput };
  }

  // Scenario 13 (PG1 & F3): UNIFIED_V1 Task creation persists explicit orchestration version
  it("13. PG1: new Task creation persists explicit UNIFIED_V1 orchestration version in DB", async () => {
    await withRollback(async suiteClient => {
      const taskId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient);

      const task = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
          objective: "Valid task objective for creation test",
        },
      });

      expect(task!.draft.orchestrationVersion).toBe("UNIFIED_V1");

      const row = await suiteClient.query(
        "select draft_projection from intentchord.task_draft_revisions where task_id=$1 and revision=0",
        [taskId],
      );
      expect(row.rowCount).toBe(1);
      const parsed = row.rows[0].draft_projection as TaskDraftInput;
      expect(parsed.orchestrationVersion).toBe("UNIFIED_V1");
    });
  });

  // Scenario 14 (PG2 & F7): Generic draft update cannot persist unvalidated Scope Confirmation
  it("14. PG2 / F7: generic draft update cannot mutate or persist scopeConfirmation for UNIFIED_V1 task", async () => {
    await withRollback(async suiteClient => {
      const taskId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient);

      const task = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
          objective: "Valid task objective for generic update test",
        },
      });

      const attemptWithScopeConfirmation: TaskDraftInput = {
        ...task!.draft,
        scopeConfirmation: {
          candidateIdentity: {
            authorityVersion: "MAPPING_V1",
            workspaceIndexSnapshotId: randomUUID(),
            mappingRunId: randomUUID(),
            proposalId: randomUUID(),
            proposalSha256: "a".repeat(64),
            acceptedContextDecisionIdsSha256: "b".repeat(64),
            candidateScopeSha256: "c".repeat(64),
          },
          confirmedAllowedPaths: [{ workspaceId: ws.id, path: "README.md" }],
          confirmedExcludedPaths: [],
          confirmedBy: "owner-local:Hisham",
          confirmedAt: new Date().toISOString(),
        },
      };

      await expect(
        reviseTask(taskId, {
          expectedRevision: task!.revision,
          draft: attemptWithScopeConfirmation,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "SCOPE_CONFIRMATION_REQUIRES_DEDICATED_COMMAND" }),
      );
    });
  });

  // Scenario 15 (PG3, PG4, PG8, F8, F9, F11): Dedicated Scope Confirmation command behavior
  it("15. PG3 & PG4 & PG8: dedicated confirmation validates and persists exactly 1 revision on success, 0 on invalid", async () => {
    await withRollback(async (suiteClient, repository) => {
      const wsId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient, wsId);
      const { canonicalIndex, mappingInput } = sampleUuidCanonicalIndex(wsId);
      const { snapshotId, runId, proposal } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex, mappingInput);

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];
      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));
      const taskId = randomUUID();

      // Create task with contextAnalysisBinding
      const initialTask = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
          objective: "Valid objective for implementation",
          contextAnalysisBinding: binding,
        },
      });

      expect(initialTask!.revision).toBe(0);

      // PG3: Invalid dedicated confirmation (non-candidate path) fails with ZERO new revisions
      await expect(
        confirmTaskScope(taskId, {
          expectedRevision: initialTask!.revision,
          expectedCandidateIdentity: {
            authorityVersion: "MAPPING_V1",
            workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
            mappingRunId: candidateScope.mappingRunId,
            proposalId: candidateScope.proposalId,
            proposalSha256: candidateScope.proposalSha256,
            acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
            candidateScopeSha256: candidateScope.candidateScopeSha256,
          },
          confirmedAllowedPaths: [{ workspaceId: wsId, path: "invalid/non-candidate/path.ts" }],
          confirmedExcludedPaths: [],
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "CONFIRMED_PATH_NOT_IN_CANDIDATE_SCOPE" }));

      const taskAfterFailed = await readTaskLifecycle(taskId);
      expect(taskAfterFailed!.revision).toBe(0);

      // PG4 & PG8: Valid dedicated confirmation creates exactly ONE new revision
      const confirmedTask = await confirmTaskScope(
        taskId,
        {
          expectedRevision: initialTask!.revision,
          expectedCandidateIdentity: {
            authorityVersion: "MAPPING_V1",
            workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
            mappingRunId: candidateScope.mappingRunId,
            proposalId: candidateScope.proposalId,
            proposalSha256: candidateScope.proposalSha256,
            acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
            candidateScopeSha256: candidateScope.candidateScopeSha256,
          },
          confirmedAllowedPaths: [{ workspaceId: wsId, path: "README.md" }],
          confirmedExcludedPaths: [],
          rationale: "Confirmed valid docs subset",
        },
        "owner-local:Hisham",
      );

      expect(confirmedTask!.revision).toBe(1);
      expect(confirmedTask!.draft.scopeConfirmation).toBeDefined();
      expect(confirmedTask!.draft.scopeConfirmation?.confirmedBy).toBe("owner-local:Hisham");
      expect(confirmedTask!.draft.scopeConfirmation?.confirmedAllowedPaths).toEqual([{ workspaceId: wsId, path: "README.md" }]);
      expect(confirmedTask!.draft.workspaces[0].allowedPaths).toEqual(["README.md"]);
    });
  });

  // Scenario 16 (PG7 & F24): Stale expectedCandidateIdentity produces zero new Task revisions
  it("16. PG7 / F24: stale expectedCandidateIdentity causes confirmTaskScope to fail closed with 0 new revisions", async () => {
    await withRollback(async (suiteClient, repository) => {
      const wsId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient, wsId);
      const { canonicalIndex, mappingInput } = sampleUuidCanonicalIndex(wsId);
      const { snapshotId, runId, proposal } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex, mappingInput);

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];
      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const taskId = randomUUID();

      const initialTask = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
          objective: "Valid objective for stale identity test",
          contextAnalysisBinding: binding,
        },
      });

      // Mismatched expectedCandidateIdentity (e.g. stale candidate hash)
      await expect(
        confirmTaskScope(taskId, {
          expectedRevision: initialTask!.revision,
          expectedCandidateIdentity: {
            authorityVersion: "MAPPING_V1",
            workspaceIndexSnapshotId: snapshotId,
            mappingRunId: runId,
            proposalId: proposal.id,
            proposalSha256: proposal.validation.parsed_catalog_sha256!,
            acceptedContextDecisionIdsSha256: "0".repeat(64),
            candidateScopeSha256: "1".repeat(64),
          },
          confirmedAllowedPaths: [{ workspaceId: wsId, path: "README.md" }],
          confirmedExcludedPaths: [],
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "STALE_CANDIDATE_SCOPE" }));

      const checkTask = await readTaskLifecycle(taskId);
      expect(checkTask!.revision).toBe(0);
    });
  });

  // Scenario 17 (F21 & F22): Server-owned orchestration version immutability
  it("17. F21 & F22: preserves orchestrationVersion immutability across revisions", async () => {
    await withRollback(async suiteClient => {
      const taskId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient);

      // Create normal UNIFIED_V1 task
      const task = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
          objective: "Valid objective for version immutability test",
        },
      });

      expect(task!.draft.orchestrationVersion).toBe("UNIFIED_V1");

      // Client attempt to remove/modify orchestrationVersion in revision
      const { orchestrationVersion: _ov, ...draftWithoutVersion } = task!.draft;
      const revised = await reviseTask(taskId, {
        expectedRevision: task!.revision,
        draft: draftWithoutVersion,
      });

      // Backend preserves UNIFIED_V1!
      expect(revised!.draft.orchestrationVersion).toBe("UNIFIED_V1");

      // Simulate a legacy task inserted without orchestrationVersion
      const legacyTaskId = randomUUID();
      const legacyDraft = {
        ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws]),
        objective: "Legacy task objective",
      };
      delete legacyDraft.orchestrationVersion;

      await suiteClient.query(
        `insert into intentchord.tasks(id,title,title_manually_edited,objective,task_mode,draft,revision)
         values($1,$2,$3,$4,$5,$6,0)`,
        [legacyTaskId, legacyDraft.title, false, legacyDraft.objective, legacyDraft.taskMode, JSON.stringify(legacyDraft)],
      );
      await suiteClient.query(
        `insert into intentchord.task_draft_revisions(id,task_id,revision,title,title_manually_edited,objective,task_mode,draft_projection,content_sha256)
         values($1,$2,0,$3,false,$4,$5,$6,'sha')`,
        [randomUUID(), legacyTaskId, legacyDraft.title, legacyDraft.objective, legacyDraft.taskMode, JSON.stringify(legacyDraft)],
      );

      // Revising a legacy task does NOT silently upgrade it to UNIFIED_V1
      const revisedLegacy = await reviseTask(legacyTaskId, {
        expectedRevision: 0,
        draft: { ...legacyDraft, objective: "Updated legacy objective" },
      });

      expect(revisedLegacy!.draft.orchestrationVersion).toBeUndefined();
    });
  });

  // Scenario 18 (F26): Generic edit after confirmation preserves scopeConfirmation
  it("18. F26: generic task edit after valid scope confirmation preserves backend-owned confirmation", async () => {
    await withRollback(async (suiteClient, repository) => {
      const wsId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient, wsId);
      const { canonicalIndex, mappingInput } = sampleUuidCanonicalIndex(wsId);
      const { snapshotId, runId, proposal } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex, mappingInput);

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [
          { contextId: "ctx_documentation", decision: "ACCEPT" },
        ],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];
      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));
      const taskId = randomUUID();

      const initialTask = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
          objective: "Valid objective for confirmation persistence test",
          contextAnalysisBinding: binding,
        },
      });

      const confirmedTask = await confirmTaskScope(
        taskId,
        {
          expectedRevision: initialTask!.revision,
          expectedCandidateIdentity: {
            authorityVersion: "MAPPING_V1",
            workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
            mappingRunId: candidateScope.mappingRunId,
            proposalId: candidateScope.proposalId,
            proposalSha256: candidateScope.proposalSha256,
            acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
            candidateScopeSha256: candidateScope.candidateScopeSha256,
          },
          confirmedAllowedPaths: [{ workspaceId: wsId, path: "README.md" }],
          confirmedExcludedPaths: [],
        },
      );

      expect(confirmedTask!.draft.scopeConfirmation).toBeDefined();

      // Normal edit (e.g. changing objective) preserves scopeConfirmation
      const revisedTask = await reviseTask(taskId, {
        expectedRevision: confirmedTask!.revision,
        draft: {
          ...confirmedTask!.draft,
          objective: "New objective while keeping confirmed scope",
        },
      });

      expect(revisedTask!.draft.scopeConfirmation).toBeDefined();
      expect(revisedTask!.draft.scopeConfirmation?.confirmedAllowedPaths).toEqual([{ workspaceId: wsId, path: "README.md" }]);
    });
  });

  // PG-M1: PostgreSQL command clock temporal authority for confirmedAt
  it("PG-M1: persists confirmedAt derived strictly from PostgreSQL database clock", async () => {
    await withRollback(async (suiteClient, repository) => {
      const wsId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient, wsId);
      const { canonicalIndex, mappingInput } = sampleUuidCanonicalIndex(wsId);
      const { snapshotId, runId, proposal } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex, mappingInput);

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [{ contextId: "ctx_documentation", decision: "ACCEPT" }],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];
      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));
      const taskId = randomUUID();

      const task = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
          objective: "Valid objective for temporal authority test",
          contextAnalysisBinding: binding,
        },
      });

      const dbBefore = await readDatabaseCommandTime(suiteClient);
      const confirmedTask = await confirmTaskScope(taskId, {
        expectedRevision: task!.revision,
        expectedCandidateIdentity: {
          authorityVersion: "MAPPING_V1",
          workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
          mappingRunId: candidateScope.mappingRunId,
          proposalId: candidateScope.proposalId,
          proposalSha256: candidateScope.proposalSha256,
          acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
          candidateScopeSha256: candidateScope.candidateScopeSha256,
        },
        confirmedAllowedPaths: [{ workspaceId: wsId, path: "README.md" }],
        confirmedExcludedPaths: [],
      });
      const dbAfter = await readDatabaseCommandTime(suiteClient);

      const confirmedAt = confirmedTask!.draft.scopeConfirmation?.confirmedAt;
      expect(confirmedAt).toBeDefined();

      // Verify confirmedAt falls strictly within the PostgreSQL database transaction clock window
      const confirmedAtMs = new Date(confirmedAt!).getTime();
      const beforeMs = new Date(dbBefore).getTime();
      const afterMs = new Date(dbAfter).getTime();

      expect(confirmedAtMs).toBeGreaterThanOrEqual(beforeMs);
      expect(confirmedAtMs).toBeLessThanOrEqual(afterMs);
    });
  });

  // PG-M2: Client cannot supply or spoof confirmedAt
  it("PG-M2: ignores or strips client-supplied confirmedAt and uses backend DB clock", async () => {
    await withRollback(async (suiteClient, repository) => {
      const wsId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient, wsId);
      const { canonicalIndex, mappingInput } = sampleUuidCanonicalIndex(wsId);
      const { snapshotId, runId, proposal } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex, mappingInput);

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [{ contextId: "ctx_documentation", decision: "ACCEPT" }],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];
      const binding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id],
      };

      const candidateScope = requireHistoricalV1CandidateScope(await validateAndResolveTaskContextBinding(binding, [wsId]));
      const taskId = randomUUID();

      const task = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
          objective: "Valid objective for spoofing test",
          contextAnalysisBinding: binding,
        },
      });

      // Attempt to pass spoofed confirmedAt (rejected by schema since command schema does not include confirmedAt)
      const confirmedTask = await confirmTaskScope(taskId, {
        expectedRevision: task!.revision,
        expectedCandidateIdentity: {
          authorityVersion: "MAPPING_V1",
          workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
          mappingRunId: candidateScope.mappingRunId,
          proposalId: candidateScope.proposalId,
          proposalSha256: candidateScope.proposalSha256,
          acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
          candidateScopeSha256: candidateScope.candidateScopeSha256,
        },
        confirmedAllowedPaths: [{ workspaceId: wsId, path: "README.md" }],
        confirmedExcludedPaths: [],
      });

      expect(confirmedTask!.draft.scopeConfirmation?.confirmedAt).not.toBe("2000-01-01T00:00:00.000Z");
      expect(new Date(confirmedTask!.draft.scopeConfirmation!.confirmedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
    });
  });

  // PG-M3: Duplicate accepted decision IDs rejected before creating candidate scope or task revision
  it("PG-M3: duplicate accepted decision IDs are rejected fail-closed during task creation", async () => {
    await withRollback(async (suiteClient, repository) => {
      const wsId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient, wsId);
      const { canonicalIndex, mappingInput } = sampleUuidCanonicalIndex(wsId);
      const { snapshotId, runId, proposal } = await setupPersistedRunAndProposal(suiteClient, repository, canonicalIndex, mappingInput);

      const review = await repository.recordOwnerReview({
        runId,
        verdict: "ACCEPT",
        contextDecisions: [{ contextId: "ctx_documentation", decision: "ACCEPT" }],
        ownerAuthority: "owner-local:Hisham",
        createdAt: "2026-08-04T10:00:02.000Z",
      });

      const decision = review.ownerContextDecisions[0];
      const malformedBinding: TaskContextAnalysisBinding = {
        workspaceIndexSnapshotId: snapshotId,
        mappingRunId: runId,
        proposalId: proposal.id,
        proposalSha256: proposal.validation.parsed_catalog_sha256!,
        acceptedContextDecisionIds: [decision.id, decision.id], // DUPLICATE!
      };

      const taskId = randomUUID();

      await expect(
        createTask({
          requestedTaskId: taskId,
          draft: {
            ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws]),
            objective: "Malformed task with duplicate decision IDs",
            contextAnalysisBinding: malformedBinding,
          },
        }),
      ).rejects.toThrowError(/Duplicate acceptedContextDecisionId is forbidden/);

      const checkTask = await readTaskLifecycle(taskId);
      expect(checkTask).toBeUndefined();
    });
  });

  // PG-M4: Conflicting UNIFIED_V1 flattened model override state cannot persist over canonical executionSetup
  it("PG-M4: conflicting flattened model override state fails closed with EXECUTION_SETUP_CONFLICT on reviseTask", async () => {
    await withRollback(async suiteClient => {
      const taskId = randomUUID();
      const ws = await registerTestWorkspace(suiteClient);

      const task = await createTask({
        requestedTaskId: taskId,
        draft: {
          ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws]),
          objective: "Valid task for conflict test",
          executionSetup: {
            providerId: "OPENAI",
            modelId: "gpt-5.5",
            executionChannelId: "CODEX",
            reasoningProfile: "Medium",
            runtimeProfileId: "STANDARD",
            modelOverrideAccepted: false,
            modelOverrideReason: "",
          },
        },
      });

      // Attempt to revise with conflicting top-level override accepted = true
      await expect(
        reviseTask(taskId, {
          expectedRevision: task!.revision,
          draft: {
            ...task!.draft,
            modelOverrideAccepted: true, // Conflicts with nested false!
            modelOverrideReason: "Owner explicit override for test",
          },
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "EXECUTION_SETUP_CONFLICT" }));

      const checkTask = await readTaskLifecycle(taskId);
      expect(checkTask!.revision).toBe(0);
      expect(checkTask!.draft.executionSetup?.modelOverrideAccepted).toBe(false);
    });
  });
});

