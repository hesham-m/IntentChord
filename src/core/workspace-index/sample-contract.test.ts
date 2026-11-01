import { describe, expect, it } from "vitest";
import sampleContract from "../../../reports/architecture-validation/samples/canonical-workspace-index-v1.sample.json";
import { canonicalWorkspaceIndexContractSchema, canonicalWorkspaceIndexJsonSchema } from "@/core/workspace-index/schema";
import { validateCanonicalWorkspaceIndexContract } from "@/core/workspace-index/validator";

describe("Canonical Workspace Index v1 sample artifact", () => {
  it("is accepted by the runtime and technical Contract validators", () => {
    expect(canonicalWorkspaceIndexContractSchema.parse(sampleContract).contract_version).toBe("1.0.0");
    const result = validateCanonicalWorkspaceIndexContract(sampleContract);
    expect(result.status).toBe("COMPLETE");
    expect(result.contract?.integrity.canonical_payload_hash).toBe(sampleContract.integrity.canonical_payload_hash);
  });

  it("is described by a strict exportable JSON Schema", () => {
    expect(canonicalWorkspaceIndexJsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(canonicalWorkspaceIndexJsonSchema.$defs.fact.additionalProperties).toBe(false);
    expect(canonicalWorkspaceIndexJsonSchema.$defs.relation.additionalProperties).toBe(false);
    expect(canonicalWorkspaceIndexJsonSchema.$defs.delta.additionalProperties).toBe(false);
    expect(canonicalWorkspaceIndexJsonSchema.$defs.coverage.additionalProperties).toBe(false);
  });

  it("contains content references but no raw Workspace content field", () => {
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        visit(child);
      }
    };
    visit(sampleContract);
    expect(sampleContract.snapshot.content_references).toHaveLength(1);
    expect(keys).not.toContain("raw_content");
    expect(keys).not.toContain("file_content");
    expect(sampleContract.source_binding.metadata.raw_content_embedded).toBe(false);
  });
});
