import type { ExecutionContract } from "@/core/contracts/execution-contract";
import { normalizeContractPath } from "@/core/policies/path-authority";
import { lintResolvedContract } from "@/core/prompts/governance";

export type PreflightIssue = {
  code: string;
  severity: "BLOCKER" | "VIOLATION";
  message: string;
  field: string;
  recommendedCorrection: string;
};

const runtimeSensitive = /(runtime|startup|session|process|release|telemetry|تشغيل|جلسة|عملية|إصدار)/i;

export function validatePreflight(contract: ExecutionContract): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const add = (
    code: string,
    message: string,
    field: string,
    recommendedCorrection: string,
    severity: PreflightIssue["severity"] = "BLOCKER",
  ) => issues.push({ code, severity, message, field, recommendedCorrection });

  if (contract.scope.workspaces.length === 0) add("MISSING_WORKSPACE", "At least one structured workspace reference is required.", "scope.workspaces", "Add a bounded workspace reference.");
  for (const workspace of contract.scope.workspaces) {
    if (!workspace.reference.trim() || !workspace.fingerprint.trim()) add("INVALID_WORKSPACE_REFERENCE", `Workspace ${workspace.displayName} requires a reference and fingerprint.`, `scope.workspaces.${workspace.id}`, "Provide the bounded reference and provenance fingerprint.");
    if (workspace.discoveryScopeMode === "SELECTED_PATHS" && workspace.allowedPaths.length === 0) {
      add("MISSING_WORKSPACE_SCOPE", `Workspace ${workspace.displayName} uses selected-path discovery but has no approved paths.`, `scope.workspaces.${workspace.id}.allowedPaths`, "Select at least one bounded path or authorize full-workspace read-only discovery.");
    }
    if (workspace.discoveryScopeMode !== "SELECTED_PATHS" && workspace.allowedPaths.length > 0) {
      add("AMBIGUOUS_WORKSPACE_SCOPE", `Workspace ${workspace.displayName} carries explicit paths outside selected-path mode.`, `scope.workspaces.${workspace.id}`, "Use selected-path mode or remove the explicit paths.", "VIOLATION");
    }
  }
  if (contract.authorization.readFiles && contract.scope.workspaces.every(workspace => workspace.discoveryScopeMode === "NONE")) {
    add("MISSING_APPROVED_SCOPE", "The task has no approved discovery/read boundary.", "scope.workspaces", "Authorize full-workspace discovery or selected paths for at least one Workspace.");
  }
  if (contract.authorization.modifySource && contract.scope.workspaces.some(workspace => workspace.discoveryScopeMode === "FULL_WORKSPACE")) {
    add("FULL_WORKSPACE_MODIFICATION_FORBIDDEN", "Full-workspace discovery is read-only and cannot become an implicit modification boundary.", "scope.workspaces", "Use explicit selected paths for source modification.", "VIOLATION");
  }

  // Controlled audits and report reviews may start from a bounded discovery/read scope
  // without preselected supporting evidence. Evidence must be extracted and cited by the
  // executor; it is not a prerequisite that forces the owner to know the root-cause file.
  const evidenceRequired = contract.taskMode === "SOURCE_IMPLEMENTATION"
    && runtimeSensitive.test(contract.objective);
  if (evidenceRequired && contract.scope.evidenceFiles.length === 0) {
    add("MISSING_EVIDENCE_SOURCE", "Runtime-sensitive source implementation requires an approved evidence source.", "scope.evidenceFiles", "Select the relevant runtime evidence or attach a local evidence file.");
  }

  // Evidence identity is bound when a Run is created or evidence is imported.
  // Discovery-first work must not force the owner to invent an identity before evidence exists.
  if (contract.scope.normalization.conflicts.length) {
    const evidence = contract.scope.normalization.conflicts.some(item => item.startsWith("Evidence path"));
    add(evidence ? "EVIDENCE_SCOPE_CONFLICT" : "SCOPE_CONFLICT", contract.scope.normalization.conflicts.join(" "), "scope", "Resolve the conflicting path roles before generating a contract.", "VIOLATION");
  }
  if (contract.taskMode === "CONTROLLED_AUDIT" && contract.authorization.modifySource) add("AUDIT_MODIFICATION", "A controlled audit cannot modify source.", "authorization.modifySource", "Disable source modification.", "VIOLATION");
  if (contract.authorization.deploy || contract.authorization.writeDatabase) add("MVP_SENSITIVE_ACTION", "Deployment and database writes are not available under the current governed policy.", "authorization", "Disable the sensitive action.", "VIOLATION");
  if (contract.configurationRecommendation.status === "BLOCKED") add("MODEL_CONFIGURATION_BLOCKED", contract.configurationRecommendation.reasons.join(" "), "selectedConfiguration", contract.configurationRecommendation.recommendedActions.join(" "), "VIOLATION");
  if (["SUPPORTED_WITH_WARNING", "OWNER_DECISION_REQUIRED"].includes(contract.configurationRecommendation.status) && !contract.selectedConfiguration.ownerOverrideAccepted) {
    add("MODEL_RECOMMENDATION_ACK_REQUIRED", "The selected model configuration requires an explicit owner decision before approval.", "selectedConfiguration.ownerOverrideAccepted", `Use the recommended model (${contract.configurationRecommendation.recommendedModelId}) or explicitly accept the warning.`);
  }
  if (contract.ownerApproval.state !== "APPROVED") add("MISSING_OWNER_APPROVAL", "Owner approval is required before execution.", "ownerApproval.state", "Obtain explicit owner approval.");
  if (contract.agentResolution.unsupportedEffectiveCapabilities.length) add("AGENT_CAPABILITY_UNSUPPORTED", `The execution channel does not support: ${contract.agentResolution.unsupportedEffectiveCapabilities.join(", ")}.`, "agentResolution.unsupportedEffectiveCapabilities", "Choose a supported configuration or reduce authorization.", "VIOLATION");
  for (const lint of lintResolvedContract(contract)) add(`CONTRACT_LINT_${lint.code}`, lint.message, "agentResolution", "Resolve the executable contract contradiction or missing execution boundary before approval.", lint.severity);
  if (contract.scope.allowedPaths.concat(contract.scope.excludedPaths, contract.scope.evidenceFiles).some(path => !normalizeContractPath(path))) add("INVALID_SCOPE_PATH", "Scope paths must be normalized and cannot contain parent traversal.", "scope", "Use relative normalized paths without .. segments.", "VIOLATION");
  return issues;
}
