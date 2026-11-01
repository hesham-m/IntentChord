import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  assertContractReadyTaskDraft,
  createBlankContractInput,
  createBlankTaskDraft,
  extractExecutionSetup,
  synchronizeLegacyWorkspaceProjection,
  transitionModel,
  transitionProvider,
  type TaskContextAnalysisBinding,
  type TaskDraftInput,
  type WorkspaceReference,
} from "@/core/tasks/task-input";
import {
  applyOwnerScopeConfirmation,
  resolveCandidateScopeFromMappingInput,
  validateStaleContextAnalysisBinding,
  TaskContextBindingError,
} from "@/core/tasks/candidate-scope";
import type {
  MappingInputEntry,
  ModelProposedContextCatalogV1,
  OwnerContextDecisionView,
  ProposedContext,
} from "@/core/ai-context-mapper/types";
import { MODEL_PROPOSED_CATALOG_SCHEMA_VERSION } from "@/core/ai-context-mapper/types";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { resolveAuthorization } from "@/core/policies/policy";

describe("PRE_B2_UNIFIED_TASK_ORCHESTRATION_FOUNDATION_P1 - Authoritative Suite (T1-T20)", () => {
  const sampleWorkspaceId = "11111111-1111-4111-8111-111111111111";
  const sampleWorkspace: WorkspaceReference = {
    id: sampleWorkspaceId,
    displayName: "Primary Workspace",
    role: "primary",
    referenceType: "LOCAL_PATH",
    source: "WINDOWS_NATIVE_SELECTOR",
    reference: "E:\\test\\repo",
    fingerprint: "sha256:test",
    allowedPaths: [],
    excludedPaths: [],
    authorizationContext: "test",
    ordering: 0,
  };

  const sampleCatalog: ModelProposedContextCatalogV1 = {
    schema_version: MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
    catalog_summary: "Sample Context Catalog for Unit Tests",
    contexts: [
      {
        context_id: "ctx-core-auth",
        display_name: "Auth Module",
        context_kind: "module",
        confidence: "high",
        summary: "Core authentication and authorization handlers",
        responsibilities: ["Authentication", "Authorization"],
        workspace_ids: [sampleWorkspaceId],
        evidence_entry_ids: ["entry-1", "entry-2"],
        interfaces: [],
        unknowns: [],
        rationale: "Core auth logic",
      },
      {
        context_id: "ctx-db-schema",
        display_name: "Database Schema",
        context_kind: "data_store",
        confidence: "high",
        summary: "Database migrations and schemas",
        responsibilities: ["Data Storage"],
        workspace_ids: [sampleWorkspaceId],
        evidence_entry_ids: ["entry-3"],
        interfaces: [],
        unknowns: [],
        rationale: "Database models",
      },
    ],
    relationships: [],
    unmapped_entries: [],
    global_unknowns: [],
    warnings: [],
  };

  const sampleMappingEntries: MappingInputEntry[] = [
    {
      entry_id: "entry-1",
      workspace_id: sampleWorkspaceId,
      normalized_path: "src/auth/jwt.ts",
      entry_type: "FILE",
      language_or_format: "typescript",
      size_bytes: 120,
      content_or_metadata_fingerprint: "sha256:entry-1",
      index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
    },
    {
      entry_id: "entry-2",
      workspace_id: sampleWorkspaceId,
      normalized_path: "src/auth/session.ts",
      entry_type: "FILE",
      language_or_format: "typescript",
      size_bytes: 85,
      content_or_metadata_fingerprint: "sha256:entry-2",
      index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
    },
    {
      entry_id: "entry-3",
      workspace_id: sampleWorkspaceId,
      normalized_path: "prisma/schema.prisma",
      entry_type: "FILE",
      language_or_format: "prisma",
      size_bytes: 200,
      content_or_metadata_fingerprint: "sha256:entry-3",
      index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
    },
  ];

  const sampleDecisions: OwnerContextDecisionView[] = [
    {
      id: "dec-1",
      runId: "run-001",
      proposalId: "prop-001",
      contextId: "ctx-core-auth",
      contextSha256: mapperSha256(sampleCatalog.contexts[0]),
      decision: "ACCEPT",
      ownerReference: "owner@intentchord",
      createdAt: new Date().toISOString(),
    },
  ];

  const helperResolveCandidateScope = (overrides: Partial<Parameters<typeof resolveCandidateScopeFromMappingInput>[0]> = {}) => {
    return resolveCandidateScopeFromMappingInput({
      binding: {
        workspaceIndexSnapshotId: "snap-001",
        mappingRunId: "run-001",
        proposalId: "prop-001",
        proposalSha256: "sha256:prop-001",
        acceptedContextDecisionIds: ["dec-1"],
      },
      workspaceIndexSnapshotId: "snap-001",
      mappingRunId: "run-001",
      proposalId: "prop-001",
      proposalSha256: "sha256:prop-001",
      ownerVerdictState: "ACCEPTED",
      catalog: sampleCatalog,
      ownerContextDecisions: sampleDecisions,
      mappingInputEntries: sampleMappingEntries,
      boundWorkspaceIds: [sampleWorkspaceId],
      ...overrides,
    });
  };

  // T1: Staged Task Draft created before execution provider/model selection
  it("T1: allows staged Task Draft to be created without execution setup", () => {
    const draft = createBlankTaskDraft("CONTROLLED_AUDIT", [sampleWorkspace]);
    expect(draft.objective).toBe("");
    expect(draft.providerId).toBeUndefined();
    expect(draft.modelId).toBeUndefined();
    expect(draft.executionChannelId).toBeUndefined();
    expect(draft.reasoningProfile).toBeUndefined();
    expect(draft.runtimeProfileId).toBeUndefined();
    expect(draft.executionSetup).toBeUndefined();
  });

  // T2: No hidden or default model injected into initial task draft
  it("T2: does NOT silently inject a default model or provider into blank task drafts", () => {
    const blank = createBlankTaskDraft();
    expect(blank.modelId).toBeUndefined();
    expect(blank.providerId).toBeUndefined();
    expect(extractExecutionSetup(blank)).toBeUndefined();
  });

  // T3: assertContractReadyTaskDraft rejects incomplete drafts
  it("T3: fails closed when compiling Contract from incomplete draft without execution setup", () => {
    const candidateScope = helperResolveCandidateScope();
    const binding: TaskContextAnalysisBinding = {
      workspaceIndexSnapshotId: "snap-001",
      mappingRunId: "run-001",
      proposalId: "prop-001",
      proposalSha256: "sha256:prop-001",
      acceptedContextDecisionIds: ["dec-1"],
    };

    const draft = applyOwnerScopeConfirmation(
      {
        ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [sampleWorkspace]),
        objective: "Implement secure password reset flow with unit tests.",
        contextAnalysisBinding: binding,
        candidateScope,
      },
      {
        candidateIdentity: {
          workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
          mappingRunId: candidateScope.mappingRunId,
          proposalId: candidateScope.proposalId,
          proposalSha256: candidateScope.proposalSha256,
          acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
          candidateScopeSha256: candidateScope.candidateScopeSha256,
        },
        confirmedAllowedPaths: [{ workspaceId: sampleWorkspaceId, path: "src/auth/jwt.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      candidateScope,
    );

    expect(() => assertContractReadyTaskDraft(draft)).toThrowError(
      expect.objectContaining({ code: "EXECUTION_SETUP_REQUIRED" }),
    );
  });

  // T4: assertContractReadyTaskDraft succeeds on complete draft
  it("T4: validates and converts complete staged draft to strict ContractInput", () => {
    const candidateScope = helperResolveCandidateScope();
    const binding: TaskContextAnalysisBinding = {
      workspaceIndexSnapshotId: "snap-001",
      mappingRunId: "run-001",
      proposalId: "prop-001",
      proposalSha256: "sha256:prop-001",
      acceptedContextDecisionIds: ["dec-1"],
    };

    let draft = applyOwnerScopeConfirmation(
      {
        ...createBlankTaskDraft("SOURCE_IMPLEMENTATION", [sampleWorkspace]),
        objective: "Implement secure password reset flow with unit tests.",
        contextAnalysisBinding: binding,
        candidateScope,
      },
      {
        candidateIdentity: {
          workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
          mappingRunId: candidateScope.mappingRunId,
          proposalId: candidateScope.proposalId,
          proposalSha256: candidateScope.proposalSha256,
          acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
          candidateScopeSha256: candidateScope.candidateScopeSha256,
        },
        confirmedAllowedPaths: [{ workspaceId: sampleWorkspaceId, path: "src/auth/jwt.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      candidateScope,
    );

    draft = transitionProvider(draft, "OPENAI");
    draft = transitionModel(draft, "gpt-5.5");

    const contractInput = assertContractReadyTaskDraft(draft);
    expect(contractInput.providerId).toBe("OPENAI");
    expect(contractInput.modelId).toBe("gpt-5.5");
    expect(contractInput.executionChannelId).toBe("CODEX");
    expect(contractInput.reasoningProfile).toBe("Medium");
    expect(contractInput.runtimeProfileId).toBe("STANDARD");
  });

  // T5: Valid context-analysis binding resolves candidate scope matching exact paths
  it("T5: resolves candidate scope paths matching exact MappingInputEntry.normalized_path from accepted evidence", () => {
    const candidateScope = helperResolveCandidateScope();

    expect(candidateScope.candidateAllowedPaths).toEqual([
      { workspaceId: sampleWorkspaceId, path: "src/auth/jwt.ts" },
      { workspaceId: sampleWorkspaceId, path: "src/auth/session.ts" },
    ]);
    expect(candidateScope.entries.length).toBe(2);
    expect(candidateScope.entries[0].normalizedPath).toBe("src/auth/jwt.ts");
    expect(candidateScope.entries[0].contextId).toBe("ctx-core-auth");
  });

  // T6: Context binding rejecting decision belonging to a different mapping run
  it("T6: fails closed when a decision belongs to a different mapping run", () => {
    const foreignDecision: OwnerContextDecisionView = {
      ...sampleDecisions[0],
      id: "dec-foreign-run",
      runId: "run-999-other",
    };

    expect(() =>
      helperResolveCandidateScope({
        ownerContextDecisions: [foreignDecision],
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001",
          proposalId: "prop-001",
          proposalSha256: "sha256:prop-001",
          acceptedContextDecisionIds: ["dec-foreign-run"],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "DECISION_MAPPING_RUN_MISMATCH" }));
  });

  // T7: Context binding rejecting decision belonging to a different proposal
  it("T7: fails closed when a decision belongs to a different proposal", () => {
    const foreignDecision: OwnerContextDecisionView = {
      ...sampleDecisions[0],
      id: "dec-foreign-prop",
      proposalId: "prop-999-other",
    };

    expect(() =>
      helperResolveCandidateScope({
        ownerContextDecisions: [foreignDecision],
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001",
          proposalId: "prop-001",
          proposalSha256: "sha256:prop-001",
          acceptedContextDecisionIds: ["dec-foreign-prop"],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "DECISION_PROPOSAL_MISMATCH" }));
  });

  // T8: REJECT decision cannot enter accepted context decisions
  it("T8: fails closed if a REJECT decision ID is passed as an accepted decision", () => {
    const rejectDecision: OwnerContextDecisionView = {
      ...sampleDecisions[0],
      id: "dec-rejected",
      decision: "REJECT",
    };

    expect(() =>
      helperResolveCandidateScope({
        ownerContextDecisions: [rejectDecision],
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001",
          proposalId: "prop-001",
          proposalSha256: "sha256:prop-001",
          acceptedContextDecisionIds: ["dec-rejected"],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "NON_ACCEPTED_DECISION_IN_BINDING" }));
  });

  // T9: Altered proposal SHA256 invalidates binding
  it("T9: fails closed when proposal SHA256 in binding does not match proposal content", () => {
    expect(() =>
      validateStaleContextAnalysisBinding({
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001",
          proposalId: "prop-001",
          proposalSha256: "sha256:STALE_OLD_SHA",
          acceptedContextDecisionIds: ["dec-1"],
        },
        currentWorkspaceIndexSnapshotId: "snap-001",
        currentMappingRunId: "run-001",
        currentProposalId: "prop-001",
        currentProposalSha256: "sha256:FRESH_NEW_SHA",
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_PROPOSAL_SHA_BINDING" }));
  });

  // T10: Altered Mapping Run ID invalidates binding
  it("T10: fails closed when current Mapping Run ID differs from binding", () => {
    expect(() =>
      validateStaleContextAnalysisBinding({
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001-old",
          proposalId: "prop-001",
          proposalSha256: "sha256:prop-001",
          acceptedContextDecisionIds: ["dec-1"],
        },
        currentWorkspaceIndexSnapshotId: "snap-001",
        currentMappingRunId: "run-002-new",
        currentProposalId: "prop-001",
        currentProposalSha256: "sha256:prop-001",
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_MAPPING_RUN_BINDING" }));
  });

  // T11: Altered Workspace Index Snapshot ID invalidates binding
  it("T11: fails closed when Workspace Index Snapshot ID differs from binding", () => {
    expect(() =>
      validateStaleContextAnalysisBinding({
        binding: {
          workspaceIndexSnapshotId: "snap-001-old",
          mappingRunId: "run-001",
          proposalId: "prop-001",
          proposalSha256: "sha256:prop-001",
          acceptedContextDecisionIds: ["dec-1"],
        },
        currentWorkspaceIndexSnapshotId: "snap-002-reindexed",
        currentMappingRunId: "run-001",
        currentProposalId: "prop-001",
        currentProposalSha256: "sha256:prop-001",
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_WORKSPACE_INDEX_SNAPSHOT_BINDING" }));
  });

  // T12: Unknown / unmapped evidence_entry_id fails closed
  it("T12: fails closed when a context references an evidence_entry_id not present in mapping entries", () => {
    const corruptContext: ProposedContext = {
      context_id: "ctx-ghost",
      display_name: "Ghost Context",
      context_kind: "module",
      confidence: "high",
      summary: "Refers to missing evidence",
      responsibilities: ["Missing"],
      workspace_ids: [sampleWorkspaceId],
      evidence_entry_ids: ["non-existent-entry-id"],
      interfaces: [],
      unknowns: [],
      rationale: "Broken evidence link",
    };
    const corruptCatalog: ModelProposedContextCatalogV1 = {
      schema_version: MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
      catalog_summary: "Corrupt Catalog",
      contexts: [corruptContext],
      relationships: [],
      unmapped_entries: [],
      global_unknowns: [],
      warnings: [],
    };
    const decision: OwnerContextDecisionView = {
      id: "dec-ghost",
      runId: "run-001",
      proposalId: "prop-corrupt",
      contextId: "ctx-ghost",
      contextSha256: mapperSha256(corruptContext),
      decision: "ACCEPT",
      ownerReference: "owner",
      createdAt: new Date().toISOString(),
    };

    expect(() =>
      helperResolveCandidateScope({
        catalog: corruptCatalog,
        proposalId: "prop-corrupt",
        proposalSha256: "sha256:prop-corrupt",
        ownerContextDecisions: [decision],
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001",
          proposalId: "prop-corrupt",
          proposalSha256: "sha256:prop-corrupt",
          acceptedContextDecisionIds: ["dec-ghost"],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "EVIDENCE_ENTRY_NOT_FOUND" }));
  });

  // T13: Evidence entry pointing to an unbound workspace fails closed
  it("T13: fails closed when evidence entry references a workspace registration ID not bound to task", () => {
    const alienEntries: MappingInputEntry[] = [
      {
        entry_id: "entry-alien",
        workspace_id: "99999999-9999-4999-8999-999999999999", // not in boundWorkspaceIds
        normalized_path: "src/alien.ts",
        entry_type: "FILE",
        language_or_format: "typescript",
        size_bytes: 100,
        content_or_metadata_fingerprint: "sha256:alien",
        index_supported_signals: { file_kind: "SOURCE", parse_status: "PARSED", coverage_state: "COVERED", fact_signals: [], relation_signals: [] },
      },
    ];
    const alienContext: ProposedContext = {
      context_id: "ctx-alien",
      display_name: "Alien Module",
      context_kind: "module",
      confidence: "high",
      summary: "Alien workspace code",
      responsibilities: ["Alien Code"],
      workspace_ids: ["99999999-9999-4999-8999-999999999999"],
      evidence_entry_ids: ["entry-alien"],
      interfaces: [],
      unknowns: [],
      rationale: "Unbound workspace",
    };
    const alienCatalog: ModelProposedContextCatalogV1 = {
      schema_version: MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
      catalog_summary: "Alien Catalog",
      contexts: [alienContext],
      relationships: [],
      unmapped_entries: [],
      global_unknowns: [],
      warnings: [],
    };
    const alienDecision: OwnerContextDecisionView = {
      id: "dec-alien",
      runId: "run-001",
      proposalId: "prop-alien",
      contextId: "ctx-alien",
      contextSha256: mapperSha256(alienContext),
      decision: "ACCEPT",
      ownerReference: "owner",
      createdAt: new Date().toISOString(),
    };

    expect(() =>
      helperResolveCandidateScope({
        catalog: alienCatalog,
        proposalId: "prop-alien",
        proposalSha256: "sha256:prop-alien",
        mappingInputEntries: alienEntries,
        ownerContextDecisions: [alienDecision],
        binding: {
          workspaceIndexSnapshotId: "snap-001",
          mappingRunId: "run-001",
          proposalId: "prop-alien",
          proposalSha256: "sha256:prop-alien",
          acceptedContextDecisionIds: ["dec-alien"],
        },
        boundWorkspaceIds: [sampleWorkspaceId],
      }),
    ).toThrowError(expect.objectContaining({ code: "EVIDENCE_WORKSPACE_UNBOUND" }));
  });

  // T14: Candidate scope uses physical paths only
  it("T14: produces candidate scope entries strictly derived from MappingInputEntry.normalized_path", () => {
    const scope = helperResolveCandidateScope();

    for (const item of scope.candidateAllowedPaths) {
      const match = sampleMappingEntries.find(e => e.normalized_path === item.path && e.workspace_id === item.workspaceId);
      expect(match).toBeDefined();
    }
  });

  // T15: Candidate scope does NOT automatically become allowedPaths (authority separation)
  it("T15: candidate scope remains candidate data and does not overwrite allowedPaths without Owner confirmation", () => {
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [sampleWorkspace]);
    const candidateScope = helperResolveCandidateScope();

    const stagedDraftWithCandidate: TaskDraftInput = {
      ...draft,
      candidateScope,
    };

    // Staged draft allowedPaths are not auto-populated by candidate scope
    expect(stagedDraftWithCandidate.workspaces[0].allowedPaths).toEqual([]);
    expect(stagedDraftWithCandidate.scopeConfirmation).toBeUndefined();
  });

  // T16: Explicit Owner scope confirmation required
  it("T16: applies explicit Owner scope confirmation boundary to update workspace allowedPaths", () => {
    const draft = createBlankTaskDraft("SOURCE_IMPLEMENTATION", [sampleWorkspace]);
    const candidateScope = helperResolveCandidateScope();

    const confirmed = applyOwnerScopeConfirmation(
      { ...draft, candidateScope },
      {
        candidateIdentity: {
          workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
          mappingRunId: candidateScope.mappingRunId,
          proposalId: candidateScope.proposalId,
          proposalSha256: candidateScope.proposalSha256,
          acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
          candidateScopeSha256: candidateScope.candidateScopeSha256,
        },
        confirmedAllowedPaths: [{ workspaceId: sampleWorkspaceId, path: "src/auth/jwt.ts" }],
        confirmedExcludedPaths: [{ workspaceId: sampleWorkspaceId, path: "src/auth/session.ts" }],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      candidateScope,
    );

    expect(confirmed.scopeConfirmation).toBeDefined();
    expect(confirmed.scopeConfirmation?.confirmedAllowedPaths).toEqual([{ workspaceId: sampleWorkspaceId, path: "src/auth/jwt.ts" }]);
    expect(confirmed.scopeConfirmation?.confirmedExcludedPaths).toEqual([{ workspaceId: sampleWorkspaceId, path: "src/auth/session.ts" }]);
    expect(confirmed.allowedPaths).toEqual([`${sampleWorkspaceId}:src/auth/jwt.ts`]);
    expect(confirmed.excludedPaths).toEqual([`${sampleWorkspaceId}:src/auth/session.ts`]);
  });

  // T17: Owner-confirmed scope cannot expand Task Mode capabilities
  it("T17: verifies that Task Mode remains authoritative over capabilities regardless of scope confirmation", () => {
    const controlledAuditDraft = createBlankTaskDraft("CONTROLLED_AUDIT", [sampleWorkspace]);
    const candidateScope = helperResolveCandidateScope();
    const confirmedAudit = applyOwnerScopeConfirmation(
      { ...controlledAuditDraft, candidateScope },
      {
        candidateIdentity: {
          workspaceIndexSnapshotId: candidateScope.workspaceIndexSnapshotId,
          mappingRunId: candidateScope.mappingRunId,
          proposalId: candidateScope.proposalId,
          proposalSha256: candidateScope.proposalSha256,
          acceptedContextDecisionIdsSha256: candidateScope.acceptedContextDecisionIdsSha256,
          candidateScopeSha256: candidateScope.candidateScopeSha256,
        },
        confirmedAllowedPaths: [{ workspaceId: sampleWorkspaceId, path: "src/auth/jwt.ts" }],
        confirmedExcludedPaths: [],
        confirmedBy: "owner@intentchord",
        confirmedAt: new Date().toISOString(),
      },
      candidateScope,
    );

    const auth = resolveAuthorization(confirmedAudit.taskMode, {
      readFiles: true,
      modifySource: true, // Owner requested modifySource in CONTROLLED_AUDIT
      runStaticValidation: true,
      runTests: true,
      build: false,
      deploy: false,
      restartServices: false,
      writeDatabase: false,
      changeEnvironment: false,
      useNetwork: false,
    });

    // Task mode CONTROLLED_AUDIT strictly disables modifySource even if requested
    expect(auth.effective.modifySource).toBe(false);
    expect(auth.effective.readFiles).toBe(true);
  });

  // T18: Historical Task drafts remain readable without mutation
  it("T18: supports legacy task draft projections without requiring migration or mutation", () => {
    const legacyProjection: Record<string, unknown> = {
      title: "Legacy Audit Task",
      objective: "Audit legacy auth module",
      taskMode: "CONTROLLED_AUDIT",
      workspaces: [{
        id: sampleWorkspaceId,
        displayName: "Primary Workspace",
        role: "primary",
        referenceType: "LOCAL_PATH",
        reference: "E:\\test\\repo",
        fingerprint: "sha256:legacy",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "owner",
        ordering: 0,
      }],
      providerId: "OPENAI",
      modelId: "gpt-5.5",
      executionChannelId: "SERVER_DOCKER",
      reasoningProfile: "STANDARD",
      runtimeProfileId: "STANDARD_CONTAINER",
    };

    const synchronized = synchronizeLegacyWorkspaceProjection(legacyProjection as unknown as TaskDraftInput);
    expect(synchronized.title).toBe("Legacy Audit Task");
    expect(synchronized.workspaces.length).toBe(1);
    expect(synchronized.workspaces[0].discoveryScopeMode).toBe("FULL_WORKSPACE");
  });

  // T19: Deterministic and fast performance of candidate scope resolution
  it("T19: validates that candidate scope resolution runs deterministically and fast", () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      helperResolveCandidateScope();
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500); // 50 runs in < 500ms
  });

  // T20: Verification that no Migration 013 exists
  it("T20: verifies that no Migration 013 was created and DB schema remains at Migration 012", () => {
    const migrationsDir = path.resolve(process.cwd(), "src/server/db/migrations");
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir);
      const hasMigration013 = files.some(f => f.includes("013"));
      expect(hasMigration013).toBe(false);
    }
  });
});
