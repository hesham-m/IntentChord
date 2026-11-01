import { describe, expect, it } from "vitest";
import { validateModelProposedCatalog } from "@/core/ai-context-mapper/validator";
import { mapperSha256, stableMapperId } from "@/core/ai-context-mapper/canonical";
import { B1_MAPPING_INPUT_SCHEMA_VERSION, type B1CanonicalArtifactMappingInputSnapshot } from "@/core/ai-context-mapper/types";
import { sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";

function validate(catalog: unknown) {
  return validateModelProposedCatalog(JSON.stringify(catalog), sampleMappingInput());
}

describe("AI Context Mapper deterministic catalog validator", () => {
  it("accepts a complete valid proposal", () => {
    const result = validate(validCatalog());
    expect(result.status).toBe("PASS");
    expect(result.gates.every(gate => gate.status === "PASS")).toBe(true);
  });

  it("rejects invalid JSON and does not invent a parsed result", () => {
    const result = validateModelProposedCatalog("{", sampleMappingInput());
    expect(result.status).toBe("FAIL");
    expect(result.parsed_catalog).toBeUndefined();
    expect(result.gates.some(gate => gate.gate === "JSON_PARSE" && gate.status === "FAIL")).toBe(true);
  });

  it("rejects extra properties", () => {
    expect(validate({ ...validCatalog(), extra: true }).status).toBe("FAIL");
  });

  it("rejects duplicate context and relationship identities", () => {
    const catalog = validCatalog();
    catalog.contexts.push({ ...catalog.contexts[0] });
    const duplicateContext = validate(catalog);
    expect(duplicateContext.gates.find(gate => gate.gate === "CONTEXT_ID_UNIQUENESS")?.status).toBe("FAIL");

    const relationshipCatalog = validCatalog();
    relationshipCatalog.contexts.push({ ...relationshipCatalog.contexts[0], context_id: "ctx_secondary", display_name: "Secondary" });
    const relation = { relationship_id: "rel_docs", from_context_id: "ctx_documentation", to_context_id: "ctx_secondary", relationship_type: "documents" as const, evidence_entry_ids: relationshipCatalog.contexts[0].evidence_entry_ids, confidence: "high" as const, rationale: "The indexed documentation describes the secondary context." };
    relationshipCatalog.relationships.push(relation, { ...relation });
    expect(validate(relationshipCatalog).gates.find(gate => gate.gate === "RELATIONSHIP_ID_UNIQUENESS")?.status).toBe("FAIL");
  });

  it("rejects nonexistent workspace, entry, and relationship endpoint references", () => {
    const catalog = validCatalog();
    catalog.contexts[0].workspace_ids = ["workspace_missing"];
    catalog.contexts[0].evidence_entry_ids = ["mie_missing"];
    catalog.relationships.push({ relationship_id: "rel_missing", from_context_id: "ctx_documentation", to_context_id: "ctx_missing", relationship_type: "depends_on", evidence_entry_ids: ["mie_missing"], confidence: "low", rationale: "Missing references are invalid." });
    const result = validate(catalog);
    expect(result.gates.find(gate => gate.gate === "WORKSPACE_REFERENCE_INTEGRITY")?.status).toBe("FAIL");
    expect(result.gates.find(gate => gate.gate === "ENTRY_REFERENCE_INTEGRITY")?.status).toBe("FAIL");
    expect(result.gates.find(gate => gate.gate === "RELATIONSHIP_ENDPOINT_INTEGRITY")?.status).toBe("FAIL");
  });

  it("rejects self relationships", () => {
    const catalog = validCatalog();
    catalog.relationships.push({ relationship_id: "rel_self", from_context_id: "ctx_documentation", to_context_id: "ctx_documentation", relationship_type: "contains", evidence_entry_ids: catalog.contexts[0].evidence_entry_ids, confidence: "low", rationale: "Self relationships are prohibited." });
    expect(validate(catalog).gates.find(gate => gate.gate === "NO_SELF_RELATIONSHIP")?.status).toBe("FAIL");
  });

  it("rejects incomplete coverage and mapped/unmapped overlap", () => {
    const overlapCatalog = validCatalog();
    const entry = overlapCatalog.contexts[0].evidence_entry_ids[0];
    overlapCatalog.unmapped_entries.push({ entry_id: entry, reason_code: "ambiguous", explanation: "Overlap is invalid." });
    expect(validate(overlapCatalog).gates.find(gate => gate.gate === "ENTRY_COVERAGE_ACCOUNTING")?.status).toBe("FAIL");

    const missingCatalog = validCatalog();
    missingCatalog.contexts[0].evidence_entry_ids = [];
    expect(validate(missingCatalog).status).toBe("FAIL");
  });

  it("rejects a tampered Mapping Input fingerprint", () => {
    const input = sampleMappingInput();
    input.entries[0].normalized_path = "tampered.md";
    const result = validateModelProposedCatalog(JSON.stringify(validCatalog(sampleMappingInput())), input);
    expect(result.gates.find(gate => gate.gate === "INPUT_FINGERPRINT_BINDING")?.status).toBe("FAIL");
  });

  it("validates the Registered B1 artifact-bound Mapping Input fingerprint", () => {
    const legacy = sampleMappingInput();
    const artifactSemanticSha256 = "sha256:" + "a".repeat(64);
    const canonicalIndexArtifactId = "cia_" + "b".repeat(64);
    const serializedPayloadSha256 = mapperSha256(legacy.entries);
    const input: B1CanonicalArtifactMappingInputSnapshot = {
      ...legacy,
      mapping_input_schema_version: B1_MAPPING_INPUT_SCHEMA_VERSION,
      source_authority: "CANONICAL_INDEX_ARTIFACT",
      canonical_index_artifact_id: canonicalIndexArtifactId,
      artifact_semantic_sha256: artifactSemanticSha256,
      workspace_index_sha256: artifactSemanticSha256,
      serialized_payload_sha256: serializedPayloadSha256,
      mapping_input_snapshot_id: stableMapperId("mis", {
        source_authority: "CANONICAL_INDEX_ARTIFACT",
        canonical_index_artifact_id: canonicalIndexArtifactId,
        artifact_semantic_sha256: artifactSemanticSha256,
        workspace_snapshot_id: legacy.workspace_snapshot_id,
        serialized_payload_sha256: serializedPayloadSha256,
      }),
    };
    const result = validateModelProposedCatalog(JSON.stringify(validCatalog(input)), input);
    expect(result.gates.find(gate => gate.gate === "INPUT_FINGERPRINT_BINDING")?.status).toBe("PASS");
  });

  it("rejects prohibited authority claims without rejecting ordinary final-stage wording", () => {
    const catalog = validCatalog();
    catalog.catalog_summary = "This catalog is APPROVED.";
    expect(validate(catalog).gates.find(gate => gate.gate === "NO_AUTHORITY_LANGUAGE_FIELDS")?.status).toBe("FAIL");
    const ordinary = validCatalog();
    ordinary.catalog_summary = "The final stage module is represented as evidence, without an approval claim.";
    expect(validate(ordinary).gates.find(gate => gate.gate === "NO_AUTHORITY_LANGUAGE_FIELDS")?.status).toBe("PASS");
  });

  it("rejects oversized output", () => {
    const input = sampleMappingInput();
    const raw = JSON.stringify(validCatalog()) + " ".repeat(80_000);
    expect(validateModelProposedCatalog(raw, input).gates.find(gate => gate.gate === "OUTPUT_SIZE_BOUND")?.status).toBe("FAIL");
  });
});
