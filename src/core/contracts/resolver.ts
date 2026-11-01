import type { ExecutionContract } from "@/core/contracts/execution-contract";
import { resolveAgentContract } from "@/core/agents/profiles";
import { policyVersion, resolveAuthorization } from "@/core/policies/policy";
import { deriveTaskSemanticProfile } from "@/core/tasks/semantic-profile";
import { evaluateConfiguration } from "@/core/recommendations/engine";
import { normalizeScopeSelections } from "@/core/policies/path-authority";
import { modelRegistry, type ExecutionChannelId, type ModelId, type ProviderId, type ReasoningProfile, type RuntimeProfileId } from "@/core/providers/registry";
import { effectiveDiscoveryScopeMode, legacyWorkspaceId, workspaceDisplayScope, workspaceScopedPaths, type OwnerRequirement, type WorkspaceReference } from "@/core/tasks/task-input";
import { reportSectionIds } from "@/core/reports/report-contract";

export type ContractResolutionInput = {
  contractId: string;
  title?: string;
  objective: string;
  taskMode: ExecutionContract["taskMode"];
  intentResolution?: NonNullable<ExecutionContract["intentResolution"]>;
  discoveryResolution?: NonNullable<ExecutionContract["discoveryResolution"]>;
  ownerRequirements?: OwnerRequirement[];
  /** Structured workspaces are authoritative; flat fields are upgraded at this boundary only. */
  workspaces?: WorkspaceReference[];
  workspaceRef?: string;
  workspaceFingerprint?: string;
  allowedPaths: string[];
  excludedPaths: string[];
  evidenceFiles: string[];
  identity: string;
  authorization: ExecutionContract["authorization"];
  providerId: ProviderId;
  modelId: ModelId;
  executionChannelId: ExecutionChannelId;
  reasoningProfile: ReasoningProfile;
  runtimeProfileId: RuntimeProfileId;
  ownerOverrideAccepted: boolean;
  ownerOverrideReason?: string;
};

const labels: Record<keyof ExecutionContract["authorization"], string> = {
  readFiles: "Read approved files",
  modifySource: "Modify approved source",
  runStaticValidation: "Run static validation",
  runTests: "Run tests",
  build: "Run build",
  deploy: "Deploy",
  restartServices: "Restart services",
  writeDatabase: "Write database",
  changeEnvironment: "Change environment",
  useNetwork: "Use network",
};

function checks(
  mode: ExecutionContract["taskMode"],
  effective: ExecutionContract["authorization"],
  approvedEvidenceCount: number,
): ExecutionContract["requiredChecks"] {
  const result: ExecutionContract["requiredChecks"] = [{
    id: "contract-validation",
    description: "Backend-validate the report schema, resolved Contract, and active Run binding.",
    required: true,
    satisfactionMode: "BACKEND_AUTOMATIC",
  }];
  void mode;
  void approvedEvidenceCount;
  if (effective.runStaticValidation) result.push({ id: "static-validation", description: "Run the approved static validation.", required: true, satisfactionMode: "TRUSTED_PRODUCER" });
  if (effective.runTests) result.push({ id: "tests", description: "Run the approved test suite.", required: true, satisfactionMode: "TRUSTED_PRODUCER" });
  if (effective.build) result.push({ id: "build", description: "Run the approved build.", required: true, satisfactionMode: "TRUSTED_PRODUCER" });
  return result;
}

function fingerprint(ref: string, provided?: string) {
  if (provided?.trim()) return provided.trim();
  let hash = 2166136261;
  for (const character of ref.trim().toLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `workspace-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function resolveExecutionContract(input: ContractResolutionInput): ExecutionContract {
  const workspaces = input.workspaces?.length ? input.workspaces : input.workspaceRef?.trim() ? [{
    id: legacyWorkspaceId, displayName: input.workspaceRef, role: "primary", referenceType: "LOCAL_PATH" as const, source: "MANUAL_UNVERIFIED" as const,
    reference: input.workspaceRef, fingerprint: input.workspaceFingerprint || `legacy-${legacyWorkspaceId}`, allowedPaths: input.allowedPaths,
    excludedPaths: input.excludedPaths, authorizationContext: "compatibility upgrade", ordering: 0,
    discoveryScopeMode: input.allowedPaths.length ? "SELECTED_PATHS" as const : input.taskMode === "CONTROLLED_AUDIT" ? "FULL_WORKSPACE" as const : "NONE" as const,
  }] : [];
  const normalizedWorkspaces = workspaces.map(workspace => {
    const discoveryScopeMode = effectiveDiscoveryScopeMode(workspace, input.taskMode);
    return {
      ...workspace,
      source: workspace.source ?? "MANUAL_UNVERIFIED" as const,
      discoveryScopeMode,
      effectiveReadBoundary: discoveryScopeMode === "FULL_WORKSPACE"
        ? "WORKSPACE_ROOT" as const
        : discoveryScopeMode === "SELECTED_PATHS"
          ? "SELECTED_PATHS" as const
          : "NONE" as const,
    };
  });
  const canonicalAllowedPaths = workspaceDisplayScope(normalizedWorkspaces, input.taskMode);
  const canonicalExcludedPaths = workspaceScopedPaths(normalizedWorkspaces, "excludedPaths").map(item => item.workspaceId === legacyWorkspaceId ? item.path : `${item.workspaceId}:${item.path}`);
  const policy = resolveAuthorization(input.taskMode, input.authorization);
  const normalized = normalizeScopeSelections({
    allowedPaths: canonicalAllowedPaths,
    excludedPaths: canonicalExcludedPaths,
    evidenceFiles: input.evidenceFiles,
  });
  const semantic = deriveTaskSemanticProfile({
    taskMode: input.taskMode,
    objective: input.objective,
    allowedPaths: normalized.allowedPaths,
    evidenceFiles: normalized.evidenceFiles,
    authorization: policy.effective,
    discoveryAssessment: input.discoveryResolution?.assessment,
  });
  const preliminaryRecommendation = evaluateConfiguration({
    providerId: input.providerId,
    modelId: input.modelId,
    reasoningProfile: input.reasoningProfile,
    runtimeProfileId: input.runtimeProfileId,
    task: semantic,
    ownerOverrideAccepted: input.ownerOverrideAccepted,
  });
  const automaticModelRouting = semantic.assessmentStatus === "ASSESSED"
    && !input.ownerOverrideAccepted
    && preliminaryRecommendation.recommendedModelId !== input.modelId
    && ["SUPPORTED_WITH_WARNING", "OWNER_DECISION_REQUIRED"].includes(preliminaryRecommendation.status);
  const selectedModelId = automaticModelRouting
    ? preliminaryRecommendation.recommendedModelId
    : input.modelId;
  const selectedModel = modelRegistry[selectedModelId];
  const selectedReasoningProfile = selectedModel.allowedReasoningProfiles.includes(input.reasoningProfile)
    ? input.reasoningProfile
    : selectedModel.defaultReasoningProfile;
  const evaluatedRecommendation = evaluateConfiguration({
    providerId: input.providerId,
    modelId: selectedModelId,
    reasoningProfile: selectedReasoningProfile,
    runtimeProfileId: input.runtimeProfileId,
    task: semantic,
    ownerOverrideAccepted: input.ownerOverrideAccepted,
  });
  const recommendation = automaticModelRouting ? {
    ...evaluatedRecommendation,
    reasons: [
      `IntentChord automatically routed from ${modelRegistry[input.modelId].displayName} to ${selectedModel.displayName} because no owner override was locked and the ${semantic.assessmentStatus.toLowerCase()} routing profile selected the recommended model.`,
      ...evaluatedRecommendation.reasons,
    ],
    recommendedActions: ["Continue with the automatically selected configuration."],
  } : evaluatedRecommendation;
  const agentResolution = resolveAgentContract({
    providerId: input.providerId,
    modelId: selectedModelId,
    executionChannelId: input.executionChannelId,
    reasoningProfile: selectedReasoningProfile,
    runtimeProfileId: input.runtimeProfileId,
    taskMode: input.taskMode,
    objective: input.objective,
    taskSemanticProfile: semantic,
    effectiveAuthorization: policy.effective,
    approvedEvidenceCount: normalized.evidenceFiles.length,
  });
  const requiredChecks = checks(input.taskMode, policy.effective, normalized.evidenceFiles.length);
  const ownerRequirements: ExecutionContract["executionPackage"]["mandatoryRequirements"] = (input.ownerRequirements ?? []).map(requirement => ({
    id: requirement.id,
    outcome: requirement.outcome,
    evidence: [`requirement:${requirement.id}`],
    gate: "owner-outcomes",
    requiredEvidenceTypes: requirement.requiredEvidenceTypes?.length
      ? requirement.requiredEvidenceTypes
      : input.taskMode === "SOURCE_IMPLEMENTATION"
        ? ["SOURCE", "VALIDATION"]
        : input.taskMode === "REPORT_REVIEW"
          ? ["ARTIFACT", "VALIDATION", "RUNTIME"]
          : ["SOURCE"],
    proofProfile: requirement.proofProfile,
  }));
  const mandatoryRequirements: ExecutionContract["executionPackage"]["mandatoryRequirements"] =
    ownerRequirements.length ? ownerRequirements : [{
      id: "objective",
      outcome: "Establish evidence-backed findings for the approved bounded objective.",
      evidence: ["objective", "report-closure"],
      gate: "owner-outcomes",
      requiredEvidenceTypes: input.taskMode === "SOURCE_IMPLEMENTATION"
        ? ["SOURCE", "VALIDATION"]
        : input.taskMode === "REPORT_REVIEW"
          ? ["ARTIFACT"]
          : ["SOURCE"],
      proofProfile: {
        sourceBehavior: input.taskMode !== "REPORT_REVIEW",
        positive: true,
        negativeAdversarial: input.taskMode === "SOURCE_IMPLEMENTATION",
        persistenceReload: input.taskMode === "SOURCE_IMPLEMENTATION",
      },
    }];
  const proofChecks: ExecutionContract["requiredChecks"] = mandatoryRequirements.flatMap(requirement => {
    const requiresTrustedExecutionEvidence = requirement.requiredEvidenceTypes.some(
      evidenceType => evidenceType === "VALIDATION" || evidenceType === "RUNTIME",
    );
    if (!requiresTrustedExecutionEvidence) return [];
    const categories: Array<[string, string, boolean]> = [
      ["source-behavior", "actual source behavior", requirement.proofProfile.sourceBehavior],
      ["positive", "positive-path proof", requirement.proofProfile.positive],
      ["negative-adversarial", "negative/adversarial proof", requirement.proofProfile.negativeAdversarial],
      ["persistence-reload", "persistence/reload proof", requirement.proofProfile.persistenceReload],
    ];
    return categories
      .filter(([, , required]) => required)
      .map(([category, label]) => ({
        id: `requirement:${requirement.id}:${category}`,
        description: `Independently validate ${label} for mandatory requirement ${requirement.id}.`,
        required: true,
        satisfactionMode: "TRUSTED_PRODUCER" as const,
      }));
  });
  const allRequiredChecks = [...requiredChecks, ...proofChecks];

  const modeContinuation = input.taskMode === "CONTROLLED_AUDIT"
    ? "Continue the remaining authorized audit and source inspection; do not repair source."
    : input.taskMode === "REPORT_REVIEW"
      ? "Continue the remaining authorized report and evidence review; do not inspect source unless separately authorized."
      : "Continue the remaining authorized source implementation and validation.";
  const stopConditions = [
    "HARD_EXECUTION_BLOCKER: stop only when an authorized action cannot safely continue because authority, required access, owner scope, workspace integrity, or protected external-database safety is unresolved.",
    `VALIDATION_GATE_FAILURE: record the proven failed gate separately. ${modeContinuation}`,
    "TOOL_OR_RUNNER_TIMEOUT: record an inconclusive timeout as EVIDENCE_REQUIRED, preserve captured output, and request a bounded rerun when needed.",
    "Stop for report/run identity or approved execution-configuration mismatch.",
  ];

  return {
    schemaVersion: "0.2",
    policyVersion,
    contractId: input.contractId,
    title: input.title ?? (input.objective || "Local IntentChord task"),
    objective: input.objective,
    taskMode: input.taskMode,
    ...(input.intentResolution ? { intentResolution: input.intentResolution } : {}),
    ...(input.discoveryResolution ? { discoveryResolution: input.discoveryResolution } : {}),
    executionPackage: {
      governanceProfile: { id: "intentchord-stable-governance", version: "1.0" },
      mandatoryRequirements,
      gates: [
        { id: "owner-outcomes", exitCriteria: ["Every Owner-defined mandatory outcome is classified against its frozen required evidence types; missing proof remains EVIDENCE_REQUIRED."] },
        { id: "source-completeness", exitCriteria: [input.taskMode === "SOURCE_IMPLEMENTATION" ? "Every mandatory source requirement is implemented or a proven STOP_FOR_OWNER condition is recorded." : "Every mandatory audit or review requirement is inspected and reported without unauthorized repair."] },
        { id: "validation", exitCriteria: ["Every required validation is mapped to a result or EVIDENCE_REQUIRED evidence."] },
      ],
      completionLock: { executionState: "CONTINUE", rule: "Do not issue a final report while a safely repairable mandatory requirement remains open; use STOP_FOR_OWNER only for a proven hard blocker." },
    },
    scope: {
      workspaces: normalizedWorkspaces.map(workspace => ({ ...workspace, fingerprint: fingerprint(workspace.reference, workspace.fingerprint) })),
      workspaceRef: normalizedWorkspaces.map(workspace => workspace.reference).join(" | "),
      workspaceSource: (() => { const values = [...new Set(normalizedWorkspaces.map(workspace => workspace.source))]; return values.length === 1 ? values[0]! : "MIXED" as const; })(),
      workspaceFingerprint: normalizedWorkspaces.map(workspace => fingerprint(workspace.reference, workspace.fingerprint)).join("|"),
      allowedPaths: normalized.allowedPaths,
      excludedPaths: normalized.excludedPaths,
      evidenceFiles: normalized.evidenceFiles,
      evidenceReadOnly: true,
      normalization: {
        removedRedundantEntries: normalized.removedRedundantEntries,
        conflicts: normalized.conflicts,
      },
    },
    authorization: input.authorization,
    policyDecisionTrace: policy.trace,
    allowedActions: policy.trace.filter(item => item.effective).map(item => labels[item.capability]),
    forbiddenActions: policy.trace.filter(item => !item.effective).map(item => labels[item.capability]),
    evidenceIdentity: input.identity ? { sessionId: input.identity, unknownFields: [] } : {},
    evidenceIdentityState: input.identity ? "BOUND" : "NOT_ESTABLISHED",
    taskSemanticProfile: semantic,
    selectedConfiguration: {
      providerId: input.providerId,
      modelId: selectedModelId,
      executionChannelId: input.executionChannelId,
      reasoningProfile: selectedReasoningProfile,
      runtimeProfileId: input.runtimeProfileId,
      ownerOverrideAccepted: input.ownerOverrideAccepted,
      ...(input.ownerOverrideAccepted && input.ownerOverrideReason?.trim()
        ? { ownerOverrideReason: input.ownerOverrideReason.trim() }
        : {}),
    },
    configurationRecommendation: recommendation,
    requiredChecks: allRequiredChecks,
    closureCriteria: [{
      id: "report-closure",
      description: "Every required check is independently proven and the required report content is present.",
      evidenceRequired: allRequiredChecks.map(item => item.id),
    }],
    stopConditions,
    requiredReportSections: [...reportSectionIds],
    ownerApproval: { required: true, state: "AWAITING_OWNER_APPROVAL" },
    agentResolution,
  };
}
