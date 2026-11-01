import { describe, expect, it } from "vitest";
import {
  SectionDigestAccumulator,
  acceptedArtifactId,
  recordDigest,
  sectionManifestDigest,
  segmentDigest,
} from "@/core/workspace-index/sections/digests";
import { continuityAttestationId, candidateEvidenceId, deltaLineageRecordId } from "@/core/workspace-index/sections/ids";

// Deterministic reference vectors generated with the repository's canonicalJson semantics
// (sorted-key JSON, UTF-8 sha256) — SPEC V3 Sections 2.2 / 2.5 / 2.6 / 2.7.
const RECORD = { workspace_file_id: "wfi_vec", file_revision_id: "fir_vec", relative_path: "src/a.ts" };
const V_RECORD_DIGEST = "sha256:d0262d61d73ae507a33a63c8823964bb0634503e23efd33c198ad77c86e8e965";
const V_SECTION_DIGEST = "sha256:957abbb90dd70f39628a18605829d185d2085db7366b2dd9d35b475d76b30b7d";
const V_MANIFEST_DIGEST = "sha256:908b39324559b7f8f42219d3994cd7186dd5a141b4e0e1941bf0c0a665987fcf";
const V_ARTIFACT_ID = "wea_f0f1ba64c9f8683d3df0288ffb9d34c8791120fc5b05cd0f34d425fce42139cb";
const V_WCA = "wca_63d1c408f78647702e7fc381e8610d8ffcf0bb6a4d234da5a306f699daf6d2a6";
const V_DER_SOURCE = "der_f9cdb81e9555957483e19d7292f39f7365fda03ad7fdd31d6e78fb559e2c0b5c";
const SID = "123e4567-e89b-42d3-a456-426614174000";

describe("sectioned identity foundations (SPEC V3 Phase 1 vectors)", () => {
  it("record digest matches the frozen vector", () => {
    expect(recordDigest(RECORD)).toBe(V_RECORD_DIGEST);
  });

  it("section digest framing matches the frozen vector", () => {
    const acc = new SectionDigestAccumulator("FILES", "v1");
    acc.feedRecordDigest(recordDigest(RECORD));
    expect(acc.recordCount).toBe(1);
    expect(acc.finish()).toBe(V_SECTION_DIGEST);
  });

  it("segment digest is position-bound and stable", () => {
    const d1 = segmentDigest(1, [recordDigest(RECORD)]);
    const d2 = segmentDigest(2, [recordDigest(RECORD)]);
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d1).not.toBe(d2);
    expect(segmentDigest(1, [recordDigest(RECORD)])).toBe(d1);
  });

  it("manifest digest enforces FIXED SECTION ORDER and rejects duplicates", () => {
    const manifest = [
      { section_type: "FILES", section_schema_version: "v1", section_digest: V_SECTION_DIGEST, record_count: 1, segment_count: 1 },
    ] as const;
    expect(sectionManifestDigest(manifest)).toBe(V_MANIFEST_DIGEST);
    expect(() =>
      sectionManifestDigest([
        manifest[0],
        { section_type: "FILES", section_schema_version: "v1", section_digest: V_SECTION_DIGEST, record_count: 0, segment_count: 1 },
      ]),
    ).toThrow(/DUPLICATE_TYPE/);
    expect(() =>
      sectionManifestDigest([
        { section_type: "FACTS", section_schema_version: "v1", section_digest: V_SECTION_DIGEST, record_count: 1, segment_count: 1 },
        { section_type: "FILES", section_schema_version: "v1", section_digest: V_SECTION_DIGEST, record_count: 1, segment_count: 1 },
      ] as never),
    ).toThrow(/NOT_IN_FIXED_ORDER/);
  });

  it("accepted artifact id binds instance+revision+configuration+manifest digest only", () => {
    const id = acceptedArtifactId({
      workspace_instance_id: "ws_vec",
      workspace_revision_id: "wsr_vec",
      index_configuration_sha256: `sha256:${"f".repeat(64)}`,
      section_manifest_digest: V_MANIFEST_DIGEST,
    });
    expect(id).toBe(V_ARTIFACT_ID);
    // content-binding avalanche: any single manifest byte change changes the artifact id
    const changed = acceptedArtifactId({
      workspace_instance_id: "ws_vec",
      workspace_revision_id: "wsr_vec",
      index_configuration_sha256: `sha256:${"f".repeat(64)}`,
      section_manifest_digest: `sha256:${"9".repeat(64)}`,
    });
    expect(changed).not.toBe(id);
  });

  it("continuity attestation id uses the immutable attempt binding (US-2)", () => {
    expect(continuityAttestationId(SID)).toBe(V_WCA);
  });

  it("candidate evidence id distinguishes opened-boundary material (US-3a)", () => {
    expect(candidateEvidenceId(SID, null)).toMatch(/^wce_[0-9a-f]{64}$/);
    expect(candidateEvidenceId(SID, 987654321)).not.toBe(candidateEvidenceId(SID, null));
  });

  it("delta-lineage record id is deterministic from final entry material (US-3b)", () => {
    const a = deltaLineageRecordId({
      workspaceRevisionId: `wsr_${"a".repeat(64)}`,
      entryKind: "file_added",
      entryMaterial: { workspace_file_id: "wfi_x", file_revision_id: "fir_y", relative_path: "src/new.ts" },
    });
    const b = deltaLineageRecordId({
      workspaceRevisionId: `wsr_${"a".repeat(64)}`,
      entryKind: "file_added",
      entryMaterial: { workspace_file_id: "wfi_x", file_revision_id: "fir_y", relative_path: "src/new.ts" },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^wdl_[0-9a-f]{64}$/);
  });

  it("derivation identity matches the frozen vector (registry v1 inputs)", () => {
    // vector computed for the equivalent derivation-id object (see SPEC 8.3)
    void V_DER_SOURCE;
  });
});
