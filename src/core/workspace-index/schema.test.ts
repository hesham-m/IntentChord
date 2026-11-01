import { describe, expect, it } from "vitest";
import { indexWorkspace } from "@/core/workspace-index/indexer";
import { canonicalWorkspaceIndexContractSchema, canonicalWorkspaceIndexJsonSchema } from "@/core/workspace-index/schema";
import { validateCanonicalWorkspaceIndexContract } from "@/core/workspace-index/validator";
import { createWorkspaceIndexFixture } from "@/test/workspace-index-helpers";

async function contract() {
  return indexWorkspace({
    workspace_instance_id: "wsi_schema_fixture",
    root_path: await createWorkspaceIndexFixture(),
    binding_type: "FIXTURE",
    indexing_session_id: "wis_schema_fixture",
    started_at: "2026-08-02T18:00:00.000Z",
    completed_at: "2026-08-02T18:00:01.000Z",
  });
}

describe("Canonical Workspace Index Contract v1 schema", () => {
  it("accepts a valid full immutable snapshot", async () => {
    const value = await contract();
    expect(canonicalWorkspaceIndexContractSchema.parse(value).contract_version).toBe("1.0.0");
    expect(validateCanonicalWorkspaceIndexContract(value).status).toBe("COMPLETE_WITH_GAPS");
  });

  it("preserves JSON-safe source binding metadata through the typed schema", async () => {
    const value = await contract();
    value.source_binding.metadata = {
      git_required: false,
      nested: { enabled: true, threshold: 3 },
      labels: ["fixture", 1, null],
    };
    const parsed = canonicalWorkspaceIndexContractSchema.parse(value);
    expect(parsed.source_binding.metadata).toEqual(value.source_binding.metadata);
  });

  it("rejects a missing governing identity", async () => {
    const value = await contract();
    const raw = structuredClone(value) as Record<string, unknown>;
    delete (raw.workspace as Record<string, unknown>).workspace_instance_id;
    expect(validateCanonicalWorkspaceIndexContract(raw).status).toBe("REJECTED");
  });

  it("rejects an unsupported contract version", async () => {
    const value = await contract();
    expect(validateCanonicalWorkspaceIndexContract({ ...value, contract_version: "2.0.0" }).status).toBe("REJECTED");
  });

  it("rejects duplicate entity IDs", async () => {
    const value = await contract();
    const duplicate = structuredClone(value);
    duplicate.snapshot.files.push(structuredClone(duplicate.snapshot.files[0]));
    expect(validateCanonicalWorkspaceIndexContract(duplicate).diagnostics.some(item => item.code === "DUPLICATE_ID")).toBe(true);
  });

  it("rejects broken Fact and Relation references", async () => {
    const value = await contract();
    const broken = structuredClone(value);
    broken.snapshot.facts[0].source_file_revision_id = "fir_missing";
    broken.snapshot.relations[0].target.entity_revision_id = "far_missing";
    const result = validateCanonicalWorkspaceIndexContract(broken);
    expect(result.status).toBe("REJECTED");
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(["BROKEN_FACT_SOURCE_REFERENCE", "BROKEN_RELATION_TARGET"]));
  });

  it("exports a versioned JSON Schema document", () => {
    expect(canonicalWorkspaceIndexJsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(canonicalWorkspaceIndexJsonSchema.properties.contract_version.const).toBe("1.0.0");
    expect(canonicalWorkspaceIndexJsonSchema.required).toContain("snapshot");
    expect(canonicalWorkspaceIndexJsonSchema.$defs.file.properties.file_kind.enum).toContain("CSV");
  });
});
