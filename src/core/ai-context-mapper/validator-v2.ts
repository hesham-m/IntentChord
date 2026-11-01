import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { modelContextAnalysisV2Schema } from "@/core/ai-context-mapper/schema-v2";
import { MAX_MODEL_OUTPUT_ESTIMATED_TOKENS } from "@/core/ai-context-mapper/types";
import type {
  ContextAssemblyMappingInputV2,
  ContextMappingV2ValidationGate,
  ContextMappingV2ValidationResult,
  ModelContextAnalysisV2,
} from "@/core/ai-context-mapper/v2";

function gate(gateName: ContextMappingV2ValidationGate, ok: boolean, code?: string, message?: string) {
  return { gate: gateName, status: ok ? "PASS" as const : "FAIL" as const, ...(ok ? {} : { code, message }) };
}

function estimateTokens(raw: string): number {
  return Math.ceil(Buffer.byteLength(raw, "utf8") / 4);
}

function noAuthorityShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const forbidden = new Set(["authority","authorized","approval","approved","context_closure","closure_pass","workspace_to_add","workspace_id_to_add","execution_instruction"]);
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) { stack.push(...current); continue; }
    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      if (forbidden.has(key.toLowerCase())) return false;
      stack.push(nested);
    }
  }
  return true;
}

export function validateModelContextAnalysisV2(raw: string, input: ContextAssemblyMappingInputV2): ContextMappingV2ValidationResult {
  const gates: ContextMappingV2ValidationResult["gates"] = [];
  const rawSha = mapperSha256(raw);
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
    gates.push(gate("JSON_PARSE", true));
  } catch {
    gates.push(gate("JSON_PARSE", false, "V2_RESPONSE_NOT_JSON", "Model response is not valid JSON."));
    return { status: "FAIL", gates, raw_response_sha256: rawSha };
  }

  const schema = modelContextAnalysisV2Schema.safeParse(parsedUnknown);
  if (!schema.success) {
    gates.push(gate("JSON_SCHEMA", false, "V2_SCHEMA_INVALID", schema.error.issues.map(issue => issue.message).join("; ").slice(0, 4000)));
    return { status: "FAIL", gates, raw_response_sha256: rawSha };
  }
  gates.push(gate("JSON_SCHEMA", true));
  const analysis: ModelContextAnalysisV2 = schema.data;

  gates.push(gate("ASSEMBLY_BINDING", input.schema_version === "intentchord.context-assembly-mapping-input.v1"));

  const componentIds = analysis.components.map(item => item.component_id);
  const componentIdSet = new Set(componentIds);
  gates.push(gate("COMPONENT_ID_UNIQUENESS", componentIdSet.size === componentIds.length, "DUPLICATE_COMPONENT_ID", "Component IDs must be unique."));
  const relationshipIds = analysis.relationships.map(item => item.relationship_id);
  const relationshipIdSet = new Set(relationshipIds);
  gates.push(gate("RELATIONSHIP_ID_UNIQUENESS", relationshipIdSet.size === relationshipIds.length, "DUPLICATE_RELATIONSHIP_ID", "Relationship IDs must be unique."));
  gates.push(gate("RELATIONSHIP_ENDPOINT_INTEGRITY", analysis.relationships.every(item => componentIdSet.has(item.from_component_id) && componentIdSet.has(item.to_component_id) && item.from_component_id !== item.to_component_id), "RELATIONSHIP_ENDPOINT_INVALID", "Relationships must reference distinct existing Components."));

  const workspaceIds = new Set(input.source_bindings.map(item => item.workspace_id));
  const entryIds = new Set(input.entries.map(item => item.entry_id));
  gates.push(gate("WORKSPACE_REFERENCE_INTEGRITY", analysis.components.every(item => item.workspace_ids.length > 0 && item.workspace_ids.every(workspaceId => workspaceIds.has(workspaceId))), "WORKSPACE_REFERENCE_INVALID", "Components may reference only governed assembly Workspaces."));
  const evidenceRefs = [
    ...analysis.components.flatMap(item => item.evidence_entry_ids),
    ...analysis.relationships.flatMap(item => item.evidence_entry_ids),
  ];
  gates.push(gate("ENTRY_REFERENCE_INTEGRITY", analysis.components.every(item => item.evidence_entry_ids.length > 0) && evidenceRefs.every(entryId => entryIds.has(entryId)), "ENTRY_REFERENCE_INVALID", "Components and relationships must cite exact governed evidence entry IDs."));
  const entryById = new Map(input.entries.map(item => [item.entry_id, item]));
  const componentEvidenceCoverage = analysis.components.every(component => {
    const evidenceWorkspaces = new Set(component.evidence_entry_ids.map(id => entryById.get(id)?.workspace_id).filter((id): id is string => Boolean(id)));
    return component.evidence_entry_ids.length > 0 && component.workspace_ids.every(workspaceId => evidenceWorkspaces.has(workspaceId));
  });
  gates.push(gate("COMPONENT_EVIDENCE_COVERAGE", componentEvidenceCoverage, "COMPONENT_EVIDENCE_COVERAGE_INVALID", "Every claimed Component Workspace must be backed by evidence from that governed Workspace."));
  const componentById = new Map(analysis.components.map(component => [component.component_id, component]));
  const crossWorkspaceRelationshipEvidence = analysis.relationships.every(relationship => {
    const from = componentById.get(relationship.from_component_id); const to = componentById.get(relationship.to_component_id);
    if (!from || !to) return false;
    const involved = new Set([...from.workspace_ids, ...to.workspace_ids]);
    if (involved.size <= 1) return relationship.evidence_entry_ids.every(id => entryById.has(id));
    const evidenceWorkspaces = new Set(relationship.evidence_entry_ids.map(id => entryById.get(id)?.workspace_id).filter((id): id is string => Boolean(id)));
    return [...involved].every(workspaceId => evidenceWorkspaces.has(workspaceId));
  });
  gates.push(gate("CROSS_WORKSPACE_RELATIONSHIP_EVIDENCE", crossWorkspaceRelationshipEvidence, "CROSS_WORKSPACE_RELATIONSHIP_EVIDENCE_INVALID", "Cross-workspace relationship claims require governed evidence from every involved Workspace."));
  gates.push(gate("NONEMPTY_COMPONENT_ANALYSIS", analysis.components.length > 0, "EMPTY_COMPONENT_ANALYSIS", "A validated V2 analysis must contain at least one evidence-backed Component."));

  const relationshipRefSet = new Set(analysis.relationships.map(item => item.relationship_id));
  const missingGrounded = analysis.missing_evidence_requests.every(request =>
    request.known_evidence_entry_ids.length > 0
    && request.known_evidence_entry_ids.every(entryId => entryIds.has(entryId))
    && request.affected_component_ids.every(componentId => componentIdSet.has(componentId))
    && request.affected_relationship_ids.every(relationshipId => relationshipRefSet.has(relationshipId)),
  );
  gates.push(gate("MISSING_EVIDENCE_GROUNDING", missingGrounded, "MISSING_EVIDENCE_UNGROUNDED", "Every Missing Evidence Request must be grounded in current governed evidence and known analysis identities."));

  const contradictionsGrounded = analysis.material_contradictions.every(item =>
    item.evidence_entry_ids.length > 0
    && item.evidence_entry_ids.every(entryId => entryIds.has(entryId))
    && item.affected_component_ids.every(componentId => componentIdSet.has(componentId))
    && item.affected_relationship_ids.every(relationshipId => relationshipRefSet.has(relationshipId)),
  );
  gates.push(gate("CONTRADICTION_GROUNDING", contradictionsGrounded, "CONTRADICTION_UNGROUNDED", "Contradictions must be evidence-grounded."));

  const blockingRequests = analysis.missing_evidence_requests.filter(item => item.materiality === "BLOCKING");
  const outcomeConsistent = analysis.analysis_outcome === "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE"
    ? analysis.missing_evidence_requests.length > 0
    : blockingRequests.length === 0;
  gates.push(gate("OUTCOME_CONSISTENCY", outcomeConsistent, "ANALYSIS_OUTCOME_INCONSISTENT", "Analysis outcome must be consistent with Missing Evidence findings."));
  gates.push(gate("NO_AUTHORITY_LANGUAGE_FIELDS", noAuthorityShape(parsedUnknown), "MODEL_AUTHORITY_FIELD_FORBIDDEN", "Model output may not contain authority/closure action fields."));
  gates.push(gate("OUTPUT_SIZE_BOUND", estimateTokens(raw) <= MAX_MODEL_OUTPUT_ESTIMATED_TOKENS, "MODEL_OUTPUT_BUDGET_EXCEEDED", "Model output exceeds governed output budget."));

  const status = gates.every(item => item.status === "PASS") ? "PASS" : "FAIL";
  return {
    status,
    gates,
    raw_response_sha256: rawSha,
    ...(status === "PASS" ? { parsed_analysis: analysis, parsed_analysis_sha256: mapperSha256(analysis) } : {}),
  };
}
