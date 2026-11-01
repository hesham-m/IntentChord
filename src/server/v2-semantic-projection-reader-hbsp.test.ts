import { describe, it, expect } from "vitest";
import {
  readAcceptedHBSP_V2SemanticProjection,
  readAcceptedHBSP_V2AsMappingInputEntries,
  streamAcceptedHBSP_V2AsMappingInputEntries,
  readAcceptedSemanticProjection_V2,
  type EvidenceRecordStreamer,
} from "@/server/v2-semantic-projection-reader-hbsp";
import {
  HBSP_V2_PROJECTION_HEADER_SCHEMA,
  HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
  deriveLogicalUnitId,
  type HBSP_V2_FileProjectionHeader,
  type HBSP_V2_StructuralProjectionEntry,
} from "@/core/workspace-index/sections/hbsp-v2-types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeHeader(): HBSP_V2_FileProjectionHeader {
  return {
    schema: HBSP_V2_PROJECTION_HEADER_SCHEMA,
    workspace_revision_id: "rev_abc",
    workspace_index_sha256: "sha256:" + "a".repeat(64),
    eligible_entry_count: 2,
    excluded_entry_count: 0,
    projection_created_at: "2026-09-03T00:00:00.000Z",
  };
}

function makeEntry(path = "src/index.ts"): HBSP_V2_StructuralProjectionEntry {
  return {
    schema: HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
    logical_unit_id: deriveLogicalUnitId(path, "sha256:bbb"),
    part_index: 0,
    is_final_part: true,
    normalized_path: path,
    entry_type: "FILE",
    language_or_format: "typescript",
    size_bytes: 1024,
    content_or_metadata_fingerprint: "sha256:" + "b".repeat(64),
    index_supported_signals: {
      file_kind: "SOURCE",
      parse_status: "SUPPORTED",
      coverage_state: "FULL",
      fact_signals: [],
      relation_signals: [],
    },
  };
}

function makeMockStreamer(records: Array<{ record_json: unknown }>): EvidenceRecordStreamer {
  return {
    async *streamAcceptedRecords(_artifactId: string, _sectionType: string) {
      for (const record of records) {
        yield record;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// readAcceptedHBSP_V2SemanticProjection
// ---------------------------------------------------------------------------

describe("readAcceptedHBSP_V2SemanticProjection", () => {
  it("reads a valid header + entries", async () => {
    const streamer = makeMockStreamer([
      { record_json: makeHeader() },
      { record_json: makeEntry("a.ts") },
      { record_json: makeEntry("b.ts") },
    ]);
    const result = await readAcceptedHBSP_V2SemanticProjection(streamer, "wea_123");
    expect(result.header.workspace_revision_id).toBe("rev_abc");
    expect(result.entries).toHaveLength(2);
    expect(result.recordCount).toBe(3);
    expect(result.logicalUnitCount).toBe(2);
  });

  it("throws on empty section", async () => {
    const streamer = makeMockStreamer([]);
    await expect(readAcceptedHBSP_V2SemanticProjection(streamer, "wea_123")).rejects.toThrow(/EMPTY_SECTION/);
  });

  it("throws on invalid header", async () => {
    const streamer = makeMockStreamer([
      { record_json: { schema: "wrong" } },
    ]);
    await expect(readAcceptedHBSP_V2SemanticProjection(streamer, "wea_123")).rejects.toThrow(/INVALID_HEADER/);
  });

  it("throws on invalid structural entry", async () => {
    const streamer = makeMockStreamer([
      { record_json: makeHeader() },
      { record_json: { schema: "wrong" } },
    ]);
    await expect(readAcceptedHBSP_V2SemanticProjection(streamer, "wea_123")).rejects.toThrow(/INVALID_ENTRY/);
  });
});

// ---------------------------------------------------------------------------
// readAcceptedHBSP_V2AsMappingInputEntries
// ---------------------------------------------------------------------------

describe("readAcceptedHBSP_V2AsMappingInputEntries", () => {
  it("produces V1-compatible MappingInputEntry[]", async () => {
    const streamer = makeMockStreamer([
      { record_json: makeHeader() },
      { record_json: makeEntry("a.ts") },
      { record_json: makeEntry("b.ts") },
    ]);
    const result = await readAcceptedHBSP_V2AsMappingInputEntries(streamer, "wea_123", "ws_1");
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].entry_id).toBeDefined();
    expect(result.entries[0].workspace_id).toBe("ws_1");
    expect(result.entries[0].normalized_path).toBe("a.ts");
  });

  it("entries are sorted by normalized_path", async () => {
    const streamer = makeMockStreamer([
      { record_json: makeHeader() },
      { record_json: makeEntry("z.ts") },
      { record_json: makeEntry("a.ts") },
    ]);
    const result = await readAcceptedHBSP_V2AsMappingInputEntries(streamer, "wea_123", "ws_1");
    expect(result.entries[0].normalized_path).toBe("a.ts");
    expect(result.entries[1].normalized_path).toBe("z.ts");
  });
});

// ---------------------------------------------------------------------------
// streamAcceptedHBSP_V2AsMappingInputEntries
// ---------------------------------------------------------------------------

describe("streamAcceptedHBSP_V2AsMappingInputEntries", () => {
  it("yields MappingInputEntry[] incrementally", async () => {
    const streamer = makeMockStreamer([
      { record_json: makeHeader() },
      { record_json: makeEntry("a.ts") },
      { record_json: makeEntry("b.ts") },
    ]);
    const entries = [];
    for await (const entry of streamAcceptedHBSP_V2AsMappingInputEntries(streamer, "wea_123", "ws_1")) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
    expect(entries[0].entry_id).toBeDefined();
    expect(entries[0].workspace_id).toBe("ws_1");
  });

  it("skips header in output", async () => {
    const streamer = makeMockStreamer([
      { record_json: makeHeader() },
      { record_json: makeEntry("a.ts") },
    ]);
    const entries = [];
    for await (const entry of streamAcceptedHBSP_V2AsMappingInputEntries(streamer, "wea_123", "ws_1")) {
      entries.push(entry);
    }
    // All entries should be FILE type, no header
    for (const entry of entries) {
      expect(entry.entry_type).toBe("FILE");
    }
  });

  it("throws on empty section", async () => {
    const streamer = makeMockStreamer([]);
    const gen = streamAcceptedHBSP_V2AsMappingInputEntries(streamer, "wea_123", "ws_1");
    await expect(gen.next()).rejects.toThrow(/EMPTY_SECTION/);
  });
});

// ---------------------------------------------------------------------------
// readAcceptedSemanticProjection_V2 (bridge)
// ---------------------------------------------------------------------------

describe("readAcceptedSemanticProjection_V2", () => {
  it("produces entries compatible with existing contract", async () => {
    const streamer = makeMockStreamer([
      { record_json: makeHeader() },
      { record_json: makeEntry("a.ts") },
    ]);
    const result = await readAcceptedSemanticProjection_V2(streamer, "wea_123");
    expect(result.entries).toHaveLength(1);
    expect(result.recordCount).toBe(2);
    expect(result.entries[0].normalized_path).toBe("a.ts");
  });

  it("throws on empty section", async () => {
    const streamer = makeMockStreamer([]);
    await expect(readAcceptedSemanticProjection_V2(streamer, "wea_123")).rejects.toThrow(/EMPTY_SECTION/);
  });
});
