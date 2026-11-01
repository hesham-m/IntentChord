import { describe, it, expect } from "vitest";
import {
  streamAcceptedSemanticProjectionEntries,
  readAcceptedSemanticProjection,
  UnsupportedSectionSchemaVersionError,
  InvalidSemanticProjectionRecordError,
} from "@/server/v2-semantic-projection-reader";
import {
  HBSP_V2_PROJECTION_HEADER_SCHEMA,
  HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
  type FileProjectionHeaderRecord,
  type StructuralProjectionEntryRecord,
} from "@/core/workspace-index/sections/hbsp-v2-types";

// ---------------------------------------------------------------------------
// Helpers and Mocks
// ---------------------------------------------------------------------------

function makeHeader(overrides?: Partial<FileProjectionHeaderRecord>): FileProjectionHeaderRecord {
  return {
    record_kind: "FILE_PROJECTION_HEADER",
    record_id: "fph_123456",
    workspace_id: "ws_abc",
    source_file_revision_id: "fre_1",
    normalized_path: "src/main.ts",
    language_or_format: "typescript",
    size_bytes: 512,
    content_or_metadata_fingerprint: "sha256:fingerprint",
    file_kind: "SOURCE_CODE",
    parse_status: "SUPPORTED",
    coverage_state: "FULL",
    ...overrides,
  };
}

function makeEntry(overrides?: Partial<StructuralProjectionEntryRecord>): StructuralProjectionEntryRecord {
  return {
    record_kind: "STRUCTURAL_PROJECTION_ENTRY",
    record_id: "spe_123456",
    workspace_id: "ws_abc",
    parent_file_entry_id: "fph_123456",
    parent_file_revision_id: "fre_1",
    logical_unit_id: "wsu_test_unit",
    parent_logical_unit_id: null,
    unit_kind: "FUNCTION",
    unit_label: "compute",
    label_authority: "SOURCE_NATIVE",
    part_index: 0,
    is_final_part: true,
    projection_signals: {
      symbols: [
        {
          local_name: "compute",
          qualified_suffix: "main.compute",
          kind: "FUNCTION",
          evidence_role: "CANONICAL",
          certainty: "EXACT",
          fact_ref: "fact_1",
        },
      ],
      relations: [],
    },
    ...overrides,
  };
}

function makeMockRepo(records: Array<Record<string, unknown>>) {
  return {
    async *streamAcceptedRecords(_artifactId: string, _sectionType: string) {
      for (const r of records) {
        yield r;
      }
    },
  };
}

describe("v2-semantic-projection-reader fail-closed version and shape authority", () => {
  it("streams valid HBSP-V2 records when section_schema_version is 'v2'", async () => {
    const repo = makeMockRepo([
      { record_seq: 1, section_schema_version: "v2", record_json: makeHeader() },
      { record_seq: 2, section_schema_version: "v2", record_json: makeEntry() },
    ]);

    const entries = [];
    for await (const entry of streamAcceptedSemanticProjectionEntries(repo, "wea_test")) {
      entries.push(entry);
    }

    expect(entries).toHaveLength(1);
    expect(entries[0].entry_id).toBe("spe_123456");
    expect(entries[0].normalized_path).toBe("src/main.ts");
    expect(entries[0].index_supported_signals.file_kind).toBe("SOURCE_CODE");
  });

  it("fails closed on unsupported section_schema_version (e.g. 'v3')", async () => {
    const repo = makeMockRepo([
      { record_seq: 1, section_schema_version: "v3", record_json: makeHeader() },
    ]);

    await expect(async () => {
      for await (const _ of streamAcceptedSemanticProjectionEntries(repo, "wea_test")) {
        // should throw immediately
      }
    }).rejects.toThrowError(UnsupportedSectionSchemaVersionError);
  });

  it("fails closed when encountering malformed record in v2 section (NO silent skip)", async () => {
    const repo = makeMockRepo([
      { record_seq: 1, section_schema_version: "v2", record_json: makeHeader() },
      { record_seq: 2, section_schema_version: "v2", record_json: { corrupted: true } },
    ]);

    await expect(async () => {
      for await (const _ of streamAcceptedSemanticProjectionEntries(repo, "wea_test")) {
        // should throw on record 2
      }
    }).rejects.toThrowError(InvalidSemanticProjectionRecordError);
  });

  it("fails closed when first record in v2 section is not a projection header", async () => {
    const repo = makeMockRepo([
      { record_seq: 1, section_schema_version: "v2", record_json: makeEntry() },
    ]);

    await expect(async () => {
      for await (const _ of streamAcceptedSemanticProjectionEntries(repo, "wea_test")) {
        // should throw on record 1
      }
    }).rejects.toThrowError(InvalidSemanticProjectionRecordError);
  });

  it("fails closed on historical v1 section_schema_version (V1_SEMANTIC_PROJECTION_REJECTED)", async () => {
    const v1Record = {
      entry_id: "v1_entry_1",
      normalized_path: "src/legacy.ts",
      entry_type: "FILE",
      size_bytes: 200,
      content_or_metadata_fingerprint: "sha256:leg",
      index_supported_signals: {
        file_kind: "SOURCE_CODE",
        parse_status: "SUPPORTED",
        coverage_state: "FULL",
        fact_signals: [],
        relation_signals: [],
      },
    };
    const repo = makeMockRepo([
      { record_seq: 1, section_schema_version: "v1", record_json: v1Record },
    ]);

    await expect(async () => {
      for await (const _ of streamAcceptedSemanticProjectionEntries(repo, "wea_test")) {
        // should throw immediately on v1
      }
    }).rejects.toThrowError(UnsupportedSectionSchemaVersionError);
  });

  it("fails closed on obsolete v1 section regardless of record contents (V2_ONLY_AUTHORITY)", async () => {
    const repo = makeMockRepo([
      { record_seq: 1, section_schema_version: "v1", record_json: { anything: true } },
    ]);

    await expect(async () => {
      for await (const _ of streamAcceptedSemanticProjectionEntries(repo, "wea_test")) {
        // should throw immediately on v1
      }
    }).rejects.toThrowError(UnsupportedSectionSchemaVersionError);
  });

  it("fails closed on unversioned streamer with unrecognized record shape", async () => {
    const repo = makeMockRepo([
      { record_seq: 1, record_json: { unrecognized_random_format: 42 } },
    ]);

    await expect(async () => {
      for await (const _ of streamAcceptedSemanticProjectionEntries(repo, "wea_test")) {
        // should throw
      }
    }).rejects.toThrowError(UnsupportedSectionSchemaVersionError);
  });
});
