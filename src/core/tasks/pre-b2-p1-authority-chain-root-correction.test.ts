import { describe, expect, it } from "vitest";
import {
  applyModeDefaults,
  assertContractReadyTaskDraft,
  createBlankContractInput,
  createBlankTaskDraft,
  extractExecutionSetup,
  normalizeExecutionSetupCanonical,
  synchronizeLegacyWorkspaceProjection,
  TaskDraftNotReadyError,
  transitionModel,
  transitionProvider,
  transitionTaskMode,
  type LegacyCandidateScopeIdentity,
  type LegacyTaskCandidateScope,
  type TaskContextAnalysisBinding,
  type TaskDraftInput,
  type TaskScopeConfirmation,
  type WorkspaceReference,
} from "@/core/tasks/task-input";
import {
  applyOwnerScopeConfirmation,
  resolveCandidateScopeFromMappingInput,
  TaskContextBindingError,
  validateStaleContextAnalysisBinding,
} from "@/core/tasks/candidate-scope";
import type {
  MappingInputEntry,
  ModelProposedContextCatalogV1,
  OwnerContextDecisionView,
} from "@/core/ai-context-mapper/types";
import { MODEL_PROPOSED_CATALOG_SCHEMA_VERSION } from "@/core/ai-context-mapper/types";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { buildDraftContract, configurationPreview } from "@/lib/ui-flow";

// Regression classification: HISTORICAL_V1_REGRESSION
describe("PRE_B2_P1_AUTHORITY_CHAIN_ROOT_CORRECTION_V1 - Authoritative Suite (R1-R16)", () => {
  const ws1Id = "11111111-1111-4111-8111-111111111111";
  const ws2Id = "22222222-2222-4222-8222-222222222222";

  const ws1: WorkspaceReference = {
    id: ws1Id,
    displayName: "Workspace Alpha",
    role: "primary",
    referenceType: "LOCAL_PATH",
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: "E:\\repo-alpha",
    fingerprint: "sha256:alpha",
    allowedPaths: [],
    excludedPaths: [],
    authorizationContext: "test",
    ordering: 0,
  };

  const ws2: WorkspaceReference = {
    id: ws2Id,
    displayName: "Workspace Beta",
    role: "secondary",
    referenceType: "LOCAL_PATH",
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: "E:\\repo-beta",
    fingerprint: "sha256:beta",
    allowedPaths: [],
    excludedPaths: [],
    authorizationContext: "test",
    ordering: 1,
  };

  const sampleCatalog: ModelProposedContextCatalogV1 = {
    schema_version: MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
    catalog_summary: "Test Catalog",
    contexts: [
      {
        context_id: "ctx-auth",
        display_name: "Auth",
        context_kind: "module",
        confidence: "high",
        summary: "Auth module",
        responsibilities: ["Auth"],
        workspace_ids: [ws1Id, ws2Id],
        evidence_entry_ids: ["entry-ws1-auth", "entry-ws2-config"],
        interfaces: [],
        unknowns: [],
        rationale: "Auth",
      },
    ],
    relationships: [],
    unmapped_entries: [],
    global_unknowns: [],
    warnings: [],
  };

  const sampleMappingEntries: MappingInputEntry[] = [
    {
      entry_id: "entry-ws1-auth",
      workspace_id: ws1Id,
      normalized_path: "src/config.ts",
      entry_type: "FILE",
      language_or_format: "typescript",
      size_bytes: 100,
      content_or_metadata_fingerprint: "sha256:ws1-config",
      index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
    },
    {
      entry_id: "entry-ws2-config",
      workspace_id: ws2Id,
      normalized_path: "src/config.ts",
      entry_type: "FILE",
      language_or_format: "typescript",
      size_bytes: 120,
      content_or_metadata_fingerprint: "sha256:ws2-config",
      index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
    },
  ];

  const sampleDecisions: OwnerContextDecisionView[] = [
    {
      id: "dec-auth",
      runId: "run-001",
      proposalId: "prop-001",
      contextId: "ctx-auth",
      contextSha256: mapperSha256(sampleCatalog.contexts[0]),
      decision: "ACCEPT",
      ownerReference: "owner@intentchord",
      createdAt: new Date().toISOString(),
    },
  ];

  type HistoricalV1CandidateScope = LegacyTaskCandidateScope & { authorityVersion: "MAPPING_V1" };

  const helperCandidateScope = (): HistoricalV1CandidateScope => {
    const scope = resolveCandidateScopeFromMappingInput({
      binding: {
        workspaceIndexSnapshotId: "snap-001",
        mappingRunId: "run-001",
        proposalId: "prop-001",
        proposalSha256: "a".repeat(64),
        acceptedContextDecisionIds: ["dec-auth"],
      },
      workspaceIndexSnapshotId: "snap-001",
      mappingRunId: "run-001",
      proposalId: "prop-001",
      proposalSha256: "a".repeat(64),
      ownerVerdictState: "ACCEPTED",
      catalog: sampleCatalog,
      ownerContextDecisions: sampleDecisions,
      mappingInputEntries: sampleMappingEntries,
      boundWorkspaceIds: [ws1Id, ws2Id],
    });
    return { ...scope, authorityVersion: "MAPPING_V1" };
  };

  const helperCandidateIdentity = (cs: HistoricalV1CandidateScope): LegacyCandidateScopeIdentity => ({
    authorityVersion: "MAPPING_V1",
    workspaceIndexSnapshotId: cs.workspaceIndexSnapshotId,
    mappingRunId: cs.mappingRunId,
    proposalId: cs.proposalId,
    proposalSha256: cs.proposalSha256,
    acceptedContextDecisionIdsSha256: cs.acceptedContextDecisionIdsSha256,
    candidateScopeSha256: cs.candidateScopeSha256,
  });

  // R1: arbitrary confirmation path rejected
  it("R1: rejects arbitrary confirmation path not present in authoritative Candidate Scope", () => {
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1, ws2]);
    const candidateScope = helperCandidateScope();

    expect(() =>
      applyOwnerScopeConfirmation(
        { ...draft, candidateScope },
        {
          candidateIdentity: helperCandidateIdentity(candidateScope),
          confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/arbitrary-unscoped-file.ts" }],
          confirmedExcludedPaths: [],
          confirmedBy: "owner@intentchord",
          confirmedAt: new Date().toISOString(),
        },
        candidateScope,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CONFIRMED_PATH_NOT_IN_CANDIDATE_SCOPE" }),
    );
  });

  // R2: confirmation subset accepted
  it("R2: accepts a valid subset of Candidate Scope paths upon Owner confirmation", () => {
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1, ws2]);
    const candidateScope = helperCandidateScope();

    const confirmed = applyOwnerScopeConfirmation(
      { ...draft, candidateScope },
      {
        candidateIdentity: helperCandidateIdentity(candidateScope),
        confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
        confirmedExcludedPaths: [{ workspaceId: ws2Id, path: "src/config.ts" }],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      candidateScope,
    );

    expect(confirmed.workspaces[0].allowedPaths).toEqual(["src/config.ts"]);
    expect(confirmed.workspaces[1].allowedPaths).toEqual([]);
    expect(confirmed.workspaces[1].excludedPaths).toEqual(["src/config.ts"]);
  });

  // R3: Workspace A:path != Workspace B:path (multi-workspace distinct identities)
  it("R3: preserves distinct workspace-scoped identities for identical relative paths across Workspaces", () => {
    const candidateScope = helperCandidateScope();

    expect(candidateScope.candidateAllowedPaths).toEqual([
      { workspaceId: ws1Id, path: "src/config.ts" },
      { workspaceId: ws2Id, path: "src/config.ts" },
    ]);

    expect(candidateScope.entries[0].workspaceId).toBe(ws1Id);
    expect(candidateScope.entries[1].workspaceId).toBe(ws2Id);
    expect(candidateScope.entries[0].normalizedPath).toBe("src/config.ts");
    expect(candidateScope.entries[1].normalizedPath).toBe("src/config.ts");
  });

  // R4: Workspace allowedPaths rebuilt from confirmed Candidate Scope
  it("R4: deterministically rebuilds each Workspace allowedPaths from confirmed Candidate Scope entries", () => {
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [
        { ...ws1, allowedPaths: ["old/stale/path.ts"] },
        { ...ws2, allowedPaths: ["old/other/path.ts"] },
      ]),
    };
    const candidateScope = helperCandidateScope();

    const confirmed = applyOwnerScopeConfirmation(
      { ...draft, candidateScope },
      {
        candidateIdentity: helperCandidateIdentity(candidateScope),
        confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      candidateScope,
    );

    expect(confirmed.workspaces[0].allowedPaths).toEqual(["src/config.ts"]);
    expect(confirmed.workspaces[1].allowedPaths).toEqual([]);
  });

  // R5: no top-level/workspace scope divergence
  it("R5: ensures top-level allowedPaths strictly reflects workspace-scoped allowed paths without divergence", () => {
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1, ws2]);
    const candidateScope = helperCandidateScope();

    const confirmed = applyOwnerScopeConfirmation(
      { ...draft, candidateScope },
      {
        candidateIdentity: helperCandidateIdentity(candidateScope),
        confirmedAllowedPaths: [
          { workspaceId: ws1Id, path: "src/config.ts" },
          { workspaceId: ws2Id, path: "src/config.ts" },
        ],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      candidateScope,
    );

    expect(confirmed.allowedPaths).toEqual([
      `${ws1Id}:src/config.ts`,
      `${ws2Id}:src/config.ts`,
    ]);
  });

  // R6: stale candidate confirmation rejected
  it("R6: rejects confirmation whose candidateIdentity does not match current authoritative Candidate Scope", () => {
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1]);
    const candidateScope = helperCandidateScope();

    expect(() =>
      applyOwnerScopeConfirmation(
        { ...draft, candidateScope },
        {
          candidateIdentity: {
            ...helperCandidateIdentity(candidateScope),
            workspaceIndexSnapshotId: "snap-stale-999",
          },
          confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
          confirmedExcludedPaths: [],
          confirmedBy: "owner@intentchord",
          confirmedAt: new Date().toISOString(),
        },
        candidateScope,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "SCOPE_CONFIRMATION_IDENTITY_MISMATCH" }),
    );
  });

  // R7: Contract readiness requires confirmed scope for new unified flow
  it("R7: fails closed when compiling Contract for unified flow without valid confirmed scope", () => {
    const candidateScope = helperCandidateScope();
    const binding: TaskContextAnalysisBinding = {
      workspaceIndexSnapshotId: "snap-001",
      mappingRunId: "run-001",
      proposalId: "prop-001",
      proposalSha256: "a".repeat(64),
      acceptedContextDecisionIds: ["dec-auth"],
    };

    const draftWithoutConfirmation: TaskDraftInput = {
      ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1, ws2]),
      objective: "Valid objective for task",
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      contextAnalysisBinding: binding,
      candidateScope,
    };

    // Missing scopeConfirmation
    expect(() => assertContractReadyTaskDraft(draftWithoutConfirmation)).toThrowError(
      expect.objectContaining({ code: "SCOPE_CONFIRMATION_REQUIRED" }),
    );

    // Stale scopeConfirmation
    const draftWithStaleConfirmation: TaskDraftInput = {
      ...draftWithoutConfirmation,
      scopeConfirmation: {
        candidateIdentity: {
          ...helperCandidateIdentity(candidateScope),
          workspaceIndexSnapshotId: "snap-different",
        },
        confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
    };

    expect(() => assertContractReadyTaskDraft(draftWithStaleConfirmation)).toThrowError(
      expect.objectContaining({ code: "SCOPE_CONFIRMATION_IDENTITY_STALE" }),
    );
  });

  // R8: executionSetup/top-level conflict rejected or canonically normalized
  it("R8: rejects conflicting dual executionSetup and normalizes valid top-level fields canonically", () => {
    const conflictingDraft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      executionSetup: {
        providerId: "ANTHROPIC",
        modelId: "claude-sonnet-5",
        executionChannelId: "CLAUDE_CODE",
        reasoningProfile: "High",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: false,
      },
    };

    expect(() => normalizeExecutionSetupCanonical(conflictingDraft)).toThrowError(
      expect.objectContaining({ code: "EXECUTION_SETUP_CONFLICT" }),
    );

    const topLevelOnlyDraft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: false,
    };

    const normalized = normalizeExecutionSetupCanonical(topLevelOnlyDraft);
    expect(normalized.executionSetup).toBeDefined();
    expect(normalized.executionSetup?.providerId).toBe("OPENAI");
    expect(normalized.executionSetup?.modelId).toBe("gpt-5.5");
  });

  // R9: mode transition cannot retain stale nested override authority
  it("R9: clears model override accepted and reason upon Task Mode transition", () => {
    const draftWithOverride: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      modelOverrideAccepted: true,
      modelOverrideReason: "Owner verified model performance for this task",
    };

    const transitioned = transitionTaskMode(draftWithOverride, "SOURCE_IMPLEMENTATION");
    expect(transitioned.modelOverrideAccepted).toBe(false);
    expect(transitioned.modelOverrideReason).toBe("");
  });

  // R10: incomplete Task preview shows NOT_SELECTED
  it("R10: returns NOT_SELECTED executionStatus when previewing an incomplete Task Draft", () => {
    const blankDraft = createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]);
    const preview = configurationPreview(blankDraft);

    expect(preview.executionStatus).toBe("NOT_SELECTED");
    expect(preview.recommendation).toBeUndefined();
    expect(preview.task).toBeDefined();
  });

  // R11: incomplete Task cannot synthesize fake ExecutionContract
  it("R11: returns undefined from buildDraftContract for incomplete Task Draft", () => {
    const blankDraft = createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]);
    const contract = buildDraftContract(blankDraft);

    expect(contract).toBeUndefined();
  });

  // R12: no OpenAI/default model injected into incomplete Task UI projection
  it("R12: ensures createBlankTaskDraft leaves providerId and modelId undefined", () => {
    const blankDraft = createBlankTaskDraft("CONTROLLED_AUDIT");

    expect(blankDraft.providerId).toBeUndefined();
    expect(blankDraft.modelId).toBeUndefined();
    expect(blankDraft.executionSetup).toBeUndefined();
  });

  // R13: missing MappingInputEntry Workspace identity fails closed
  it("R13: fails closed when a MappingInputEntry lacks an authoritative workspace_id", () => {
    const invalidEntry: MappingInputEntry = {
      entry_id: "entry-no-ws",
      workspace_id: "" as string, // missing workspace_id
      normalized_path: "src/index.ts",
      entry_type: "FILE",
      language_or_format: "typescript",
      size_bytes: 50,
      content_or_metadata_fingerprint: "sha256:no-ws",
      index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
    };

    const catalog: ModelProposedContextCatalogV1 = {
      ...sampleCatalog,
      contexts: [
        {
          ...sampleCatalog.contexts[0],
          evidence_entry_ids: ["entry-no-ws"],
        },
      ],
    };

    const decisionsWithUpdatedHash: OwnerContextDecisionView[] = [
      {
        ...sampleDecisions[0],
        contextSha256: mapperSha256(catalog.contexts[0]),
      },
    ];

    expect(() =>
      resolveCandidateScopeFromMappingInput({
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001",
          proposalId: "prop-001",
          proposalSha256: "a".repeat(64),
          acceptedContextDecisionIds: ["dec-auth"],
        },
        workspaceIndexSnapshotId: "snap-001",
        mappingRunId: "run-001",
        proposalId: "prop-001",
        proposalSha256: "a".repeat(64),
        ownerVerdictState: "ACCEPTED",
        catalog,
        ownerContextDecisions: decisionsWithUpdatedHash,
        mappingInputEntries: [invalidEntry],
        boundWorkspaceIds: [ws1Id],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "EVIDENCE_WORKSPACE_IDENTITY_MISSING" }),
    );
  });

  // R14: early Task can persist with zero Workspaces
  it("R14: supports creating an early staged Task Draft with zero Workspaces", () => {
    const earlyDraft = createBlankTaskDraft("CONTROLLED_AUDIT", []);

    expect(earlyDraft.workspaces).toHaveLength(0);
    expect(earlyDraft.title).toBe("Untitled IntentChord task");
    expect(earlyDraft.taskMode).toBe("CONTROLLED_AUDIT");
  });

  // R15: Contract cannot resolve with zero Workspaces
  it("R15: fails closed when attempting to compile Contract with zero Workspaces", () => {
    const zeroWorkspaceDraft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", []),
      objective: "Valid objective with enough characters",
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
    };

    expect(() => assertContractReadyTaskDraft(zeroWorkspaceDraft)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_REQUIRED" }),
    );
  });

  // R16: Multi-Workspace Candidate Scope remains workspace-scoped
  it("R16: ensures Multi-Workspace Candidate Scope preserves workspaceId on every path entry", () => {
    const candidateScope = helperCandidateScope();

    expect(candidateScope.candidateAllowedPaths).toHaveLength(2);
    for (const item of candidateScope.candidateAllowedPaths) {
      expect(item.workspaceId).toBeDefined();
      expect(typeof item.workspaceId).toBe("string");
      expect(item.path).toBeDefined();
    }
  });
});
