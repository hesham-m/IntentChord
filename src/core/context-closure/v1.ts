import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import {
  CONTEXT_CLOSURE_CONTRACT_VERSION,
  CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,
  type BackendGapClassification,
  type ContextClosureEvaluationV1,
  type ModelContextAnalysisV2,
} from "@/core/ai-context-mapper/v2";

export function classifyMissingEvidenceRequestV2(
  gap: ModelContextAnalysisV2["missing_evidence_requests"][number],
): BackendGapClassification {
  if (gap.gap_type === "INTERNAL_SOURCE" && gap.materiality === "BLOCKING") return "BLOCKING_INTERNAL_SOURCE_GAP";
  if (gap.gap_type === "EXTERNAL_DEPENDENCY") return "EXTERNAL_DEPENDENCY";
  if (gap.gap_type === "OPTIONAL_CONTEXT_GAP") return "OPTIONAL_CONTEXT_GAP";
  return "NON_BLOCKING_UNRESOLVED";
}

export type AdmittedMissingEvidenceRequestFact = {
  id: string;
  requestSha256: string;
};

export type BackendGapClassificationFact = {
  id: string;
  requestId: string;
  classificationSha256: string;
};

export type AuthoritativeMissingInternalRequirementOverlap = {
  requirementId: string;
  affectedComponentIds: string[];
  affectedRelationshipIds: string[];
};

export function hasOverlappingAuthoritativeMissingInternalRequirement(
  contradiction: Pick<ModelContextAnalysisV2["material_contradictions"][number], "affected_component_ids" | "affected_relationship_ids">,
  requirements: AuthoritativeMissingInternalRequirementOverlap[],
): boolean {
  return requirements.some(requirement =>
    requirement.affectedComponentIds.some(id => contradiction.affected_component_ids.includes(id))
    || requirement.affectedRelationshipIds.some(id => contradiction.affected_relationship_ids.includes(id)),
  );
}

export function exactMissingEvidenceClassificationCoverage(input: {
  requests: AdmittedMissingEvidenceRequestFact[];
  classifications: BackendGapClassificationFact[];
}): {
  pass: boolean;
  missingEvidenceRequestCount: number;
  backendClassificationCount: number;
  unclassifiedMissingEvidenceCount: number;
  duplicateClassificationRequestCount: number;
  extraneousClassificationCount: number;
} {
  const requestIds = new Set(input.requests.map(item => item.id));
  const classificationCounts = new Map<string, number>();
  let extraneousClassificationCount = 0;
  for (const classification of input.classifications) {
    if (!requestIds.has(classification.requestId)) {
      extraneousClassificationCount += 1;
      continue;
    }
    classificationCounts.set(classification.requestId, (classificationCounts.get(classification.requestId) ?? 0) + 1);
  }
  let unclassifiedMissingEvidenceCount = 0;
  let duplicateClassificationRequestCount = 0;
  for (const request of input.requests) {
    const count = classificationCounts.get(request.id) ?? 0;
    if (count === 0) unclassifiedMissingEvidenceCount += 1;
    if (count > 1) duplicateClassificationRequestCount += 1;
  }
  const pass = unclassifiedMissingEvidenceCount === 0
    && duplicateClassificationRequestCount === 0
    && extraneousClassificationCount === 0
    && input.requests.length === input.classifications.length;
  return {
    pass,
    missingEvidenceRequestCount: input.requests.length,
    backendClassificationCount: input.classifications.length,
    unclassifiedMissingEvidenceCount,
    duplicateClassificationRequestCount,
    extraneousClassificationCount,
  };
}

export type ContextClosureGovernanceInputV1 = {
  contextAssemblyRevisionId: string;
  assemblySha256: string;
  mappingIterationId: string;
  mappingResultSha256: string;
  persistedSourceCount: number;
  mappingInputSourceCount: number;
  admittedMissingEvidenceRequests: AdmittedMissingEvidenceRequestFact[];
  classifications: BackendGapClassificationFact[];
  openBlockingRequirements: Array<{ id: string; requirementSha256: string; requirementType: "MISSING_INTERNAL_EVIDENCE" | "SOURCE_TRUTH_CONFLICT" }>;
  resolutionFactHashes: string[];
  activeQualificationScope?: string;
  qualificationId?: string;
  capabilityProfileVersion?: string;
  engineConfigurationSha256?: string;
  existingAcceptedCatalogId?: string;
  currentEffectiveContextAuthorityProven: boolean;
  currentTaskSourceSetSha256?: string;
  currentSourceAuthoritySha256?: string;
};

export function buildContextClosureEvaluationInputIdentityV1(input: ContextClosureGovernanceInputV1): string {
  return mapperSha256({
    contract_version: CONTEXT_CLOSURE_CONTRACT_VERSION,
    context_assembly_revision_id: input.contextAssemblyRevisionId,
    assembly_sha256: input.assemblySha256,
    mapping_iteration_id: input.mappingIterationId,
    mapping_result_sha256: input.mappingResultSha256,
    admitted_missing_evidence_requests: [...input.admittedMissingEvidenceRequests].sort((a,b)=>a.id.localeCompare(b.id)),
    backend_gap_classifications: [...input.classifications].sort((a,b)=>
      a.requestId.localeCompare(b.requestId) || a.id.localeCompare(b.id),
    ),
    open_blocking_resolution_requirements: [...input.openBlockingRequirements].sort((a,b)=>a.id.localeCompare(b.id)),
    resolution_fact_hashes: [...input.resolutionFactHashes].sort(),
    exact_v2_qualification: {
      qualification_scope: input.activeQualificationScope ?? null,
      qualification_id: input.qualificationId ?? null,
      capability_profile_version: input.capabilityProfileVersion ?? null,
      engine_configuration_sha256: input.engineConfigurationSha256 ?? null,
    },
    existing_accepted_catalog_id: input.existingAcceptedCatalogId ?? null,
    current_effective_context_authority: {
      proven: input.currentEffectiveContextAuthorityProven,
      task_source_set_sha256: input.currentTaskSourceSetSha256 ?? null,
      source_authority_sha256: input.currentSourceAuthoritySha256 ?? null,
    },
  });
}

export function evaluateContextClosureV1(input: ContextClosureGovernanceInputV1): ContextClosureEvaluationV1 {
  const gates: ContextClosureEvaluationV1["gates"] = [];
  const add=(gate:string,status:"PASS"|"FAIL",evidence?:string)=>gates.push({gate,status,...(evidence?{evidence}:{})});
  add(
    "ALL_SOURCES_READY_CANONICAL_INDEX",
    input.persistedSourceCount>0 && input.persistedSourceCount===input.mappingInputSourceCount ? "PASS":"FAIL",
    `persisted_sources=${input.persistedSourceCount};mapping_input_sources=${input.mappingInputSourceCount}`,
  );
  add("EXACT_MAPPING_ITERATION_BOUND", Boolean(input.mappingIterationId && input.mappingResultSha256) ? "PASS":"FAIL");
  const classificationCoverage = exactMissingEvidenceClassificationCoverage({
    requests: input.admittedMissingEvidenceRequests,
    classifications: input.classifications,
  });
  add(
    "ALL_MISSING_EVIDENCE_REQUESTS_BACKEND_CLASSIFIED",
    classificationCoverage.pass ? "PASS":"FAIL",
    [
      `missing_evidence_requests=${classificationCoverage.missingEvidenceRequestCount}`,
      `backend_classifications=${classificationCoverage.backendClassificationCount}`,
      `unclassified_missing_evidence=${classificationCoverage.unclassifiedMissingEvidenceCount}`,
      `duplicate_classification_requests=${classificationCoverage.duplicateClassificationRequestCount}`,
      `extraneous_classifications=${classificationCoverage.extraneousClassificationCount}`,
    ].join(";"),
  );
  add(
    "NO_OPEN_BLOCKING_CONTEXT_RESOLUTION_REQUIREMENT",
    input.openBlockingRequirements.length===0 ? "PASS":"FAIL",
    `open_requirements=${input.openBlockingRequirements.length}`,
  );
  add(
    "AI_CONTEXT_MAPPING_V2_EXACT_QUALIFICATION",
    input.activeQualificationScope===CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE
      && Boolean(input.qualificationId)
      && Boolean(input.capabilityProfileVersion)
      && Boolean(input.engineConfigurationSha256)
      ? "PASS":"FAIL",
  );
  add(
    "CURRENT_EFFECTIVE_CONTEXT_AUTHORITY",
    input.currentEffectiveContextAuthorityProven && Boolean(input.currentTaskSourceSetSha256) && Boolean(input.currentSourceAuthoritySha256) ? "PASS" : "FAIL",
    `task_source_set=${input.currentTaskSourceSetSha256 ?? "UNPROVEN"};source_authority=${input.currentSourceAuthoritySha256 ?? "UNPROVEN"}`,
  );
  add(
    "NO_CONTRADICTORY_ACCEPTED_CATALOG",
    input.existingAcceptedCatalogId ? "FAIL":"PASS",
    input.existingAcceptedCatalogId ? `catalog=${input.existingAcceptedCatalogId}`:undefined,
  );
  const decision=gates.every(g=>g.status==="PASS")?"PASS":"BLOCKED";
  return {
    contract_version:CONTEXT_CLOSURE_CONTRACT_VERSION,
    context_assembly_revision_id:input.contextAssemblyRevisionId,
    mapping_iteration_id:input.mappingIterationId,
    evaluation_input_sha256:buildContextClosureEvaluationInputIdentityV1(input),
    decision,
    reason_code:decision==="PASS"?"GOVERNED_CONTEXT_CLOSED":"CONTEXT_RESOLUTION_OR_GOVERNANCE_REQUIRED",
    gates,
  };
}
