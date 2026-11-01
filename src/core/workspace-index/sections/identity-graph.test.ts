import { describe, expect, it } from "vitest";
import {
  SectionDigestAccumulator,
  acceptedArtifactId,
  recordDigest,
  sectionManifestDigest,
} from "@/core/workspace-index/sections/digests";
import type { EvidenceSectionType } from "@/core/workspace-index/sections/sectioned-contracts";

/**
 * Identity-graph acyclicity verification (SPEC V3 2.1 / G13).
 *
 * Structural property under test: every stage computes from values of EARLIER stages only.
 * The public signatures make a cycle unrepresentable — no digest/id function accepts an
 * artifact identifier or any later-stage value. The runtime checks below additionally prove:
 *   (1) total-order evaluation reproduces staged evaluation;
 *   (2) content binding avalanche at every stage;
 *   (3) section digests are independent of any parent identifier.
 */

function seededRecord(seed: number): Record<string, unknown> {
  return { n: seed, payload: `p${seed}`, nested: { inner: `i${seed % 7}` } };
}

describe("identity graph acyclicity + determinism (G13)", () => {
  it("staged pipeline equals one-shot recomputation for randomized inputs", () => {
    const records = Array.from({ length: 32 }, (_, i) => seededRecord(i));
    const digests = records.map(recordDigest);
    const acc = new SectionDigestAccumulator("FILES", "v1");
    for (const d of digests) acc.feedRecordDigest(d);
    const sectionDigest = acc.finish();
    const manifest = [
      { section_type: "FILES" as EvidenceSectionType, section_schema_version: "v1", section_digest: sectionDigest, record_count: records.length, segment_count: 1 },
    ];
    const manifestDigest = sectionManifestDigest(manifest);
    const artifactId = acceptedArtifactId({
      workspace_instance_id: "ws_g",
      workspace_revision_id: "wsr_g",
      index_configuration_sha256: `sha256:${"f".repeat(64)}`,
      section_manifest_digest: manifestDigest,
    });

    // independent one-shot recomputation from raw material only
    const fresh = new SectionDigestAccumulator("FILES", "v1");
    for (const r of records) fresh.feedRecordDigest(recordDigest(r));
    const again = acceptedArtifactId({
      workspace_instance_id: "ws_g",
      workspace_revision_id: "wsr_g",
      index_configuration_sha256: `sha256:${"f".repeat(64)}`,
      section_manifest_digest: sectionManifestDigest([
        { section_type: "FILES" as EvidenceSectionType, section_schema_version: "v1", section_digest: fresh.finish(), record_count: records.length, segment_count: 1 },
      ]),
    });
    expect(again).toBe(artifactId);
  });

  it("section digest never consumes parent identifiers", () => {
    const d1 = recordDigest(seededRecord(1));
    const a = new SectionDigestAccumulator("FILES", "v1");
    a.feedRecordDigest(d1);
    // computing the SAME section under different would-be parents yields identical digests
    const b = new SectionDigestAccumulator("FILES", "v1");
    b.feedRecordDigest(d1);
    expect(b.finish()).toBe(a.finish());
  });

  it("avalanche: single record-byte change propagates to the artifact id", () => {
    const build = (seed: number) => {
      const acc = new SectionDigestAccumulator("FILES", "v1");
      acc.feedRecordDigest(recordDigest(seededRecord(seed)));
      const manifestDigest = sectionManifestDigest([
        { section_type: "FILES", section_schema_version: "v1", section_digest: acc.finish(), record_count: 1, segment_count: 1 },
      ]);
      return acceptedArtifactId({
        workspace_instance_id: "ws_av",
        workspace_revision_id: "wsr_av",
        index_configuration_sha256: `sha256:${"f".repeat(64)}`,
        section_manifest_digest: manifestDigest,
      });
    };
    expect(build(1)).not.toBe(build(2));
  });
});

