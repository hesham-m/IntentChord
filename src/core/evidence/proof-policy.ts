import type { EvidenceType } from "@/core/intelligence/intent-schema";
import type {
  EvidenceAwareFindingStatus,
  ProofEvidenceKind,
  ProofEvidenceRef,
} from "@/core/evidence/evidence-types";

const evidenceTypeToKinds: Record<EvidenceType, ProofEvidenceKind[]> = {
  SOURCE: ["SOURCE_EVIDENCE"],
  ARTIFACT: ["ARTIFACT_EVIDENCE"],
  VALIDATION: ["VALIDATION_EVIDENCE"],
  RUNTIME: ["RUNTIME_EVIDENCE"],
};

const provenStatusKind: Partial<Record<EvidenceAwareFindingStatus, ProofEvidenceKind>> = {
  PROVEN_BY_SOURCE: "SOURCE_EVIDENCE",
  PROVEN_BY_ARTIFACT: "ARTIFACT_EVIDENCE",
  PROVEN_BY_VALIDATION: "VALIDATION_EVIDENCE",
  PROVEN_BY_RUNTIME: "RUNTIME_EVIDENCE",
};

export function requiredEvidenceKinds(requiredEvidenceTypes: EvidenceType[]): Set<ProofEvidenceKind> {
  return new Set(requiredEvidenceTypes.flatMap(type => evidenceTypeToKinds[type]));
}

/**
 * Finding references may include additional evidence classes. The requirement-level
 * policy decides which classes are mandatory for closure; this function only prevents
 * a typed PROVEN status from being backed by the wrong evidence class.
 */
export function validateFindingEvidence(input: {
  status: EvidenceAwareFindingStatus;
  evidenceRefs: ProofEvidenceRef[];
  requiredEvidenceTypes: EvidenceType[];
}): string[] {
  const issues: string[] = [];
  void requiredEvidenceKinds(input.requiredEvidenceTypes);

  const requiredKind = provenStatusKind[input.status];
  if (requiredKind && !input.evidenceRefs.some(reference => reference.kind === requiredKind)) {
    issues.push(`PROVEN_STATUS_REQUIRES_${requiredKind}`);
  }
  if ((input.status === "NOT_PROVEN" || input.status === "EVIDENCE_REQUIRED")
    && input.evidenceRefs.length === 0) {
    return issues;
  }
  if (input.status === "CONTRADICTED" && input.evidenceRefs.length === 0) {
    issues.push("CONTRADICTED_FINDING_REQUIRES_EVIDENCE");
  }
  return issues;
}

export function evidenceTypeCanProveClaim(
  evidenceType: EvidenceType,
  claimClass: "SOURCE" | "ARTIFACT" | "VALIDATION" | "RUNTIME",
): boolean {
  return evidenceType === claimClass;
}
