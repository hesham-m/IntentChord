import type { MappingRunStatus } from "@/core/ai-context-mapper/types";

const transitions: Readonly<Record<MappingRunStatus, readonly MappingRunStatus[]>> = Object.freeze({
  CREATED: ["INPUT_VALIDATED"],
  INPUT_VALIDATED: ["PRIMARY_RUNNING"],
  PRIMARY_RUNNING: ["VALIDATING", "PRIMARY_FAILED_TECHNICAL", "FAILED"],
  PRIMARY_FAILED_TECHNICAL: ["STANDBY_BLOCKED_GOVERNANCE", "STANDBY_RUNNING"],
  STANDBY_BLOCKED_GOVERNANCE: [],
  STANDBY_RUNNING: ["VALIDATING", "FAILED"],
  VALIDATING: ["AWAITING_OWNER_REVIEW", "ANALYSIS_COMPLETE", "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE", "REJECTED_VALIDATION", "FAILED"],
  AWAITING_OWNER_REVIEW: ["OWNER_ACCEPTED", "OWNER_REJECTED"],
  REJECTED_VALIDATION: [],
  FAILED: [],
  OWNER_ACCEPTED: [],
  OWNER_REJECTED: [],
  ANALYSIS_COMPLETE: [],
  ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE: [],
});

export function isAllowedMappingRunTransition(from: MappingRunStatus, to: MappingRunStatus): boolean {
  return transitions[from].includes(to);
}

export function assertMappingRunTransition(from: MappingRunStatus, to: MappingRunStatus): void {
  if (!isAllowedMappingRunTransition(from, to)) {
    throw new Error(`AI_CONTEXT_MAPPING_RUN_TRANSITION_BLOCKED:${from}->${to}`);
  }
}
