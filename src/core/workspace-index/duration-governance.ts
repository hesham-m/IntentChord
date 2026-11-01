export const WORKSPACE_DURATION_POLICY_ID = "intentchord.workspace-duration-governance/v3" as const;
export const SOURCE_AUTHORITY_MAX_MS = 120_000;
export const DISCOVERY_MAX_MS = 120_000;
export const PROCESSING_BASE_MS = 30_000;
export const PROCESSING_GOVERNED_BYTES_PER_SECOND = 12 * 1024 * 1024;
export const PROCESSING_PER_FILE_MS = 40;
export const PROCESSING_MIN_MS = 120_000;
export const PROCESSING_MAX_MS = 1_500_000;
export const FINALIZATION_MAX_MS = 120_000;
export const ABSOLUTE_OPERATION_MAX_MS = 1_800_000;

export type WorkspaceDurationGovernancePhase = "SOURCE_AUTHORITY" | "DISCOVERY" | "PROCESSING" | "FINALIZATION";

export type WorkspaceDurationPhaseAuthority = {
  durationPolicyId: string;
  governancePhase: WorkspaceDurationGovernancePhase;
  phaseStartedAtMs: number;
  phaseBudgetMs: number;
  phaseDeadlineAt: number;
  absoluteOperationDeadlineAt: number;
};

export type WorkspaceDurationGovernance = {
  durationPolicyId: string;
  sourceAuthorityMaxMs: number;
  discoveryMaxMs: number;
  processingBaseMs: number;
  processingGovernedBytesPerSecond: number;
  processingPerFileMs: number;
  processingMinMs: number;
  processingMaxMs: number;
  finalizationMaxMs: number;
  absoluteOperationMaxMs: number;
};

export const DEFAULT_WORKSPACE_DURATION_GOVERNANCE: Readonly<WorkspaceDurationGovernance> = Object.freeze({
  durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
  sourceAuthorityMaxMs: SOURCE_AUTHORITY_MAX_MS,
  discoveryMaxMs: DISCOVERY_MAX_MS,
  processingBaseMs: PROCESSING_BASE_MS,
  processingGovernedBytesPerSecond: PROCESSING_GOVERNED_BYTES_PER_SECOND,
  processingPerFileMs: PROCESSING_PER_FILE_MS,
  processingMinMs: PROCESSING_MIN_MS,
  processingMaxMs: PROCESSING_MAX_MS,
  finalizationMaxMs: FINALIZATION_MAX_MS,
  absoluteOperationMaxMs: ABSOLUTE_OPERATION_MAX_MS,
});

export type WorkspaceProcessingDurationDecision = {
  durationPolicyId: string;
  discoveredFiles: number;
  discoveredBytes: number;
  byteAllowanceMs: number;
  fileAllowanceMs: number;
  rawProcessingBudgetMs: number;
  derivedProcessingBudgetMs: number;
  absoluteOperationMaxMs: number;
};

export type WorkspaceDurationConfigurationIdentity = {
  duration_policy_id: string;
  source_authority_max_ms: number;
  discovery_max_ms: number;
  processing_base_ms: number;
  processing_governed_bytes_per_second: number;
  processing_per_file_ms: number;
  processing_min_ms: number;
  processing_max_ms: number;
  finalization_max_ms: number;
  absolute_operation_max_ms: number;
};

function requireSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`WORKSPACE_DURATION_POLICY_INVALID:${name}`);
}

export function assertWorkspaceDurationGovernance(policy: WorkspaceDurationGovernance): void {
  if (!policy.durationPolicyId.trim()) throw new Error("WORKSPACE_DURATION_POLICY_INVALID:durationPolicyId");
  requireSafeNonNegativeInteger(policy.sourceAuthorityMaxMs, "sourceAuthorityMaxMs");
  requireSafeNonNegativeInteger(policy.discoveryMaxMs, "discoveryMaxMs");
  requireSafeNonNegativeInteger(policy.processingBaseMs, "processingBaseMs");
  requireSafeNonNegativeInteger(policy.processingGovernedBytesPerSecond, "processingGovernedBytesPerSecond");
  requireSafeNonNegativeInteger(policy.processingPerFileMs, "processingPerFileMs");
  requireSafeNonNegativeInteger(policy.processingMinMs, "processingMinMs");
  requireSafeNonNegativeInteger(policy.processingMaxMs, "processingMaxMs");
  requireSafeNonNegativeInteger(policy.finalizationMaxMs, "finalizationMaxMs");
  requireSafeNonNegativeInteger(policy.absoluteOperationMaxMs, "absoluteOperationMaxMs");
  if (policy.processingGovernedBytesPerSecond === 0) throw new Error("WORKSPACE_DURATION_POLICY_INVALID:processingGovernedBytesPerSecond");
  if (policy.processingMinMs > policy.processingMaxMs) throw new Error("WORKSPACE_DURATION_POLICY_INVALID:processingMinMs>processingMaxMs");
}

export function workspaceDurationConfigurationIdentity(
  policy: WorkspaceDurationGovernance = DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
): WorkspaceDurationConfigurationIdentity {
  assertWorkspaceDurationGovernance(policy);
  return {
    duration_policy_id: policy.durationPolicyId,
    source_authority_max_ms: policy.sourceAuthorityMaxMs,
    discovery_max_ms: policy.discoveryMaxMs,
    processing_base_ms: policy.processingBaseMs,
    processing_governed_bytes_per_second: policy.processingGovernedBytesPerSecond,
    processing_per_file_ms: policy.processingPerFileMs,
    processing_min_ms: policy.processingMinMs,
    processing_max_ms: policy.processingMaxMs,
    finalization_max_ms: policy.finalizationMaxMs,
    absolute_operation_max_ms: policy.absoluteOperationMaxMs,
  };
}

export function deriveWorkspaceProcessingDurationBudget(
  input: { discoveredBytes: number; discoveredFiles: number },
  policy: WorkspaceDurationGovernance = DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
): WorkspaceProcessingDurationDecision {
  assertWorkspaceDurationGovernance(policy);
  requireSafeNonNegativeInteger(input.discoveredBytes, "discoveredBytes");
  requireSafeNonNegativeInteger(input.discoveredFiles, "discoveredFiles");
  const byteAllowanceMs = Math.ceil((input.discoveredBytes * 1000) / policy.processingGovernedBytesPerSecond);
  const fileAllowanceMs = input.discoveredFiles * policy.processingPerFileMs;
  if (!Number.isSafeInteger(fileAllowanceMs)) throw new Error("WORKSPACE_DURATION_WORKLOAD_INVALID:fileAllowanceMs");
  const rawProcessingBudgetMs = policy.processingBaseMs + byteAllowanceMs + fileAllowanceMs;
  if (!Number.isSafeInteger(rawProcessingBudgetMs)) throw new Error("WORKSPACE_DURATION_WORKLOAD_INVALID:rawProcessingBudgetMs");
  const derivedProcessingBudgetMs = Math.min(
    policy.processingMaxMs,
    Math.max(policy.processingMinMs, rawProcessingBudgetMs),
  );
  return {
    durationPolicyId: policy.durationPolicyId,
    discoveredFiles: input.discoveredFiles,
    discoveredBytes: input.discoveredBytes,
    byteAllowanceMs,
    fileAllowanceMs,
    rawProcessingBudgetMs,
    derivedProcessingBudgetMs,
    absoluteOperationMaxMs: policy.absoluteOperationMaxMs,
  };
}

export function workspaceAbsoluteOperationDeadlineAt(
  attemptStartedAtMs: number,
  policy: WorkspaceDurationGovernance = DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
): number {
  assertWorkspaceDurationGovernance(policy);
  requireSafeNonNegativeInteger(attemptStartedAtMs, "attemptStartedAtMs");
  const deadline = attemptStartedAtMs + policy.absoluteOperationMaxMs;
  if (!Number.isSafeInteger(deadline)) throw new Error("WORKSPACE_DURATION_DEADLINE_INVALID:absoluteOperationDeadlineAt");
  return deadline;
}

export function workspacePhaseDeadlineAt(input: {
  phaseStartedAtMs: number;
  phaseBudgetMs: number;
  absoluteOperationDeadlineAt: number;
}): number {
  requireSafeNonNegativeInteger(input.phaseStartedAtMs, "phaseStartedAtMs");
  requireSafeNonNegativeInteger(input.phaseBudgetMs, "phaseBudgetMs");
  requireSafeNonNegativeInteger(input.absoluteOperationDeadlineAt, "absoluteOperationDeadlineAt");
  const phaseDeadline = input.phaseStartedAtMs + input.phaseBudgetMs;
  if (!Number.isSafeInteger(phaseDeadline)) throw new Error("WORKSPACE_DURATION_DEADLINE_INVALID:phaseDeadlineAt");
  return Math.min(phaseDeadline, input.absoluteOperationDeadlineAt);
}
