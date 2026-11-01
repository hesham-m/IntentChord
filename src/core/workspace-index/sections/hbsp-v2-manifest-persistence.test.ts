import { describe, it, expect } from "vitest";
import {
  buildHBSP_V2SectionManifestEntry,
  buildHBSP_V2FullSectionManifest,
  computeArtifactManifestSha256,
  computeCanonicalCompatSha256,
  computeHBSP_V2ArtifactSemanticSha256,
  computeHBSP_V2AcceptedArtifactId,
  buildStagedRecordsFromProjection,
  assertAllStagedRecordsWithinBounds,
  buildSectionInsert,
  buildArtifactHeader,
} from "@/core/workspace-index/sections/hbsp-v2-manifest-persistence";
import {
  HBSP_V2_SECTION_SCHEMA_VERSION,
  HBSP_V2_PROJECTION_HEADER_SCHEMA,
  HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
  deriveLogicalUnitId,
  type HBSP_V2_FileProjectionHeader,
  type HBSP_V2_StructuralProjectionEntry,
} from "@/core/workspace-index/sections/hbsp-v2-types";
import { HBSP_V2_RECORD_MAX_UTF8_OCTETS } from "@/core/workspace-index/sections/hbsp-v2-byte-authority";
import { utf8OctetLength } from "@/core/workspace-index/sections/bounds";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHeader(): HBSP_V2_FileProjectionHeader {
  return {
    schema: HBSP_V2_PROJECTION_HEADER_SCHEMA,
    workspace_revision_id: "rev_abc",
    workspace_index_sha256: "sha256:" + "a".repeat(64),
    eligible_entry_count: 5,
    excluded_entry_count: 1,
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

// ---------------------------------------------------------------------------
// Package 4: Section Manifest Entry
// ---------------------------------------------------------------------------

describe("buildHBSP_V2SectionManifestEntry", () => {
  it("produces a valid manifest entry with HBSP-V2 schema version", () => {
    const entry = buildHBSP_V2SectionManifestEntry("sha256:" + "c".repeat(64), 10, 1);
    expect(entry.section_type).toBe("SEMANTIC_PROJECTION");
    expect(entry.section_schema_version).toBe(HBSP_V2_SECTION_SCHEMA_VERSION);
    expect(entry.section_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.record_count).toBe(10);
    expect(entry.segment_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Package 4: Full Section Manifest
// ---------------------------------------------------------------------------

describe("buildHBSP_V2FullSectionManifest", () => {
  it("produces a 9-section manifest in fixed order", () => {
    const manifest = buildHBSP_V2FullSectionManifest(
      {
        FILES: { digest: "sha256:" + "1".repeat(64), recordCount: 10, segmentCount: 1 },
        FACTS: { digest: "sha256:" + "2".repeat(64), recordCount: 20, segmentCount: 1 },
        RELATIONS: { digest: "sha256:" + "3".repeat(64), recordCount: 15, segmentCount: 1 },
        CONTENT_REFERENCES: { digest: "sha256:" + "4".repeat(64), recordCount: 5, segmentCount: 1 },
        FAILURES: { digest: "sha256:" + "5".repeat(64), recordCount: 0, segmentCount: 1 },
        CONTINUITY_ATTESTATION: { digest: "sha256:" + "6".repeat(64), recordCount: 1, segmentCount: 1 },
        DERIVATION_ATTESTATION: { digest: "sha256:" + "7".repeat(64), recordCount: 3, segmentCount: 1 },
        DELTA_LINEAGE: { digest: "sha256:" + "8".repeat(64), recordCount: 2, segmentCount: 1 },
      },
      "sha256:" + "9".repeat(64),
      12,
      1,
    );
    expect(manifest).toHaveLength(9);
    expect(manifest[0].section_type).toBe("FILES");
    expect(manifest[5].section_type).toBe("SEMANTIC_PROJECTION");
    expect(manifest[5].section_schema_version).toBe(HBSP_V2_SECTION_SCHEMA_VERSION);
  });

  it("throws if a non-SEMANTIC_PROJECTION section digest is missing", () => {
    expect(() => buildHBSP_V2FullSectionManifest({}, "sha256:" + "a".repeat(64), 1, 1)).toThrow(/MISSING_SECTION_DIGEST/);
  });
});

// ---------------------------------------------------------------------------
// Package 5: Artifact Manifest
// ---------------------------------------------------------------------------

describe("computeArtifactManifestSha256", () => {
  it("produces a valid sha256 digest", () => {
    const manifest = buildHBSP_V2FullSectionManifest(
      {
        FILES: { digest: "sha256:" + "1".repeat(64), recordCount: 10, segmentCount: 1 },
        FACTS: { digest: "sha256:" + "2".repeat(64), recordCount: 20, segmentCount: 1 },
        RELATIONS: { digest: "sha256:" + "3".repeat(64), recordCount: 15, segmentCount: 1 },
        CONTENT_REFERENCES: { digest: "sha256:" + "4".repeat(64), recordCount: 5, segmentCount: 1 },
        FAILURES: { digest: "sha256:" + "5".repeat(64), recordCount: 0, segmentCount: 1 },
        CONTINUITY_ATTESTATION: { digest: "sha256:" + "6".repeat(64), recordCount: 1, segmentCount: 1 },
        DERIVATION_ATTESTATION: { digest: "sha256:" + "7".repeat(64), recordCount: 3, segmentCount: 1 },
        DELTA_LINEAGE: { digest: "sha256:" + "8".repeat(64), recordCount: 2, segmentCount: 1 },
      },
      "sha256:" + "9".repeat(64),
      12,
      1,
    );
    const hash = computeArtifactManifestSha256(manifest);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("computeCanonicalCompatSha256", () => {
  it("matches computeArtifactManifestSha256", () => {
    const manifest = buildHBSP_V2FullSectionManifest(
      {
        FILES: { digest: "sha256:" + "1".repeat(64), recordCount: 10, segmentCount: 1 },
        FACTS: { digest: "sha256:" + "2".repeat(64), recordCount: 20, segmentCount: 1 },
        RELATIONS: { digest: "sha256:" + "3".repeat(64), recordCount: 15, segmentCount: 1 },
        CONTENT_REFERENCES: { digest: "sha256:" + "4".repeat(64), recordCount: 5, segmentCount: 1 },
        FAILURES: { digest: "sha256:" + "5".repeat(64), recordCount: 0, segmentCount: 1 },
        CONTINUITY_ATTESTATION: { digest: "sha256:" + "6".repeat(64), recordCount: 1, segmentCount: 1 },
        DERIVATION_ATTESTATION: { digest: "sha256:" + "7".repeat(64), recordCount: 3, segmentCount: 1 },
        DELTA_LINEAGE: { digest: "sha256:" + "8".repeat(64), recordCount: 2, segmentCount: 1 },
      },
      "sha256:" + "9".repeat(64),
      12,
      1,
    );
    expect(computeCanonicalCompatSha256(manifest)).toBe(computeArtifactManifestSha256(manifest));
  });
});

// ---------------------------------------------------------------------------
// Package 6: Semantic Hash
// ---------------------------------------------------------------------------

describe("computeHBSP_V2ArtifactSemanticSha256", () => {
  it("produces a valid sha256 digest", () => {
    const hash = computeHBSP_V2ArtifactSemanticSha256(
      "rev_abc",
      "sha256:" + "a".repeat(64),
      "sha256:" + "b".repeat(64),
    );
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("deterministic: same inputs → same hash", () => {
    const h1 = computeHBSP_V2ArtifactSemanticSha256("rev_abc", "sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64));
    const h2 = computeHBSP_V2ArtifactSemanticSha256("rev_abc", "sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64));
    expect(h1).toBe(h2);
  });

  it("different inputs → different hashes", () => {
    const h1 = computeHBSP_V2ArtifactSemanticSha256("rev_1", "sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64));
    const h2 = computeHBSP_V2ArtifactSemanticSha256("rev_2", "sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64));
    expect(h1).not.toBe(h2);
  });
});

describe("computeHBSP_V2AcceptedArtifactId", () => {
  it("produces a valid wea_ prefixed ID", () => {
    const id = computeHBSP_V2AcceptedArtifactId("inst_1", "rev_1", "sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64));
    expect(id).toMatch(/^wea_[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Package 7: Staged Records
// ---------------------------------------------------------------------------

describe("buildStagedRecordsFromProjection", () => {
  it("produces records starting with header", () => {
    const records = buildStagedRecordsFromProjection("snap_1", makeHeader(), [makeEntry()]);
    expect(records).toHaveLength(2);
    expect(records[0].record_seq).toBe(1);
    expect(records[0].section_type).toBe("SEMANTIC_PROJECTION");
    expect(records[0].record_json).toEqual(makeHeader());
    expect(records[1].record_seq).toBe(2);
    expect(records[1].record_json).toEqual(makeEntry());
  });

  it("record digests are sha256-prefixed hex", () => {
    const records = buildStagedRecordsFromProjection("snap_1", makeHeader(), [makeEntry()]);
    for (const r of records) {
      expect(r.record_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("assertAllStagedRecordsWithinBounds", () => {
  it("passes for normal records", () => {
    const records = buildStagedRecordsFromProjection("snap_1", makeHeader(), [makeEntry()]);
    expect(() => assertAllStagedRecordsWithinBounds(records)).not.toThrow();
  });

  it("throws for oversized records", () => {
    const hugeEntry = {
      ...makeEntry(),
      content_or_metadata_fingerprint: "x".repeat(300_000),
    };
    const records = buildStagedRecordsFromProjection("snap_1", makeHeader(), [hugeEntry as HBSP_V2_StructuralProjectionEntry]);
    expect(() => assertAllStagedRecordsWithinBounds(records)).toThrow(/OVERBOUND/);
  });
});

// ---------------------------------------------------------------------------
// Section Insert
// ---------------------------------------------------------------------------

describe("buildSectionInsert", () => {
  it("produces a valid section insert with HBSP-V2 schema", () => {
    const insert = buildSectionInsert("reg_1", "wea_abc", "sha256:" + "a".repeat(64), 10, 1);
    expect(insert.section_type).toBe("SEMANTIC_PROJECTION");
    expect(insert.section_order).toBe(6);
    expect(insert.section_schema_version).toBe(HBSP_V2_SECTION_SCHEMA_VERSION);
    expect(insert.workspace_registration_id).toBe("reg_1");
    expect(insert.artifact_id).toBe("wea_abc");
  });
});

// ---------------------------------------------------------------------------
// Artifact Header
// ---------------------------------------------------------------------------

describe("buildArtifactHeader", () => {
  it("produces a valid artifact header", () => {
    const header = buildArtifactHeader("rev_1", "inst_1", "sha256:" + "a".repeat(64));
    expect(header.schema).toBe("intentchord.workspace-evidence-artifact/v2");
    expect(header.workspace_revision_id).toBe("rev_1");
    expect(header.engine_mode).toBe("V2_SECTIONED");
  });
});
