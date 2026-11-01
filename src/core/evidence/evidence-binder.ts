import {
  proofEvidenceRefSchema,
  type EvidenceAwareFindingStatus,
  type ProofEvidenceRef,
} from "@/core/evidence/evidence-types";
import type { EvidenceType } from "@/core/intelligence/intent-schema";
import { validateFindingEvidence } from "@/core/evidence/proof-policy";

export type EvidenceBindingInput = {
  requirementId: string;
  claim: string;
  status: EvidenceAwareFindingStatus;
  requiredEvidenceTypes: EvidenceType[];
  evidenceRefs: ProofEvidenceRef[];
};

export type EvidenceBindingResult = EvidenceBindingInput & {
  accepted: boolean;
  issues: string[];
};

export function bindFindingEvidence(input: EvidenceBindingInput): EvidenceBindingResult {
  const evidenceRefs = input.evidenceRefs.map(reference => proofEvidenceRefSchema.parse(reference));
  const issues = validateFindingEvidence({
    status: input.status,
    evidenceRefs,
    requiredEvidenceTypes: input.requiredEvidenceTypes,
  });
  return {
    ...input,
    evidenceRefs,
    accepted: issues.length === 0,
    issues,
  };
}
