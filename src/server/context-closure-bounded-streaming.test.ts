import { describe, it, expect, vi } from "vitest";
import { buildAssemblyInputBoundedStreaming } from "@/server/context-closure-service";
import { MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS } from "@/core/ai-context-mapper/types";
import type { AssemblyRevisionRow } from "@/server/context-closure-service";
import type { FileProjectionHeaderRecord, StructuralProjectionEntryRecord } from "@/core/workspace-index/sections/hbsp-v2-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestHeader(normalizedPath = "src/main.ts"): FileProjectionHeaderRecord {
  return {
    record_kind: "FILE_PROJECTION_HEADER",
    record_id: `fph_${normalizedPath}`,
    workspace_id: "ws_test_1",
    source_file_revision_id: `fre_${normalizedPath}`,
    normalized_path: normalizedPath,
    language_or_format: "typescript",
    size_bytes: 500,
    content_or_metadata_fingerprint: "sha256:fp",
    file_kind: "SOURCE_CODE",
    parse_status: "SUPPORTED",
    coverage_state: "FULL",
  };
}

function makeTestPart(id: string, partIndex = 0, symbolsCount = 1): StructuralProjectionEntryRecord {
  return {
    record_kind: "STRUCTURAL_PROJECTION_ENTRY",
    record_id: `spe_${id}_${partIndex}`,
    workspace_id: "ws_test_1",
    parent_file_entry_id: `fph_src/main.ts`,
    parent_file_revision_id: "fre_src/main.ts",
    logical_unit_id: `wsu_${id}`,
    parent_logical_unit_id: null,
    unit_kind: "FUNCTION",
    unit_label: id,
    label_authority: "SOURCE_NATIVE",
    part_index: partIndex,
    is_final_part: true,
    projection_signals: {
      symbols: Array.from({ length: symbolsCount }, (_, i) => ({
        local_name: `${id}_fn_${i}`,
        qualified_suffix: `main.${id}_fn_${i}`,
        kind: "FUNCTION",
        evidence_role: "CANONICAL",
        certainty: "EXACT",
        fact_ref: `fact_${id}_${i}`,
      })),
      relations: [],
    },
  };
}

describe("Context Closure Bounded Streaming Consumption (Issue 1 Proof)", () => {
  const revision: AssemblyRevisionRow = {
    id: "car_test_rev",
    context_assembly_id: "ca_test_assembly",
    revision: 1,
    assembly_sha256: "sha256:test_assembly",
  };

  it("proves BOUNDED_CONTEXT_PREPARATION_PROVEN: streams V2 entries and builds valid assembly input", async () => {
    const mockRecords = [
      { record_seq: 1, section_schema_version: "v2", record_json: makeTestHeader("src/main.ts") },
      { record_seq: 2, section_schema_version: "v2", record_json: makeTestPart("alpha") },
      { record_seq: 3, section_schema_version: "v2", record_json: makeTestPart("beta") },
    ];

    const mockRepo = {
      async *streamAcceptedRecords() {
        for (const r of mockRecords) yield r;
      },
    };

    const sources = [
      {
        binding: {
          workspace_id: "ws_test_1",
          workspace_registration_revision: 1,
          workspace_registration_fingerprint: "sha256:fp",
          workspace_revision_id: "rev_1",
          workspace_index_snapshot_id: "snp_1",
          canonical_index_artifact_id: "wea_1",
          workspace_index_sha256: "sha256:idx",
          artifact_semantic_sha256: "sha256:art",
        },
        isV2: true,
        canonicalIndexArtifactId: "wea_1",
      },
    ];

    const input = await buildAssemblyInputBoundedStreaming(revision, sources as any, mockRepo as any);

    expect(input.schema_version).toBe("intentchord.context-assembly-mapping-input.v1");
    expect(input.entries).toHaveLength(2);
    expect(input.entries[0].entry_id).toBe("spe_alpha_0");
    expect(input.entries[1].entry_id).toBe("spe_beta_0");
    expect(input.provider_neutral_estimated_tokens).toBeLessThanOrEqual(MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS);
  });

  it("proves BUDGET_ENFORCED_BEFORE_UNBOUNDED_ACCUMULATION: stream aborts immediately upon exceeding budget", async () => {
    let recordsReadCount = 0;

    // Create a generator that would yield 1,000,000 entries if not bounded
    const mockRepo = {
      async *streamAcceptedRecords() {
        yield { record_seq: 1, section_schema_version: "v2", record_json: makeTestHeader("src/huge.ts") };
        recordsReadCount++;

        // Yield huge parts until budget is blown
        for (let i = 0; i < 50_000; i++) {
          recordsReadCount++;
          // Each part has 200 symbols (~10,000 tokens per part)
          yield {
            record_seq: i + 2,
            section_schema_version: "v2",
            record_json: makeTestPart(`huge_part_${i}`, 0, 200),
          };
        }
      },
    };

    const sources = [
      {
        binding: {
          workspace_id: "ws_huge",
          workspace_registration_revision: 1,
          workspace_registration_fingerprint: "sha256:fp",
          workspace_revision_id: "rev_1",
          workspace_index_snapshot_id: "snp_1",
          canonical_index_artifact_id: "wea_huge",
          workspace_index_sha256: "sha256:idx",
          artifact_semantic_sha256: "sha256:art",
        },
        isV2: true,
        canonicalIndexArtifactId: "wea_huge",
      },
    ];

    let caughtError: any = null;
    try {
      await buildAssemblyInputBoundedStreaming(revision, sources as any, mockRepo as any);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.code).toBe("CONTEXT_ASSEMBLY_INPUT_BUDGET_EXCEEDED");
    expect(caughtError.status).toBe(413);

    // CRITICAL PROOF: The generator was halted after only a few parts (far below 50,000)!
    // No whole-workspace materialization occurred!
    expect(recordsReadCount).toBeLessThan(15);
    expect(recordsReadCount).toBeGreaterThan(0);
  });

  it("detects entry ID collision across streaming parts", async () => {
    const mockRecords = [
      { record_seq: 1, section_schema_version: "v2", record_json: makeTestHeader("src/main.ts") },
      { record_seq: 2, section_schema_version: "v2", record_json: makeTestPart("duplicate_id") },
      { record_seq: 3, section_schema_version: "v2", record_json: makeTestPart("duplicate_id") },
    ];

    const mockRepo = {
      async *streamAcceptedRecords() {
        for (const r of mockRecords) yield r;
      },
    };

    const sources = [
      {
        binding: {
          workspace_id: "ws_test_1",
          workspace_registration_revision: 1,
          workspace_registration_fingerprint: "sha256:fp",
          workspace_revision_id: "rev_1",
          workspace_index_snapshot_id: "snp_1",
          canonical_index_artifact_id: "wea_1",
          workspace_index_sha256: "sha256:idx",
          artifact_semantic_sha256: "sha256:art",
        },
        isV2: true,
        canonicalIndexArtifactId: "wea_1",
      },
    ];

    let caughtError: any = null;
    try {
      await buildAssemblyInputBoundedStreaming(revision, sources as any, mockRepo as any);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.code).toBe("CONTEXT_ASSEMBLY_ENTRY_ID_COLLISION");
    expect(caughtError.status).toBe(409);
  });
});
