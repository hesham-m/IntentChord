import { describe, expect, it, vi } from "vitest";
import { createBlankContractInput } from "@/core/tasks/task-input";
import type { TaskRecord } from "@/lib/workspace";
import { sampleCanonicalWorkspaceIndex } from "@/core/ai-context-mapper/test-fixtures";
import { canonicalIndexArtifactSemanticState, canonicalIndexArtifactSemanticStateSha256 } from "@/core/workspace-index/artifact-identity";

const IDS = {
  task: "550e8400-e29b-41d4-a716-446655440000",
  workspace: "11111111-1111-4111-8111-111111111111",
  snapshot: "33333333-3333-4333-8333-333333333333",
  mapping: "44444444-4444-4444-8444-444444444444",
  proposal: "55555555-5555-4555-8555-555555555555",
};

const fakes = vi.hoisted(() => ({
  readTaskLifecycle: vi.fn(),
  readWorkspaceAuthorityRegistration: vi.fn(),
  readPersistedWorkspaceIndexSnapshot: vi.fn(),
  readPersistedWorkspaceIndexMappingAuthority: vi.fn(),
  readMappingRun: vi.fn(),
  listAttempts: vi.fn(),
  databaseQuery: vi.fn(),
}));

vi.mock("@/server/lifecycle", () => ({ readTaskLifecycle: fakes.readTaskLifecycle }));
vi.mock("@/server/workspace-connector", () => ({ readWorkspaceAuthorityRegistration: fakes.readWorkspaceAuthorityRegistration }));
vi.mock("@/server/workspace-index-snapshot-service", () => ({
  readPersistedWorkspaceIndexSnapshot: fakes.readPersistedWorkspaceIndexSnapshot,
  readPersistedWorkspaceIndexMappingAuthority: fakes.readPersistedWorkspaceIndexMappingAuthority,
}));
vi.mock("@/server/ai-context-mapping-repository", () => ({
  PostgresAiContextMappingRepository: class {
    readRun = fakes.readMappingRun;
    listAttempts = fakes.listAttempts;
  },
}));
vi.mock("@/server/db", () => ({ databaseQuery: fakes.databaseQuery }));

import { getTaskExperienceProjection } from "@/server/task-experience-projection-service";

function task(): TaskRecord {
  const draft = createBlankContractInput("SOURCE_IMPLEMENTATION");
  // Exercise historical persisted data without changing new-draft typing.
  Object.assign(draft, { orchestrationVersion: "LEGACY_PRE_B2_V0" });
  draft.objective = "Production composition path";
  draft.workspaces = [{
    id: IDS.workspace,
    displayName: "Backend",
    role: "primary",
    referenceType: "LOCAL_PATH",
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: "E:\\backend",
    fingerprint: "sha256:workspace",
    discoveryScopeMode: "SELECTED_PATHS",
    allowedPaths: ["src/server"],
    excludedPaths: [],
    authorizationContext: "owner",
    ordering: 0,
  }];
  draft.workspaceRef = "E:\\backend";
  draft.workspaceFingerprint = "sha256:workspace";
  return {
    id: IDS.task,
    revision: 1,
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T08:00:00.000Z",
    draft,
    runs: [],
    promptLocaleExplicit: false,
    contractTab: "summary",
    reviewTab: "summary",
  };
}

const persistedSnapshot = {
  id: IDS.snapshot,
  sourceMode: "REGISTERED_WORKSPACE",
  status: "READY",
  workspaceRegistrationId: IDS.workspace,
  workspaceRegistrationRevision: 3,
  workspaceRegistrationFingerprint: "sha256:workspace",
  governedScope: {},
  snapshotIdempotencyKey: "snapshot-key",
  requestFingerprintSha256: "a".repeat(64),
  canonicalContractVersion: "intentchord.canonical-workspace-index.v1",
  canonicalSha256: "b".repeat(64),
  workspaceObservationId: "77777777-7777-4777-8777-777777777777",
  workspaceRevisionId: "88888888-8888-4888-8888-888888888888",
  canonicalIndexArtifactId: "99999999-9999-4999-8999-999999999999",
  indexConfigurationSha256: "c".repeat(64),
  observationResult: "SOURCE_UNCHANGED",
  indexAttemptStatus: "SUCCEEDED",
  ownerReference: "owner-local:Hisham",
  startedAt: "2026-08-16T07:00:00.000Z",
  completedAt: "2026-08-16T07:10:00.000Z",
  createdAt: "2026-08-16T07:00:00.000Z",
};

const mappingRun = {
  id: IDS.mapping,
  status: "AWAITING_OWNER_REVIEW",
  mappingInputSnapshotId: "mis-production",
  mappingInputSha256: "d".repeat(64),
  workspaceSnapshotId: "workspace-revision",
  workspaceIndexSha256: "e".repeat(64),
  workspaceIndexSnapshotId: IDS.snapshot,
  eligibleEntryCount: 0,
  excludedEntryCount: 0,
  estimatedTokens: 0,
  primaryProviderId: "zai",
  primaryChannelId: "zai_direct_chat_completions_v4",
  primaryModelId: "glm-4.7-flash",
  standbyProviderId: "sambanova",
  standbyChannelId: "sambanova_direct_chat_completions_v1",
  standbyModelId: "gpt-oss-120b",
  providerConfigurationSnapshot: {
    primary: { provider_id: "zai", channel_id: "zai_direct_chat_completions_v4", model_id: "glm-4.7-flash" },
    standby: { provider_id: "sambanova", channel_id: "sambanova_direct_chat_completions_v1", model_id: "gpt-oss-120b", enabled: false, governance_state: "BLOCKED_BY_GOVERNANCE" },
  },
  standbyEnabled: false,
  standbyGovernanceState: "BLOCKED_BY_GOVERNANCE",
  ownerVerdictState: "PENDING",
  createdAt: "2026-08-16T07:11:00.000Z",
  updatedAt: "2026-08-16T07:12:00.000Z",
  proposal: {
    id: IDS.proposal,
    runId: IDS.mapping,
    attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    proposalSha256: "f".repeat(64),
    schemaVersion: "intentchord.model-proposed-context-catalog.v1",
    validationEvidence: { status: "PASS", gates: [] },
    resultEnvelope: {},
    modelProposal: {
      schema_version: "intentchord.model-proposed-context-catalog.v1",
      catalog_summary: "Backend",
      contexts: [{
        context_id: "ctx-production",
        display_name: "Production Context",
        context_kind: "service",
        summary: "Persisted Mapping authority",
        responsibilities: ["Projection"],
        workspace_ids: [IDS.workspace],
        evidence_entry_ids: [],
        interfaces: [],
        unknowns: [],
        confidence: "high",
        rationale: "Persisted proposal",
      }],
      relationships: [],
      unmapped_entries: [],
      global_unknowns: [],
      warnings: [],
    },
    createdAt: "2026-08-16T07:12:00.000Z",
  },
  ownerContextDecisions: [],
};

describe("TaskExperienceProjection production authority composition wiring", () => {
  it("uses the default production composer to read current persisted Index + Mapping authority before projection", async () => {
    fakes.readTaskLifecycle.mockResolvedValue(task());
    fakes.readWorkspaceAuthorityRegistration.mockResolvedValue({
      id: IDS.workspace,
      revision: 3,
      displayName: "Backend",
      role: "primary",
      referenceType: "LOCAL_PATH",
      source: "WINDOWS_NATIVE_SELECTOR",
      reference: "E:\\backend",
      normalizedReference: "E:\\backend",
      verificationStatus: "VERIFIED",
      verificationMethod: "WINDOWS_NATIVE_SELECTOR",
      verifiedAt: "2026-08-16T07:00:00.000Z",
      verificationAuthority: "owner-local:Hisham",
      fingerprint: "sha256:workspace",
      provenance: {},
      authorizationContext: "owner",
      verifiedRootRealPath: "E:\\backend",
      verifiedRootObjectIdentity: { device_id: "dev", file_id: "file", proof_method: "WINDOWS_FILE_ID_128_V1" },
      verifiedRootVerifiedAt: "2026-08-16T07:00:00.000Z",
      rootAuthorityState: "VERIFIED_MATCH",
      rootAuthorityCheckedAt: "2026-08-16T07:00:00.000Z",
    });
    fakes.databaseQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("from intentchord.workspace_index_snapshots")) return { rowCount: 1, rows: [{ id: IDS.snapshot }] };
      if (sql.includes("from intentchord.context_mapping_runs")) return { rowCount: 1, rows: [{ id: IDS.mapping }] };
      if (sql.includes("from intentchord.context_assemblies")) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected production query: ${sql}`);
    });
    const rawIndex = sampleCanonicalWorkspaceIndex();
    const semState = canonicalIndexArtifactSemanticState(rawIndex);
    const semSha256 = canonicalIndexArtifactSemanticStateSha256(semState);
    fakes.readPersistedWorkspaceIndexSnapshot.mockResolvedValue(persistedSnapshot);
    fakes.readPersistedWorkspaceIndexMappingAuthority.mockResolvedValue({
      snapshot: persistedSnapshot,
      artifact: {
        id: persistedSnapshot.canonicalIndexArtifactId,
        semanticSha256: semSha256,
        semanticState: semState,
      },
    });
    fakes.readMappingRun.mockResolvedValue(mappingRun);
    fakes.listAttempts.mockResolvedValue([{ id: "attempt-production" }]);

    const projection = await getTaskExperienceProjection(IDS.task, "en");

    expect(projection?.analysisSummary).toMatchObject({ indexStatus: "READY", mappingStatus: "COMPLETED", discoveryCount: 1 });
    expect(projection?.discoveredWorkSummary.components[0]).toMatchObject({ componentId: "ctx-production", mappingRunId: IDS.mapping, proposalId: IDS.proposal, workspaceIds: [IDS.workspace] });
    expect(projection?.executionOptions).toEqual({
      authorityMeaning: "OWNER_SELECTS_PLATFORM_BACKEND_RESOLVES_CONFIGURATION",
      availablePlatforms: [
        { executionChannelId: "CODEX", displayName: "Codex" },
        { executionChannelId: "CLAUDE_CODE", displayName: "Claude Code" },
        { executionChannelId: "GEMINI_CLI", displayName: "Gemini CLI" },
      ],
    });
    const indexQuery = fakes.databaseQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes("from intentchord.workspace_index_snapshots"));
    expect(String(indexQuery?.[0])).toContain("source_mode='REGISTERED_WORKSPACE'");
    expect(String(indexQuery?.[0])).toContain("join intentchord.workspaces w on w.id=s.workspace_registration_id");
    expect(String(indexQuery?.[0])).toContain("s.workspace_registration_revision=w.revision");
    expect(String(indexQuery?.[0])).toContain("s.workspace_registration_fingerprint=w.fingerprint");
    expect(indexQuery?.[1]).toEqual([IDS.workspace]);
    const mappingQuery = fakes.databaseQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes("from intentchord.context_mapping_runs"));
    expect(String(mappingQuery?.[0])).toContain("workspace_index_snapshot_id=$1");
    expect(fakes.readTaskLifecycle).toHaveBeenCalledWith(IDS.task);
    expect(fakes.readPersistedWorkspaceIndexSnapshot).toHaveBeenCalledWith(IDS.snapshot);
    expect(fakes.readPersistedWorkspaceIndexMappingAuthority).toHaveBeenCalledWith(IDS.snapshot);
    expect(fakes.readMappingRun).toHaveBeenCalledWith(IDS.mapping);
  });
});
