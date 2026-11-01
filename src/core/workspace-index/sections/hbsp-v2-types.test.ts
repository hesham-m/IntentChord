import { describe, it, expect } from "vitest";
import {
  HBSP_V2_SECTION_SCHEMA_VERSION,
  HBSP_V2_PROJECTION_HEADER_SCHEMA,
  HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
  HBSP_V2_LOGICAL_UNIT_ID_SCHEMA,
  HBSP_V2_ENTRY_TYPES,
  HBSP_V2_COVERAGE_STATES,
  HBSP_V2_PARSE_STATUSES,
  HBSP_OVERSIZED_SYMBOL_FALLBACK_MAX_OCTETS,
  HBSP_OVERSIZED_RELATION_FALLBACK_MAX_OCTETS,
  type HBSP_V2_FileProjectionHeader,
  type HBSP_V2_StructuralProjectionEntry,
  type CandidateFileProjectionHeader,
  type CandidateStructuralProjectionEntry,
  deriveLogicalUnitId,
  isValidHBSP_V2EntryType,
  isValidHBSP_V2CoverageState,
  isValidHBSP_V2ParseStatus,
  clampOversizedSymbol,
  clampOversizedRelation,
  assertStructuralEntryWithinBounds,
  assertProjectionHeaderWithinBounds,
  assertLogicalUnitIdSourceGrounded,
  assertFactSignalsCanonical,
  assertRelationSignalsCanonical,
  validateStructuralProjectionEntry,
  validateFileProjectionHeader,
} from "@/core/workspace-index/sections/hbsp-v2-types";

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
      ...(overrides?.index_supported_signals as Record<string, unknown> ?? {}),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("HBSP-V2 frozen constants", () => {
  it("schema versions are frozen strings", () => {
    expect(HBSP_V2_SECTION_SCHEMA_VERSION).toBe("intentchord.section-schema/v2");
    expect(HBSP_V2_PROJECTION_HEADER_SCHEMA).toBe("intentchord.hbsp-v2.projection-header/v1");
    expect(HBSP_V2_STRUCTURAL_ENTRY_SCHEMA).toBe("intentchord.hbsp-v2.structural-entry/v1");
    expect(HBSP_V2_LOGICAL_UNIT_ID_SCHEMA).toBe("intentchord.hbsp-v2.logical-unit-id/v1");
  });

  it("entry types are frozen to FILE only", () => {
    expect(HBSP_V2_ENTRY_TYPES).toEqual(["FILE"]);
  });

  it("coverage states are frozen", () => {
    expect(HBSP_V2_COVERAGE_STATES).toEqual(["UNSUPPORTED", "PARTIAL", "FULL"]);
  });

  it("parse statuses are frozen", () => {
    expect(HBSP_V2_PARSE_STATUSES).toEqual(["NOT_APPLICABLE", "SUPPORTED", "PARTIAL", "FAILED"]);
  });

  it("oversized bounds are frozen", () => {
    expect(HBSP_OVERSIZED_SYMBOL_FALLBACK_MAX_OCTETS).toBe(254);
    expect(HBSP_OVERSIZED_RELATION_FALLBACK_MAX_OCTETS).toBe(260);
  });
});

// ---------------------------------------------------------------------------
// Logical unit ID derivation
// ---------------------------------------------------------------------------

describe("deriveLogicalUnitId", () => {
  it("produces deterministic IDs from path + fingerprint", () => {
    const id1 = deriveLogicalUnitId("src/index.ts", "sha256:aaa");
    const id2 = deriveLogicalUnitId("src/index.ts", "sha256:aaa");
    expect(id1).toBe(id2);
  });

  it("different paths produce different IDs", () => {
    const id1 = deriveLogicalUnitId("src/index.ts", "sha256:aaa");
    const id2 = deriveLogicalUnitId("src/other.ts", "sha256:aaa");
    expect(id1).not.toBe(id2);
  });

  it("different fingerprints produce different IDs", () => {
    const id1 = deriveLogicalUnitId("src/index.ts", "sha256:aaa");
    const id2 = deriveLogicalUnitId("src/index.ts", "sha256:bbb");
    expect(id1).not.toBe(id2);
  });

  it("IDs start with canonical schema prefix", () => {
    const id = deriveLogicalUnitId("src/index.ts", "sha256:aaa");
    expect(id).toMatch(/^intentchord\.hbsp-v2\.logical-unit-id\.v1_/);
  });

  it("IDs are source-grounded (no discovery order dependency)", () => {
    const id1 = deriveLogicalUnitId("z/file.ts", "sha256:aaa");
    const id2 = deriveLogicalUnitId("a/file.ts", "sha256:aaa");
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Closed vocabulary validators
// ---------------------------------------------------------------------------

describe("closed vocabulary validators", () => {
  it("isValidHBSP_V2EntryType accepts FILE", () => {
    expect(isValidHBSP_V2EntryType("FILE")).toBe(true);
  });

  it("isValidHBSP_V2EntryType rejects noncanonical values", () => {
    expect(isValidHBSP_V2EntryType("FACT")).toBe(false);
    expect(isValidHBSP_V2EntryType("")).toBe(false);
    expect(isValidHBSP_V2EntryType("file")).toBe(false);
  });

  it("isValidHBSP_V2CoverageState accepts valid values", () => {
    expect(isValidHBSP_V2CoverageState("UNSUPPORTED")).toBe(true);
    expect(isValidHBSP_V2CoverageState("PARTIAL")).toBe(true);
    expect(isValidHBSP_V2CoverageState("FULL")).toBe(true);
  });

  it("isValidHBSP_V2CoverageState rejects noncanonical values", () => {
    expect(isValidHBSP_V2CoverageState("complete")).toBe(false);
    expect(isValidHBSP_V2CoverageState("")).toBe(false);
  });

  it("isValidHBSP_V2ParseStatus accepts valid values", () => {
    expect(isValidHBSP_V2ParseStatus("NOT_APPLICABLE")).toBe(true);
    expect(isValidHBSP_V2ParseStatus("SUPPORTED")).toBe(true);
    expect(isValidHBSP_V2ParseStatus("PARTIAL")).toBe(true);
    expect(isValidHBSP_V2ParseStatus("FAILED")).toBe(true);
  });

  it("isValidHBSP_V2ParseStatus rejects noncanonical values", () => {
    expect(isValidHBSP_V2ParseStatus("OK")).toBe(false);
    expect(isValidHBSP_V2ParseStatus("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Oversized symbol/relation clamping
// ---------------------------------------------------------------------------

describe("clampOversizedSymbol", () => {
  it("returns original if within bounds", () => {
    const short = "a".repeat(100);
    expect(clampOversizedSymbol(short)).toBe(short);
  });

  it("truncates to max octets", () => {
    const long = "a".repeat(300);
    const result = clampOversizedSymbol(long);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(HBSP_OVERSIZED_SYMBOL_FALLBACK_MAX_OCTETS);
  });
});

describe("clampOversizedRelation", () => {
  it("returns original if within bounds", () => {
    const short = "b".repeat(100);
    expect(clampOversizedRelation(short)).toBe(short);
  });

  it("truncates to max octets", () => {
    const long = "b".repeat(300);
    const result = clampOversizedRelation(long);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(HBSP_OVERSIZED_RELATION_FALLBACK_MAX_OCTETS);
  });
});

// ---------------------------------------------------------------------------
// Bounds assertions
// ---------------------------------------------------------------------------

describe("assertStructuralEntryWithinBounds", () => {
  it("passes for a small entry", () => {
    expect(() => assertStructuralEntryWithinBounds(makeEntry())).not.toThrow();
  });

  it("throws when entry exceeds 262144 octets", () => {
    // Build a raw entry with a huge content_or_metadata_fingerprint to exceed the bound
    const rawEntry = {
      schema: HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
      logical_unit_id: deriveLogicalUnitId("src/huge.ts", "sha256:aaa"),
      part_index: 0,
      is_final_part: true,
      normalized_path: "src/huge.ts",
      entry_type: "FILE",
      language_or_format: "typescript",
      size_bytes: 999999,
      content_or_metadata_fingerprint: "x".repeat(300_000),
      index_supported_signals: {
        file_kind: "SOURCE",
        parse_status: "SUPPORTED",
        coverage_state: "FULL",
        fact_signals: [],
        relation_signals: [],
      },
    };
    expect(() => assertStructuralEntryWithinBounds(rawEntry as HBSP_V2_StructuralProjectionEntry)).toThrow(/OVERBOUND/);
  });
});

describe("assertProjectionHeaderWithinBounds", () => {
  it("passes for a normal header", () => {
    expect(() => assertProjectionHeaderWithinBounds(makeHeader())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Logical unit ID grounding
// ---------------------------------------------------------------------------

describe("assertLogicalUnitIdSourceGrounded", () => {
  it("passes for canonical prefix", () => {
    const id = deriveLogicalUnitId("src/index.ts", "sha256:aaa");
    expect(() => assertLogicalUnitIdSourceGrounded(id)).not.toThrow();
  });

  it("throws for non-canonical prefix", () => {
    expect(() => assertLogicalUnitIdSourceGrounded("mie_abc123")).toThrow(/NOT_SOURCE_GROUNDED/);
  });
});

// ---------------------------------------------------------------------------
// Signal canonical assertions
// ---------------------------------------------------------------------------

describe("assertFactSignalsCanonical", () => {
  it("passes for valid signals", () => {
    expect(() => assertFactSignalsCanonical([
      { fact_type: "FUNCTION_DECLARATION", certainty: "EXACT", evidence_role: "DECLARATION" },
    ])).not.toThrow();
  });

  it("throws for empty fact_type", () => {
    expect(() => assertFactSignalsCanonical([
      { fact_type: "", certainty: "EXACT", evidence_role: "DECLARATION" },
    ])).toThrow(/NONCANONICAL/);
  });

  it("throws for empty certainty", () => {
    expect(() => assertFactSignalsCanonical([
      { fact_type: "FUNCTION_DECLARATION", certainty: "", evidence_role: "DECLARATION" },
    ])).toThrow(/NONCANONICAL/);
  });
});

describe("assertRelationSignalsCanonical", () => {
  it("passes for valid signals", () => {
    expect(() => assertRelationSignalsCanonical([
      { relation_type: "CALLS", certainty: "EXACT", evidence_role: "INVOCATION" },
    ])).not.toThrow();
  });

  it("throws for empty relation_type", () => {
    expect(() => assertRelationSignalsCanonical([
      { relation_type: "", certainty: "EXACT", evidence_role: "INVOCATION" },
    ])).toThrow(/NONCANONICAL/);
  });
});

// ---------------------------------------------------------------------------
// Full validation predicates
// ---------------------------------------------------------------------------

describe("validateStructuralProjectionEntry", () => {
  it("accepts a valid entry", () => {
    expect(validateStructuralProjectionEntry(makeEntry())).toBe(true);
  });

  it("rejects null", () => {
    expect(validateStructuralProjectionEntry(null)).toBe(false);
  });

  it("rejects wrong schema", () => {
    expect(validateStructuralProjectionEntry({ ...makeEntry(), schema: "wrong" })).toBe(false);
  });

  it("rejects non-source-grounded logical_unit_id", () => {
    expect(validateStructuralProjectionEntry({
      ...makeEntry(),
      logical_unit_id: "mie_invalid",
    })).toBe(false);
  });

  it("rejects noncanonical entry_type", () => {
    expect(validateStructuralProjectionEntry({
      ...makeEntry(),
      entry_type: "FACT",
    })).toBe(false);
  });

  it("rejects negative part_index", () => {
    expect(validateStructuralProjectionEntry({
      ...makeEntry(),
      part_index: -1,
    })).toBe(false);
  });

  it("rejects non-boolean is_final_part", () => {
    expect(validateStructuralProjectionEntry({
      ...makeEntry(),
      is_final_part: "yes",
    })).toBe(false);
  });
});

describe("validateFileProjectionHeader", () => {
  it("accepts a valid header", () => {
    expect(validateFileProjectionHeader(makeHeader())).toBe(true);
  });

  it("rejects null", () => {
    expect(validateFileProjectionHeader(null)).toBe(false);
  });

  it("rejects wrong schema", () => {
    expect(validateFileProjectionHeader({ ...makeHeader(), schema: "wrong" })).toBe(false);
  });

  it("rejects negative eligible_entry_count", () => {
    expect(validateFileProjectionHeader({
      ...makeHeader(),
      eligible_entry_count: -1,
    })).toBe(false);
  });
});
