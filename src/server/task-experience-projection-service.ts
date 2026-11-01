import type { RunRecord } from "@/lib/workspace";
import { requiredCheckSatisfactionMode, type RequiredCheck } from "@/core/contracts/execution-contract";
import type { WorkspaceScopedPath } from "@/core/tasks/task-input";
import {
  providerRegistry,
  modelRegistry,
  type ProviderId,
  type ReasoningProfile,
  type RuntimeProfileId,
} from "@/core/providers/registry";
import { compileAgentPromptDiagnostics } from "@/core/prompts/compiler";
import {
  composeTaskExperienceAuthoritySnapshot,
  configuredModelBelongsToProvider,
  type TaskExperienceAuthorityDependencies,
  type TaskExperienceAuthoritySnapshot,
} from "@/server/task-experience-authority-snapshot";

export type WorkspaceScopedDisplayPath = {
  workspaceId: string;
  workspaceDisplayName: string;
  path: string;
};

export interface TaskExperienceProjectionV1 {
  taskSummary: {
    id: string;
    revision: number;
    title: string;
    objective: string;
    taskMode: "CONTROLLED_AUDIT" | "SOURCE_IMPLEMENTATION" | "REPORT_REVIEW";
    taskContext: {
      kind: "INDEPENDENT" | "PROJECT_BOUND";
      projectId?: string;
      projectDisplayName?: string;
      projectRevision?: number;
    };
    createdAt: string;
    updatedAt: string;
  };

  visiblePhase: "UNDERSTAND" | "GOVERN" | "EXECUTE" | "DECIDE";
  phaseStatus:
    | "AWAITING_OBJECTIVE"
    | "WORKSPACE_VERIFYING"
    | "ANALYSIS_READY_TO_START"
    | "INDEXING_AND_MAPPING"
    | "CONTEXT_EVIDENCE_REQUIRED"
    | "CONTEXT_SOURCE_TRUTH_CONFLICT"
    | "CONTEXT_MAPPING_RETRYABLE"
    | "COMPONENTS_READY_FOR_WORK_SELECTION"
    | "STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED"
    | "SOURCE_DRIFT_REBASE_REQUIRED"
    | "CURRENT_CONTEXT_REBUILD_REQUIRED"
    | "SCOPE_DERIVED_AWAITING_CONFIRMATION"
    | "SCOPE_CONFIRMED_AWAITING_PLATFORM"
    | "PLATFORM_SELECTED_CONFIGURATION_RESOLVED_AWAITING_CONTRACT"
    | "CONTRACT_APPROVED_READY_FOR_RUN"
    | "RUN_ACTIVE_EXECUTING"
    | "REPORT_INGESTED_AWAITING_EVALUATION"
    | "VERDICT_READY_AWAITING_OWNER_DECISION"
    | "CORRECTION_REQUESTED"
    | "TASK_CLOSED";

  workspaceSummary: {
    workspaces: Array<{
      id: string;
      displayName: string;
      referencePath: string;
      role: string;
      verificationStatus: "VERIFIED" | "MANUAL_VERIFIED" | "UNVERIFIED" | "STALE";
      sourceFreshness: "FRESH" | "KNOWN_RESTORED" | "CHANGED" | "UNKNOWN";
      fingerprint: string;
      rootAuthorityValid: boolean;
    }>;
  };

  analysisSummary: {
    indexStatus: "IDLE" | "PARTIAL" | "IN_PROGRESS" | "READY" | "FAILED";
    indexProgressPercent?: number;
    mappingStatus: "IDLE" | "PARTIAL" | "IN_PROGRESS" | "COMPLETED" | "REJECTED" | "FAILED";
    mappingAttemptCount: number;
    discoveryCount: number;
    analysisReady: boolean;
    contextClosureState: "NOT_STARTED" | "OPEN" | "BLOCKED" | "PASS";
    contextAssemblyRevision?: number;
    missingEvidenceCount: number;
  };

  contextResolutionSummary: {
    contextAssemblyId?: string;
    contextAssemblyRevisionId?: string;
    contextAssemblyRevision?: number;
    closureState: "NOT_STARTED" | "OPEN" | "BLOCKED" | "PASS";
    missingEvidenceRequests: Array<{
      id: string;
      modelGapId: string;
      classification: "BLOCKING_INTERNAL_SOURCE_GAP" | "EXTERNAL_DEPENDENCY" | "NON_BLOCKING_UNRESOLVED" | "OPTIONAL_CONTEXT_GAP";
      materiality: "BLOCKING" | "NON_BLOCKING";
      description: string;
      requiredEvidenceKind: string;
      sourceHint?: string;
      candidateWorkspaceRegistrationId?: string;
      authorizationDecision?: "APPROVE" | "DENY";
      resolutionState?: "CANDIDATE_SOURCE_IDENTIFIED" | "OWNER_AUTHORIZED_SOURCE" | "OWNER_DENIED_SOURCE" | "SUPERSEDED_BY_NEW_ASSEMBLY" | "SOURCE_UNAVAILABLE" | "CLASSIFIED_NON_BLOCKING";
    }>;
    resolutionRequirements: Array<{
      id: string;
      type: "MISSING_INTERNAL_EVIDENCE" | "SOURCE_TRUTH_CONFLICT";
      mappingIterationId: string;
      lastEvent?: string;
    }>;
  };

  contextAuthoritySummary: {
    status:
      | "NONE"
      | "CURRENT_CONTEXT_READY_FOR_WORK"
      | "CURRENT_WORK_INTENT_AWAITING_SCOPE_CONFIRMATION"
      | "STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED"
      | "SCOPE_CONFIRMED"
      | "SOURCE_DRIFT_REBASE_REQUIRED"
      | "CURRENT_CONTEXT_REBUILD_REQUIRED"
      | "ACTIVE_RUN_ON_FROZEN_AUTHORITY";
    frozenContextAssemblyRevisionId?: string;
    currentHeadRevisionId?: string;
    currentHeadRevision?: number;
    headStatus: "CURRENT" | "SUPERSEDED" | "NONE";
    sourceAuthorityStatus: "CURRENT" | "DRIFT" | "UNPROVEN" | "NOT_APPLICABLE";
  };

  discoveredWorkSummary: {
    components: Array<{
      componentId: string;
      mappingRunId?: string;
      proposalId?: string;
      acceptedCatalogRevisionId?: string;
      workspaceIds: string[];
      name: string;
      responsibilitySummary: string;
      relevantPaths: WorkspaceScopedDisplayPath[];
      fileCount: number;
      isSelectedByOwner: boolean;
    }>;
    totalRelevantFiles: number;
    excludedPathPatterns: WorkspaceScopedDisplayPath[];
  };

  ownerSelectionSummary: {
    selectedContextIds: string[];
    selectedComponentIds: string[];
    customScopeNotes?: string;
    selectionCommitted: boolean;
  };

  candidateScopeSummary: {
    isDerived: boolean;
    identity?:
      | {
          authorityVersion?: "MAPPING_V1";
          workspaceIndexSnapshotId: string;
          mappingRunId: string;
          proposalId: string;
          proposalSha256: string;
          acceptedContextDecisionIdsSha256: string;
          candidateScopeSha256: string;
        }
      | {
          authorityVersion: "CONTEXT_ASSEMBLY_V2";
          contextAssemblyId: string;
          contextAssemblyRevisionId: string;
          mappingIterationId: string;
          closureEvaluationId: string;
          acceptedCatalogRevisionId: string;
          acceptedCatalogSha256: string;
          selectedComponentIdsSha256: string;
          candidateScopeSha256: string;
        };
    allowedPaths: WorkspaceScopedDisplayPath[];
    excludedPaths: WorkspaceScopedDisplayPath[];
    boundaryCount: number;
  };

  effectiveAuthoritySummary: {
    capabilities: Array<{
      capability:
        | "readFiles"
        | "modifySource"
        | "runStaticValidation"
        | "runTests"
        | "build"
        | "deploy"
        | "restartServices"
        | "writeDatabase"
        | "changeEnvironment"
        | "useNetwork";
      label: string;
      isRequested: boolean;
      isEffective: boolean;
      governingPolicyReason: string;
    }>;
  };

  scopeConfirmationSummary: {
    isConfirmed: boolean;
    confirmedAtFormatted?: string;
    confirmedAllowedPaths: WorkspaceScopedDisplayPath[];
    confirmedExcludedPaths: WorkspaceScopedDisplayPath[];
  };

  executionSetupSummary: {
    isConfigured: boolean;
    authoritySource: "NONE" | "DRAFT" | "CONTRACT" | "RUN";
    providerId: "OPENAI" | "ANTHROPIC" | "GOOGLE" | null;
    modelId: string | null;
    executionChannelId: "CODEX" | "CLAUDE_CODE" | "GEMINI_CLI" | null;
    reasoningProfile: ReasoningProfile | null;
    runtimeProfileId: RuntimeProfileId | null;
    modelOverrideAccepted: boolean;
    modelOverrideReason?: string;
  };

  executionOptions: {
    authorityMeaning: "OWNER_SELECTS_PLATFORM_BACKEND_RESOLVES_CONFIGURATION";
    availablePlatforms: Array<{
      executionChannelId: "CODEX" | "CLAUDE_CODE" | "GEMINI_CLI";
      displayName: string;
    }>;
  };

  governedExecutionInstructionsSummary: {
    isGenerated: boolean;
    authoritySource: "NONE" | "CONTRACT_PREVIEW" | "RUN_FROZEN_ARTIFACT";
    instructionsPreview: string;
    byteLength: number;
    locale: "ar" | "en";
  };

  contractSummary: {
    contractId?: string;
    contractRevision?: number;
    ownerApprovalState: "DRAFT" | "AWAITING_OWNER_APPROVAL" | "APPROVED" | "REJECTED" | "CANCELLED";
    mandatoryRequirementsCount: number;
    requiredChecksCount: number;
  };

  runSummary: {
    activeRunId?: string;
    runIndex?: number;
    status: "IDLE" | "PREPARING" | "EXECUTING" | "AWAITING_REPORT" | "EVALUATING" | "COMPLETED";
    elapsedSeconds?: number;
    toolTracesCount: number;
    latestToolCommand?: string;
    reportSubmitted: boolean;
    reportFormat?: "APPLICATION_JSON" | "TEXT_MARKDOWN";
    evidenceReferencesCount: number;
    validationEvidenceCount: number;
    inheritedValidationEvidenceCount: number;
    sourceEvidenceCount: number;
    artifactEvidenceCount: number;
  };

  verdictSummary: {
    isEvaluated: boolean;
    classification?: "PASS" | "EVIDENCE_REQUIRED" | "VIOLATION" | "BLOCKER";
    summaryNote?: string;
    satisfiedChecksCount: number;
    totalChecksCount: number;
    checkLedger: Array<{
      checkId: string;
      title: string;
      status: "SATISFIED" | "UNSATISFIED" | "VIOLATED";
      satisfactionMode: "PRODUCER_EVIDENCE" | "BACKEND_AUTOMATIC" | "TOOL_TRACE";
      proofSnippet?: string;
    }>;
    detectedViolations: string[];
    ownerDecision: "NONE" | "ACCEPTED" | "CORRECTION_REQUESTED" | "ACCEPTED_WITH_OVERRIDE" | "ACKNOWLEDGED" | "REJECTED";
    ownerDecisionNotes?: string;
  };

  primaryAction: {
    actionKey:
      | "START_CONTEXT_ANALYSIS"
      | "RETRY_CONTEXT_MAPPING"
      | "RESOLVE_CONTEXT"
      | "RESOLVE_SOURCE_TRUTH"
      | "COMMIT_WORK_SELECTION"
      | "REBASE_CONTEXT_WORK_SELECTION"
      | "CONFIRM_SCOPE"
      | "SELECT_EXECUTION_PLATFORM"
      | "APPROVE_CONTRACT"
      | "START_RUN"
      | "SUBMIT_REPORT"
      | "EVALUATE_VERDICT"
      | "ACCEPT_DECISION"
      | "REQUEST_CORRECTION";
    labelEn: string;
    labelAr: string;
    availability: "ENABLED" | "DISABLED" | "BUSY" | "COMPLETED";
    disabledReasonEn?: string;
    disabledReasonAr?: string;
  };

  availableOwnerActions: Array<{
    actionKey: string;
    labelEn: string;
    labelAr: string;
    style: "PRIMARY" | "SECONDARY" | "DANGER" | "DRAWER_TRIGGER";
  }>;

  auditDetails: {
    taskId: string;
    databaseTxTime?: string;
    confirmedAtIso?: string;
    confirmedBy?: string;
    candidateScopeSha256?: string;
    acceptedDecisionIdsSha256?: string;
    contractSha256?: string;
    verdictSha256?: string;
    workspaceIndexSnapshotId?: string;
    b1WorkspaceObservationId?: string;
    workspaceRevisionId?: string;
    canonicalIndexArtifactId?: string;
    mappingRunId?: string;
    mappingProposalId?: string;
    contextAssemblyId?: string;
    contextAssemblyRevisionId?: string;
    mappingIterationId?: string;
    contextClosureEvaluationId?: string;
    acceptedCatalogRevisionId?: string;
    reportSubmissionId?: string;
    verdictId?: string;
    ownerDecisionId?: string;
    policyDecisionTraceCount: number;
  };
}

function taskContext(snapshot: TaskExperienceAuthoritySnapshot): TaskExperienceProjectionV1["taskSummary"]["taskContext"] {
  const context = snapshot.task.draft.taskContext;
  if (!context || context.kind === "INDEPENDENT") return { kind: "INDEPENDENT" };
  return {
    kind: "PROJECT_BOUND",
    projectId: context.projectContextId,
    projectDisplayName: context.projectContextDisplayName,
    projectRevision: context.projectContextRevision,
  };
}

function displayNameForWorkspace(snapshot: TaskExperienceAuthoritySnapshot, workspaceId: string): string {
  return snapshot.workspaces.find(item => item.taskWorkspace.id === workspaceId)?.taskWorkspace.displayName ?? workspaceId;
}

function displayPath(snapshot: TaskExperienceAuthoritySnapshot, path: WorkspaceScopedPath): WorkspaceScopedDisplayPath {
  return {
    workspaceId: path.workspaceId,
    workspaceDisplayName: displayNameForWorkspace(snapshot, path.workspaceId),
    path: path.path,
  };
}

function sourceFreshness(item: TaskExperienceAuthoritySnapshot["workspaces"][number]): TaskExperienceProjectionV1["workspaceSummary"]["workspaces"][number]["sourceFreshness"] {
  const observation = item.latestIndex?.observationResult;
  if (observation === "KNOWN_STATE_RESTORED") return "KNOWN_RESTORED";
  if (observation === "SOURCE_CHANGED") return "CHANGED";
  if (observation === "FIRST_INDEXED" || observation === "SOURCE_UNCHANGED" || observation === "SOURCE_UNCHANGED_INDEX_REFRESHED") return "FRESH";
  return "UNKNOWN";
}

function workspaceVerificationStatus(item: TaskExperienceAuthoritySnapshot["workspaces"][number]): TaskExperienceProjectionV1["workspaceSummary"]["workspaces"][number]["verificationStatus"] {
  const registration = item.registration;
  if (!registration) return "UNVERIFIED";
  if (registration.verificationStatus === "STALE" || registration.verificationStatus === "FAILED") return "STALE";
  if (registration.verificationStatus !== "VERIFIED") return "UNVERIFIED";
  return registration.source === "MANUAL_VERIFIED" ? "MANUAL_VERIFIED" : "VERIFIED";
}

function rootAuthorityValid(item: TaskExperienceAuthoritySnapshot["workspaces"][number]): boolean {
  return item.registration?.verificationStatus === "VERIFIED"
    && item.registration.rootAuthorityState === "VERIFIED_MATCH";
}

function indexStatus(snapshot: TaskExperienceAuthoritySnapshot): TaskExperienceProjectionV1["analysisSummary"]["indexStatus"] {
  if (!snapshot.workspaces.length) return "IDLE";
  const latest = snapshot.workspaces.map(item => item.latestIndex);
  if (latest.some(item => item?.status === "FAILED")) return "FAILED";
  if (latest.some(item => item?.status === "CREATING")) return "IN_PROGRESS";
  const readyCount = latest.filter(item => item?.status === "READY").length;
  if (readyCount === snapshot.workspaces.length) return "READY";
  if (readyCount > 0) return "PARTIAL";
  return "IDLE";
}

function mappingRunStatus(run: NonNullable<TaskExperienceAuthoritySnapshot["currentAnalyses"][number]["mappingRun"]>): "IN_PROGRESS" | "COMPLETED" | "REJECTED" | "FAILED" {
  if (["AWAITING_OWNER_REVIEW", "OWNER_ACCEPTED"].includes(run.status)) return "COMPLETED";
  if (run.status === "OWNER_REJECTED") return "REJECTED";
  if (["REJECTED_VALIDATION", "FAILED", "STANDBY_BLOCKED_GOVERNANCE"].includes(run.status)) return "FAILED";
  if (run.status === "PRIMARY_FAILED_TECHNICAL" && !run.standbyEnabled) return "FAILED";
  return "IN_PROGRESS";
}

function analysesForPresentation(snapshot: TaskExperienceAuthoritySnapshot) {
  if (snapshot.candidateScope && snapshot.boundAnalysis) return [snapshot.boundAnalysis];
  return snapshot.currentAnalyses;
}

function mappingStatus(snapshot: TaskExperienceAuthoritySnapshot): TaskExperienceProjectionV1["analysisSummary"]["mappingStatus"] {
  if (snapshot.task.draft.orchestrationVersion === "UNIFIED_V1" && snapshot.contextClosure) {
    if (snapshot.contextClosure.state === "MAPPING") return "IN_PROGRESS";
    if (snapshot.contextClosure.state === "MAPPING_RETRYABLE") return "FAILED";
    const status = snapshot.contextClosure.latestMappingRun?.status;
    if (status === "ANALYSIS_COMPLETE" || status === "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE") return "COMPLETED";
    if (status === "REJECTED_VALIDATION") return "REJECTED";
    if (status === "FAILED" || status === "STANDBY_BLOCKED_GOVERNANCE" || status === "PRIMARY_FAILED_TECHNICAL") return "FAILED";
    return status ? "IN_PROGRESS" : "IDLE";
  }
  const analyses = analysesForPresentation(snapshot);
  const runs = analyses.flatMap(analysis => analysis.mappingRun ? [analysis.mappingRun] : []);
  if (!runs.length) return "IDLE";
  const statuses = runs.map(mappingRunStatus);
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("REJECTED")) return "REJECTED";
  if (statuses.includes("IN_PROGRESS")) return "IN_PROGRESS";

  if (!snapshot.candidateScope) {
    const readyWorkspaceIds = new Set(snapshot.workspaces
      .filter(item => item.latestIndex?.status === "READY")
      .map(item => item.taskWorkspace.id));
    const completedWorkspaceIds = new Set(analyses
      .filter(analysis => analysis.mappingRun && mappingRunStatus(analysis.mappingRun) === "COMPLETED")
      .map(analysis => analysis.workspaceId));
    if ([...readyWorkspaceIds].some(workspaceId => !completedWorkspaceIds.has(workspaceId))) return "PARTIAL";
  }
  return "COMPLETED";
}

function resolvedSelectedContextIds(snapshot: TaskExperienceAuthoritySnapshot): string[] {
  const binding = snapshot.boundAnalysis?.binding;
  if (!binding) return [];
  const byId = new Map(snapshot.ownerContextDecisions.map(decision => [decision.id, decision]));
  const selected: string[] = [];
  for (const decisionId of binding.acceptedContextDecisionIds) {
    const decision = byId.get(decisionId);
    if (!decision || decision.decision !== "ACCEPT") continue;
    if (!selected.includes(decision.contextId)) selected.push(decision.contextId);
  }
  return selected;
}

function resolvedSelectedComponentIds(snapshot: TaskExperienceAuthoritySnapshot): string[] {
  const scope = snapshot.candidateScope;
  if (!scope || scope.authorityVersion !== "CONTEXT_ASSEMBLY_V2") return [];
  return [...new Set(scope.entries.map(entry => "componentId" in entry ? entry.componentId : "").filter(Boolean))].sort();
}

function runStatus(run: RunRecord | undefined): TaskExperienceProjectionV1["runSummary"]["status"] {
  if (!run) return "IDLE";
  if (run.status === "AWAITING_REPORT") return "AWAITING_REPORT";
  if (run.status === "REPORT_RECEIVED") return "EVALUATING";
  return "COMPLETED";
}

export function computeTaskExperienceProjection(
  snapshot: TaskExperienceAuthoritySnapshot,
  locale: "ar" | "en" = "ar",
): TaskExperienceProjectionV1 {
  const task = snapshot.task;
  const draft = task.draft;
  const activeRun = snapshot.activeRun;
  const isCandidateScopeDerived = Boolean(snapshot.candidateScope?.candidateAllowedPaths.length);
  const isScopeConfirmed = Boolean(snapshot.scopeConfirmation);
  const selectedSetup = snapshot.execution.setup;
  const isExecutionPlatformResolved = isScopeConfirmed
    && selectedSetup !== undefined
    && configuredModelBelongsToProvider(selectedSetup.modelId, selectedSetup.providerId)
    && providerRegistry[selectedSetup.providerId].executionChannelId === selectedSetup.executionChannelId;
  const isContractApproved = task.contract?.ownerApproval.state === "APPROVED";
  const currentIndexStatus = indexStatus(snapshot);
  const currentMappingStatus = mappingStatus(snapshot);
  const presentationAnalyses = analysesForPresentation(snapshot);
  const proposalAuthorities = presentationAnalyses.flatMap(analysis => {
    const proposal = analysis.mappingRun?.proposal;
    if (!analysis.mappingRun || !proposal) return [];
    return [{ analysis, run: analysis.mappingRun, proposal }];
  });
  const unifiedContextClosure = draft.orchestrationVersion === "UNIFIED_V1" ? snapshot.contextClosure : undefined;
  const acceptedCatalogAuthority = unifiedContextClosure?.closureState === "PASS" ? unifiedContextClosure.acceptedCatalog : undefined;
  const discoveryCount = draft.orchestrationVersion === "UNIFIED_V1"
    ? acceptedCatalogAuthority?.catalog.components.length ?? 0
    : proposalAuthorities.reduce((total, authority) => total + authority.proposal.modelProposal.contexts.length, 0);
  const analysisReady = draft.orchestrationVersion === "UNIFIED_V1"
    ? Boolean(unifiedContextClosure?.closureState === "PASS" && acceptedCatalogAuthority && discoveryCount > 0)
    : currentMappingStatus === "COMPLETED"
      && presentationAnalyses.length > 0
      && proposalAuthorities.length === presentationAnalyses.length
      && discoveryCount > 0;
  const allWorkspacesVerified = snapshot.workspaces.length > 0 && snapshot.workspaces.every(rootAuthorityValid);
  const contextForwardAuthority = snapshot.contextForwardAuthority;
  const currentContextForwardAuthority = snapshot.currentContextForwardAuthority;
  const frozenContextAuthorityStale = contextForwardAuthority.headStatus === "SUPERSEDED"
    || contextForwardAuthority.sourceAuthorityStatus === "DRIFT"
    || contextForwardAuthority.sourceAuthorityStatus === "UNPROVEN";
  const currentContextAuthorityStale = currentContextForwardAuthority.headStatus === "SUPERSEDED"
    || currentContextForwardAuthority.sourceAuthorityStatus === "DRIFT"
    || currentContextForwardAuthority.sourceAuthorityStatus === "UNPROVEN";
  const currentContextAuthorityCurrent = currentContextForwardAuthority.headStatus === "CURRENT"
    && currentContextForwardAuthority.sourceAuthorityStatus === "CURRENT";
  const pendingCorrectionRun = [...task.runs]
    .filter(run => run.decision === "CORRECTION_REQUESTED" && !run.correctionStarted)
    .sort((a, b) => b.round - a.round)[0];

  let visiblePhase: TaskExperienceProjectionV1["visiblePhase"] = "UNDERSTAND";
  let phaseStatus: TaskExperienceProjectionV1["phaseStatus"] = "AWAITING_OBJECTIVE";

  if (activeRun?.verdict) {
    visiblePhase = "DECIDE";
    if (!activeRun.decision || activeRun.decision === "NONE") phaseStatus = "VERDICT_READY_AWAITING_OWNER_DECISION";
    else if (activeRun.decision === "CORRECTION_REQUESTED") phaseStatus = "CORRECTION_REQUESTED";
    else phaseStatus = "TASK_CLOSED";
  } else if (activeRun?.status === "REPORT_RECEIVED") {
    visiblePhase = "EXECUTE";
    phaseStatus = "REPORT_INGESTED_AWAITING_EVALUATION";
  } else if (activeRun) {
    // A started Run remains frozen to its exact approved authority even if current Context later advances.
    visiblePhase = "EXECUTE";
    phaseStatus = "RUN_ACTIVE_EXECUTING";
  } else if (pendingCorrectionRun && frozenContextAuthorityStale) {
    visiblePhase = "GOVERN";
    phaseStatus = analysisReady && currentContextAuthorityCurrent
      ? "SOURCE_DRIFT_REBASE_REQUIRED"
      : "CURRENT_CONTEXT_REBUILD_REQUIRED";
  } else if (pendingCorrectionRun && isScopeConfirmed && isContractApproved) {
    visiblePhase = "EXECUTE";
    phaseStatus = "CORRECTION_REQUESTED";
  } else if (!isCandidateScopeDerived && !isScopeConfirmed && currentContextAuthorityStale && unifiedContextClosure) {
    // Historical Catalog/Requirements remain visible, but stale/unproven Context cannot expose
    // NEW Work Selection or Source Authorization authority.
    visiblePhase = "UNDERSTAND";
    phaseStatus = "CURRENT_CONTEXT_REBUILD_REQUIRED";
  } else if (isScopeConfirmed && frozenContextAuthorityStale) {
    visiblePhase = "GOVERN";
    phaseStatus = "SOURCE_DRIFT_REBASE_REQUIRED";
  } else if (isCandidateScopeDerived && frozenContextAuthorityStale) {
    visiblePhase = "GOVERN";
    phaseStatus = "STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED";
  } else if (isContractApproved) {
    visiblePhase = "EXECUTE";
    phaseStatus = "CONTRACT_APPROVED_READY_FOR_RUN";
  } else if (isScopeConfirmed) {
    visiblePhase = isExecutionPlatformResolved ? "EXECUTE" : "GOVERN";
    phaseStatus = isExecutionPlatformResolved
      ? "PLATFORM_SELECTED_CONFIGURATION_RESOLVED_AWAITING_CONTRACT"
      : "SCOPE_CONFIRMED_AWAITING_PLATFORM";
  } else if (isCandidateScopeDerived) {
    visiblePhase = "GOVERN";
    phaseStatus = "SCOPE_DERIVED_AWAITING_CONFIRMATION";
  } else if (!draft.objective?.trim() || !snapshot.workspaces.length) {
    phaseStatus = "AWAITING_OBJECTIVE";
  } else if (!allWorkspacesVerified) {
    phaseStatus = "WORKSPACE_VERIFYING";
  } else if (draft.orchestrationVersion === "UNIFIED_V1" && unifiedContextClosure && currentContextAuthorityStale) {
    phaseStatus = "CURRENT_CONTEXT_REBUILD_REQUIRED";
  } else if (draft.orchestrationVersion === "UNIFIED_V1" && unifiedContextClosure?.state === "MAPPING_RETRYABLE") {
    phaseStatus = "CONTEXT_MAPPING_RETRYABLE";
  } else if (draft.orchestrationVersion === "UNIFIED_V1" && unifiedContextClosure?.state === "SOURCE_TRUTH_CONFLICT") {
    phaseStatus = "CONTEXT_SOURCE_TRUTH_CONFLICT";
  } else if (draft.orchestrationVersion === "UNIFIED_V1" && unifiedContextClosure
    && unifiedContextClosure.closureState !== "PASS"
    && (unifiedContextClosure.state === "EVIDENCE_REQUIRED" || unifiedContextClosure.state === "BLOCKED" || unifiedContextClosure.closureState === "BLOCKED")) {
    phaseStatus = "CONTEXT_EVIDENCE_REQUIRED";
  } else if (currentIndexStatus === "IN_PROGRESS" || currentMappingStatus === "IN_PROGRESS" || unifiedContextClosure?.state === "MAPPING") {
    phaseStatus = "INDEXING_AND_MAPPING";
  } else if (analysisReady) {
    phaseStatus = "COMPONENTS_READY_FOR_WORK_SELECTION";
  } else {
    phaseStatus = "ANALYSIS_READY_TO_START";
  }

  const contextAuthoritySummary: TaskExperienceProjectionV1["contextAuthoritySummary"] = {
    status: activeRun
      ? "ACTIVE_RUN_ON_FROZEN_AUTHORITY"
      : isScopeConfirmed && frozenContextAuthorityStale
        ? "SOURCE_DRIFT_REBASE_REQUIRED"
        : isCandidateScopeDerived && frozenContextAuthorityStale
          ? "STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED"
          : !isCandidateScopeDerived && !isScopeConfirmed && currentContextAuthorityStale && unifiedContextClosure
            ? "CURRENT_CONTEXT_REBUILD_REQUIRED"
          : isScopeConfirmed
            ? "SCOPE_CONFIRMED"
            : isCandidateScopeDerived
              ? "CURRENT_WORK_INTENT_AWAITING_SCOPE_CONFIRMATION"
              : analysisReady
                ? "CURRENT_CONTEXT_READY_FOR_WORK"
                : "NONE",
    ...(contextForwardAuthority.frozenContextAssemblyRevisionId ? { frozenContextAssemblyRevisionId: contextForwardAuthority.frozenContextAssemblyRevisionId } : {}),
    ...(contextForwardAuthority.currentHeadRevisionId ? { currentHeadRevisionId: contextForwardAuthority.currentHeadRevisionId } : {}),
    ...(contextForwardAuthority.currentHeadRevision !== undefined ? { currentHeadRevision: contextForwardAuthority.currentHeadRevision } : {}),
    headStatus: contextForwardAuthority.headStatus,
    sourceAuthorityStatus: contextForwardAuthority.sourceAuthorityStatus,
  };

  const workspaceSummary: TaskExperienceProjectionV1["workspaceSummary"] = {
    workspaces: snapshot.workspaces.map(item => ({
      id: item.taskWorkspace.id,
      displayName: item.registration?.displayName ?? item.taskWorkspace.displayName,
      referencePath: item.registration?.reference ?? item.taskWorkspace.reference,
      role: item.registration?.role ?? item.taskWorkspace.role,
      verificationStatus: workspaceVerificationStatus(item),
      sourceFreshness: sourceFreshness(item),
      fingerprint: item.registration?.fingerprint ?? item.taskWorkspace.fingerprint,
      rootAuthorityValid: rootAuthorityValid(item),
    })),
  };

  const analysisSummary: TaskExperienceProjectionV1["analysisSummary"] = {
    indexStatus: currentIndexStatus,
    mappingStatus: currentMappingStatus,
    mappingAttemptCount: draft.orchestrationVersion === "UNIFIED_V1"
      ? (unifiedContextClosure?.latestMappingRun ? 1 : 0)
      : presentationAnalyses.reduce((total, analysis) => total + analysis.mappingAttempts.length, 0),
    discoveryCount,
    analysisReady,
    contextClosureState: unifiedContextClosure?.closureState ?? (draft.orchestrationVersion === "UNIFIED_V1" ? "NOT_STARTED" : "NOT_STARTED"),
    ...(unifiedContextClosure ? { contextAssemblyRevision: unifiedContextClosure.revision } : {}),
    missingEvidenceCount: unifiedContextClosure?.missingEvidenceRequests.length ?? 0,
  };

  const contextResolutionSummary: TaskExperienceProjectionV1["contextResolutionSummary"] = {
    ...(unifiedContextClosure ? {
      contextAssemblyId: unifiedContextClosure.contextAssemblyId,
      contextAssemblyRevisionId: unifiedContextClosure.revisionId,
      contextAssemblyRevision: unifiedContextClosure.revision,
    } : {}),
    closureState: unifiedContextClosure?.closureState ?? "NOT_STARTED",
    missingEvidenceRequests: unifiedContextClosure?.missingEvidenceRequests.map(request => ({ ...request })) ?? [],
    resolutionRequirements: unifiedContextClosure?.resolutionRequirements.map(requirement => ({ ...requirement })) ?? [],
  };

  const selectedContextIds = resolvedSelectedContextIds(snapshot);
  const selectedComponentIds = resolvedSelectedComponentIds(snapshot);
  const discoveredComponents: TaskExperienceProjectionV1["discoveredWorkSummary"]["components"] = draft.orchestrationVersion === "UNIFIED_V1"
    ? (() => {
        if (!acceptedCatalogAuthority) return [];
        const evidenceById = new Map((unifiedContextClosure?.evidenceEntries ?? []).map(entry => [entry.entry_id, entry]));
        return acceptedCatalogAuthority.catalog.components.map(component => {
          const relevantPaths = component.evidence_entry_ids.flatMap(entryId => {
            const entry = evidenceById.get(entryId);
            if (!entry?.workspace_id || !entry.normalized_path) return [];
            return [{
              workspaceId: entry.workspace_id,
              workspaceDisplayName: displayNameForWorkspace(snapshot, entry.workspace_id),
              path: entry.normalized_path,
            }];
          });
          return {
            componentId: component.component_id,
            acceptedCatalogRevisionId: acceptedCatalogAuthority.id,
            workspaceIds: [...component.workspace_ids],
            name: component.display_name,
            responsibilitySummary: component.summary || component.responsibilities.join("; "),
            relevantPaths,
            fileCount: relevantPaths.length,
            isSelectedByOwner: selectedComponentIds.includes(component.component_id),
          };
        });
      })()
    : proposalAuthorities.flatMap(({ analysis, run, proposal }) => {
        const mappingEntries = new Map(analysis.mappingInputEntries.map(entry => [entry.entry_id, entry]));
        return proposal.modelProposal.contexts.map(context => {
          const relevantPaths = context.evidence_entry_ids.flatMap(entryId => {
            const entry = mappingEntries.get(entryId);
            if (!entry?.workspace_id || !entry.normalized_path) return [];
            if (!context.workspace_ids.includes(entry.workspace_id)) return [];
            return [{
              workspaceId: entry.workspace_id,
              workspaceDisplayName: displayNameForWorkspace(snapshot, entry.workspace_id),
              path: entry.normalized_path,
            }];
          });
          return {
            componentId: context.context_id,
            mappingRunId: run.id,
            proposalId: proposal.id,
            workspaceIds: [...context.workspace_ids],
            name: context.display_name,
            responsibilitySummary: context.summary || context.responsibilities.join("; "),
            relevantPaths,
            fileCount: relevantPaths.length,
            isSelectedByOwner: snapshot.boundAnalysis?.mappingRun.id === run.id && selectedContextIds.includes(context.context_id),
          };
        });
      });

  const excludedPathPatterns = snapshot.workspaces.flatMap(item => item.taskWorkspace.excludedPaths.map(path => ({
    workspaceId: item.taskWorkspace.id,
    workspaceDisplayName: item.taskWorkspace.displayName,
    path,
  })));

  const discoveredWorkSummary: TaskExperienceProjectionV1["discoveredWorkSummary"] = {
    components: discoveredComponents,
    totalRelevantFiles: discoveredComponents.reduce((sum, component) => sum + component.fileCount, 0),
    excludedPathPatterns,
  };

  const ownerSelectionSummary: TaskExperienceProjectionV1["ownerSelectionSummary"] = {
    selectedContextIds,
    selectedComponentIds,
    selectionCommitted: Boolean(snapshot.candidateScope),
  };

  const candidateAllowedPaths = snapshot.candidateScope?.candidateAllowedPaths.map(path => displayPath(snapshot, path)) ?? [];
  const candidateScopeSummary: TaskExperienceProjectionV1["candidateScopeSummary"] = {
    isDerived: Boolean(snapshot.candidateScope),
    ...(snapshot.candidateScope ? {
      identity: snapshot.candidateScope.authorityVersion === "CONTEXT_ASSEMBLY_V2"
        ? {
            authorityVersion: "CONTEXT_ASSEMBLY_V2" as const,
            contextAssemblyId: snapshot.candidateScope.contextAssemblyId,
            contextAssemblyRevisionId: snapshot.candidateScope.contextAssemblyRevisionId,
            mappingIterationId: snapshot.candidateScope.mappingIterationId,
            closureEvaluationId: snapshot.candidateScope.closureEvaluationId,
            acceptedCatalogRevisionId: snapshot.candidateScope.acceptedCatalogRevisionId,
            acceptedCatalogSha256: snapshot.candidateScope.acceptedCatalogSha256,
            selectedComponentIdsSha256: snapshot.candidateScope.selectedComponentIdsSha256,
            candidateScopeSha256: snapshot.candidateScope.candidateScopeSha256,
          }
        : {
            authorityVersion: "MAPPING_V1" as const,
            workspaceIndexSnapshotId: snapshot.candidateScope.workspaceIndexSnapshotId,
            mappingRunId: snapshot.candidateScope.mappingRunId,
            proposalId: snapshot.candidateScope.proposalId,
            proposalSha256: snapshot.candidateScope.proposalSha256,
            acceptedContextDecisionIdsSha256: snapshot.candidateScope.acceptedContextDecisionIdsSha256,
            candidateScopeSha256: snapshot.candidateScope.candidateScopeSha256,
          },
    } : {}),
    allowedPaths: candidateAllowedPaths,
    excludedPaths: [],
    boundaryCount: candidateAllowedPaths.length,
  };

  const effectiveAuthoritySummary: TaskExperienceProjectionV1["effectiveAuthoritySummary"] = {
    capabilities: snapshot.effectivePolicyTrace.map(trace => ({
      capability: trace.capability,
      label: trace.capability,
      isRequested: snapshot.requestedAuthorization[trace.capability],
      isEffective: trace.effective,
      governingPolicyReason: trace.reason,
    })),
  };

  const confirmedAllowedPaths = snapshot.scopeConfirmation?.confirmedAllowedPaths.map(path => displayPath(snapshot, path)) ?? [];
  const confirmedExcludedPaths = snapshot.scopeConfirmation?.confirmedExcludedPaths.map(path => displayPath(snapshot, path)) ?? [];
  const scopeConfirmationSummary: TaskExperienceProjectionV1["scopeConfirmationSummary"] = {
    isConfirmed: Boolean(snapshot.scopeConfirmation),
    ...(snapshot.scopeConfirmation?.confirmedAt ? { confirmedAtFormatted: snapshot.scopeConfirmation.confirmedAt } : {}),
    confirmedAllowedPaths,
    confirmedExcludedPaths,
  };

  const setup = snapshot.execution.setup;
  const exposedSetup = snapshot.execution.source === "DRAFT" && !isScopeConfirmed
    ? undefined
    : setup;
  const executionSetupSummary: TaskExperienceProjectionV1["executionSetupSummary"] = {
    isConfigured: Boolean(exposedSetup),
    authoritySource: exposedSetup ? snapshot.execution.source : "NONE",
    providerId: exposedSetup?.providerId ?? null,
    modelId: exposedSetup?.modelId ?? null,
    executionChannelId: exposedSetup?.executionChannelId ?? null,
    reasoningProfile: exposedSetup?.reasoningProfile ?? null,
    runtimeProfileId: exposedSetup?.runtimeProfileId ?? null,
    modelOverrideAccepted: Boolean(exposedSetup?.modelOverrideAccepted),
    ...(exposedSetup?.modelOverrideReason ? { modelOverrideReason: exposedSetup.modelOverrideReason } : {}),
  };

  const executionOptions: TaskExperienceProjectionV1["executionOptions"] = {
    authorityMeaning: "OWNER_SELECTS_PLATFORM_BACKEND_RESOLVES_CONFIGURATION",
    availablePlatforms: Object.values(providerRegistry).map(provider => ({
      executionChannelId: provider.executionChannelId,
      displayName: provider.executionChannelName,
    })),
  };

  const instructionsPreview = snapshot.execution.frozenCompiledArtifact?.text ?? "";
  const instructionAuthority: TaskExperienceProjectionV1["governedExecutionInstructionsSummary"]["authoritySource"] =
    snapshot.execution.frozenCompiledArtifact ? "RUN_FROZEN_ARTIFACT" : "NONE";

  const governedExecutionInstructionsSummary: TaskExperienceProjectionV1["governedExecutionInstructionsSummary"] = {
    isGenerated: instructionsPreview.length > 0,
    authoritySource: instructionAuthority,
    instructionsPreview,
    byteLength: new TextEncoder().encode(instructionsPreview).byteLength,
    locale,
  };

  const contractSummary: TaskExperienceProjectionV1["contractSummary"] = {
    contractId: task.contract?.contractId,
    contractRevision: snapshot.contractRevision,
    ownerApprovalState: task.contract?.ownerApproval.state ?? "DRAFT",
    mandatoryRequirementsCount: task.contract?.executionPackage.mandatoryRequirements.length ?? 0,
    requiredChecksCount: task.contract?.requiredChecks.length ?? 0,
  };

  const reportFormat = snapshot.runAuthority?.reportSubmission?.reportFormat;
  const runSummary: TaskExperienceProjectionV1["runSummary"] = {
    activeRunId: activeRun?.id,
    runIndex: activeRun?.round,
    status: runStatus(activeRun),
    toolTracesCount: snapshot.runAuthority?.toolTraceEvents.length ?? 0,
    ...(snapshot.runAuthority?.toolTraceEvents.length
      ? { latestToolCommand: snapshot.runAuthority.toolTraceEvents[snapshot.runAuthority.toolTraceEvents.length - 1].command }
      : {}),
    reportSubmitted: Boolean(snapshot.runAuthority?.reportSubmission),
    ...(reportFormat === "JSON" ? { reportFormat: "APPLICATION_JSON" as const } : {}),
    ...(reportFormat === "MARKDOWN" ? { reportFormat: "TEXT_MARKDOWN" as const } : {}),
    evidenceReferencesCount: snapshot.runAuthority?.evidenceReferences.length ?? 0,
    validationEvidenceCount: snapshot.runAuthority?.validationEvidence.length ?? 0,
    inheritedValidationEvidenceCount: snapshot.runAuthority?.inheritedValidationEvidence.length ?? 0,
    sourceEvidenceCount: snapshot.runAuthority?.sourceEvidence.length ?? 0,
    artifactEvidenceCount: snapshot.runAuthority?.artifactEvidence.length ?? 0,
  };

  const verdict = activeRun?.verdict;
  const trustedSatisfied = new Set(verdict?.trustedSatisfiedCheckIds ?? []);
  const requiredChecks = task.contract?.requiredChecks.filter((check: RequiredCheck) => check.required) ?? [];
  const inheritedProofByCheck = new Map((snapshot.runAuthority?.inheritedValidationEvidence ?? [])
    .map(evidence => [evidence.checkId, evidence.source.details] as const));
  const checkLedger: TaskExperienceProjectionV1["verdictSummary"]["checkLedger"] = verdict
    ? requiredChecks.map((check: RequiredCheck) => {
      const status = trustedSatisfied.has(check.id)
        ? "SATISFIED" as const
        : "UNSATISFIED" as const;
      const canonicalMode = requiredCheckSatisfactionMode(check);
      const satisfactionMode = canonicalMode === "BACKEND_AUTOMATIC"
        ? "BACKEND_AUTOMATIC" as const
        : "PRODUCER_EVIDENCE" as const;
      const inheritedProof = inheritedProofByCheck.get(check.id);
      return {
        checkId: check.id,
        title: check.description,
        status,
        satisfactionMode,
        ...(trustedSatisfied.has(check.id) && inheritedProof ? { proofSnippet: inheritedProof } : {}),
      };
    })
    : [];

  const verdictSummary: TaskExperienceProjectionV1["verdictSummary"] = {
    isEvaluated: Boolean(verdict),
    classification: verdict?.classification,
    summaryNote: verdict?.contractComplianceSummary,
    satisfiedChecksCount: verdict?.trustedSatisfiedCheckIds?.length ?? 0,
    totalChecksCount: requiredChecks.length,
    checkLedger,
    detectedViolations: verdict?.detectedViolations ?? [],
    ownerDecision: activeRun?.decision ?? "NONE",
    ...(activeRun?.correctionNotes ? { ownerDecisionNotes: activeRun.correctionNotes } : {}),
  };

  let primaryAction: TaskExperienceProjectionV1["primaryAction"];
  const availableOwnerActions: TaskExperienceProjectionV1["availableOwnerActions"] = [
    { actionKey: "VIEW_AUDIT_DETAILS", labelEn: "Audit Details", labelAr: "تفاصيل التدقيق", style: "DRAWER_TRIGGER" },
  ];

  switch (phaseStatus) {
    case "AWAITING_OBJECTIVE":
    case "WORKSPACE_VERIFYING":
      primaryAction = {
        actionKey: "START_CONTEXT_ANALYSIS",
        labelEn: "Analyze & Discover Context",
        labelAr: "تحليل واستكشاف الكود",
        availability: "DISABLED",
        disabledReasonEn: "Objective and verified workspace authority are required",
        disabledReasonAr: "الهدف وسلطة Workspace المتحقق منها مطلوبان",
      };
      break;
    case "ANALYSIS_READY_TO_START":
    case "INDEXING_AND_MAPPING":
      primaryAction = {
        actionKey: "START_CONTEXT_ANALYSIS",
        labelEn: "Analyze & Discover Context",
        labelAr: "تحليل واستكشاف الكود",
        availability: phaseStatus === "INDEXING_AND_MAPPING" ? "BUSY" : "ENABLED",
      };
      break;
    case "CONTEXT_MAPPING_RETRYABLE":
      primaryAction = {
        actionKey: "RETRY_CONTEXT_MAPPING",
        labelEn: "Retry Context Mapping",
        labelAr: "إعادة محاولة تحليل السياق",
        availability: "ENABLED",
      };
      break;
    case "CONTEXT_EVIDENCE_REQUIRED":
      primaryAction = {
        actionKey: "RESOLVE_CONTEXT",
        labelEn: "Resolve Required Context Evidence",
        labelAr: "استكمال أدلة السياق المطلوبة",
        availability: "ENABLED",
      };
      break;
    case "CONTEXT_SOURCE_TRUTH_CONFLICT":
      primaryAction = {
        actionKey: "RESOLVE_SOURCE_TRUTH",
        labelEn: "Resolve Source Truth Conflict",
        labelAr: "حل تعارض حقيقة السورس",
        availability: "ENABLED",
      };
      break;
    case "COMPONENTS_READY_FOR_WORK_SELECTION":
      primaryAction = { actionKey: "COMMIT_WORK_SELECTION", labelEn: "Derive Governed Scope", labelAr: "توليد النطاق المحكوم", availability: "ENABLED" };
      break;
    case "CURRENT_CONTEXT_REBUILD_REQUIRED":
      primaryAction = {
        actionKey: "START_CONTEXT_ANALYSIS",
        labelEn: pendingCorrectionRun ? "Rebuild Current Context for Correction" : "Rebuild Current Governed Context",
        labelAr: pendingCorrectionRun ? "إعادة بناء السياق الحالي للتصحيح" : "إعادة بناء السياق المحكوم الحالي",
        availability: allWorkspacesVerified ? "ENABLED" : "DISABLED",
      };
      break;
    case "STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED":
    case "SOURCE_DRIFT_REBASE_REQUIRED":
      primaryAction = analysisReady && currentContextAuthorityCurrent
        ? { actionKey: "REBASE_CONTEXT_WORK_SELECTION", labelEn: "Review Current Context & Rebase Work", labelAr: "مراجعة السياق الحالي وإعادة اختيار العمل", availability: "ENABLED" }
        : { actionKey: "START_CONTEXT_ANALYSIS", labelEn: "Rebuild Current Governed Context", labelAr: "إعادة بناء السياق المحكوم الحالي", availability: allWorkspacesVerified ? "ENABLED" : "DISABLED" };
      break;
    case "SCOPE_DERIVED_AWAITING_CONFIRMATION":
      primaryAction = { actionKey: "CONFIRM_SCOPE", labelEn: "Confirm Scope & Permissions", labelAr: "تأكيد النطاق واعتماده", availability: "ENABLED" };
      break;
    case "SCOPE_CONFIRMED_AWAITING_PLATFORM":
      primaryAction = executionOptions.availablePlatforms.length > 0
        ? { actionKey: "SELECT_EXECUTION_PLATFORM", labelEn: "Select Execution Platform", labelAr: "اختيار منصة التنفيذ", availability: "ENABLED" }
        : {
          actionKey: "SELECT_EXECUTION_PLATFORM",
          labelEn: "Select Execution Platform",
          labelAr: "اختيار منصة التنفيذ",
          availability: "DISABLED",
          disabledReasonEn: "No governed execution platform is supported by this product build",
          disabledReasonAr: "لا توجد منصة تنفيذ محكومة مدعومة في نسخة المنتج الحالية",
        };
      break;
    case "PLATFORM_SELECTED_CONFIGURATION_RESOLVED_AWAITING_CONTRACT":
      primaryAction = { actionKey: "APPROVE_CONTRACT", labelEn: "Review Governed Contract", labelAr: "مراجعة العقد المحكوم", availability: "ENABLED" };
      break;
    case "CONTRACT_APPROVED_READY_FOR_RUN":
      primaryAction = { actionKey: "START_RUN", labelEn: "Start Governed Run", labelAr: "بدء التشغيل المحكوم", availability: "ENABLED" };
      break;
    case "RUN_ACTIVE_EXECUTING":
      primaryAction = { actionKey: "SUBMIT_REPORT", labelEn: "Submit Execution Report", labelAr: "تسليم تقرير المنفذ", availability: "ENABLED" };
      break;
    case "REPORT_INGESTED_AWAITING_EVALUATION":
      primaryAction = { actionKey: "EVALUATE_VERDICT", labelEn: "Evaluate Deterministic Verdict", labelAr: "إصدار حكم المطابقة", availability: "ENABLED" };
      break;
    case "VERDICT_READY_AWAITING_OWNER_DECISION":
      primaryAction = { actionKey: "ACCEPT_DECISION", labelEn: "Accept & Close Task", labelAr: "قبول واعتماد الإغلاق", availability: "ENABLED" };
      availableOwnerActions.push({ actionKey: "REQUEST_CORRECTION", labelEn: "Request Correction", labelAr: "طلب تصحيح محدد", style: "SECONDARY" });
      break;
    case "CORRECTION_REQUESTED":
      primaryAction = { actionKey: "START_RUN", labelEn: "Start Correction Run", labelAr: "بدء تشغيل التصحيح", availability: "ENABLED" };
      break;
    case "TASK_CLOSED":
    default:
      primaryAction = { actionKey: "ACCEPT_DECISION", labelEn: "Task Closed", labelAr: "المهمة مغلقة", availability: "COMPLETED" };
      break;
  }

  const auditDetails: TaskExperienceProjectionV1["auditDetails"] = {
    taskId: task.id,
    confirmedAtIso: snapshot.scopeConfirmation?.confirmedAt,
    confirmedBy: snapshot.scopeConfirmation?.confirmedBy,
    candidateScopeSha256: snapshot.candidateScope?.candidateScopeSha256,
    acceptedDecisionIdsSha256: snapshot.candidateScope && snapshot.candidateScope.authorityVersion !== "CONTEXT_ASSEMBLY_V2"
      ? snapshot.candidateScope.acceptedContextDecisionIdsSha256
      : undefined,
    contractSha256: task.contractContentSha256,
    workspaceIndexSnapshotId: snapshot.boundAnalysis?.workspaceIndex.id,
    b1WorkspaceObservationId: snapshot.boundAnalysis?.workspaceIndex.workspaceObservationId,
    workspaceRevisionId: snapshot.boundAnalysis?.workspaceIndex.workspaceRevisionId,
    canonicalIndexArtifactId: snapshot.boundAnalysis?.workspaceIndex.canonicalIndexArtifactId,
    mappingRunId: snapshot.boundAnalysis?.mappingRun.id,
    mappingProposalId: snapshot.boundAnalysis?.mappingRun.proposal?.id,
    contextAssemblyId: snapshot.contextClosure?.contextAssemblyId,
    contextAssemblyRevisionId: snapshot.contextClosure?.revisionId,
    mappingIterationId: snapshot.contextClosure?.closureEvaluation?.mappingIterationId,
    contextClosureEvaluationId: snapshot.contextClosure?.closureEvaluation?.id,
    acceptedCatalogRevisionId: snapshot.contextClosure?.acceptedCatalog?.id,
    reportSubmissionId: snapshot.runAuthority?.reportSubmission?.id,
    verdictId: snapshot.runAuthority?.verdictIdentity?.id,
    ownerDecisionId: snapshot.runAuthority?.ownerDecisionIdentity?.id,
    policyDecisionTraceCount: snapshot.effectivePolicyTrace.length,
  };

  return {
    taskSummary: {
      id: task.id,
      revision: task.revision,
      title: draft.title || draft.objective || "Untitled Task",
      objective: draft.objective,
      taskMode: draft.taskMode,
      taskContext: taskContext(snapshot),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    visiblePhase,
    phaseStatus,
    workspaceSummary,
    analysisSummary,
    contextResolutionSummary,
    contextAuthoritySummary,
    discoveredWorkSummary,
    ownerSelectionSummary,
    candidateScopeSummary,
    effectiveAuthoritySummary,
    scopeConfirmationSummary,
    executionSetupSummary,
    executionOptions,
    governedExecutionInstructionsSummary,
    contractSummary,
    runSummary,
    verdictSummary,
    primaryAction,
    availableOwnerActions,
    auditDetails,
  };
}

export async function getTaskExperienceProjection(
  taskId: string,
  locale: "ar" | "en" = "ar",
  dependencies?: TaskExperienceAuthorityDependencies,
): Promise<TaskExperienceProjectionV1 | undefined> {
  const authority = await composeTaskExperienceAuthoritySnapshot(taskId, dependencies);
  if (!authority) return undefined;
  return computeTaskExperienceProjection(authority, locale);
}
