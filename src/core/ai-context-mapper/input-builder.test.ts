import { rename } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMappingInputSnapshot, buildMappingInputSnapshotFromCanonicalArtifact, mappingInputSemanticPayload, mappingInputSemanticSha256 } from "@/core/ai-context-mapper/input-builder";
import { mappingInputSnapshotSchema } from "@/core/ai-context-mapper/schema";
import { canonicalJson as mapperCanonicalJson } from "@/core/ai-context-mapper/canonical";
import { sampleCanonicalWorkspaceIndex, sampleMappingInput } from "@/core/ai-context-mapper/test-fixtures";
import { finalizeWorkspaceIndexContract } from "@/core/workspace-index/canonical";
import { canonicalIndexArtifactId, canonicalIndexArtifactSemanticSha256, canonicalIndexArtifactSemanticState, workspaceIndexConfigurationDescriptor, workspaceIndexConfigurationSha256 } from "@/core/workspace-index/artifact-identity";
import { indexWorkspace } from "@/core/workspace-index/indexer";
import { createWorkspaceIndexFixture } from "@/test/workspace-index-helpers";
import { deriveCoverageSummary } from "@/core/workspace-index/validator";
import type { CanonicalWorkspaceIndexContract } from "@/core/workspace-index/types";

function refinalize(contract: CanonicalWorkspaceIndexContract): CanonicalWorkspaceIndexContract {
  const { integrity: _integrity, ...withoutIntegrity } = contract;
  return finalizeWorkspaceIndexContract({
    ...withoutIntegrity,
    delta: null,
    coverage: deriveCoverageSummary(contract.snapshot),
  });
}

function expandedIndex(count: number) {
  const contract = sampleCanonicalWorkspaceIndex();
  const base = contract.snapshot.files[0];
  const contentRef = contract.snapshot.content_references[0];
  contract.snapshot.files = Array.from({ length: count }, (_, index) => {
    const ordinal = String(index).padStart(4, "0");
    return {
      ...base,
      workspace_file_id: `wfi_${ordinal}`,
      file_revision_id: `fir_${ordinal}`,
      relative_path: `docs/${ordinal}.md`,
      file_name: `${ordinal}.md`,
      content_ref_id: `wcr_${ordinal}`,
    };
  });
  contract.snapshot.facts = [];
  contract.snapshot.relations = [];
  contract.snapshot.content_references = contract.snapshot.files.map((file, index) => ({
    ...contentRef,
    content_ref_id: `wcr_${String(index).padStart(4, "0")}`,
    file_revision_id: file.file_revision_id,
    content_hash: file.content_hash,
  }));
  return refinalize(contract);
}

describe("AI Context Mapper input builder", () => {
  it("produces stable ordering and SHA-256 for the same canonical input", () => {
    const first = buildMappingInputSnapshot(sampleCanonicalWorkspaceIndex(), { createdAt: "2026-08-04T10:00:00.000Z" });
    const second = buildMappingInputSnapshot(sampleCanonicalWorkspaceIndex(), { createdAt: "2026-08-04T10:00:00.000Z" });
    expect(second).toEqual(first);
    expect(first.entries.map(entry => entry.normalized_path)).toEqual([...first.entries.map(entry => entry.normalized_path)].sort());
    expect(first.serialized_payload_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects an unknown or tampered Workspace Index contract", () => {
    const contract = sampleCanonicalWorkspaceIndex();
    contract.workspace.workspace_revision_id = "wsr_tampered";
    expect(() => buildMappingInputSnapshot(contract)).toThrow(/failed deterministic validation/i);
  });

  it("blocks secret-like content marked available", () => {
    const contract = sampleCanonicalWorkspaceIndex();
    contract.snapshot.files[0].sensitivity_state = "SECRET";
    contract.snapshot.content_references[0].sensitivity_class = "SECRET";
    contract.snapshot.content_references[0].availability_state = "AVAILABLE";
    expect(() => buildMappingInputSnapshot(refinalize(contract))).toThrow(/Sensitive entry/);
  });

  it("accepts the exact provider-neutral budget and blocks one token above without truncation", () => {
    const contract = expandedIndex(8);
    const baseline = buildMappingInputSnapshot(contract);
    const before = structuredClone(contract);
    expect(buildMappingInputSnapshot(contract, { maxEstimatedTokens: baseline.provider_neutral_estimated_tokens }).entries).toHaveLength(8);
    expect(() => buildMappingInputSnapshot(contract, { maxEstimatedTokens: baseline.provider_neutral_estimated_tokens - 1 })).toThrow(/exceeds the provider-neutral budget/);
    expect(contract).toEqual(before);
  });

  it("keeps restricted entries excluded rather than sending them", () => {
    const contract = sampleCanonicalWorkspaceIndex();
    contract.snapshot.files[0].sensitivity_state = "OWNER_RESTRICTED";
    contract.snapshot.content_references[0].sensitivity_class = "OWNER_RESTRICTED";
    contract.snapshot.content_references[0].availability_state = "RESTRICTED";
    expect(() => buildMappingInputSnapshot(refinalize(contract))).toThrow(/no eligible mapping entries/i);
  });

  it("rejects missing snapshot fields, duplicate entry IDs, and unknown workspace references", () => {
    const input = sampleMappingInput();
    const missing = { ...input } as Partial<typeof input>;
    delete missing.workspace_snapshot_id;
    expect(mappingInputSnapshotSchema.safeParse(missing).success).toBe(false);

    const duplicate = { ...input, entries: [input.entries[0], structuredClone(input.entries[0])], eligible_entry_count: 2 };
    expect(mappingInputSnapshotSchema.safeParse(duplicate).success).toBe(false);

    const unknownWorkspace = structuredClone(input);
    unknownWorkspace.entries[0].workspace_id = "workspace_unknown";
    expect(mappingInputSnapshotSchema.safeParse(unknownWorkspace).success).toBe(false);
  });
  it("T26 same final Source Revision + Config yields the same governed B1 Mapping semantic hash through different predecessor histories", async () => {
    const withHistory = await createWorkspaceIndexFixture();
    const directRoot = await createWorkspaceIndexFixture();
    const workspaceInstanceId = "wsi_mapping_history_independence";
    const predecessor = await indexWorkspace({
      workspace_instance_id: workspaceInstanceId, root_path: withHistory, binding_type: "FIXTURE", indexing_session_id: "map-history-a",
      started_at: "2026-08-12T05:00:00.000Z", completed_at: "2026-08-12T05:00:01.000Z",
    });
    await rename(path.join(withHistory, "src", "util.ts"), path.join(withHistory, "src", "helper.ts"));
    const viaRename = await indexWorkspace({
      workspace_instance_id: workspaceInstanceId, root_path: withHistory, binding_type: "FIXTURE", previous_contract: predecessor, indexing_session_id: "map-history-b",
      started_at: "2026-08-12T05:00:02.000Z", completed_at: "2026-08-12T05:00:03.000Z",
      git_enrichment: { rename_hints: [{ from_relative_path: "src/util.ts", to_relative_path: "src/helper.ts", confidence: "PROVEN", evidence: "fixture" }], diagnostics: [] },
    });
    await rename(path.join(directRoot, "src", "util.ts"), path.join(directRoot, "src", "helper.ts"));
    const direct = await indexWorkspace({
      workspace_instance_id: workspaceInstanceId, root_path: directRoot, binding_type: "FIXTURE", indexing_session_id: "map-direct",
      started_at: "2030-01-01T00:00:00.000Z", completed_at: "2030-01-01T00:00:01.000Z",
    });
    const configSha = workspaceIndexConfigurationSha256(workspaceIndexConfigurationDescriptor());
    const artifactId = canonicalIndexArtifactId(viaRename.workspace.workspace_revision_id, configSha);
    const viaState = canonicalIndexArtifactSemanticState(viaRename);
    const directState = canonicalIndexArtifactSemanticState(direct);
    expect(canonicalIndexArtifactSemanticSha256(viaRename)).toBe(canonicalIndexArtifactSemanticSha256(direct));

    const firstInput = buildMappingInputSnapshotFromCanonicalArtifact({
      canonicalIndexArtifactId: artifactId,
      artifactSemanticSha256: canonicalIndexArtifactSemanticSha256(viaRename),
      semanticState: viaState,
    }, { createdAt: "2026-08-12T06:00:00.000Z" });
    const secondInput = buildMappingInputSnapshotFromCanonicalArtifact({
      canonicalIndexArtifactId: artifactId,
      artifactSemanticSha256: canonicalIndexArtifactSemanticSha256(direct),
      semanticState: directState,
    }, { createdAt: "2035-01-01T00:00:00.000Z" });
    expect(firstInput.mapping_input_snapshot_id).toBe(secondInput.mapping_input_snapshot_id);
    expect(mapperCanonicalJson(mappingInputSemanticPayload(firstInput))).toBe(
      mapperCanonicalJson(mappingInputSemanticPayload(secondInput)),
    );
    expect(mappingInputSemanticSha256(firstInput)).toBe(mappingInputSemanticSha256(secondInput));
  });

  it("T28 keeps the historical/ADVANCED_DIAGNOSTIC V1 Mapping Input contract readable", () => {
    const legacy = buildMappingInputSnapshot(sampleCanonicalWorkspaceIndex(), { createdAt: "2026-08-04T10:00:00.000Z" });
    expect(legacy.mapping_input_schema_version).toBe("intentchord.ai-context-mapping-input.v1");
    expect("source_authority" in legacy).toBe(false);
    expect("canonical_index_artifact_id" in legacy).toBe(false);
    expect(mappingInputSnapshotSchema.safeParse(legacy).success).toBe(true);
  });

});
