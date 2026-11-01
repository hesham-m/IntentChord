import { describe, it, expect } from "vitest";
import {
  buildStreamingSemanticProjection,
  buildStreamingProjectionAsMappingInputEntries,
  type StreamingFileEvidence,
  type StreamingFactEvidence,
  type StreamingRelationEvidence,
} from "@/core/workspace-index/sections/hbsp-v2-streaming-builder";
import {
  HBSP_V2_PROJECTION_HEADER_SCHEMA,
  HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
} from "@/core/workspace-index/sections/hbsp-v2-types";
import { HBSP_V2_RECORD_MAX_UTF8_OCTETS } from "@/core/workspace-index/sections/hbsp-v2-byte-authority";
import { utf8OctetLength } from "@/core/workspace-index/sections/bounds";
import { canonicalJson } from "@/core/truth/project-truth-hash";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeFile(overrides?: Partial<StreamingFileEvidence>): StreamingFileEvidence {
  return {
    workspace_file_id: "wf_abc",
    file_revision_id: "fre_abc",
    relative_path: "src/index.ts",
    file_kind: "SOURCE",
    language: "typescript",
    size_bytes: 1024,
    content_hash: "sha256:aaa",
    metadata_hash: "sha256:aaa",
    sensitivity_state: "NORMAL",
    parse_status: "SUPPORTED",
    coverage_state: "FULL",
    ...overrides,
  };
}

function makeFact(overrides?: Partial<StreamingFactEvidence>): StreamingFactEvidence {
  return {
    source_file_revision_id: "fre_abc",
    fact_type: "FUNCTION_DECLARATION",
    qualified_name: "foo",
    display_name: "foo",
    attributes: {},
    certainty: "EXACT",
    evidence_role: "DECLARATION",
    ...overrides,
  };
}

function makeRelation(overrides?: Partial<StreamingRelationEvidence>): StreamingRelationEvidence {
  return {
    source_entity_revision_id: "fre_abc",
    target_entity_revision_id: "fre_def",
    relation_type: "CALLS",
    direction: "OUTGOING",
    certainty: "EXACT",
    evidence_role: "INVOCATION",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Header construction
// ---------------------------------------------------------------------------

describe("buildStreamingSemanticProjection — header", () => {
  it("produces a valid FILE_PROJECTION_HEADER", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [],
      [],
    );
    expect(result.header.schema).toBe(HBSP_V2_PROJECTION_HEADER_SCHEMA);
    expect(result.header.workspace_revision_id).toBe("rev_1");
    expect(result.header.eligible_entry_count).toBe(1);
    expect(result.header.excluded_entry_count).toBe(0);
  });

  it("counts excluded files", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [
        makeFile({ sensitivity_state: "NORMAL" }),
        makeFile({ relative_path: "secret.ts", sensitivity_state: "RESTRICTED" }),
      ],
      [],
      [],
    );
    expect(result.header.eligible_entry_count).toBe(1);
    expect(result.header.excluded_entry_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Structural entry construction
// ---------------------------------------------------------------------------

describe("buildStreamingSemanticProjection — entries", () => {
  it("produces one structural entry per eligible file", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile({ relative_path: "a.ts" }), makeFile({ relative_path: "b.ts" })],
      [],
      [],
    );
    const entries = result.records.filter(
      (r): r is typeof r & { schema: typeof HBSP_V2_STRUCTURAL_ENTRY_SCHEMA } =>
        "schema" in r && r.schema === HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].normalized_path).toBe("a.ts");
    expect(entries[1].normalized_path).toBe("b.ts");
  });

  it("entries use part_index=0 and is_final_part=true for normal files", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [],
      [],
    );
    const entry = result.records.find(
      (r): r is typeof r & { schema: typeof HBSP_V2_STRUCTURAL_ENTRY_SCHEMA } =>
        "schema" in r && r.schema === HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
    );
    expect(entry).toBeDefined();
    expect(entry!.part_index).toBe(0);
    expect(entry!.is_final_part).toBe(true);
  });

  it("entries have deterministic logical_unit_id", () => {
    const r1 = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [],
      [],
    );
    const r2 = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [],
      [],
    );
    const e1 = r1.records.find((r) => "logical_unit_id" in r) as { logical_unit_id: string };
    const e2 = r2.records.find((r) => "logical_unit_id" in r) as { logical_unit_id: string };
    expect(e1.logical_unit_id).toBe(e2.logical_unit_id);
  });

  it("entries are sorted by normalized_path", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [
        makeFile({ relative_path: "z.ts" }),
        makeFile({ relative_path: "a.ts" }),
        makeFile({ relative_path: "m.ts" }),
      ],
      [],
      [],
    );
    const paths = result.records
      .filter((r): r is typeof r & { normalized_path: string } => "normalized_path" in r)
      .map((r) => r.normalized_path);
    expect(paths).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Fact signals
// ---------------------------------------------------------------------------

describe("buildStreamingSemanticProjection — fact signals", () => {
  it("includes facts linked to the file", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [makeFact()],
      [],
    );
    const entry = result.records.find(
      (r): r is typeof r & { index_supported_signals: { fact_signals: Array<{ fact_type: string; qualified_name: string; display_name: string; attributes: Record<string, unknown>; certainty: string; evidence_role: string }> } } =>
        "index_supported_signals" in r,
    );
    expect(entry).toBeDefined();
    expect(entry!.index_supported_signals.fact_signals).toHaveLength(1);
    expect(entry!.index_supported_signals.fact_signals[0].fact_type).toBe("FUNCTION_DECLARATION");
  });

  it("facts are sorted by qualified_name", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [makeFact({ qualified_name: "zoo" }), makeFact({ qualified_name: "aaa" })],
      [],
    );
    const entry = result.records.find(
      (r): r is typeof r & { index_supported_signals: { fact_signals: { qualified_name: string }[] } } =>
        "index_supported_signals" in r,
    );
    expect(entry!.index_supported_signals.fact_signals[0].qualified_name).toBe("aaa");
    expect(entry!.index_supported_signals.fact_signals[1].qualified_name).toBe("zoo");
  });

  it("excludes facts not linked to the file", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile({ file_revision_id: "fre_abc" })],
      [makeFact({ source_file_revision_id: "fre_other" })],
      [],
    );
    const entry = result.records.find(
      (r): r is typeof r & { index_supported_signals: { fact_signals: unknown[] } } =>
        "index_supported_signals" in r,
    );
    expect(entry!.index_supported_signals.fact_signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Relation signals
// ---------------------------------------------------------------------------

describe("buildStreamingSemanticProjection — relation signals", () => {
  it("includes relations connected to file's facts", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [makeFact()],
      [makeRelation()],
    );
    const entry = result.records.find(
      (r): r is typeof r & { index_supported_signals: { relation_signals: Array<{ relation_type: string; direction: string; source_entry_or_entity_id: string; target_entry_or_entity_id: string; certainty: string; evidence_role: string }> } } =>
        "index_supported_signals" in r,
    );
    expect(entry!.index_supported_signals.relation_signals).toHaveLength(1);
    expect(entry!.index_supported_signals.relation_signals[0].relation_type).toBe("CALLS");
  });
});

// ---------------------------------------------------------------------------
// Section digest
// ---------------------------------------------------------------------------

describe("buildStreamingSemanticProjection — section digest", () => {
  it("produces a valid sha256 digest", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [],
      [],
    );
    expect(result.sectionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("same input → same digest", () => {
    function compute() {
      return buildStreamingSemanticProjection(
        "ws_1",
        "rev_1",
        "sha256:" + "a".repeat(64),
        [makeFile()],
        [makeFact()],
        [],
      );
    }
    expect(compute().sectionDigest).toBe(compute().sectionDigest);
  });

  it("different files → different digest", () => {
    const d1 = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile({ relative_path: "a.ts" })],
      [],
      [],
    ).sectionDigest;
    const d2 = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile({ relative_path: "b.ts" })],
      [],
      [],
    ).sectionDigest;
    expect(d1).not.toBe(d2);
  });
});

// ---------------------------------------------------------------------------
// Record counts
// ---------------------------------------------------------------------------

describe("buildStreamingSemanticProjection — record counts", () => {
  it("totalRecordCount includes header", () => {
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [],
      [],
    );
    expect(result.totalRecordCount).toBe(2); // header + 1 entry
    expect(result.totalEntryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Oversized entry splitting
// ---------------------------------------------------------------------------

describe("buildStreamingSemanticProjection — oversized splitting", () => {
  it("splits an entry with many facts into multiple parts", () => {
    const manyFacts = Array.from({ length: 2000 }, (_, i) =>
      makeFact({
        qualified_name: `func_${i}_${"x".repeat(300)}`,
        display_name: `Func ${i} ${"y".repeat(300)}`,
        attributes: { description: "z".repeat(300) },
      }),
    );
    const result = buildStreamingSemanticProjection(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      manyFacts,
      [],
    );
    const entries = result.records.filter(
      (r): r is typeof r & { schema: typeof HBSP_V2_STRUCTURAL_ENTRY_SCHEMA } =>
        "schema" in r && r.schema === HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
    );
    // Should have multiple parts
    expect(entries.length).toBeGreaterThan(1);

    // All parts should be within bounds
    for (const entry of entries) {
      const octets = utf8OctetLength(canonicalJson(entry));
      expect(octets).toBeLessThanOrEqual(HBSP_V2_RECORD_MAX_UTF8_OCTETS);
    }

    // Parts should use part_index + is_final_part
    expect(entries[0].part_index).toBe(0);
    expect(entries[entries.length - 1].is_final_part).toBe(true);
    for (let i = 0; i < entries.length - 1; i++) {
      expect(entries[i].is_final_part).toBe(false);
      expect(entries[i + 1].part_index).toBe(i + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// V1 compatibility adapter
// ---------------------------------------------------------------------------

describe("buildStreamingProjectionAsMappingInputEntries", () => {
  it("produces V1-compatible MappingInputEntry[]", () => {
    const entries = buildStreamingProjectionAsMappingInputEntries(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [makeFact()],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].entry_id).toBeDefined();
    expect(entries[0].workspace_id).toBe("ws_1");
    expect(entries[0].normalized_path).toBe("src/index.ts");
    expect(entries[0].entry_type).toBe("FILE");
    expect(entries[0].index_supported_signals.fact_signals).toHaveLength(1);
  });

  it("excludes header from V1 output", () => {
    const entries = buildStreamingProjectionAsMappingInputEntries(
      "ws_1",
      "rev_1",
      "sha256:" + "a".repeat(64),
      [makeFile()],
      [],
      [],
    );
    // No header in V1 output
    for (const entry of entries) {
      expect(entry.entry_type).toBe("FILE");
    }
  });
});
