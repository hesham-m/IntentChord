import { describe, it, expect } from "vitest";
import {
  HBSP_V2_RECORD_MAX_UTF8_OCTETS,
  canonicalEntryBytes,
  canonicalHeaderBytes,
  entryRecordDigest,
  headerRecordDigest,
  assertEntryByteAuthority,
  assertHeaderByteAuthority,
  createSemanticProjectionDigestAccumulator,
  computeHBSP_V2SemanticHash,
  structuralEntryToMappingInputEntry,
  type HBSP_V2_SemanticHashInput,
} from "@/core/workspace-index/sections/hbsp-v2-byte-authority";
import {
  HBSP_V2_PROJECTION_HEADER_SCHEMA,
  HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
  deriveLogicalUnitId,
  type HBSP_V2_FileProjectionHeader,
  type HBSP_V2_StructuralProjectionEntry,
  type CandidateFileProjectionHeader,
  type CandidateStructuralProjectionEntry,
} from "@/core/workspace-index/sections/hbsp-v2-types";
import { utf8OctetLength } from "@/core/workspace-index/sections/bounds";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeHeader(overrides?: Partial<CandidateFileProjectionHeader>): CandidateFileProjectionHeader {
  return {
    schema: HBSP_V2_PROJECTION_HEADER_SCHEMA,
    workspace_revision_id: "rev_abc123",
    workspace_index_sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    eligible_entry_count: 10,
    excluded_entry_count: 2,
    projection_created_at: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

function makeEntry(overrides?: Partial<CandidateStructuralProjectionEntry>): CandidateStructuralProjectionEntry {
  const normalizedPath = overrides?.normalized_path ?? "src/index.ts";
  const fingerprint = overrides?.content_or_metadata_fingerprint ?? "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  return {
    schema: HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
    logical_unit_id: overrides?.logical_unit_id ?? deriveLogicalUnitId(normalizedPath, fingerprint),
    part_index: overrides?.part_index ?? 0,
    is_final_part: overrides?.is_final_part ?? true,
    normalized_path: normalizedPath,
    entry_type: "FILE",
    language_or_format: "typescript",
    size_bytes: overrides?.size_bytes ?? 1024,
    content_or_metadata_fingerprint: fingerprint,
    index_supported_signals: {
      file_kind: "SOURCE",
      parse_status: "SUPPORTED",
      coverage_state: "FULL",
      fact_signals: [],
      relation_signals: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("HBSP-V2 byte authority constants", () => {
  it("record max octets is frozen to 262144", () => {
    expect(HBSP_V2_RECORD_MAX_UTF8_OCTETS).toBe(262_144);
  });
});

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

describe("canonicalEntryBytes", () => {
  it("produces deterministic output", () => {
    const entry = makeEntry();
    const b1 = canonicalEntryBytes(entry);
    const b2 = canonicalEntryBytes(entry);
    expect(b1).toBe(b2);
  });

  it("output is valid JSON", () => {
    const entry = makeEntry();
    const bytes = canonicalEntryBytes(entry);
    expect(() => JSON.parse(bytes)).not.toThrow();
  });

  it("output has no whitespace", () => {
    const entry = makeEntry();
    const bytes = canonicalEntryBytes(entry);
    expect(bytes).not.toMatch(/\s/);
  });

  it("output uses sorted keys", () => {
    const entry = makeEntry();
    const bytes = canonicalEntryBytes(entry);
    const parsed = JSON.parse(bytes);
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

describe("canonicalHeaderBytes", () => {
  it("produces deterministic output", () => {
    const header = makeHeader();
    const b1 = canonicalHeaderBytes(header);
    const b2 = canonicalHeaderBytes(header);
    expect(b1).toBe(b2);
  });

  it("output is valid JSON with sorted keys", () => {
    const header = makeHeader();
    const bytes = canonicalHeaderBytes(header);
    const parsed = JSON.parse(bytes);
    expect(Object.keys(parsed)).toEqual(Object.keys(parsed).sort());
  });
});

// ---------------------------------------------------------------------------
// Record digests
// ---------------------------------------------------------------------------

describe("entryRecordDigest", () => {
  it("produces sha256-prefixed hex digest", () => {
    const entry = makeEntry();
    const digest = entryRecordDigest(entry);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("deterministic: same entry → same digest", () => {
    const entry = makeEntry();
    expect(entryRecordDigest(entry)).toBe(entryRecordDigest(entry));
  });

  it("different entries → different digests", () => {
    const e1 = makeEntry({ normalized_path: "a.ts" });
    const e2 = makeEntry({ normalized_path: "b.ts" });
    expect(entryRecordDigest(e1)).not.toBe(entryRecordDigest(e2));
  });
});

describe("headerRecordDigest", () => {
  it("produces sha256-prefixed hex digest", () => {
    const header = makeHeader();
    const digest = headerRecordDigest(header);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Byte authority assertions
// ---------------------------------------------------------------------------

describe("assertEntryByteAuthority", () => {
  it("returns octet count for a small entry", () => {
    const entry = makeEntry();
    const octets = assertEntryByteAuthority(entry);
    expect(octets).toBeGreaterThan(0);
    expect(octets).toBeLessThan(HBSP_V2_RECORD_MAX_UTF8_OCTETS);
  });

  it("throws for an oversized entry", () => {
    const rawEntry = {
      ...makeEntry(),
      content_or_metadata_fingerprint: "x".repeat(300_000),
    };
    expect(() => assertEntryByteAuthority(rawEntry as HBSP_V2_StructuralProjectionEntry)).toThrow(/BYTE_AUTHORITY_VIOLATION/);
  });
});

describe("assertHeaderByteAuthority", () => {
  it("returns octet count for a normal header", () => {
    const header = makeHeader();
    const octets = assertHeaderByteAuthority(header);
    expect(octets).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Incremental section digest accumulator
// ---------------------------------------------------------------------------

describe("SemanticProjectionDigestAccumulator", () => {
  it("computes digest from header + entries in order", () => {
    const acc = createSemanticProjectionDigestAccumulator();
    const header = makeHeader();
    const e1 = makeEntry({ normalized_path: "a.ts" });
    const e2 = makeEntry({ normalized_path: "b.ts" });

    acc.feedHeader(header);
    acc.feedEntry(e1);
    acc.feedEntry(e2);

    expect(acc.recordCount).toBe(3); // header + 2 entries
    expect(acc.entryCount).toBe(2);
    expect(acc.headerFed).toBe(true);

    const digest = acc.finish();
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("same records in same order → same digest", () => {
    function computeDigest(): string {
      const acc = createSemanticProjectionDigestAccumulator();
      acc.feedHeader(makeHeader());
      acc.feedEntry(makeEntry({ normalized_path: "a.ts" }));
      acc.feedEntry(makeEntry({ normalized_path: "b.ts" }));
      return acc.finish();
    }
    expect(computeDigest()).toBe(computeDigest());
  });

  it("different order → different digest", () => {
    const acc1 = createSemanticProjectionDigestAccumulator();
    acc1.feedHeader(makeHeader());
    acc1.feedEntry(makeEntry({ normalized_path: "a.ts" }));
    acc1.feedEntry(makeEntry({ normalized_path: "b.ts" }));
    const d1 = acc1.finish();

    const acc2 = createSemanticProjectionDigestAccumulator();
    acc2.feedHeader(makeHeader());
    acc2.feedEntry(makeEntry({ normalized_path: "b.ts" }));
    acc2.feedEntry(makeEntry({ normalized_path: "a.ts" }));
    const d2 = acc2.finish();

    expect(d1).not.toBe(d2);
  });

  it("throws if header fed twice", () => {
    const acc = createSemanticProjectionDigestAccumulator();
    acc.feedHeader(makeHeader());
    expect(() => acc.feedHeader(makeHeader())).toThrow(/HEADER_ALREADY_FED/);
  });

  it("throws if entry fed before header", () => {
    const acc = createSemanticProjectionDigestAccumulator();
    expect(() => acc.feedEntry(makeEntry())).toThrow(/HEADER_NOT_FED/);
  });

  it("throws if finished without header", () => {
    const acc = createSemanticProjectionDigestAccumulator();
    expect(() => acc.finish()).toThrow(/CANNOT_FINISH_WITHOUT_HEADER/);
  });
});

// ---------------------------------------------------------------------------
// Semantic hash
// ---------------------------------------------------------------------------

describe("computeHBSP_V2SemanticHash", () => {
  it("produces sha256-prefixed hex digest", () => {
    const input: HBSP_V2_SemanticHashInput = {
      schema: "intentchord.artifact-semantic/v2",
      workspace_revision_id: "rev_abc",
      section_manifest_digest: "sha256:" + "a".repeat(64),
      semantic_projection_digest: "sha256:" + "b".repeat(64),
    };
    const hash = computeHBSP_V2SemanticHash(input);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("deterministic: same input → same hash", () => {
    const input: HBSP_V2_SemanticHashInput = {
      schema: "intentchord.artifact-semantic/v2",
      workspace_revision_id: "rev_abc",
      section_manifest_digest: "sha256:" + "a".repeat(64),
      semantic_projection_digest: "sha256:" + "b".repeat(64),
    };
    expect(computeHBSP_V2SemanticHash(input)).toBe(computeHBSP_V2SemanticHash(input));
  });

  it("different inputs → different hashes", () => {
    const input1: HBSP_V2_SemanticHashInput = {
      schema: "intentchord.artifact-semantic/v2",
      workspace_revision_id: "rev_1",
      section_manifest_digest: "sha256:" + "a".repeat(64),
      semantic_projection_digest: "sha256:" + "b".repeat(64),
    };
    const input2: HBSP_V2_SemanticHashInput = {
      schema: "intentchord.artifact-semantic/v2",
      workspace_revision_id: "rev_2",
      section_manifest_digest: "sha256:" + "a".repeat(64),
      semantic_projection_digest: "sha256:" + "b".repeat(64),
    };
    expect(computeHBSP_V2SemanticHash(input1)).not.toBe(computeHBSP_V2SemanticHash(input2));
  });
});

// ---------------------------------------------------------------------------
// MappingInputEntry bridge
// ---------------------------------------------------------------------------

describe("structuralEntryToMappingInputEntry", () => {
  it("maps logical_unit_id to entry_id", () => {
    const entry = makeEntry();
    const mapped = structuralEntryToMappingInputEntry(entry);
    expect(mapped.entry_id).toBe(entry.logical_unit_id);
  });

  it("preserves normalized_path", () => {
    const entry = makeEntry({ normalized_path: "src/lib/utils.ts" });
    const mapped = structuralEntryToMappingInputEntry(entry);
    expect(mapped.normalized_path).toBe("src/lib/utils.ts");
  });

  it("preserves fact_signals", () => {
    const entry = makeEntry({
      index_supported_signals: {
        file_kind: "SOURCE",
        parse_status: "SUPPORTED",
        coverage_state: "FULL",
        fact_signals: [
          {
            fact_type: "FUNCTION_DECLARATION",
            qualified_name: "foo",
            display_name: "foo",
            attributes: {},
            certainty: "EXACT",
            evidence_role: "DECLARATION",
          },
        ],
        relation_signals: [],
      },
    });
    const mapped = structuralEntryToMappingInputEntry(entry);
    expect(mapped.index_supported_signals.fact_signals).toHaveLength(1);
    expect(mapped.index_supported_signals.fact_signals[0].fact_type).toBe("FUNCTION_DECLARATION");
  });

  it("preserves relation_signals", () => {
    const entry = makeEntry({
      index_supported_signals: {
        file_kind: "SOURCE",
        parse_status: "SUPPORTED",
        coverage_state: "FULL",
        fact_signals: [],
        relation_signals: [
          {
            relation_type: "CALLS",
            direction: "OUTGOING",
            source_entry_or_entity_id: "src_a",
            target_entry_or_entity_id: "src_b",
            certainty: "EXACT",
            evidence_role: "INVOCATION",
          },
        ],
      },
    });
    const mapped = structuralEntryToMappingInputEntry(entry);
    expect(mapped.index_supported_signals.relation_signals).toHaveLength(1);
    expect(mapped.index_supported_signals.relation_signals[0].relation_type).toBe("CALLS");
  });
});
