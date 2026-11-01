import {
  B1_MAPPING_INPUT_SCHEMA_VERSION,
  MAX_MODEL_OUTPUT_ESTIMATED_TOKENS,
  type CatalogValidationResult,
  type MappingInputSnapshot,
  type ModelProposedContextCatalogV1,
  type ValidationGateName,
  type ValidationGateResult,
} from "@/core/ai-context-mapper/types";
import { estimatedTokensForUtf8, mapperSha256, sha256Utf8, stableMapperId } from "@/core/ai-context-mapper/canonical";
import { modelProposedContextCatalogSchema } from "@/core/ai-context-mapper/schema";

function gate(gateName: ValidationGateName, status: "PASS" | "FAIL", code?: string, message?: string): ValidationGateResult {
  return { gate: gateName, status, ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function allStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value)) allStrings(item, output);
  return output;
}


const rootKeys = new Set(["schema_version", "catalog_summary", "contexts", "relationships", "unmapped_entries", "global_unknowns", "warnings"]);
const contextKeys = new Set(["context_id", "display_name", "context_kind", "summary", "responsibilities", "workspace_ids", "evidence_entry_ids", "interfaces", "unknowns", "confidence", "rationale"]);
const relationshipKeys = new Set(["relationship_id", "from_context_id", "to_context_id", "relationship_type", "evidence_entry_ids", "confidence", "rationale"]);
const unmappedKeys = new Set(["entry_id", "reason_code", "explanation"]);

function unknownPropertyPaths(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const unknown: string[] = Object.keys(record).filter(key => !rootKeys.has(key)).map(key => key);
  if (Array.isArray(record.contexts)) {
    record.contexts.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const key of Object.keys(item)) if (!contextKeys.has(key)) unknown.push(`contexts.${index}.${key}`);
      }
    });
  }
  if (Array.isArray(record.relationships)) {
    record.relationships.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const key of Object.keys(item)) if (!relationshipKeys.has(key)) unknown.push(`relationships.${index}.${key}`);
      }
    });
  }
  if (Array.isArray(record.unmapped_entries)) {
    record.unmapped_entries.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const key of Object.keys(item)) if (!unmappedKeys.has(key)) unknown.push(`unmapped_entries.${index}.${key}`);
      }
    });
  }
  return unknown;
}

function firstFailed(gates: ValidationGateResult[]): boolean {
  return gates.some(item => item.status === "FAIL");
}

export function validateModelProposedCatalog(rawResponse: string, input: MappingInputSnapshot): CatalogValidationResult {
  const gates: ValidationGateResult[] = [];
  const rawHash = sha256Utf8(rawResponse);
  const outputEstimatedTokens = estimatedTokensForUtf8(rawResponse);
  gates.push(outputEstimatedTokens <= MAX_MODEL_OUTPUT_ESTIMATED_TOKENS
    ? gate("OUTPUT_SIZE_BOUND", "PASS")
    : gate("OUTPUT_SIZE_BOUND", "FAIL", "MODEL_OUTPUT_SIZE_BOUND_EXCEEDED", `Estimated output ${outputEstimatedTokens} exceeds ${MAX_MODEL_OUTPUT_ESTIMATED_TOKENS}.`));

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(rawResponse) as unknown;
    gates.push(gate("JSON_PARSE", "PASS"));
  } catch {
    gates.push(gate("JSON_PARSE", "FAIL", "PRIMARY_RESPONSE_NOT_JSON", "Provider response is not valid JSON."));
    return { status: "FAIL", gates, raw_response_sha256: rawHash };
  }

  const unknownProperties = unknownPropertyPaths(parsedUnknown);
  const schemaResult = modelProposedContextCatalogSchema.safeParse(parsedUnknown);
  if (!schemaResult.success) {
    gates.push(gate("JSON_SCHEMA", "FAIL", "PRIMARY_SCHEMA_INVALID", schemaResult.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
    gates.push(unknownProperties.length
      ? gate("NO_UNKNOWN_PROPERTIES", "FAIL", "PRIMARY_SCHEMA_INVALID", `Unknown properties: ${unknownProperties.join(", ")}.`)
      : gate("NO_UNKNOWN_PROPERTIES", "PASS"));
    return { status: "FAIL", gates, raw_response_sha256: rawHash };
  }
  const catalog = schemaResult.data;
  gates.push(gate("JSON_SCHEMA", "PASS"));
  gates.push(unknownProperties.length
    ? gate("NO_UNKNOWN_PROPERTIES", "FAIL", "PRIMARY_SCHEMA_INVALID", `Unknown properties: ${unknownProperties.join(", ")}.`)
    : gate("NO_UNKNOWN_PROPERTIES", "PASS"));
  const expectedPayloadSha256 = mapperSha256(input.entries);
  const expectedSnapshotId = input.mapping_input_schema_version === B1_MAPPING_INPUT_SCHEMA_VERSION
    ? stableMapperId("mis", {
      source_authority: "CANONICAL_INDEX_ARTIFACT",
      canonical_index_artifact_id: input.canonical_index_artifact_id,
      artifact_semantic_sha256: input.artifact_semantic_sha256,
      workspace_snapshot_id: input.workspace_snapshot_id,
      serialized_payload_sha256: expectedPayloadSha256,
    })
    : stableMapperId("mis", {
      workspace_snapshot_id: input.workspace_snapshot_id,
      workspace_index_sha256: input.workspace_index_sha256,
      serialized_payload_sha256: expectedPayloadSha256,
    });
  const inputFingerprintBound = input.serialized_payload_sha256 === expectedPayloadSha256
    && input.mapping_input_snapshot_id === expectedSnapshotId
    && input.eligible_entry_count === input.entries.length;
  gates.push(inputFingerprintBound
    ? gate("INPUT_FINGERPRINT_BINDING", "PASS")
    : gate("INPUT_FINGERPRINT_BINDING", "FAIL", "INPUT_FINGERPRINT_BINDING_FAILED", "Mapping Input Snapshot identity or payload hash does not match the exact eligible entries."));

  const workspaceIds = new Set(input.eligible_workspace_ids);
  const invalidWorkspace = catalog.contexts.flatMap(context => context.workspace_ids).find(id => !workspaceIds.has(id));
  gates.push(invalidWorkspace
    ? gate("WORKSPACE_REFERENCE_INTEGRITY", "FAIL", "PRIMARY_REFERENTIAL_INTEGRITY_FAILED", `Unknown workspace_id ${invalidWorkspace}.`)
    : gate("WORKSPACE_REFERENCE_INTEGRITY", "PASS"));

  const eligibleEntries = new Set(input.entries.map(entry => entry.entry_id));
  const referencedEntries = [
    ...catalog.contexts.flatMap(context => context.evidence_entry_ids),
    ...catalog.relationships.flatMap(relationship => relationship.evidence_entry_ids),
    ...catalog.unmapped_entries.map(entry => entry.entry_id),
  ];
  const invalidEntry = referencedEntries.find(id => !eligibleEntries.has(id));
  gates.push(invalidEntry
    ? gate("ENTRY_REFERENCE_INTEGRITY", "FAIL", "PRIMARY_REFERENTIAL_INTEGRITY_FAILED", `Unknown entry_id ${invalidEntry}.`)
    : gate("ENTRY_REFERENCE_INTEGRITY", "PASS"));

  const duplicateContextIds = duplicates(catalog.contexts.map(context => context.context_id));
  gates.push(duplicateContextIds.length
    ? gate("CONTEXT_ID_UNIQUENESS", "FAIL", "PRIMARY_SCHEMA_INVALID", `Duplicate context IDs: ${duplicateContextIds.join(", ")}.`)
    : gate("CONTEXT_ID_UNIQUENESS", "PASS"));

  const duplicateRelationshipIds = duplicates(catalog.relationships.map(relationship => relationship.relationship_id));
  gates.push(duplicateRelationshipIds.length
    ? gate("RELATIONSHIP_ID_UNIQUENESS", "FAIL", "PRIMARY_SCHEMA_INVALID", `Duplicate relationship IDs: ${duplicateRelationshipIds.join(", ")}.`)
    : gate("RELATIONSHIP_ID_UNIQUENESS", "PASS"));

  const contextIds = new Set(catalog.contexts.map(context => context.context_id));
  const badEndpoint = catalog.relationships.find(relationship => !contextIds.has(relationship.from_context_id) || !contextIds.has(relationship.to_context_id));
  gates.push(badEndpoint
    ? gate("RELATIONSHIP_ENDPOINT_INTEGRITY", "FAIL", "PRIMARY_REFERENTIAL_INTEGRITY_FAILED", `Relationship ${badEndpoint.relationship_id} references a missing context.`)
    : gate("RELATIONSHIP_ENDPOINT_INTEGRITY", "PASS"));

  const selfRelationship = catalog.relationships.find(relationship => relationship.from_context_id === relationship.to_context_id);
  gates.push(selfRelationship
    ? gate("NO_SELF_RELATIONSHIP", "FAIL", "PRIMARY_REFERENTIAL_INTEGRITY_FAILED", `Relationship ${selfRelationship.relationship_id} is self-referential.`)
    : gate("NO_SELF_RELATIONSHIP", "PASS"));

  const mapped = new Set(catalog.contexts.flatMap(context => context.evidence_entry_ids));
  const unmappedIds = catalog.unmapped_entries.map(entry => entry.entry_id);
  const duplicateUnmapped = duplicates(unmappedIds);
  const unmapped = new Set(unmappedIds);
  const overlap = [...mapped].filter(id => unmapped.has(id));
  const accounted = new Set([...mapped, ...unmapped]);
  const missing = [...eligibleEntries].filter(id => !accounted.has(id));
  const extra = [...accounted].filter(id => !eligibleEntries.has(id));
  gates.push(duplicateUnmapped.length || overlap.length || missing.length || extra.length
    ? gate("ENTRY_COVERAGE_ACCOUNTING", "FAIL", "PRIMARY_COVERAGE_INVALID", `Coverage mismatch. duplicateUnmapped=${duplicateUnmapped.join(",") || "none"}; overlap=${overlap.join(",") || "none"}; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}.`)
    : gate("ENTRY_COVERAGE_ACCOUNTING", "PASS"));

  const authorityLanguage = allStrings(catalog).find(value => /\b(?:approved|authoritative|owner[- ]approved|final verdict|final approval|pass(?:ed)? validation)\b/i.test(value));
  gates.push(authorityLanguage
    ? gate("NO_AUTHORITY_LANGUAGE_FIELDS", "FAIL", "PRIMARY_SCHEMA_INVALID", "Proposal contains prohibited authority language.")
    : gate("NO_AUTHORITY_LANGUAGE_FIELDS", "PASS"));

  const status = firstFailed(gates) ? "FAIL" : "PASS";
  return {
    status,
    gates,
    raw_response_sha256: rawHash,
    ...(status === "PASS" ? {
      parsed_catalog: catalog as ModelProposedContextCatalogV1,
      parsed_catalog_sha256: mapperSha256(catalog),
    } : {}),
  };
}
