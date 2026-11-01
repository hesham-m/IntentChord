export type RequirementEvidenceType = "SOURCE" | "ARTIFACT" | "VALIDATION" | "RUNTIME";

export type RequirementProofProfile = {
  sourceBehavior: boolean;
  positive: boolean;
  negativeAdversarial: boolean;
  persistenceReload: boolean;
};

/**
 * Preserve an Owner-explicit proof policy exactly. For planner-inferred
 * requirements, derive only proof categories that the frozen evidence classes
 * can actually establish. A SOURCE-only inferred requirement must never gain a
 * persistence/reload obligation merely because the surrounding Task is an
 * implementation Task.
 */
export function resolveRequirementProofProfile(
  requiredEvidenceTypes: readonly RequirementEvidenceType[],
  explicitOwnerProfile?: RequirementProofProfile,
): RequirementProofProfile {
  if (explicitOwnerProfile) return { ...explicitOwnerProfile };

  const evidenceTypes = new Set(requiredEvidenceTypes);
  const requiresTrustedExecutionEvidence = evidenceTypes.has("VALIDATION")
    || evidenceTypes.has("RUNTIME");

  return {
    sourceBehavior: evidenceTypes.has("SOURCE"),
    positive: true,
    negativeAdversarial: requiresTrustedExecutionEvidence,
    persistenceReload: evidenceTypes.has("RUNTIME"),
  };
}
