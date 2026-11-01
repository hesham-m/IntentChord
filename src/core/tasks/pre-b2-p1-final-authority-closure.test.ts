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
  type TaskExecutionSetup,
  type TaskScopeConfirmation,
  type WorkspaceReference,
} from "@/core/tasks/task-input";
import {
  applyOwnerScopeConfirmation,
  resolveCandidateScopeFromMappingInput,
  TaskContextBindingError,
} from "@/core/tasks/candidate-scope";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import type {
  MappingInputEntry,
  ModelProposedContextCatalogV1,
  OwnerContextDecisionView,
} from "@/core/ai-context-mapper/types";
import { configurationPreview, buildDraftContract } from "@/lib/ui-flow";
import { taskContextAnalysisBindingSchema } from "@/server/schemas";

// Regression classification: HISTORICAL_V1_REGRESSION
describe("INTENTCHORD_PRE_B2_P1_FINAL_AUTHORITY_CLOSURE: F1-F28 Unit Tests", () => {
  const ws1Id = "11111111-1111-4111-8111-111111111111";
  const ws2Id = "22222222-2222-4222-8222-222222222222";

  const ws1: WorkspaceReference = {
    id: ws1Id,
    displayName: "primary-server",
    role: "primary",
    referenceType: "LOCAL_PATH",
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: "E:\\server",
    fingerprint: "sha256:ws1",
    discoveryScopeMode: "SELECTED_PATHS",
    allowedPaths: [],
    excludedPaths: [],
    authorizationContext: "owner",
    ordering: 0,
  };

  const ws2: WorkspaceReference = {
    id: ws2Id,
    displayName: "client-ui",
    role: "secondary",
    referenceType: "LOCAL_PATH",
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: "E:\\ui",
    fingerprint: "sha256:ws2",
    discoveryScopeMode: "SELECTED_PATHS",
    allowedPaths: [],
    excludedPaths: [],
    authorizationContext: "owner",
    ordering: 1,
  };

  const sampleCatalog: ModelProposedContextCatalogV1 = {
    schema_version: "intentchord.model-proposed-context-catalog.v1",
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
      {
        context_id: "ctx-api",
        display_name: "API",
        context_kind: "module",
        confidence: "high",
        summary: "API module",
        responsibilities: ["API"],
        workspace_ids: [ws1Id],
        evidence_entry_ids: ["entry-ws1-api"],
        interfaces: [],
        unknowns: [],
        rationale: "API",
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
    {
      entry_id: "entry-ws1-api",
      workspace_id: ws1Id,
      normalized_path: "src/api.ts",
      entry_type: "FILE",
      language_or_format: "typescript",
      size_bytes: 200,
      content_or_metadata_fingerprint: "sha256:ws1-api",
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
    {
      id: "dec-api",
      runId: "run-001",
      proposalId: "prop-001",
      contextId: "ctx-api",
      contextSha256: mapperSha256(sampleCatalog.contexts[1]),
      decision: "ACCEPT",
      ownerReference: "owner@intentchord",
      createdAt: new Date().toISOString(),
    },
  ];

  type HistoricalV1CandidateScope = LegacyTaskCandidateScope & { authorityVersion: "MAPPING_V1" };

  const helperCandidateScope = (acceptedDecisions: string[] = ["dec-auth"]): HistoricalV1CandidateScope => {
    const scope = resolveCandidateScopeFromMappingInput({
      binding: {
        workspaceIndexSnapshotId: "snap-001",
        mappingRunId: "run-001",
        proposalId: "prop-001",
        proposalSha256: "a".repeat(64),
        acceptedContextDecisionIds: acceptedDecisions,
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

  // F1: Changed accepted decision set invalidates old Candidate Scope identity
  it("F1: invalidates Candidate Scope identity when accepted decision set changes on same snapshot/run/proposal", () => {
    const scopeA = helperCandidateScope(["dec-auth"]);
    const scopeB = helperCandidateScope(["dec-api"]);

    expect(scopeA.workspaceIndexSnapshotId).toBe(scopeB.workspaceIndexSnapshotId);
    expect(scopeA.mappingRunId).toBe(scopeB.mappingRunId);
    expect(scopeA.proposalId).toBe(scopeB.proposalId);
    expect(scopeA.proposalSha256).toBe(scopeB.proposalSha256);

    // Cryptographic selection identity differs
    expect(scopeA.acceptedContextDecisionIdsSha256).not.toBe(scopeB.acceptedContextDecisionIdsSha256);
    expect(scopeA.candidateScopeSha256).not.toBe(scopeB.candidateScopeSha256);

    // Scope confirmation with scopeA identity applied to scopeB must fail closed
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1, ws2]);
    expect(() =>
      applyOwnerScopeConfirmation(
        { ...draft, candidateScope: scopeB },
        {
          candidateIdentity: helperCandidateIdentity(scopeA),
          confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/auth/jwt.ts" }],
          confirmedExcludedPaths: [],
          confirmedBy: "owner@intentchord",
          confirmedAt: new Date().toISOString(),
        },
        scopeB,
      ),
    ).toThrowError(expect.objectContaining({ code: "SCOPE_CONFIRMATION_IDENTITY_MISMATCH" }));
  });

  // F2: Candidate Scope SHA changes when entries change
  it("F2: produces different candidateScopeSha256 when Candidate entries change", () => {
    const scopeAuth = helperCandidateScope(["dec-auth"]);
    const scopeBoth = helperCandidateScope(["dec-auth", "dec-api"]);

    expect(scopeAuth.candidateAllowedPaths.length).toBe(2);
    expect(scopeBoth.candidateAllowedPaths.length).toBe(3);
    expect(scopeAuth.candidateScopeSha256).not.toBe(scopeBoth.candidateScopeSha256);
  });

  // F3: UNIFIED_V1 stamped immediately on new Task creation
  it("F3: stamps orchestrationVersion UNIFIED_V1 immediately upon blank Task draft creation", () => {
    const draft = createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]);
    expect(draft.orchestrationVersion).toBe("UNIFIED_V1");
  });

  // F4: UNIFIED_V1 without contextAnalysisBinding cannot take Legacy Contract path
  it("F4: prevents UNIFIED_V1 Task without contextAnalysisBinding from bypassing scope gating", () => {
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1]),
      objective: "Implement auth token refresh",
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      // contextAnalysisBinding is intentionally missing
    };

    expect(() => assertContractReadyTaskDraft(draft)).toThrowError(
      expect.objectContaining({ code: "CONTEXT_ANALYSIS_REQUIRED" }),
    );
  });

  // F5: Historical draft without orchestrationVersion remains readable as Legacy
  it("F5: allows historical draft without orchestrationVersion to pass Contract readiness as Legacy", () => {
    const historicalDraft: TaskDraftInput = {
      title: "Historical Task",
      titleManuallyEdited: false,
      objective: "Legacy audit task",
      ownerRequirements: [],
      taskMode: "CONTROLLED_AUDIT",
      workspaces: [ws1],
      workspaceRef: "E:\\server",
      workspaceSource: "MANUAL_UNVERIFIED",
      workspaceFingerprint: "sha256:ws1",
      allowedPaths: ["src"],
      excludedPaths: [],
      evidenceFiles: [],
      identity: "",
      readFiles: true,
      modifySource: false,
      runStaticValidation: true,
      runTests: true,
      build: false,
      deploy: false,
      restartServices: false,
      writeDatabase: false,
      changeEnvironment: false,
      useNetwork: false,
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      // No orchestrationVersion!
    };

    const contractInput = assertContractReadyTaskDraft(historicalDraft);
    expect(contractInput).toBeDefined();
    expect(contractInput.providerId).toBe("OPENAI");
  });

  // F6: Historical draft is not mutated to add orchestrationVersion
  it("F6: verifies historical draft remains unmutated without orchestrationVersion", () => {
    const historicalDraft: TaskDraftInput = {
      title: "Historical Task",
      titleManuallyEdited: false,
      objective: "Legacy audit task",
      ownerRequirements: [],
      taskMode: "CONTROLLED_AUDIT",
      workspaces: [ws1],
      workspaceRef: "E:\\server",
      workspaceSource: "MANUAL_UNVERIFIED",
      workspaceFingerprint: "sha256:ws1",
      allowedPaths: [],
      excludedPaths: [],
      evidenceFiles: [],
      identity: "",
      readFiles: true,
      modifySource: false,
      runStaticValidation: true,
      runTests: true,
      build: false,
      deploy: false,
      restartServices: false,
      writeDatabase: false,
      changeEnvironment: false,
      useNetwork: false,
    };

    expect(historicalDraft.orchestrationVersion).toBeUndefined();
  });

  // F13: resolveContract fail-closed check
  it("F13: asserts assertContractReadyTaskDraft fails closed if scope confirmation candidateIdentity is stale", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    const binding: TaskContextAnalysisBinding = {
      workspaceIndexSnapshotId: "snap-001",
      mappingRunId: "run-001",
      proposalId: "prop-001",
      proposalSha256: "a".repeat(64),
      acceptedContextDecisionIds: ["dec-auth"],
    };

    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1]),
      objective: "Valid objective for implementation",
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      contextAnalysisBinding: binding,
      candidateScope,
      scopeConfirmation: {
        candidateIdentity: {
          ...helperCandidateIdentity(candidateScope),
          candidateScopeSha256: "wrong".repeat(12).slice(0, 64),
        },
        confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/auth/jwt.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
    };

    expect(() => assertContractReadyTaskDraft(draft)).toThrowError(
      expect.objectContaining({ code: "SCOPE_CONFIRMATION_IDENTITY_STALE" }),
    );
  });

  // F14: UNIFIED_V1 staged Task normalizes executionSetup as single canonical representation
  it("F14: extracts canonical executionSetup from complete Task draft", () => {
    const setup: TaskExecutionSetup = {
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: false,
    };
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      executionSetup: setup,
    };

    const extracted = extractExecutionSetup(draft);
    expect(extracted).toEqual(setup);
  });

  // F15: Conflicting compatibility execution fields fail closed
  it("F15: throws EXECUTION_SETUP_CONFLICT when nested executionSetup and top-level fields conflict", () => {
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      providerId: "ANTHROPIC",
      modelId: "claude-sonnet-5",
      executionChannelId: "CLAUDE_CODE",
      reasoningProfile: "High",
      runtimeProfileId: "STANDARD",
      executionSetup: {
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: false,
      },
    };

    expect(() => normalizeExecutionSetupCanonical(draft)).toThrowError(
      expect.objectContaining({ code: "EXECUTION_SETUP_CONFLICT" }),
    );
  });

  // F16: ContractInput execution fields are derived from canonical executionSetup
  it("F16: derives ContractInput execution fields from canonical executionSetup", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    const binding: TaskContextAnalysisBinding = {
      workspaceIndexSnapshotId: "snap-001",
      mappingRunId: "run-001",
      proposalId: "prop-001",
      proposalSha256: "a".repeat(64),
      acceptedContextDecisionIds: ["dec-auth"],
    };

    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1]),
      objective: "Valid audit objective",
      contextAnalysisBinding: binding,
      candidateScope,
      scopeConfirmation: {
        candidateIdentity: helperCandidateIdentity(candidateScope),
        confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      executionSetup: {
        providerId: "GOOGLE",
        modelId: "gemini-3.6-flash",
        executionChannelId: "GEMINI_CLI",
        reasoningProfile: "Auto",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: false,
      },
    };

    const contractInput = assertContractReadyTaskDraft(draft);
    expect(contractInput.providerId).toBe("GOOGLE");
    expect(contractInput.modelId).toBe("gemini-3.6-flash");
    expect(contractInput.executionChannelId).toBe("GEMINI_CLI");
  });

  // F17: UI reads canonical execution projection
  it("F17: configurationPreview accurately reflects valid executionSetup", () => {
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      objective: "Valid preview objective",
      executionSetup: {
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: false,
      },
    };

    const preview = configurationPreview(draft);
    expect(preview.executionStatus).toBe("SELECTED");
    expect(preview.recommendation).toBeDefined();
  });

  // F18: No executionSetup => UI status NOT_SELECTED
  it("F18: configurationPreview returns NOT_SELECTED when executionSetup is missing", () => {
    const draft = createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]);
    const preview = configurationPreview(draft);
    expect(preview.executionStatus).toBe("NOT_SELECTED");
    expect(preview.recommendation).toBeUndefined();

    const contractDraft = buildDraftContract(draft);
    expect(contractDraft).toBeUndefined();
  });

  // F19 & F28: Mode change clears stale canonical model override state in executionSetup
  it("F19 / F28: clears nested model override state upon actual taskMode change", () => {
    const initialDraft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      executionSetup: {
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: true,
        modelOverrideReason: "Owner explicit override for audit mode",
      },
    };

    const transitioned = transitionTaskMode(initialDraft, "SOURCE_IMPLEMENTATION");
    expect(transitioned.taskMode).toBe("SOURCE_IMPLEMENTATION");
    expect(transitioned.executionSetup?.modelOverrideAccepted).toBe(false);
    expect(transitioned.executionSetup?.modelOverrideReason).toBeUndefined();
  });

  // F20: Existing historical execution projections remain readable
  it("F20: extracts executionSetup from top-level fields for historical records", () => {
    const legacyDraft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: true,
      modelOverrideReason: "Legacy override reason",
    };

    const extracted = extractExecutionSetup(legacyDraft);
    expect(extracted).toBeDefined();
    expect(extracted?.providerId).toBe("OPENAI");
    expect(extracted?.modelOverrideAccepted).toBe(true);
    expect(extracted?.modelOverrideReason).toBe("Legacy override reason");
  });

  // F23: Same accepted Context Decision SET in different order yields identical selection hash
  it("F23: produces identical acceptedContextDecisionIdsSha256 regardless of input decision order", () => {
    const scopeOrder1 = resolveCandidateScopeFromMappingInput({
      binding: {
        workspaceIndexSnapshotId: "snap-001",
        mappingRunId: "run-001",
        proposalId: "prop-001",
        proposalSha256: "a".repeat(64),
        acceptedContextDecisionIds: ["dec-auth", "dec-api"],
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

    const scopeOrder2 = resolveCandidateScopeFromMappingInput({
      binding: {
        workspaceIndexSnapshotId: "snap-001",
        mappingRunId: "run-001",
        proposalId: "prop-001",
        proposalSha256: "a".repeat(64),
        acceptedContextDecisionIds: ["dec-api", "dec-auth"], // Reversed order
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

    expect(scopeOrder1.acceptedContextDecisionIdsSha256).toBe(scopeOrder2.acceptedContextDecisionIdsSha256);
    expect(scopeOrder1.candidateScopeSha256).toBe(scopeOrder2.candidateScopeSha256);
  });

  // F7: Generic Task revision attempt containing scopeConfirmation for UNIFIED_V1 fails closed
  it("F7: rejects client-authored scopeConfirmation on UNIFIED_V1 draft without dedicated command", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1]),
      scopeConfirmation: {
        candidateIdentity: helperCandidateIdentity(candidateScope),
        confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "client-spoofed",
        confirmedAt: new Date().toISOString(),
      },
    };

    // Stamped UNIFIED_V1 draft with raw unconfirmed scopeConfirmation requires dedicated command in lifecycle
    expect(draft.orchestrationVersion).toBe("UNIFIED_V1");
    expect(draft.scopeConfirmation?.confirmedBy).toBe("client-spoofed");
  });

  // F8: Dedicated Owner Scope Confirmation recomputes Candidate Scope
  it("F8: recomputes authoritative candidate scope before applying confirmation", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    expect(candidateScope.candidateAllowedPaths).toEqual([
      { workspaceId: ws1Id, path: "src/config.ts" },
      { workspaceId: ws2Id, path: "src/config.ts" },
    ]);
  });

  // F9: Invalid/non-candidate path causes confirmation to fail
  it("F9: fails closed when attempting to confirm an unmapped path", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1]);

    expect(() =>
      applyOwnerScopeConfirmation(
        { ...draft, candidateScope },
        {
          candidateIdentity: helperCandidateIdentity(candidateScope),
          confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "unmapped/foreign.ts" }],
          confirmedExcludedPaths: [],
          confirmedBy: "owner@intentchord",
          confirmedAt: new Date().toISOString(),
        },
        candidateScope,
      ),
    ).toThrowError(expect.objectContaining({ code: "CONFIRMED_PATH_NOT_IN_CANDIDATE_SCOPE" }));
  });

  // F10 / F24: Stale Candidate identity causes confirmation to fail
  it("F10 / F24: fails closed when expectedCandidateIdentity does not match authoritative candidate identity", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1]);

    expect(() =>
      applyOwnerScopeConfirmation(
        { ...draft, candidateScope },
        {
          candidateIdentity: {
            ...helperCandidateIdentity(candidateScope),
            acceptedContextDecisionIdsSha256: "0".repeat(64), // Mismatched selection SHA
          },
          confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
          confirmedExcludedPaths: [],
          confirmedBy: "owner@intentchord",
          confirmedAt: new Date().toISOString(),
        },
        candidateScope,
      ),
    ).toThrowError(expect.objectContaining({ code: "SCOPE_CONFIRMATION_IDENTITY_MISMATCH" }));
  });

  // F11 & F12: Valid confirmation updates workspaces allowedPaths exactly matching confirmed selection
  it("F11 / F12: applies confirmed subset to workspaces and top-level projection deterministically", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1, ws2]);

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
    expect(confirmed.workspaces[0].discoveryScopeMode).toBe("SELECTED_PATHS");
    expect(confirmed.workspaces[1].allowedPaths).toEqual([]);
    expect(confirmed.workspaces[1].discoveryScopeMode).toBe("NONE");
    expect(confirmed.workspaces[1].excludedPaths).toEqual(["src/config.ts"]);
    expect(confirmed.allowedPaths).toEqual([`${ws1Id}:src/config.ts`]);
  });

  it("F11B: ContractInput projects only Owner-confirmed execution paths and never falls back to a Workspace root", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    let confirmed = applyOwnerScopeConfirmation(
      { ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [{ ...ws1, discoveryScopeMode: "FULL_WORKSPACE" }, { ...ws2, discoveryScopeMode: "FULL_WORKSPACE" }]), candidateScope },
      {
        candidateIdentity: helperCandidateIdentity(candidateScope),
        confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      candidateScope,
    );
    confirmed = {
      ...confirmed,
      contextAnalysisBinding: {
        workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
        mappingRunId: candidateScope.mappingRunId,
        proposalId: candidateScope.proposalId,
        proposalSha256: candidateScope.proposalSha256,
        acceptedContextDecisionIds: ["dec-auth"],
      },
      executionSetup: {
        providerId: "OPENAI", modelId: "gpt-5.6-sol", executionChannelId: "CODEX",
        reasoningProfile: "Medium", runtimeProfileId: "STANDARD", modelOverrideAccepted: false,
      },
    };
    const contractInput = assertContractReadyTaskDraft(confirmed);
    expect(contractInput.workspaces[0].allowedPaths).toEqual(["src/config.ts"]);
    expect(contractInput.workspaces[0].discoveryScopeMode).toBe("SELECTED_PATHS");
    expect(contractInput.workspaces[1].allowedPaths).toEqual([]);
    expect(contractInput.workspaces[1].discoveryScopeMode).toBe("NONE");
    expect(contractInput.allowedPaths).toEqual([`${ws1Id}:src/config.ts`]);
  });

  // F25: Candidate Scope is server-owned and derived from binding
  it("F25: verifies Candidate Scope is derived from authoritative mapping input and decisions", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    expect(candidateScope.entries.length).toBe(2);
    const workspaceIds = Array.from(new Set(candidateScope.entries.map(e => e.workspaceId))).sort();
    expect(workspaceIds).toEqual([ws1Id, ws2Id].sort());
  });

  // F27: Unrelated Task edit does not erase valid canonical model override state
  it("F27: preserves model override state when updating unrelated task fields in the same mode", () => {
    const initialDraft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      executionSetup: {
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: true,
        modelOverrideReason: "Owner explicit override for audit mode",
      },
    };

    // Applying same mode defaults (e.g. on general edit) preserves override
    const updated = applyModeDefaults(initialDraft, "CONTROLLED_AUDIT");
    expect(updated.executionSetup?.modelOverrideAccepted).toBe(true);
    expect(updated.executionSetup?.modelOverrideReason).toBe("Owner explicit override for audit mode");
  });

  // M2-1: Same unique IDs in different order => same hash
  it("M2-1: produces identical acceptedContextDecisionIdsSha256 for same unique IDs in different order", () => {
    const scope1 = helperCandidateScope(["dec-auth", "dec-api"]);
    const scope2 = helperCandidateScope(["dec-api", "dec-auth"]);

    expect(scope1.acceptedContextDecisionIdsSha256).toBe(scope2.acceptedContextDecisionIdsSha256);
    expect(scope1.candidateScopeSha256).toBe(scope2.candidateScopeSha256);
  });

  // M2-2: Duplicate representation of same IDs => rejected fail-closed in candidate-scope resolution
  it("M2-2: rejects duplicate acceptedContextDecisionIds fail-closed in resolveCandidateScopeFromMappingInput", () => {
    expect(() =>
      resolveCandidateScopeFromMappingInput({
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001",
          proposalId: "prop-001",
          proposalSha256: "a".repeat(64),
          acceptedContextDecisionIds: ["dec-auth", "dec-auth"], // Duplicate!
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
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ACCEPTED_DECISION_IDS" }));
  });

  // M2-3: Different decision set => different identity
  it("M2-3: produces different acceptedContextDecisionIdsSha256 for different decision sets", () => {
    const scopeAuth = helperCandidateScope(["dec-auth"]);
    const scopeApi = helperCandidateScope(["dec-api"]);

    expect(scopeAuth.acceptedContextDecisionIdsSha256).not.toBe(scopeApi.acceptedContextDecisionIdsSha256);
    expect(scopeAuth.candidateScopeSha256).not.toBe(scopeApi.candidateScopeSha256);
  });

  // M2-4: Malformed duplicate binding schema validation rejects fail-closed
  it("M2-4: rejects duplicate acceptedContextDecisionIds in taskContextAnalysisBindingSchema", () => {
    const parsed = taskContextAnalysisBindingSchema.safeParse({
      workspaceIndexSnapshotId: "11111111-1111-4111-8111-111111111111",
      mappingRunId: "22222222-2222-4222-8222-222222222222",
      proposalId: "33333333-3333-4333-8333-333333333333",
      proposalSha256: "a".repeat(64),
      acceptedContextDecisionIds: [
        "44444444-4444-4444-8444-444444444444",
        "44444444-4444-4444-8444-444444444444",
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain("Duplicate acceptedContextDecisionId is forbidden.");
    }
  });

  // M3-1: UNIFIED_V1 nested executionSetup with modelOverrideAccepted=false + top-level true => fails closed
  it("M3-1: throws EXECUTION_SETUP_CONFLICT when top-level modelOverrideAccepted conflicts with nested false", () => {
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      modelOverrideAccepted: true,
      executionSetup: {
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: false,
        modelOverrideReason: "",
      },
    };

    expect(() => normalizeExecutionSetupCanonical(draft)).toThrowError(
      expect.objectContaining({ code: "EXECUTION_SETUP_CONFLICT" }),
    );
  });

  // M3-2: UNIFIED_V1 nested modelOverrideReason=A + top-level reason=B => fails closed
  it("M3-2: throws EXECUTION_SETUP_CONFLICT when top-level modelOverrideReason conflicts with nested reason", () => {
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      modelOverrideAccepted: true,
      modelOverrideReason: "Top level reason B",
      executionSetup: {
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: true,
        modelOverrideReason: "Nested reason A",
      },
    };

    expect(() => normalizeExecutionSetupCanonical(draft)).toThrowError(
      expect.objectContaining({ code: "EXECUTION_SETUP_CONFLICT" }),
    );
  });

  // M3-3: Matching nested + compatibility fields accepted
  it("M3-3: accepts matching nested executionSetup and top-level fields without error", () => {
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: true,
      modelOverrideReason: "Same reason",
      executionSetup: {
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: true,
        modelOverrideReason: "Same reason",
      },
    };

    const normalized = normalizeExecutionSetupCanonical(draft);
    expect(normalized.executionSetup?.providerId).toBe("OPENAI");
    expect(normalized.executionSetup?.modelOverrideAccepted).toBe(true);
  });

  // M3-4: Legacy record with ONLY historical flattened execution fields remains readable
  it("M3-4: normalizes Legacy draft with only flattened execution fields into executionSetup", () => {
    const legacyDraft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      providerId: "ANTHROPIC",
      modelId: "claude-sonnet-5",
      executionChannelId: "CLAUDE_CODE",
      reasoningProfile: "High",
      runtimeProfileId: "STANDARD",
      modelOverrideAccepted: true,
      modelOverrideReason: "Historical legacy override",
    };
    delete legacyDraft.executionSetup;

    const normalized = normalizeExecutionSetupCanonical(legacyDraft);
    expect(normalized.executionSetup).toBeDefined();
    expect(normalized.executionSetup?.providerId).toBe("ANTHROPIC");
    expect(normalized.executionSetup?.modelId).toBe("claude-sonnet-5");
    expect(normalized.executionSetup?.modelOverrideAccepted).toBe(true);
    expect(normalized.executionSetup?.modelOverrideReason).toBe("Historical legacy override");
  });

  // M3-5: extractExecutionSetup returns canonical nested setup without top-level override
  it("M3-5: extracts canonical nested executionSetup without silent top-level modification", () => {
    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("CONTROLLED_AUDIT", [ws1]),
      modelOverrideAccepted: true, // Should NOT override nested false
      modelOverrideReason: "Malicious top-level override",
      executionSetup: {
        providerId: "OPENAI",
        modelId: "gpt-5.5",
        executionChannelId: "CODEX",
        reasoningProfile: "Medium",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: false,
        modelOverrideReason: "Authoritative nested reason",
      },
    };

    const extracted = extractExecutionSetup(draft);
    expect(extracted?.modelOverrideAccepted).toBe(false);
    expect(extracted?.modelOverrideReason).toBe("Authoritative nested reason");
  });

  // M3-6: assertContractReadyTaskDraft derives execution settings solely from canonical executionSetup
  it("M3-6: derives ContractInput execution settings solely from canonical executionSetup for UNIFIED_V1", () => {
    const candidateScope = helperCandidateScope(["dec-auth"]);
    const binding: TaskContextAnalysisBinding = {
      workspaceIndexSnapshotId: "snap-001",
      mappingRunId: "run-001",
      proposalId: "prop-001",
      proposalSha256: "a".repeat(64),
      acceptedContextDecisionIds: ["dec-auth"],
    };

    const draft: TaskDraftInput = {
      ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [ws1]),
      objective: "Valid objective",
      contextAnalysisBinding: binding,
      candidateScope,
      scopeConfirmation: {
        candidateIdentity: helperCandidateIdentity(candidateScope),
        confirmedAllowedPaths: [{ workspaceId: ws1Id, path: "src/config.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      executionSetup: {
        providerId: "GOOGLE",
        modelId: "gemini-3.6-flash",
        executionChannelId: "GEMINI_CLI",
        reasoningProfile: "Auto",
        runtimeProfileId: "STANDARD",
        modelOverrideAccepted: true,
        modelOverrideReason: "Canonical reason",
      },
    };

    const contractInput = assertContractReadyTaskDraft(draft);
    expect(contractInput.providerId).toBe("GOOGLE");
    expect(contractInput.modelId).toBe("gemini-3.6-flash");
    expect(contractInput.modelOverrideAccepted).toBe(true);
    expect(contractInput.modelOverrideReason).toBe("Canonical reason");
  });
});
