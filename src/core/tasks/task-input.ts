import type { ExecutionContract } from "@/core/contracts/execution-contract";
import type { EvidenceType } from "@/core/intelligence/intent-schema";
import {
  defaultModelForProvider,
  defaultRuntimeProfileForProvider,
  modelRegistry,
  providerRegistry,
  runtimeProfileSupportsProvider,
  type ExecutionChannelId,
  type ModelId,
  type ProviderId,
  type ReasoningProfile,
  type RuntimeProfileId,
} from "@/core/providers/registry";

export type AuthorizationCapability = keyof ExecutionContract["authorization"];

export const taskContextKinds = ["INDEPENDENT", "PROJECT_BOUND"] as const;
export type TaskContextKind = typeof taskContextKinds[number];
export type TaskContext =
  | { kind: "INDEPENDENT" }
  | {
      kind: "PROJECT_BOUND";
      projectContextId: string;
      projectContextDisplayName: string;
      projectContextRevision: number;
    };

export const independentTaskContext = (): TaskContext => ({ kind: "INDEPENDENT" });

export function effectiveTaskContext(input: Pick<TaskDraftInput, "taskContext">): TaskContext {
  return input.taskContext ?? independentTaskContext();
}

export type OwnerRequirement = {
  id: string;
  outcome: string;
  requiredEvidenceTypes?: EvidenceType[];
  proofProfile: {
    sourceBehavior: boolean;
    positive: boolean;
    negativeAdversarial: boolean;
    persistenceReload: boolean;
  };
};

export function normalizeOwnerRequirements(
  requirements: OwnerRequirement[] | undefined,
  mode: ExecutionContract["taskMode"],
): OwnerRequirement[] {
  const seen = new Set<string>();
  return (requirements ?? []).map((requirement, index) => {
    const requestedId = requirement.id.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    const baseId = requestedId || `REQ-${String(index + 1).padStart(3, "0")}`;
    let id = baseId;
    let suffix = 2;
    while (seen.has(id)) id = `${baseId}-${suffix++}`;
    seen.add(id);
    const requiredEvidenceTypes = requirement.requiredEvidenceTypes?.length
      ? Array.from(new Set(requirement.requiredEvidenceTypes))
      : mode === "SOURCE_IMPLEMENTATION"
        ? ["SOURCE", "VALIDATION"] as EvidenceType[]
        : mode === "REPORT_REVIEW"
          ? ["ARTIFACT", "VALIDATION", "RUNTIME"] as EvidenceType[]
          : ["SOURCE"] as EvidenceType[];
    return {
      id,
      outcome: requirement.outcome.trim(),
      requiredEvidenceTypes,
      proofProfile: {
        sourceBehavior: requirement.proofProfile?.sourceBehavior ?? requiredEvidenceTypes.includes("SOURCE"),
        positive: requirement.proofProfile?.positive ?? true,
        negativeAdversarial: requirement.proofProfile?.negativeAdversarial
          ?? requiredEvidenceTypes.some(type => type === "VALIDATION" || type === "RUNTIME"),
        persistenceReload: requirement.proofProfile?.persistenceReload
          ?? (requiredEvidenceTypes.includes("RUNTIME") || mode === "SOURCE_IMPLEMENTATION"),
      },
    };
  }).filter(requirement => requirement.outcome.length > 0);
}

export function parseOwnerRequirementLines(
  value: string,
  mode: ExecutionContract["taskMode"],
): OwnerRequirement[] {
  const raw = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return normalizeOwnerRequirements(raw.map((line, index) => {
    const separator = line.indexOf("::");
    return {
      id: separator >= 0 ? line.slice(0, separator).trim() : `REQ-${String(index + 1).padStart(3, "0")}`,
      outcome: separator >= 0 ? line.slice(separator + 2).trim() : line,
      requiredEvidenceTypes: mode === "SOURCE_IMPLEMENTATION"
        ? ["SOURCE", "VALIDATION"]
        : mode === "REPORT_REVIEW"
          ? ["ARTIFACT", "VALIDATION", "RUNTIME"]
          : ["SOURCE"],
      proofProfile: {
        sourceBehavior: mode !== "REPORT_REVIEW",
        positive: true,
        negativeAdversarial: true,
        persistenceReload: mode === "SOURCE_IMPLEMENTATION",
      },
    };
  }), mode);
}

export type WorkspaceSource = "WINDOWS_NATIVE_SELECTOR" | "MANUAL_VERIFIED" | "MANUAL_UNVERIFIED" | "REMOTE_CONNECTOR" | "MIXED";

export const discoveryScopeModes = ["FULL_WORKSPACE", "SELECTED_PATHS", "NONE"] as const;
export type DiscoveryScopeMode = typeof discoveryScopeModes[number];
export const workspaceRootScopePath = "@workspace-root";

export function defaultDiscoveryScopeMode(
  mode: ExecutionContract["taskMode"],
): DiscoveryScopeMode {
  if (mode === "CONTROLLED_AUDIT") return "FULL_WORKSPACE";
  if (mode === "REPORT_REVIEW") return "NONE";
  return "SELECTED_PATHS";
}

export function effectiveDiscoveryScopeMode(
  workspace: Pick<WorkspaceReference, "discoveryScopeMode" | "allowedPaths">,
  taskMode: ExecutionContract["taskMode"] = "CONTROLLED_AUDIT",
): DiscoveryScopeMode {
  return workspace.discoveryScopeMode
    ?? (workspace.allowedPaths.length > 0 ? "SELECTED_PATHS" : defaultDiscoveryScopeMode(taskMode));
}

export type WorkspaceReference = {
  id: string;
  displayName: string;
  role: string;
  referenceType: "LOCAL_PATH" | "REMOTE_REFERENCE";
  source?: Exclude<WorkspaceSource, "MIXED">;
  reference: string;
  repositoryIdentity?: string;
  branch?: string;
  commitSha?: string;
  fingerprint: string;
  provenance?: string;
  discoveryScopeMode?: DiscoveryScopeMode;
  allowedPaths: string[];
  excludedPaths: string[];
  authorizationContext: string;
  ordering: number;
};

export const legacyWorkspaceId = "00000000-0000-4000-8000-000000000001";

export type WorkspaceScopedPath = { workspaceId: string; path: string };

export function workspaceScopedPaths(workspaces: WorkspaceReference[], kind: "allowedPaths" | "excludedPaths"): WorkspaceScopedPath[] {
  return workspaces.flatMap(workspace => workspace[kind].map(path => ({ workspaceId: workspace.id, path })));
}

export function workspaceDisplayScope(
  workspaces: WorkspaceReference[],
  taskMode: ExecutionContract["taskMode"] = "CONTROLLED_AUDIT",
): string[] {
  return workspaces.flatMap(workspace => {
    const mode = effectiveDiscoveryScopeMode(workspace, taskMode);
    if (mode === "NONE") return [];
    if (mode === "FULL_WORKSPACE") {
      return [workspace.id === legacyWorkspaceId
        ? workspaceRootScopePath
        : `${workspace.id}:${workspaceRootScopePath}`];
    }
    return workspace.allowedPaths.map(path =>
      workspace.id === legacyWorkspaceId ? path : `${workspace.id}:${path}`);
  });
}

export function synchronizeLegacyWorkspaceProjection<T extends TaskDraftInput>(input: T): T & { workspaces: WorkspaceReference[] } {
  const workspaces: WorkspaceReference[] = input.workspaces.map((workspace, ordering) => ({
    ...workspace,
    source: workspace.source ?? "MANUAL_UNVERIFIED" as const,
    discoveryScopeMode: effectiveDiscoveryScopeMode(workspace, input.taskMode),
    ordering,
  }));
  const sources = [...new Set(workspaces.map(workspace => workspace.source))];
  const workspaceSource: WorkspaceSource = sources.length === 1 ? sources[0]! : "MIXED";
  return {
    ...input,
    ownerRequirements: normalizeOwnerRequirements(input.ownerRequirements, input.taskMode),
    workspaces,
    workspaceRef: workspaces.map(workspace => workspace.reference).join(" | "),
    workspaceSource,
    workspaceFingerprint: workspaces.map(workspace => workspace.fingerprint).join("|"),
    allowedPaths: workspaceDisplayScope(workspaces, input.taskMode),
    excludedPaths: workspaceScopedPaths(workspaces, "excludedPaths").map(item => `${item.workspaceId}:${item.path}`),
  };
}

export function workspaceDisplayNameFromReference(reference: string): string {
  const normalized = reference.trim().replace(/[\\/]+$/g, "");
  if (!normalized) return "";
  return normalized.split(/[\\/]/).at(-1)?.trim() || normalized;
}

export function generatedTaskTitle(objective: string): string {
  const normalized = objective.trim().replace(/\s+/g, " ");
  if (!normalized) return "Untitled IntentChord task";
  const sentenceEnd = normalized.search(/[!?]|\.(?=\s|$)/);
  const sentence = (sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd) : normalized).trim() || normalized;
  return sentence.length > 72 ? `${sentence.slice(0, 69).trimEnd()}...` : sentence;
}

export const authorizationCapabilities: AuthorizationCapability[] = [
  "readFiles",
  "modifySource",
  "runStaticValidation",
  "runTests",
  "build",
  "deploy",
  "restartServices",
  "writeDatabase",
  "changeEnvironment",
  "useNetwork",
];

export type TaskContextAnalysisBinding = {
  workspaceIndexSnapshotId: string;
  mappingRunId: string;
  proposalId: string;
  proposalSha256: string;
  acceptedContextDecisionIds: string[];
};

export type TaskContextAssemblyBinding = {
  contractVersion: "intentchord.context-assembly.v1";
  contextAssemblyId: string;
  contextAssemblyRevisionId: string;
  contextAssemblyRevision: number;
  mappingIterationId: string;
  closureEvaluationId: string;
  acceptedCatalogRevisionId: string;
  acceptedCatalogSha256: string;
};

export type TaskOrchestrationVersion = "UNIFIED_V1";

export type LegacyTaskCandidateScopeEntry = {
  workspaceId: string;
  normalizedPath: string;
  contextId: string;
  evidenceEntryId: string;
};

export type ContextAssemblyTaskCandidateScopeEntry = {
  workspaceId: string;
  normalizedPath: string;
  componentId: string;
  evidenceEntryId: string;
};

export type TaskCandidateScopeEntry = LegacyTaskCandidateScopeEntry | ContextAssemblyTaskCandidateScopeEntry;

export type LegacyCandidateScopeIdentity = {
  authorityVersion?: "MAPPING_V1";
  workspaceIndexSnapshotId: string;
  mappingRunId: string;
  proposalId: string;
  proposalSha256: string;
  acceptedContextDecisionIdsSha256: string;
  candidateScopeSha256: string;
};

export type ContextAssemblyCandidateScopeIdentity = {
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

export type CandidateScopeIdentity = LegacyCandidateScopeIdentity | ContextAssemblyCandidateScopeIdentity;

export function candidateScopeIdentityMatches(left: CandidateScopeIdentity, right: CandidateScopeIdentity): boolean {
  const leftVersion = left.authorityVersion ?? "MAPPING_V1";
  const rightVersion = right.authorityVersion ?? "MAPPING_V1";
  if (leftVersion !== rightVersion) return false;
  if (left.authorityVersion === "CONTEXT_ASSEMBLY_V2" && right.authorityVersion === "CONTEXT_ASSEMBLY_V2") {
    return left.contextAssemblyId === right.contextAssemblyId
      && left.contextAssemblyRevisionId === right.contextAssemblyRevisionId
      && left.mappingIterationId === right.mappingIterationId
      && left.closureEvaluationId === right.closureEvaluationId
      && left.acceptedCatalogRevisionId === right.acceptedCatalogRevisionId
      && left.acceptedCatalogSha256 === right.acceptedCatalogSha256
      && left.selectedComponentIdsSha256 === right.selectedComponentIdsSha256
      && left.candidateScopeSha256 === right.candidateScopeSha256;
  }
  if (leftVersion === "MAPPING_V1" && rightVersion === "MAPPING_V1") {
    const l = left as LegacyCandidateScopeIdentity;
    const r = right as LegacyCandidateScopeIdentity;
    return l.workspaceIndexSnapshotId === r.workspaceIndexSnapshotId
      && l.mappingRunId === r.mappingRunId
      && l.proposalId === r.proposalId
      && l.proposalSha256 === r.proposalSha256
      && l.acceptedContextDecisionIdsSha256 === r.acceptedContextDecisionIdsSha256
      && l.candidateScopeSha256 === r.candidateScopeSha256;
  }
  return false;
}

export function candidateScopeIdentityFromScope(scope: TaskCandidateScope): CandidateScopeIdentity {
  if (scope.authorityVersion === "CONTEXT_ASSEMBLY_V2") {
    return {
      authorityVersion: "CONTEXT_ASSEMBLY_V2",
      contextAssemblyId: scope.contextAssemblyId,
      contextAssemblyRevisionId: scope.contextAssemblyRevisionId,
      mappingIterationId: scope.mappingIterationId,
      closureEvaluationId: scope.closureEvaluationId,
      acceptedCatalogRevisionId: scope.acceptedCatalogRevisionId,
      acceptedCatalogSha256: scope.acceptedCatalogSha256,
      selectedComponentIdsSha256: scope.selectedComponentIdsSha256,
      candidateScopeSha256: scope.candidateScopeSha256,
    };
  }
  return {
    authorityVersion: "MAPPING_V1",
    workspaceIndexSnapshotId: scope.workspaceIndexSnapshotId,
    mappingRunId: scope.mappingRunId,
    proposalId: scope.proposalId,
    proposalSha256: scope.proposalSha256,
    acceptedContextDecisionIdsSha256: scope.acceptedContextDecisionIdsSha256,
    candidateScopeSha256: scope.candidateScopeSha256,
  };
}

export type LegacyTaskCandidateScope = LegacyCandidateScopeIdentity & {
  entries: LegacyTaskCandidateScopeEntry[];
  candidateAllowedPaths: WorkspaceScopedPath[];
};

export type ContextAssemblyTaskCandidateScope = ContextAssemblyCandidateScopeIdentity & {
  entries: ContextAssemblyTaskCandidateScopeEntry[];
  candidateAllowedPaths: WorkspaceScopedPath[];
};

export type TaskCandidateScope = LegacyTaskCandidateScope | ContextAssemblyTaskCandidateScope;

export type TaskScopeConfirmation = {
  candidateIdentity: CandidateScopeIdentity;
  authorityInputSha256?: string;
  confirmedAt: string;
  confirmedBy: string;
  confirmedAllowedPaths: WorkspaceScopedPath[];
  confirmedExcludedPaths: WorkspaceScopedPath[];
  rationale?: string;
};

export type TaskExecutionSetup = {
  providerId: ProviderId;
  modelId: ModelId;
  executionChannelId: ExecutionChannelId;
  reasoningProfile: ReasoningProfile;
  runtimeProfileId: RuntimeProfileId;
  modelOverrideAccepted: boolean;
  modelOverrideReason?: string;
};

/**
 * TaskDraftInput represents a staged, progressively completed Task Draft.
 * Execution provider/model selection is OPTIONAL during early stages (Late Model Selection).
 */
export type TaskDraftInput = {
  orchestrationVersion?: TaskOrchestrationVersion;
  title: string;
  titleManuallyEdited: boolean;
  objective: string;
  ownerRequirements: OwnerRequirement[];
  taskContext?: TaskContext;
  taskMode: ExecutionContract["taskMode"];
  workspaces: WorkspaceReference[];
  workspaceRef: string;
  workspaceSource: WorkspaceSource;
  workspaceFingerprint: string;
  allowedPaths: string[];
  excludedPaths: string[];
  evidenceFiles: string[];
  identity: string;
  readFiles: boolean;
  modifySource: boolean;
  runStaticValidation: boolean;
  runTests: boolean;
  build: boolean;
  deploy: boolean;
  restartServices: boolean;
  writeDatabase: boolean;
  changeEnvironment: boolean;
  useNetwork: boolean;

  // Staged Task Orchestration fields
  contextAnalysisBinding?: TaskContextAnalysisBinding;
  contextAssemblyBinding?: TaskContextAssemblyBinding;
  candidateScope?: TaskCandidateScope;
  scopeConfirmation?: TaskScopeConfirmation;
  executionSetup?: TaskExecutionSetup;

  // Optional execution setup at top-level for legacy compatibility and convenient access
  providerId?: ProviderId;
  modelId?: ModelId;
  executionChannelId?: ExecutionChannelId;
  reasoningProfile?: ReasoningProfile;
  runtimeProfileId?: RuntimeProfileId;
  modelOverrideAccepted?: boolean;
  modelOverrideReason?: string;
};

/**
 * ContractInput represents a strictly validated, contract-ready input.
 * All execution-provider/model fields are REQUIRED.
 */
export type ContractInput = TaskDraftInput & {
  providerId: ProviderId;
  modelId: ModelId;
  executionChannelId: ExecutionChannelId;
  reasoningProfile: ReasoningProfile;
  runtimeProfileId: RuntimeProfileId;
  modelOverrideAccepted: boolean;
  modelOverrideReason: string;
  executionSetup: TaskExecutionSetup;
};

export function modeDefaultAuthorization(
  mode: ExecutionContract["taskMode"],
): ExecutionContract["authorization"] {
  if (mode === "CONTROLLED_AUDIT") {
    return {
      readFiles: true,
      modifySource: false,
      runStaticValidation: false,
      runTests: false,
      build: false,
      deploy: false,
      restartServices: false,
      writeDatabase: false,
      changeEnvironment: false,
      useNetwork: false,
    };
  }
  if (mode === "REPORT_REVIEW") {
    return {
      readFiles: true,
      modifySource: false,
      runStaticValidation: false,
      runTests: false,
      build: false,
      deploy: false,
      restartServices: false,
      writeDatabase: false,
      changeEnvironment: false,
      useNetwork: false,
    };
  }
  return {
    readFiles: true,
    modifySource: true,
    runStaticValidation: true,
    runTests: true,
    build: true,
    deploy: false,
    restartServices: false,
    writeDatabase: false,
    changeEnvironment: false,
    useNetwork: false,
  };
}

/**
 * Creates an initial blank TaskDraftInput without injecting any default execution model.
 * Late model selection is preserved.
 * Explicitly stamped with UNIFIED_V1 orchestration version.
 */
export function createBlankTaskDraft(
  mode: ExecutionContract["taskMode"] = "CONTROLLED_AUDIT",
  workspaces: WorkspaceReference[] = [],
): TaskDraftInput {
  return synchronizeLegacyWorkspaceProjection({
    orchestrationVersion: "UNIFIED_V1",
    title: "Untitled IntentChord task",
    titleManuallyEdited: false,
    objective: "",
    ownerRequirements: [],
    taskContext: independentTaskContext(),
    taskMode: mode,
    workspaceRef: "",
    workspaces,
    workspaceSource: "MANUAL_UNVERIFIED",
    workspaceFingerprint: "",
    allowedPaths: [],
    excludedPaths: [],
    evidenceFiles: [],
    identity: "",
    ...modeDefaultAuthorization(mode),
  });
}

/**
 * Creates a complete ContractInput with default provider/model for tests and strict contract creation.
 */
export function createBlankContractInput(
  mode: ExecutionContract["taskMode"] = "CONTROLLED_AUDIT",
): ContractInput {
  const providerId: ProviderId = "OPENAI";
  const modelId = defaultModelForProvider(providerId);
  const executionSetup: TaskExecutionSetup = {
    providerId,
    modelId,
    executionChannelId: providerRegistry[providerId].executionChannelId,
    reasoningProfile: modelRegistry[modelId].defaultReasoningProfile,
    runtimeProfileId: defaultRuntimeProfileForProvider(providerId),
    modelOverrideAccepted: false,
    modelOverrideReason: "",
  };
  return {
    ...createBlankTaskDraft(mode),
    ...executionSetup,
    modelOverrideAccepted: false,
    modelOverrideReason: "",
    executionSetup,
  };
}

export function extractExecutionSetup(input: Partial<TaskDraftInput>): TaskExecutionSetup | undefined {
  if (input.executionSetup) {
    return input.executionSetup;
  }
  if (
    input.providerId &&
    input.modelId &&
    input.executionChannelId &&
    input.reasoningProfile &&
    input.runtimeProfileId
  ) {
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      executionChannelId: input.executionChannelId,
      reasoningProfile: input.reasoningProfile,
      runtimeProfileId: input.runtimeProfileId,
      modelOverrideAccepted: Boolean(input.modelOverrideAccepted),
      modelOverrideReason: input.modelOverrideReason,
    };
  }
  return undefined;
}

/**
 * Ensures a single canonical source of truth for execution setup.
 * If both executionSetup and top-level fields are present and conflict, throws.
 * If only top-level fields are present, normalizes them into executionSetup.
 * Returns the input with canonical executionSetup applied.
 */
export function normalizeExecutionSetupCanonical<T extends TaskDraftInput>(input: T): T {
  const hasNested = Boolean(input.executionSetup);
  const hasTopLevel = Boolean(
    input.providerId ||
    input.modelId ||
    input.executionChannelId ||
    input.reasoningProfile ||
    input.runtimeProfileId ||
    input.modelOverrideAccepted !== undefined ||
    input.modelOverrideReason !== undefined,
  );

  if (!hasNested && !hasTopLevel) {
    return input;
  }

  if (hasNested && hasTopLevel) {
    const setup = input.executionSetup!;
    const conflicts: string[] = [];
    if (input.providerId && input.providerId !== setup.providerId) conflicts.push("providerId");
    if (input.modelId && input.modelId !== setup.modelId) conflicts.push("modelId");
    if (input.executionChannelId && input.executionChannelId !== setup.executionChannelId) conflicts.push("executionChannelId");
    if (input.reasoningProfile && input.reasoningProfile !== setup.reasoningProfile) conflicts.push("reasoningProfile");
    if (input.runtimeProfileId && input.runtimeProfileId !== setup.runtimeProfileId) conflicts.push("runtimeProfileId");
    if (input.modelOverrideAccepted !== undefined && Boolean(input.modelOverrideAccepted) !== Boolean(setup.modelOverrideAccepted)) {
      conflicts.push("modelOverrideAccepted");
    }
    if (input.modelOverrideReason !== undefined && (input.modelOverrideReason || "") !== (setup.modelOverrideReason || "")) {
      conflicts.push("modelOverrideReason");
    }
    if (conflicts.length > 0) {
      throw new TaskDraftNotReadyError(
        "EXECUTION_SETUP_CONFLICT",
        `Conflicting execution setup values between nested executionSetup and top-level fields: ${conflicts.join(", ")}.`,
      );
    }
    return input;
  }

  if (hasTopLevel && !hasNested) {
    const executionSetup: TaskExecutionSetup = {
      providerId: input.providerId!,
      modelId: input.modelId!,
      executionChannelId: input.executionChannelId!,
      reasoningProfile: input.reasoningProfile!,
      runtimeProfileId: input.runtimeProfileId!,
      modelOverrideAccepted: Boolean(input.modelOverrideAccepted),
      modelOverrideReason: input.modelOverrideReason,
    };
    return { ...input, executionSetup };
  }

  return input;
}

export class TaskDraftNotReadyError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "TaskDraftNotReadyError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Determines whether a draft uses the new unified context-analysis flow.
 * Checks explicit orchestrationVersion = UNIFIED_V1.
 */
export function isUnifiedTaskDraft(draft: TaskDraftInput): boolean {
  return draft.orchestrationVersion === "UNIFIED_V1";
}

/** Compatibility alias for isUnifiedTaskDraft */
export function isUnifiedContextAnalysisFlow(draft: TaskDraftInput): boolean {
  return isUnifiedTaskDraft(draft);
}

/**
 * Validates that a TaskDraftInput is contract-ready and converts it into a strict ContractInput.
 * Fails closed if execution setup is missing or invalid.
 *
 * For UNIFIED_V1 Tasks:
 * - Requires completed contextAnalysisBinding (fails closed with CONTEXT_ANALYSIS_REQUIRED if missing)
 * - Requires valid candidateScope
 * - Requires valid scopeConfirmation bound to the exact candidate identity
 * - Requires executionSetup
 *
 * Legacy drafts (without orchestrationVersion) pass without scope checks (historical compatibility).
 */
export function assertContractReadyTaskDraft(draft: TaskDraftInput): ContractInput {
  if (!draft.objective || draft.objective.trim().length < 3) {
    throw new TaskDraftNotReadyError(
      "OBJECTIVE_REQUIRED",
      "Task objective must be at least 3 characters long.",
    );
  }

  // Canonicalize execution setup: reject conflicts, normalize legacy representation
  const canonicalized = normalizeExecutionSetupCanonical(draft);
  const executionSetup = extractExecutionSetup(canonicalized);
  if (!executionSetup) {
    throw new TaskDraftNotReadyError(
      "EXECUTION_SETUP_REQUIRED",
      "Execution provider, model, channel, reasoning profile, and runtime profile must be selected before generating a Contract.",
    );
  }

  const model = modelRegistry[executionSetup.modelId];
  if (!model) {
    throw new TaskDraftNotReadyError("UNKNOWN_MODEL", `Unknown model ${executionSetup.modelId}.`);
  }
  const provider = providerRegistry[executionSetup.providerId];
  if (!provider) {
    throw new TaskDraftNotReadyError("UNKNOWN_PROVIDER", `Unknown provider ${executionSetup.providerId}.`);
  }
  if (model.providerId !== executionSetup.providerId) {
    throw new TaskDraftNotReadyError("MODEL_PROVIDER_MISMATCH", "Selected model does not belong to the selected provider.");
  }
  if (provider.executionChannelId !== executionSetup.executionChannelId) {
    throw new TaskDraftNotReadyError("EXECUTION_CHANNEL_MISMATCH", "Execution channel does not match the selected provider.");
  }
  if (!model.allowedReasoningProfiles.includes(executionSetup.reasoningProfile)) {
    throw new TaskDraftNotReadyError("REASONING_PROFILE_MISMATCH", "Selected reasoning profile is not supported by the model.");
  }
  if (!runtimeProfileSupportsProvider(executionSetup.runtimeProfileId, executionSetup.providerId)) {
    throw new TaskDraftNotReadyError("RUNTIME_PROFILE_MISMATCH", "Runtime profile is not supported by the selected provider.");
  }
  if (executionSetup.modelOverrideAccepted && (!executionSetup.modelOverrideReason || executionSetup.modelOverrideReason.length < 12)) {
    throw new TaskDraftNotReadyError("MODEL_OVERRIDE_REASON_REQUIRED", "An explicit Owner override reason of at least 12 characters is required.");
  }

  if (canonicalized.workspaces.length === 0 && !canonicalized.workspaceRef.trim()) {
    throw new TaskDraftNotReadyError("WORKSPACE_REQUIRED", "At least one Workspace is required to build a Contract.");
  }

  // Scope authority chain validation for UNIFIED_V1 tasks
  if (isUnifiedTaskDraft(canonicalized)) {
    if (!canonicalized.contextAssemblyBinding && !canonicalized.contextAnalysisBinding) {
      throw new TaskDraftNotReadyError(
        "CONTEXT_UNDERSTANDING_REQUIRED",
        "A closed Context Assembly or historical completed Context Analysis is required for UNIFIED_V1 tasks before generating a Contract.",
      );
    }
    if (!canonicalized.candidateScope) {
      throw new TaskDraftNotReadyError(
        "CANDIDATE_SCOPE_REQUIRED",
        "A valid Candidate Scope is required for the unified context-analysis flow before generating a Contract.",
      );
    }
    if (!canonicalized.scopeConfirmation) {
      throw new TaskDraftNotReadyError(
        "SCOPE_CONFIRMATION_REQUIRED",
        "Owner Scope Confirmation is required for the unified context-analysis flow before generating a Contract.",
      );
    }
    const ci = canonicalized.scopeConfirmation.candidateIdentity;
    const cs = canonicalized.candidateScope;
    if (!candidateScopeIdentityMatches(ci, cs)) {
      throw new TaskDraftNotReadyError(
        "SCOPE_CONFIRMATION_IDENTITY_STALE",
        "Owner Scope Confirmation does not match the current Candidate Scope identity. Re-confirm scope.",
      );
    }
  }

  const contractReadyDraft = isUnifiedTaskDraft(canonicalized) && canonicalized.scopeConfirmation
    ? synchronizeLegacyWorkspaceProjection({
        ...canonicalized,
        workspaces: canonicalized.workspaces.map(workspace => {
          const allowedPaths = canonicalized.scopeConfirmation!.confirmedAllowedPaths
            .filter(path => path.workspaceId === workspace.id)
            .map(path => path.path);
          const ownerExcludedPaths = canonicalized.scopeConfirmation!.confirmedExcludedPaths
            .filter(path => path.workspaceId === workspace.id)
            .map(path => path.path);
          return {
            ...workspace,
            allowedPaths,
            excludedPaths: Array.from(new Set([...workspace.excludedPaths, ...ownerExcludedPaths])).sort(),
            discoveryScopeMode: allowedPaths.length ? "SELECTED_PATHS" as const : "NONE" as const,
          };
        }),
      })
    : canonicalized;

  return {
    ...contractReadyDraft,
    providerId: executionSetup.providerId,
    modelId: executionSetup.modelId,
    executionChannelId: executionSetup.executionChannelId,
    reasoningProfile: executionSetup.reasoningProfile,
    runtimeProfileId: executionSetup.runtimeProfileId,
    modelOverrideAccepted: executionSetup.modelOverrideAccepted,
    modelOverrideReason: executionSetup.modelOverrideReason ?? "",
    executionSetup,
  };
}

export function applyModeDefaults<T extends TaskDraftInput>(
  input: T,
  mode: ExecutionContract["taskMode"] = input.taskMode,
): T {
  const isModeChange = input.taskMode !== mode;
  const workspaces = input.workspaces.map(workspace => {
    const current = effectiveDiscoveryScopeMode(workspace, input.taskMode);
    const discoveryScopeMode = mode === "SOURCE_IMPLEMENTATION" && current === "FULL_WORKSPACE"
      ? "SELECTED_PATHS" as const
      : current;
    return {
      ...workspace,
      discoveryScopeMode,
      allowedPaths: discoveryScopeMode === "SELECTED_PATHS" ? workspace.allowedPaths : [],
    };
  });
  const executionSetup = input.executionSetup
    ? (isModeChange
        ? {
            ...input.executionSetup,
            modelOverrideAccepted: false,
            modelOverrideReason: undefined,
          }
        : input.executionSetup)
    : undefined;
  return synchronizeLegacyWorkspaceProjection({
    ...input,
    taskMode: mode,
    workspaces,
    ownerRequirements: normalizeOwnerRequirements(input.ownerRequirements, mode),
    modelOverrideAccepted: isModeChange ? false : input.modelOverrideAccepted,
    modelOverrideReason: isModeChange ? "" : input.modelOverrideReason,
    ...(executionSetup ? { executionSetup } : {}),
    ...modeDefaultAuthorization(mode),
  });
}

export function transitionTaskMode<T extends TaskDraftInput>(
  input: T,
  nextMode: ExecutionContract["taskMode"],
): T {
  return applyModeDefaults(input, nextMode);
}

export function transitionProvider<T extends TaskDraftInput>(input: T, providerId: ProviderId): T {
  const modelId = defaultModelForProvider(providerId);
  const executionSetup: TaskExecutionSetup = {
    providerId,
    modelId,
    executionChannelId: providerRegistry[providerId].executionChannelId,
    reasoningProfile: modelRegistry[modelId].defaultReasoningProfile,
    runtimeProfileId: defaultRuntimeProfileForProvider(providerId),
    modelOverrideAccepted: false,
    modelOverrideReason: "",
  };
  return {
    ...input,
    ...executionSetup,
    executionSetup,
  };
}

export function transitionModel<T extends TaskDraftInput>(input: T, modelId: ModelId): T {
  const model = modelRegistry[modelId];
  const executionSetup: TaskExecutionSetup = {
    providerId: model.providerId,
    modelId,
    executionChannelId: providerRegistry[model.providerId].executionChannelId,
    reasoningProfile: model.defaultReasoningProfile,
    runtimeProfileId: defaultRuntimeProfileForProvider(model.providerId),
    modelOverrideAccepted: false,
    modelOverrideReason: "",
  };
  return {
    ...input,
    ...executionSetup,
    executionSetup,
  };
}

export function transitionReasoning<T extends TaskDraftInput>(input: T, reasoningProfile: ReasoningProfile): T {
  const executionSetup = extractExecutionSetup(input);
  return {
    ...input,
    reasoningProfile,
    modelOverrideAccepted: false,
    modelOverrideReason: "",
    ...(executionSetup ? { executionSetup: { ...executionSetup, reasoningProfile, modelOverrideAccepted: false, modelOverrideReason: "" } } : {}),
  };
}

export function transitionRuntimeProfile<T extends TaskDraftInput>(input: T, runtimeProfileId: RuntimeProfileId): T {
  const executionSetup = extractExecutionSetup(input);
  return {
    ...input,
    runtimeProfileId,
    modelOverrideAccepted: false,
    modelOverrideReason: "",
    ...(executionSetup ? { executionSetup: { ...executionSetup, runtimeProfileId, modelOverrideAccepted: false, modelOverrideReason: "" } } : {}),
  };
}

export function requestedAuthorization(
  input: TaskDraftInput,
): ExecutionContract["authorization"] {
  return authorizationCapabilities.reduce((result, capability) => {
    result[capability] = Boolean(input[capability]);
    return result;
  }, {} as ExecutionContract["authorization"]);
}
