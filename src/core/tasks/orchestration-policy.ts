export function usesUnifiedGovernedTaskLifecycle(orchestrationVersion: string | undefined): boolean {
  return orchestrationVersion === "UNIFIED_V1";
}

/**
 * Legacy Intent Planner + bounded Plane-A discovery are compatibility prerequisites only.
 * UNIFIED_V1 derives execution context from Canonical Workspace Index + Internal AI Context
 * Mapping + Owner Work Selection + Backend Candidate Scope + Owner Scope Confirmation.
 */
export function requiresLegacyIntentAndDiscovery(orchestrationVersion: string | undefined): boolean {
  return !usesUnifiedGovernedTaskLifecycle(orchestrationVersion);
}
