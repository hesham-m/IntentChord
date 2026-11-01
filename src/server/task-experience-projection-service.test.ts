import { describe, expect, it, vi } from "vitest";
import { HttpCommandError } from "@/server/errors";
import { resolveExecutionContract } from "@/core/contracts/resolver";
import type { RequiredCheck } from "@/core/contracts/execution-contract";
import type { MappingInputEntry, MappingRunView, OwnerContextDecisionView } from "@/core/ai-context-mapper/types";
import type { TaskRecord, RunRecord } from "@/lib/workspace";
import { candidateScopeIdentityFromScope, createBlankContractInput, type WorkspaceReference } from "@/core/tasks/task-input";
import type { WorkspaceAuthorityRegistration } from "@/server/workspace-connector";
import type { WorkspaceIndexSnapshotRecord } from "@/server/workspace-index-snapshot-repository";
import type { ContextClosureView } from "@/server/context-closure-service";
import {
  composeTaskExperienceAuthoritySnapshot,
  type TaskExperienceAuthorityDependencies,
  type TaskExperienceRunAuthority,
} from "@/server/task-experience-authority-snapshot";
import {
  computeTaskExperienceProjection,
  getTaskExperienceProjection,
} from "@/server/task-experience-projection-service";

const WS1 = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "550e8400-e29b-41d4-a716-446655440000";
const SNAP1 = "33333333-3333-4333-8333-333333333333";
const SNAP2 = "66666666-6666-4666-8666-666666666666";
const MAP1 = "44444444-4444-4444-8444-444444444444";
const MAP2 = "aaaaaaaa-1111-4111-8111-111111111111";
const PROP1 = "55555555-5555-4555-8555-555555555555";
const PROP2 = "aaaaaaaa-2222-4222-8222-222222222222";
const ASSEMBLY_ID = "aaaaaaaa-3333-4333-8333-333333333333";
const ASSEMBLY_REVISION_ID = "aaaaaaaa-4444-4444-8444-444444444444";
const MAPPING_ITERATION_ID = "aaaaaaaa-5555-4555-8555-555555555555";
const CLOSURE_EVALUATION_ID = "aaaaaaaa-7777-4777-8777-777777777777";
const ACCEPTED_CATALOG_ID = "aaaaaaaa-6666-4666-8666-666666666666";

function workspace(id: string, displayName: string, path: string, ordering: number): WorkspaceReference {
  return {
    id,
    displayName,
    role: ordering === 0 ? "primary" : "secondary",
    referenceType: "LOCAL_PATH",
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: path,
    fingerprint: `sha256:${id}`,
    discoveryScopeMode: "SELECTED_PATHS",
    allowedPaths: [ordering === 0 ? "src/server" : "src/client"],
    excludedPaths: [ordering === 0 ? "src/server/private" : "src/client/private"],
    authorizationContext: "owner",
    ordering,
  };
}

const workspaces = [
  workspace(WS1, "Backend", "E:\\backend", 0),
  workspace(WS2, "Client", "E:\\client", 1),
];

function taskBase(): TaskRecord {
  const draft = createBlankContractInput("SOURCE_IMPLEMENTATION");
  draft.objective = "Close Task Experience projection authority composition";
  draft.workspaces = workspaces;
  draft.workspaceRef = workspaces[0].reference;
  draft.workspaceFingerprint = workspaces[0].fingerprint;
  draft.allowedPaths = [];
  draft.excludedPaths = [];
  draft.readFiles = true;
  draft.modifySource = true;
  draft.runStaticValidation = true;
  draft.runTests = true;
  draft.build = true;
  draft.deploy = true;
  delete (draft as any).executionSetup;
  delete (draft as any).providerId;
  delete (draft as any).modelId;
  delete (draft as any).executionChannelId;
  delete (draft as any).reasoningProfile;
  delete (draft as any).runtimeProfileId;
  delete draft.orchestrationVersion;
  return {
    id: TASK_ID,
    revision: 7,
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T08:30:00.000Z",
    draft,
    runs: [],
    promptLocaleExplicit: false,
    contractTab: "summary",
    reviewTab: "summary",
  };
}

function unifiedTaskBase(): TaskRecord {
  const task = taskBase();
  task.draft.orchestrationVersion = "UNIFIED_V1";
  return task;
}

function closedContextClosure(): ContextClosureView {
  return {
    contextAssemblyId: ASSEMBLY_ID,
    revisionId: ASSEMBLY_REVISION_ID,
    revision: 2,
    state: "CLOSED",
    closureState: "PASS",
    assemblySha256: `sha256:${"a".repeat(64)}`,
    sources: [],
    evidenceEntries: [mappingEntry(WS1), mappingEntry(WS2)],
    missingEvidenceRequests: [],
    resolutionRequirements: [],
    closureEvaluation: { id: CLOSURE_EVALUATION_ID, mappingIterationId: MAPPING_ITERATION_ID, decision: "PASS", reasonCode: "GOVERNED_CONTEXT_CLOSED", evaluationInputSha256: `sha256:${"b".repeat(64)}`, evidenceSha256: `sha256:${"c".repeat(64)}` },
    acceptedCatalog: {
      id: ACCEPTED_CATALOG_ID,
      catalogSha256: `sha256:${"d".repeat(64)}`,
      catalog: {
        schema_version: "intentchord.accepted-context-catalog.v1",
        context_assembly_id: ASSEMBLY_ID,
        context_assembly_revision_id: ASSEMBLY_REVISION_ID,
        mapping_iteration_id: MAPPING_ITERATION_ID,
        closure_evaluation_id: CLOSURE_EVALUATION_ID,
        catalog_summary: "Closed cross-workspace catalog",
        components: [
          { component_id: "ctx-backend", display_name: "Backend lifecycle", context_kind: "service", summary: "Backend lifecycle authority", responsibilities: ["Task lifecycle"], workspace_ids: [WS1], evidence_entry_ids: ["entry-backend"], interfaces: [], unknowns: [], confidence: "high", rationale: "Source evidence" },
          { component_id: "ctx-client", display_name: "Client runtime", context_kind: "application", summary: "Client runtime surface", responsibilities: ["Client runtime"], workspace_ids: [WS2], evidence_entry_ids: ["entry-client"], interfaces: [], unknowns: [], confidence: "high", rationale: "Source evidence" },
        ],
        relationships: [],
        source_bindings: [],
      },
    },
  };
}

function bindV2Selection(task: TaskRecord, confirmed = true): void {
  task.draft.contextAssemblyBinding = {
    contractVersion: "intentchord.context-assembly.v1",
    contextAssemblyId: ASSEMBLY_ID,
    contextAssemblyRevisionId: ASSEMBLY_REVISION_ID,
    contextAssemblyRevision: 2,
    mappingIterationId: MAPPING_ITERATION_ID,
    closureEvaluationId: CLOSURE_EVALUATION_ID,
    acceptedCatalogRevisionId: ACCEPTED_CATALOG_ID,
    acceptedCatalogSha256: `sha256:${"d".repeat(64)}`,
  };
  task.draft.candidateScope = {
    authorityVersion: "CONTEXT_ASSEMBLY_V2",
    contextAssemblyId: ASSEMBLY_ID,
    contextAssemblyRevisionId: ASSEMBLY_REVISION_ID,
    mappingIterationId: MAPPING_ITERATION_ID,
    closureEvaluationId: CLOSURE_EVALUATION_ID,
    acceptedCatalogRevisionId: ACCEPTED_CATALOG_ID,
    acceptedCatalogSha256: `sha256:${"d".repeat(64)}`,
    selectedComponentIdsSha256: `sha256:${"e".repeat(64)}`,
    candidateScopeSha256: `sha256:${"f".repeat(64)}`,
    entries: [{ workspaceId: WS1, normalizedPath: "src/server/lifecycle.ts", componentId: "ctx-backend", evidenceEntryId: "entry-backend" }],
    candidateAllowedPaths: [{ workspaceId: WS1, path: "src/server/lifecycle.ts" }],
  };
  if (confirmed) {
    task.draft.scopeConfirmation = {
      candidateIdentity: candidateScopeIdentityFromScope(task.draft.candidateScope),
      confirmedAt: "2026-08-16T07:30:00.000Z",
      confirmedBy: "owner-local:Hisham",
      confirmedAllowedPaths: [{ workspaceId: WS1, path: "src/server/lifecycle.ts" }],
      confirmedExcludedPaths: [],
    };
  }
}

function registration(ws: WorkspaceReference): WorkspaceAuthorityRegistration {
  return {
    id: ws.id,
    revision: 5,
    displayName: ws.displayName,
    role: ws.role,
    referenceType: ws.referenceType,
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: ws.reference,
    normalizedReference: ws.reference,
    verificationStatus: "VERIFIED",
    verificationMethod: "WINDOWS_NATIVE_SELECTOR",
    verifiedAt: "2026-08-16T07:00:00.000Z",
    verificationAuthority: "owner-local:Hisham",
    fingerprint: ws.fingerprint,
    provenance: {},
    authorizationContext: ws.authorizationContext,
    verifiedRootRealPath: ws.reference,
    verifiedRootObjectIdentity: { device_id: "dev", file_id: ws.id, proof_method: "WINDOWS_FILE_ID_128_V1" },
    verifiedRootVerifiedAt: "2026-08-16T07:00:00.000Z",
    rootAuthorityState: "VERIFIED_MATCH",
    rootAuthorityCheckedAt: "2026-08-16T07:00:00.000Z",
  };
}

function snapshotId(workspaceId: string) {
  return workspaceId === WS1 ? SNAP1 : SNAP2;
}

function indexSnapshot(workspaceId: string, status: "CREATING" | "READY" | "FAILED" = "READY"): WorkspaceIndexSnapshotRecord {
  return {
    id: snapshotId(workspaceId),
    sourceMode: "REGISTERED_WORKSPACE",
    status,
    workspaceRegistrationId: workspaceId,
    workspaceRegistrationRevision: 5,
    workspaceRegistrationFingerprint: `sha256:${workspaceId}`,
    governedScope: {},
    snapshotIdempotencyKey: `key-${workspaceId}`,
    requestFingerprintSha256: "a".repeat(64),
    canonicalContractVersion: "intentchord.canonical-workspace-index.v1",
    canonicalSha256: "b".repeat(64),
    workspaceObservationId: workspaceId === WS1 ? "77777777-7777-4777-8777-777777777777" : "bbbbbbbb-7777-4777-8777-777777777777",
    workspaceRevisionId: workspaceId === WS1 ? "88888888-8888-4888-8888-888888888888" : "bbbbbbbb-8888-4888-8888-888888888888",
    canonicalIndexArtifactId: workspaceId === WS1 ? "99999999-9999-4999-8999-999999999999" : "bbbbbbbb-9999-4999-8999-999999999999",
    indexConfigurationSha256: "c".repeat(64),
    observationResult: "SOURCE_UNCHANGED",
    indexAttemptStatus: status === "READY" ? "SUCCEEDED" : status === "FAILED" ? "FAILED" : "IN_PROGRESS",
    ownerReference: "owner-local:Hisham",
    startedAt: "2026-08-16T07:10:00.000Z",
    completedAt: status === "READY" ? "2026-08-16T07:20:00.000Z" : undefined,
    createdAt: "2026-08-16T07:10:00.000Z",
  } as WorkspaceIndexSnapshotRecord;
}

function mappingEntry(workspaceId: string): MappingInputEntry {
  const backend = workspaceId === WS1;
  return {
    entry_id: backend ? "entry-backend" : "entry-client",
    workspace_id: workspaceId,
    normalized_path: backend ? "src/server/lifecycle.ts" : "src/client/runtime.ts",
    entry_type: "FILE",
    language_or_format: "typescript",
    size_bytes: 100,
    content_or_metadata_fingerprint: `sha256:${workspaceId}`,
    index_supported_signals: {
      file_kind: "SOURCE",
      parse_status: "PARSED",
      coverage_state: "FULL",
      fact_signals: [],
      relation_signals: [],
    },
  };
}

function mappingRun(workspaceId: string, decisions: OwnerContextDecisionView[] = [], status: MappingRunView["status"] = "AWAITING_OWNER_REVIEW"): MappingRunView {
  const backend = workspaceId === WS1;
  const runId = backend ? MAP1 : MAP2;
  const proposalId = backend ? PROP1 : PROP2;
  const contextId = backend ? "ctx-backend" : "ctx-client";
  const input = mappingEntry(workspaceId);
  return {
    id: runId,
    status,
    mappingInputSnapshotId: backend ? "mis-backend" : "mis-client",
    mappingInputSha256: "d".repeat(64),
    workspaceSnapshotId: backend ? "workspace-revision-backend" : "workspace-revision-client",
    workspaceIndexSha256: "e".repeat(64),
    workspaceIndexSnapshotId: snapshotId(workspaceId),
    canonicalIndexArtifactId: indexSnapshot(workspaceId).canonicalIndexArtifactId,
    artifactSemanticSha256: "f".repeat(64),
    eligibleEntryCount: 1,
    excludedEntryCount: 0,
    estimatedTokens: 1000,
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
    finalAttemptId: backend ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ownerVerdictState: status === "OWNER_ACCEPTED" ? "ACCEPTED" : "PENDING",
    createdAt: "2026-08-16T07:21:00.000Z",
    updatedAt: "2026-08-16T07:25:00.000Z",
    proposal: {
      id: proposalId,
      runId,
      attemptId: backend ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      proposalSha256: backend ? "1".repeat(64) : "2".repeat(64),
      schemaVersion: "intentchord.model-proposed-context-catalog.v1",
      validationEvidence: { status: "PASS", gates: [] } as any,
      resultEnvelope: {} as any,
      modelProposal: {
        schema_version: "intentchord.model-proposed-context-catalog.v1",
        catalog_summary: backend ? "Backend context" : "Client context",
        contexts: [{
          context_id: contextId,
          display_name: backend ? "Backend lifecycle" : "Client runtime",
          context_kind: backend ? "service" : "application",
          summary: backend ? "Backend lifecycle authority" : "Client runtime surface",
          responsibilities: [backend ? "Task lifecycle" : "Client runtime"],
          workspace_ids: [workspaceId],
          evidence_entry_ids: [input.entry_id],
          interfaces: [],
          unknowns: [],
          confidence: "high",
          rationale: "Source evidence",
        }],
        relationships: [],
        unmapped_entries: [],
        global_unknowns: [],
        warnings: [],
      },
      createdAt: "2026-08-16T07:24:00.000Z",
    },
    ownerContextDecisions: decisions,
  };
}

function frozenSetup(overrides: Partial<TaskExperienceRunAuthority["frozenExecutionSetup"]> = {}): TaskExperienceRunAuthority["frozenExecutionSetup"] {
  return {
    providerId: "OPENAI",
    modelId: "gpt-5.6-terra",
    executionChannelId: "CODEX",
    reasoningProfile: "Medium",
    runtimeProfileId: "STANDARD",
    modelOverrideAccepted: true,
    modelOverrideReason: "Frozen Owner-approved Run override reason",
    ...overrides,
  };
}

function emptyRunAuthority(overrides: Partial<TaskExperienceRunAuthority> = {}): TaskExperienceRunAuthority {
  return {
    frozenExecutionSetup: frozenSetup(),
    evidenceReferences: [],
    validationEvidence: [],
    inheritedValidationEvidence: [],
    sourceEvidence: [],
    artifactEvidence: [],
    toolTraceEvents: [],
    ...overrides,
  };
}

function depsFor(task: TaskRecord, options: {
  currentRuns?: Partial<Record<string, MappingRunView | undefined>>;
  boundRun?: MappingRunView;
  indexes?: Record<string, WorkspaceIndexSnapshotRecord | undefined>;
  runAuthority?: TaskExperienceRunAuthority;
  configuredProviders?: Array<"OPENAI" | "ANTHROPIC" | "GOOGLE">;
  configuredModels?: any[];
  contextClosure?: ContextClosureView;
  contextForwardAuthority?: {
    frozenContextAssemblyRevisionId?: string;
    currentHeadRevisionId?: string;
    currentHeadRevision?: number;
    headStatus: "CURRENT" | "SUPERSEDED" | "NONE";
    sourceAuthorityStatus: "CURRENT" | "DRIFT" | "UNPROVEN" | "NOT_APPLICABLE";
  };
  contextForwardAuthorityByRevision?: Record<string, {
    frozenContextAssemblyRevisionId?: string;
    currentHeadRevisionId?: string;
    currentHeadRevision?: number;
    headStatus: "CURRENT" | "SUPERSEDED" | "NONE";
    sourceAuthorityStatus: "CURRENT" | "DRIFT" | "UNPROVEN" | "NOT_APPLICABLE";
  }>;
} = {}): TaskExperienceAuthorityDependencies {
  const currentRuns = options.currentRuns ?? { [SNAP1]: mappingRun(WS1), [SNAP2]: mappingRun(WS2) };
  const boundRun = options.boundRun ?? mappingRun(WS1);
  return {
    readTaskLifecycle: vi.fn(async () => task) as any,
    readWorkspaceAuthorityRegistration: vi.fn(async (id: string) => registration(workspaces.find(ws => ws.id === id)!)),
    readLatestWorkspaceIndexSnapshot: vi.fn(async (authorityRegistration: WorkspaceAuthorityRegistration) => {
      if (options.indexes && Object.prototype.hasOwnProperty.call(options.indexes, authorityRegistration.id)) {
        return options.indexes[authorityRegistration.id];
      }
      return indexSnapshot(authorityRegistration.id);
    }),
    readWorkspaceIndexAuthority: vi.fn(async (snapshotIdValue: string) => {
      const workspaceId = snapshotIdValue === SNAP1 ? WS1 : WS2;
      return { snapshot: indexSnapshot(workspaceId) } as any;
    }),
    readLatestMappingRunForWorkspaceIndexSnapshot: vi.fn(async (snapshotIdValue: string) => currentRuns[snapshotIdValue]),
    readMappingInputEntries: vi.fn((authority: any) => authority.snapshot.workspaceRegistrationId ? [mappingEntry(authority.snapshot.workspaceRegistrationId)] : []),
    readMappingRun: vi.fn(async () => boundRun),
    listMappingAttempts: vi.fn(async () => [{ id: "attempt-1" } as any]),
    readRunAuthority: vi.fn(async () => options.runAuthority ?? emptyRunAuthority()),
    readContractRevision: vi.fn(async () => 3),
    readContextClosure: vi.fn(async () => options.contextClosure),
    readContextForwardAuthority: vi.fn(async (_taskId: string, frozenContextAssemblyRevisionId?: string) => (
      frozenContextAssemblyRevisionId ? options.contextForwardAuthorityByRevision?.[frozenContextAssemblyRevisionId] : undefined
    ) ?? options.contextForwardAuthority ?? ({
      ...(frozenContextAssemblyRevisionId ? { frozenContextAssemblyRevisionId, currentHeadRevisionId: frozenContextAssemblyRevisionId, currentHeadRevision: 1 } : {}),
      headStatus: frozenContextAssemblyRevisionId ? "CURRENT" as const : "NONE" as const,
      sourceAuthorityStatus: frozenContextAssemblyRevisionId ? "CURRENT" as const : "NOT_APPLICABLE" as const,
    })),
    readInstallationConfiguration: vi.fn(() => ({
      configuredProviders: options.configuredProviders ?? [],
      configuredModels: options.configuredModels ?? [],
      providerConfigurationSource: options.configuredProviders?.length ? "TEST_OVERRIDE" as const : "NONE" as const,
      modelConfigurationSource: options.configuredModels?.length ? "TEST_OVERRIDE" as const : "NONE" as const,
    })),
  };
}

function bindBackendAnalysis(task: TaskRecord, decisions: OwnerContextDecisionView[]) {
  task.draft.contextAnalysisBinding = {
    workspaceIndexSnapshotId: SNAP1,
    mappingRunId: MAP1,
    proposalId: PROP1,
    proposalSha256: "1".repeat(64),
    acceptedContextDecisionIds: decisions.filter(decision => decision.decision === "ACCEPT").map(decision => decision.id),
  };
}

function acceptedBackendDecision(): OwnerContextDecisionView {
  return {
    id: "decision-record-1",
    runId: MAP1,
    proposalId: PROP1,
    contextId: "ctx-backend",
    contextSha256: "9".repeat(64),
    decision: "ACCEPT",
    ownerReference: "owner-local:Hisham",
    createdAt: "2026-08-16T07:26:00.000Z",
  };
}

function deriveCandidate(task: TaskRecord) {
  task.draft.candidateScope = {
    workspaceIndexSnapshotId: SNAP1,
    mappingRunId: MAP1,
    proposalId: PROP1,
    proposalSha256: "1".repeat(64),
    acceptedContextDecisionIdsSha256: "3".repeat(64),
    candidateScopeSha256: "4".repeat(64),
    entries: [],
    candidateAllowedPaths: [{ workspaceId: WS1, path: "src/server" }],
  };
}

function confirmScope(task: TaskRecord) {
  deriveCandidate(task);
  task.draft.scopeConfirmation = {
    candidateIdentity: {
      workspaceIndexSnapshotId: SNAP1,
      mappingRunId: MAP1,
      proposalId: PROP1,
      proposalSha256: "1".repeat(64),
      acceptedContextDecisionIdsSha256: "3".repeat(64),
      candidateScopeSha256: "4".repeat(64),
    },
    confirmedAt: "2026-08-16T07:30:00.000Z",
    confirmedBy: "owner-local:Hisham",
    confirmedAllowedPaths: [{ workspaceId: WS1, path: "src/server" }],
    confirmedExcludedPaths: [{ workspaceId: WS1, path: "src/server/private" }],
  };
}

function contractFor(task: TaskRecord) {
  return resolveExecutionContract({
    contractId: "contract-projection-authority",
    title: task.draft.title,
    objective: task.draft.objective,
    taskMode: task.draft.taskMode,
    workspaces: task.draft.workspaces,
    providerId: "OPENAI",
    modelId: "gpt-5.6-sol",
    executionChannelId: "CODEX",
    reasoningProfile: "High",
    runtimeProfileId: "STANDARD",
    ownerOverrideAccepted: false,
    allowedPaths: [],
    excludedPaths: [],
    evidenceFiles: [],
    identity: "",
    authorization: {
      readFiles: true,
      modifySource: true,
      runStaticValidation: true,
      runTests: true,
      build: true,
      deploy: true,
      restartServices: false,
      writeDatabase: false,
      changeEnvironment: false,
      useNetwork: false,
    },
  });
}

function runRecord(id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", withArtifact = true): RunRecord {
  return {
    id,
    round: 1,
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T08:05:00.000Z",
    contractId: "contract-projection-authority",
    source: "IMPORTED_REPORT",
    executionType: "INITIAL",
    status: "AWAITING_REPORT",
    bindingMarker: "IC-RUN-TEST",
    executor: "codex",
    agentProfileId: "CODEX",
    providerId: "OPENAI",
    modelId: "gpt-5.6-terra",
    reasoningProfile: "Medium",
    runtimeProfileId: "STANDARD",
    executionCompleted: false,
    decision: "NONE",
    correctionNotes: "",
    correctionStarted: false,
    ...(withArtifact ? { compiledArtifact: { id: "artifact-1", text: "FROZEN EXECUTED INSTRUCTIONS", sha256: "5".repeat(64), compilerVersion: "1", compiledAt: "2026-08-16T08:00:00.000Z", deliveryState: "DELIVERED" as const } } : {}),
  };
}

describe("TaskExperienceAuthoritySnapshot -> TaskExperienceProjectionV1", () => {
  it("reads Workspace Index state from REGISTERED_WORKSPACE authority and ignores DiscoveryRun", async () => {
    const task = taskBase();
    task.discoveryRun = { status: "RUNNING", findings: [] } as any;
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.analysisSummary.indexStatus).toBe("READY");
    expect(projection.workspaceSummary.workspaces.every(item => item.sourceFreshness === "FRESH")).toBe(true);
  });

  it("does not treat an Index bound to an older Workspace Registration authority as current", async () => {
    const task = taskBase();
    task.draft.workspaces = [workspaces[0]];
    task.draft.workspaceRef = workspaces[0].reference;
    task.draft.workspaceFingerprint = workspaces[0].fingerprint;
    const staleIndex = { ...indexSnapshot(WS1), workspaceRegistrationRevision: 4 };
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      indexes: { [WS1]: staleIndex },
      currentRuns: { [SNAP1]: mappingRun(WS1) },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(authority!.workspaces[0].latestIndex).toBeUndefined();
    expect(authority!.currentAnalyses).toEqual([]);
    expect(projection.workspaceSummary.workspaces[0].sourceFreshness).toBe("UNKNOWN");
    expect(projection.analysisSummary).toMatchObject({ indexStatus: "IDLE", mappingStatus: "IDLE", analysisReady: false });
  });

  it("continues to project a correctly bound current Workspace Index normally", async () => {
    const task = taskBase();
    task.draft.workspaces = [workspaces[0]];
    task.draft.workspaceRef = workspaces[0].reference;
    task.draft.workspaceFingerprint = workspaces[0].fingerprint;
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      indexes: { [WS1]: indexSnapshot(WS1) },
      currentRuns: { [SNAP1]: mappingRun(WS1) },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(authority!.workspaces[0].latestIndex?.id).toBe(SNAP1);
    expect(authority!.currentAnalyses).toHaveLength(1);
    expect(projection.workspaceSummary.workspaces[0].sourceFreshness).toBe("FRESH");
    expect(projection.analysisSummary).toMatchObject({ indexStatus: "READY", mappingStatus: "COMPLETED", analysisReady: true });
  });

  it("represents unproven workspace freshness/root authority without synthetic PASS", async () => {
    const task = taskBase();
    const dependencies = depsFor(task, { indexes: { [WS1]: undefined, [WS2]: undefined }, currentRuns: {} });
    dependencies.readWorkspaceAuthorityRegistration = vi.fn(async (id: string) => ({
      ...registration(workspaces.find(ws => ws.id === id)!),
      verificationStatus: "STALE" as const,
      rootAuthorityState: "STALE_MISMATCH" as const,
    }));
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, dependencies);
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.workspaceSummary.workspaces.every(item => item.sourceFreshness === "UNKNOWN")).toBe(true);
    expect(projection.workspaceSummary.workspaces.every(item => item.rootAuthorityValid === false)).toBe(true);
    expect(projection.workspaceSummary.workspaces.every(item => item.verificationStatus === "STALE")).toBe(true);
  });

  it("projects pre-selection Mapping authority without requiring contextAnalysisBinding", async () => {
    const task = taskBase();
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(task.draft.contextAnalysisBinding).toBeUndefined();
    expect(projection.analysisSummary.mappingStatus).toBe("COMPLETED");
    expect(projection.analysisSummary.discoveryCount).toBe(2);
    expect(projection.phaseStatus).toBe("COMPONENTS_READY_FOR_WORK_SELECTION");
  });

  it("hides Draft execution setup before Owner Scope Confirmation while preserving the Draft internally", async () => {
    const task = unifiedTaskBase();
    task.draft.executionSetup = {
      providerId: "OPENAI",
      modelId: "gpt-5.6-sol",
      executionChannelId: "CODEX",
      reasoningProfile: "High",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: true,
      modelOverrideReason: "Internal pre-scope draft state only",
    };
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      configuredProviders: ["OPENAI"],
      configuredModels: ["gpt-5.6-sol"],
    }));
    expect(authority!.execution).toMatchObject({ source: "DRAFT", setup: { providerId: "OPENAI", modelId: "gpt-5.6-sol" } });
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.scopeConfirmationSummary.isConfirmed).toBe(false);
    expect(projection.executionSetupSummary).toMatchObject({
      isConfigured: false,
      authoritySource: "NONE",
      providerId: null,
      modelId: null,
      executionChannelId: null,
      reasoningProfile: null,
      runtimeProfileId: null,
      modelOverrideAccepted: false,
    });
    expect(projection.executionSetupSummary.modelOverrideReason).toBeUndefined();
  });

  it("projects late execution-platform selection only after governed Scope Confirmation", async () => {
    const task = unifiedTaskBase();
    bindV2Selection(task);
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      contextClosure: closedContextClosure(),
      configuredProviders: [],
      configuredModels: [],
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("SCOPE_CONFIRMED_AWAITING_PLATFORM");
    expect(projection.executionOptions).toEqual({
      authorityMeaning: "OWNER_SELECTS_PLATFORM_BACKEND_RESOLVES_CONFIGURATION",
      availablePlatforms: [
        { executionChannelId: "CODEX", displayName: "Codex" },
        { executionChannelId: "CLAUDE_CODE", displayName: "Claude Code" },
        { executionChannelId: "GEMINI_CLI", displayName: "Gemini CLI" },
      ],
    });
    expect(projection.primaryAction).toMatchObject({ actionKey: "SELECT_EXECUTION_PLATFORM", availability: "ENABLED" });
  });

  it("projects exact Model/Reasoning only after backend execution resolution", async () => {
    const task = unifiedTaskBase();
    bindV2Selection(task);
    task.draft.executionSetup = {
      providerId: "OPENAI",
      modelId: "gpt-5.6-sol",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: false,
    };
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      contextClosure: closedContextClosure(),
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("PLATFORM_SELECTED_CONFIGURATION_RESOLVED_AWAITING_CONTRACT");
    expect(projection.executionSetupSummary).toMatchObject({
      isConfigured: true,
      authoritySource: "DRAFT",
      providerId: "OPENAI",
      modelId: "gpt-5.6-sol",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: false,
    });
    expect(projection.primaryAction).toMatchObject({ actionKey: "APPROVE_CONTRACT", availability: "ENABLED" });
  });

  it("does not publish Owner-selectable Components before deterministic Context Closure PASS", async () => {
    const task = unifiedTaskBase();
    const blocked = { ...closedContextClosure(), state: "EVIDENCE_REQUIRED" as const, closureState: "BLOCKED" as const, acceptedCatalog: undefined, missingEvidenceRequests: [{ id: "gap-record-1", modelGapId: "gap_client", classification: "BLOCKING_INTERNAL_SOURCE_GAP" as const, materiality: "BLOCKING" as const, description: "Client counterpart is missing", requiredEvidenceKind: "client implementation" }] };
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { contextClosure: blocked }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.analysisSummary.contextClosureState).toBe("BLOCKED");
    expect(projection.discoveredWorkSummary.components).toEqual([]);
    expect(projection.phaseStatus).toBe("CONTEXT_EVIDENCE_REQUIRED");
    expect(projection.primaryAction).toMatchObject({ actionKey: "RESOLVE_CONTEXT" });
  });

  it("projects a terminal failed Mapping iteration as explicit retryable Context action without exposing Work Selection", async () => {
    const task = unifiedTaskBase();
    const retryable = {
      ...closedContextClosure(),
      state: "MAPPING_RETRYABLE" as const,
      closureState: "OPEN" as const,
      acceptedCatalog: undefined,
      closureEvaluation: undefined,
      missingEvidenceRequests: [],
      latestMappingRun: {
        id: "00000000-0000-4000-8000-000000000901",
        status: "FAILED" as const,
        contextAssemblyRevisionId: ASSEMBLY_REVISION_ID,
        contextAssemblySha256: `sha256:${"a".repeat(64)}`,
        mappingInputSha256: `sha256:${"b".repeat(64)}`,
        providerConfigurationSnapshot: {} as never,
        createdAt: "2026-08-18T12:00:00.000Z",
        updatedAt: "2026-08-18T12:00:01.000Z",
      },
    };
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { contextClosure: retryable }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("CONTEXT_MAPPING_RETRYABLE");
    expect(projection.analysisSummary.mappingStatus).toBe("FAILED");
    expect(projection.discoveredWorkSummary.components).toEqual([]);
    expect(projection.primaryAction).toMatchObject({ actionKey: "RETRY_CONTEXT_MAPPING", availability: "ENABLED" });
  });

  it("publishes the complete V2 Catalog only after Backend Context Closure PASS", async () => {
    const task = unifiedTaskBase();
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { contextClosure: closedContextClosure() }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.analysisSummary).toMatchObject({ contextClosureState: "PASS", analysisReady: true, discoveryCount: 2 });
    expect(projection.discoveredWorkSummary.components.map(item => item.componentId).sort()).toEqual(["ctx-backend", "ctx-client"]);
    expect(projection.primaryAction).toMatchObject({ actionKey: "COMMIT_WORK_SELECTION", availability: "ENABLED" });
  });

  it("projects pre-confirmation Work intent as stale when the Context Head advances and removes Confirm Scope authority", async () => {
    const task = unifiedTaskBase();
    bindV2Selection(task, false);
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      contextClosure: closedContextClosure(),
      contextForwardAuthority: {
        frozenContextAssemblyRevisionId: ASSEMBLY_REVISION_ID,
        currentHeadRevisionId: "00000000-0000-4000-8000-000000000777",
        currentHeadRevision: 3,
        headStatus: "SUPERSEDED",
        sourceAuthorityStatus: "CURRENT",
      },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED");
    expect(projection.contextAuthoritySummary.status).toBe("STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED");
    expect(projection.primaryAction.actionKey).toBe("START_CONTEXT_ANALYSIS");
    expect(projection.primaryAction.actionKey).not.toBe("CONFIRM_SCOPE");
  });

  it("projects confirmed Scope as frozen historical authority when current source authority drifts", async () => {
    const task = unifiedTaskBase();
    bindV2Selection(task, true);
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      contextClosure: closedContextClosure(),
      contextForwardAuthority: {
        frozenContextAssemblyRevisionId: ASSEMBLY_REVISION_ID,
        currentHeadRevisionId: ASSEMBLY_REVISION_ID,
        currentHeadRevision: 2,
        headStatus: "CURRENT",
        sourceAuthorityStatus: "DRIFT",
      },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("SOURCE_DRIFT_REBASE_REQUIRED");
    expect(projection.contextAuthoritySummary.status).toBe("SOURCE_DRIFT_REBASE_REQUIRED");
    expect(projection.scopeConfirmationSummary.isConfirmed).toBe(true);
    expect(projection.primaryAction.actionKey).toBe("START_CONTEXT_ANALYSIS");
    expect(projection.primaryAction.actionKey).not.toBe("SELECT_EXECUTION_PLATFORM");
  });

  it("keeps an already-started Run projected on frozen authority after Context Head advance", async () => {
    const task = unifiedTaskBase();
    bindV2Selection(task, true);
    const setup = frozenSetup();
    task.activeRunId = "run-active";
    task.runs = [{ id: "run-active", taskId: TASK_ID, contractRevisionId: "contract-1", status: "AWAITING_REPORT", round: 1, source: "MANUAL", executionType: "INITIAL", selectedConfiguration: setup } as any];
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      contextClosure: closedContextClosure(),
      runAuthority: emptyRunAuthority({ frozenExecutionSetup: setup }),
      contextForwardAuthority: {
        frozenContextAssemblyRevisionId: ASSEMBLY_REVISION_ID,
        currentHeadRevisionId: "00000000-0000-4000-8000-000000000777",
        currentHeadRevision: 3,
        headStatus: "SUPERSEDED",
        sourceAuthorityStatus: "DRIFT",
      },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("RUN_ACTIVE_EXECUTING");
    expect(projection.contextAuthoritySummary.status).toBe("ACTIVE_RUN_ON_FROZEN_AUTHORITY");
    expect(projection.executionSetupSummary.authoritySource).toBe("RUN");
  });

  it("preserves real multi-workspace identity by composing one Mapping Run per Workspace Index", async () => {
    const task = taskBase();
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task));
    const projection = computeTaskExperienceProjection(authority!, "en");
    const backend = projection.discoveredWorkSummary.components.find(item => item.mappingRunId === MAP1)!;
    const client = projection.discoveredWorkSummary.components.find(item => item.mappingRunId === MAP2)!;
    expect(backend).toMatchObject({ componentId: "ctx-backend", proposalId: PROP1, workspaceIds: [WS1] });
    expect(backend.relevantPaths).toEqual([{ workspaceId: WS1, workspaceDisplayName: "Backend", path: "src/server/lifecycle.ts" }]);
    expect(client).toMatchObject({ componentId: "ctx-client", proposalId: PROP2, workspaceIds: [WS2] });
    expect(client.relevantPaths).toEqual([{ workspaceId: WS2, workspaceDisplayName: "Client", path: "src/client/runtime.ts" }]);
  });

  it("reports partial multi-workspace Mapping truth instead of inventing in-progress work", async () => {
    const task = taskBase();
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      currentRuns: { [SNAP1]: mappingRun(WS1), [SNAP2]: undefined },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.analysisSummary).toMatchObject({ mappingStatus: "PARTIAL", analysisReady: false, discoveryCount: 1 });
    expect(projection.phaseStatus).toBe("ANALYSIS_READY_TO_START");
  });

  it("keeps Owner-rejected Mapping authority distinct from completed selectable discovery", async () => {
    const task = taskBase();
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      currentRuns: { [SNAP1]: mappingRun(WS1, [], "OWNER_REJECTED"), [SNAP2]: mappingRun(WS2) },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.analysisSummary).toMatchObject({ mappingStatus: "REJECTED", analysisReady: false });
    expect(projection.phaseStatus).toBe("ANALYSIS_READY_TO_START");
  });

  it("fails closed when Candidate or Confirmation authority levels are detached from their binding identities", async () => {
    const candidateWithoutBinding = taskBase();
    deriveCandidate(candidateWithoutBinding);
    await expect(composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(candidateWithoutBinding))).rejects.toMatchObject({
      code: "TASK_EXPERIENCE_CANDIDATE_WITHOUT_BINDING",
    });

    const mismatched = taskBase();
    const decision = acceptedBackendDecision();
    bindBackendAnalysis(mismatched, [decision]);
    deriveCandidate(mismatched);
    if (mismatched.draft.candidateScope?.authorityVersion === "CONTEXT_ASSEMBLY_V2" || !mismatched.draft.candidateScope) throw new Error("Expected legacy candidate scope fixture.");
    mismatched.draft.candidateScope.mappingRunId = MAP2;
    await expect(composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(mismatched, { boundRun: mappingRun(WS1, [decision], "OWNER_ACCEPTED") }))).rejects.toMatchObject({
      code: "TASK_EXPERIENCE_CANDIDATE_BINDING_MISMATCH",
    });
  });

  it("resolves accepted decision IDs through authoritative records and fails closed on unknown IDs", async () => {
    const task = taskBase();
    const decision = acceptedBackendDecision();
    bindBackendAnalysis(task, [decision]);
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { boundRun: mappingRun(WS1, [decision], "OWNER_ACCEPTED") }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.ownerSelectionSummary.selectedContextIds).toEqual(["ctx-backend"]);

    const corruptTask = taskBase();
    bindBackendAnalysis(corruptTask, [{ ...decision, id: "missing-id" }]);
    corruptTask.draft.contextAnalysisBinding!.acceptedContextDecisionIds = ["missing-id"];
    await expect(composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(corruptTask, { boundRun: mappingRun(WS1, [], "OWNER_ACCEPTED") })))
      .rejects.toMatchObject({ code: "TASK_EXPERIENCE_ACCEPTED_DECISION_NOT_FOUND" });
  });

  it("keeps requested authorization distinct from effective policy authority", async () => {
    const task = taskBase();
    task.contract = contractFor(task);
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task));
    const projection = computeTaskExperienceProjection(authority!, "en");
    const deploy = projection.effectiveAuthoritySummary.capabilities.find(item => item.capability === "deploy")!;
    expect(deploy.isRequested).toBe(true);
    expect(deploy.isEffective).toBe(false);
  });

  it("transitions execution authority Draft -> Contract -> frozen Run without borrowing current Contract override state", async () => {
    const draftTask = taskBase();
    const draftDecision = acceptedBackendDecision();
    bindBackendAnalysis(draftTask, [draftDecision]);
    confirmScope(draftTask);
    draftTask.draft.executionSetup = { providerId: "ANTHROPIC", modelId: "claude-sonnet-5", executionChannelId: "CLAUDE_CODE", reasoningProfile: "High", runtimeProfileId: "STANDARD", modelOverrideAccepted: false };
    let authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(draftTask, { boundRun: mappingRun(WS1, [draftDecision], "OWNER_ACCEPTED") }));
    expect(authority!.execution).toMatchObject({ source: "DRAFT", setup: { providerId: "ANTHROPIC" } });

    const contractTask = taskBase();
    contractTask.contract = contractFor(contractTask);
    authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(contractTask));
    expect(authority!.execution).toMatchObject({ source: "CONTRACT", setup: { modelId: contractTask.contract.selectedConfiguration.modelId, modelOverrideAccepted: false } });

    const runTask = taskBase();
    runTask.contract = contractFor(runTask);
    const run = runRecord();
    runTask.runs = [run];
    runTask.activeRunId = run.id;
    authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(runTask, { runAuthority: emptyRunAuthority({ frozenExecutionSetup: frozenSetup() }) }));
    expect(authority!.execution).toMatchObject({ source: "RUN", setup: { modelId: "gpt-5.6-terra", modelOverrideAccepted: true, modelOverrideReason: "Frozen Owner-approved Run override reason" } });
  });

  it("never dynamically recompiles historical Run truth when its frozen compiled artifact is absent", async () => {
    const task = taskBase();
    task.contract = contractFor(task);
    const run = runRecord(undefined, false);
    task.runs = [run];
    task.activeRunId = run.id;
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.governedExecutionInstructionsSummary).toMatchObject({ authoritySource: "NONE", isGenerated: false, instructionsPreview: "" });
  });

  it("does not promote an old DECIDED Run when activeRunId is absent after Task revision", async () => {
    const task = taskBase();
    task.contract = contractFor(task);
    const historical = { ...runRecord(), status: "DECIDED" as const, decision: "ACCEPTED" as const };
    task.runs = [historical];
    task.activeRunId = undefined;
    const dependencies = depsFor(task);
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, dependencies);
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(authority!.activeRun).toBeUndefined();
    expect(dependencies.readRunAuthority).not.toHaveBeenCalled();
    expect(projection.runSummary.activeRunId).toBeUndefined();
    expect(projection.executionSetupSummary.authoritySource).toBe("CONTRACT");
  });

  it("fails closed if activeRunId points at a superseded Run", async () => {
    const task = taskBase();
    task.contract = contractFor(task);
    const superseded = { ...runRecord(), status: "SUPERSEDED" as const, supersededAt: "2026-08-16T09:00:00.000Z" };
    task.runs = [superseded];
    task.activeRunId = superseded.id;
    await expect(composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task))).rejects.toMatchObject({
      code: "TASK_EXPERIENCE_ACTIVE_RUN_SUPERSEDED",
    });
  });

  it("projects only late execution-platform choice while backend owns exact execution resolution", async () => {
    const task = unifiedTaskBase();
    bindV2Selection(task);
    task.draft.executionSetup = { providerId: "OPENAI", modelId: "gpt-5.6-sol", executionChannelId: "CODEX", reasoningProfile: "High", runtimeProfileId: "STANDARD", modelOverrideAccepted: false };
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { contextClosure: closedContextClosure() }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.executionOptions).toEqual({
      authorityMeaning: "OWNER_SELECTS_PLATFORM_BACKEND_RESOLVES_CONFIGURATION",
      availablePlatforms: [
        { executionChannelId: "CODEX", displayName: "Codex" },
        { executionChannelId: "CLAUDE_CODE", displayName: "Claude Code" },
        { executionChannelId: "GEMINI_CLI", displayName: "Gemini CLI" },
      ],
    });
  });

  it("uses canonical required-check satisfaction mode and never invents direct evidence proof attribution", async () => {
    const task = taskBase();
    task.contract = contractFor(task);
    // Simulate a legacy persisted contract where the canonical default must still resolve contract-validation.
    const contractValidation = task.contract.requiredChecks.find((check: RequiredCheck) => check.id === "contract-validation")!;
    delete (contractValidation as any).satisfactionMode;
    const run = { ...runRecord(), status: "REVIEW_READY" as const };
    run.verdict = {
      classification: "EVIDENCE_REQUIRED",
      acceptedFacts: [],
      detectedViolations: [],
      evidenceGaps: [],
      unsupportedClaims: [],
      contractComplianceSummary: "Trusted test proof inherited",
      nextAction: "Owner review",
      ownerDecisionState: "OWNER_DECISION_REQUIRED",
      trustedSatisfiedCheckIds: ["contract-validation", "tests"],
      unresolvedCheckIds: task.contract.requiredChecks.filter((check: RequiredCheck) => check.required && !["contract-validation", "tests"].includes(check.id)).map((check: RequiredCheck) => check.id),
    };
    task.runs = [run];
    task.activeRunId = run.id;
    const directValidation = {
      id: "direct-unattributed",
      checkId: "tests",
      status: "PASS" as const,
      producerType: "HARNESS",
      details: "Do not attribute this row directly to the Verdict",
      capturedAt: "2026-08-16T08:09:00.000Z",
    };
    const runAuthority = emptyRunAuthority({
      validationEvidence: [directValidation],
      inheritedValidationEvidence: [{
        checkId: "tests",
        parentRunId: "parent-run",
        sourceValidationEvidenceId: "source-validation-id",
        inheritedAt: "2026-08-16T08:09:30.000Z",
        source: { ...directValidation, id: "source-validation-id", details: "Exact inherited trusted source proof" },
      }],
    });
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { runAuthority }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    const contractRow = projection.verdictSummary.checkLedger.find(item => item.checkId === "contract-validation")!;
    const testsRow = projection.verdictSummary.checkLedger.find(item => item.checkId === "tests")!;
    expect(contractRow.satisfactionMode).toBe("BACKEND_AUTOMATIC");
    expect(contractRow.proofSnippet).toBeUndefined();
    expect(testsRow.satisfactionMode).toBe("PRODUCER_EVIDENCE");
    expect(testsRow.proofSnippet).toBe("Exact inherited trusted source proof");
  });

  it("grounds Run report/evidence counts and identities in persisted Run authority", async () => {
    const task = taskBase();
    task.contract = contractFor(task);
    const run = { ...runRecord(), status: "REVIEW_READY" as const };
    task.runs = [run];
    task.activeRunId = run.id;
    const runAuthority = emptyRunAuthority({
      reportSubmission: { id: "report-1", reportFormat: "JSON", contentSha256: "6".repeat(64), receivedAt: "2026-08-16T08:08:00.000Z" },
      evidenceReferences: [{ workspaceId: WS1, path: "src/server/lifecycle.ts", sourceReference: "src/server/lifecycle.ts", observation: "source", evidenceType: "SOURCE" }],
      validationEvidence: [{ id: "ve-1", checkId: "tests", status: "PASS", producerType: "HARNESS", details: "Tests", capturedAt: "2026-08-16T08:09:00.000Z" }],
      inheritedValidationEvidence: [],
      sourceEvidence: [{ requirementId: "req-1", workspaceId: WS1, path: "src/server/lifecycle.ts", contentSha256: "7".repeat(64), observation: "source", producerType: "BACKEND" }],
      artifactEvidence: [{ requirementId: "req-2", artifactId: "artifact-build", artifactSha256: "8".repeat(64), producerType: "BACKEND" }],
      toolTraceEvents: [{ sequence: 0, command: "npm run typecheck", authorizationResult: "AUTHORIZED", occurredAt: "2026-08-16T08:09:30.000Z" }],
      verdictIdentity: { id: "verdict-1", engineVersion: "v1", createdAt: "2026-08-16T08:10:00.000Z" },
      ownerDecisionIdentity: { id: "decision-1", createdAt: "2026-08-16T08:11:00.000Z" },
    });
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { runAuthority }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.runSummary).toMatchObject({ reportFormat: "APPLICATION_JSON", toolTracesCount: 1, evidenceReferencesCount: 1, validationEvidenceCount: 1, sourceEvidenceCount: 1, artifactEvidenceCount: 1 });
    expect(projection.auditDetails).toMatchObject({ reportSubmissionId: "report-1", verdictId: "verdict-1", ownerDecisionId: "decision-1" });
  });

  it("keeps phase progression and candidate/confirmed scope authority levels distinct", async () => {
    const task = taskBase();
    const decision = acceptedBackendDecision();
    bindBackendAnalysis(task, [decision]);
    deriveCandidate(task);
    let authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { boundRun: mappingRun(WS1, [decision], "OWNER_ACCEPTED") }));
    let projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("SCOPE_DERIVED_AWAITING_CONFIRMATION");
    expect(projection.candidateScopeSummary.allowedPaths).toEqual([{ workspaceId: WS1, workspaceDisplayName: "Backend", path: "src/server" }]);
    expect(projection.scopeConfirmationSummary.isConfirmed).toBe(false);

    confirmScope(task);
    authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, { boundRun: mappingRun(WS1, [decision], "OWNER_ACCEPTED") }));
    projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.scopeConfirmationSummary.isConfirmed).toBe(true);
    expect(projection.scopeConfirmationSummary.confirmedExcludedPaths).toEqual([{ workspaceId: WS1, workspaceDisplayName: "Backend", path: "src/server/private" }]);
  });

  it("getTaskExperienceProjection composes authority before projection", async () => {
    const task = taskBase();
    const dependencies = depsFor(task);
    const result = await getTaskExperienceProjection(TASK_ID, "en", dependencies);
    expect(result?.taskSummary.id).toBe(TASK_ID);
    expect(dependencies.readTaskLifecycle).toHaveBeenCalledWith(TASK_ID);
    expect(dependencies.readWorkspaceAuthorityRegistration).toHaveBeenCalledTimes(2);
    expect(dependencies.readLatestWorkspaceIndexSnapshot).toHaveBeenCalledTimes(2);
    expect(dependencies.readLatestMappingRunForWorkspaceIndexSnapshot).toHaveBeenCalledTimes(2);
  });
  it("allows Work rebase when frozen Scope is stale but a newer closed Context is itself current", async () => {
    const task = unifiedTaskBase();
    bindV2Selection(task, true);
    const parent = runRecord();
    parent.status = "DECIDED";
    parent.decision = "CORRECTION_REQUESTED";
    parent.correctionStarted = false;
    task.runs = [parent];
    const CURRENT_REVISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const currentClosure = {
      ...closedContextClosure(),
      revisionId: CURRENT_REVISION,
      revision: 3,
      acceptedCatalog: {
        ...closedContextClosure().acceptedCatalog!,
        catalog: { ...closedContextClosure().acceptedCatalog!.catalog, context_assembly_revision_id: CURRENT_REVISION },
      },
    };
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      contextClosure: currentClosure,
      contextForwardAuthorityByRevision: {
        [ASSEMBLY_REVISION_ID]: { frozenContextAssemblyRevisionId: ASSEMBLY_REVISION_ID, currentHeadRevisionId: CURRENT_REVISION, currentHeadRevision: 3, headStatus: "SUPERSEDED", sourceAuthorityStatus: "DRIFT" },
        [CURRENT_REVISION]: { frozenContextAssemblyRevisionId: CURRENT_REVISION, currentHeadRevisionId: CURRENT_REVISION, currentHeadRevision: 3, headStatus: "CURRENT", sourceAuthorityStatus: "CURRENT" },
      },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("SOURCE_DRIFT_REBASE_REQUIRED");
    expect(projection.primaryAction.actionKey).toBe("REBASE_CONTEXT_WORK_SELECTION");
  });

  it("projects stale closed pre-Work-Selection Context as rebuild-only historical provenance", async () => {
    const task = unifiedTaskBase();
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      contextClosure: closedContextClosure(),
      contextForwardAuthority: {
        frozenContextAssemblyRevisionId: ASSEMBLY_REVISION_ID,
        currentHeadRevisionId: ASSEMBLY_REVISION_ID,
        currentHeadRevision: 2,
        headStatus: "CURRENT",
        sourceAuthorityStatus: "UNPROVEN",
      },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("CURRENT_CONTEXT_REBUILD_REQUIRED");
    expect(projection.primaryAction).toMatchObject({ actionKey: "START_CONTEXT_ANALYSIS", availability: "ENABLED" });
    expect(projection.contextAuthoritySummary.status).toBe("CURRENT_CONTEXT_REBUILD_REQUIRED");
  });

  it("preserves a pending correction obligation but requires Context rebuild when frozen authority is consumed/stale", async () => {
    const task = unifiedTaskBase();
    bindV2Selection(task, true);
    const parent = runRecord();
    parent.status = "DECIDED";
    parent.decision = "CORRECTION_REQUESTED";
    parent.correctionStarted = false;
    task.runs = [parent];
    const authority = await composeTaskExperienceAuthoritySnapshot(TASK_ID, depsFor(task, {
      contextClosure: closedContextClosure(),
      contextForwardAuthority: {
        frozenContextAssemblyRevisionId: ASSEMBLY_REVISION_ID,
        currentHeadRevisionId: ASSEMBLY_REVISION_ID,
        currentHeadRevision: 2,
        headStatus: "CURRENT",
        sourceAuthorityStatus: "UNPROVEN",
      },
    }));
    const projection = computeTaskExperienceProjection(authority!, "en");
    expect(projection.phaseStatus).toBe("CURRENT_CONTEXT_REBUILD_REQUIRED");
    expect(projection.primaryAction.actionKey).toBe("START_CONTEXT_ANALYSIS");
    expect(projection.primaryAction.labelEn).toContain("Correction");
  });

});
