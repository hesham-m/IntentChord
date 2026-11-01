import { createHash } from "node:crypto";
import { canonicalJson, sha256Canonical } from "@/core/truth/project-truth-hash";
import {
  SECTION_DIGEST_SCHEMA_V2,
  SEGMENT_FRAMING_TAG,
  SECTION_FRAMING_TAG,
  FIXED_SECTION_ORDER,
  WORKSPACE_EVIDENCE_ARTIFACT_SCHEMA_V2,
  type EvidenceSectionType,
  type SectionManifestEntry,
  type SectionedArtifactIdInput,
} from "@/core/workspace-index/sections/sectioned-contracts";

/**
 * Content-addressed identity foundations (SPEC V3 Section 2). Acyclic by construction:
 * every function consumes only values defined EARLIER in the dependency order
 *   record_json -> record_digest -> segment_digest -> section_digest
 *   -> section_manifest -> section_manifest_digest -> accepted_artifact_id.
 * No function in this module accepts an artifact identifier.
 */

export type RecordDigest = `sha256:${string}`;

function sha256HexOfParts(parts: ReadonlyArray<Buffer | string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function uint32BigEndian(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

/** VALUE 2 — record_digest := "sha256:" + hex(sha256(utf8(canonicalJson(record_body)))). */
export function recordDigest(recordBody: unknown): RecordDigest {
  return `sha256:${sha256Canonical(recordBody)}`;
}

/** VALUE 3 — segment digest over (segment_seq, ordered record digests); verification batching only. */
export function segmentDigest(segmentSeq: number, orderedRecordDigests: ReadonlyArray<string>): string {
  if (!Number.isSafeInteger(segmentSeq) || segmentSeq < 1) {
    throw new RangeError("SEGMENT_SEQ_MUST_BE_POSITIVE_INTEGER");
  }
  const parts: Array<Buffer | string> = [Buffer.from(SEGMENT_FRAMING_TAG, "utf8"), uint32BigEndian(segmentSeq)];
  for (const recordDigestHex of orderedRecordDigests) {
    parts.push(uint32BigEndian(64), Buffer.from(recordDigestHex, "ascii"));
  }
  return `sha256:${sha256HexOfParts(parts)}`;
}

/**
 * Incremental VALUE 4 accumulator. O(1) memory while records stream past; order-binding makes the
 * final digest a true set-and-order authority. No total count is hashed (SPEC 2.2).
 */
export class SectionDigestAccumulator {
  private readonly parts: Array<Buffer | string>;
  private fed = 0;

  constructor(
    public readonly sectionType: EvidenceSectionType,
    public readonly sectionSchemaVersion: string,
  ) {
    this.parts = [
      Buffer.from(SECTION_FRAMING_TAG, "utf8"),
      Buffer.from(`${sectionType}\0${sectionSchemaVersion}\0`, "utf8"),
    ];
  }

  feedRecordDigest(recordDigestValue: string): void {
    if (recordDigestValue.length !== 64 + "sha256:".length || !recordDigestValue.startsWith("sha256:")) {
      throw new TypeError("RECORD_DIGEST_MUST_BE_SHA256_PREFIXED_64HEX");
    }
    this.parts.push(uint32BigEndian(64), Buffer.from(recordDigestValue, "ascii"));
    this.fed += 1;
  }

  get recordCount(): number {
    return this.fed;
  }

  finish(): string {
    return `sha256:${sha256HexOfParts(this.parts)}`;
  }
}

export type OrderedSectionManifest = ReadonlyArray<SectionManifestEntry>;

/** Asserts manifest entries appear exactly in the FIXED SECTION ORDER with no duplicates/gaps. */
export function assertCanonicalSectionOrder(manifest: OrderedSectionManifest): void {
  const seen = manifest.map(entry => entry.section_type);
  if (new Set(seen).size !== seen.length) throw new RangeError("SECTION_MANIFEST_DUPLICATE_TYPE");
  const expected = FIXED_SECTION_ORDER.filter(sectionType => seen.includes(sectionType));
  if (seen.length !== expected.length || seen.some((sectionType, index) => sectionType !== expected[index])) {
    throw new RangeError("SECTION_MANIFEST_NOT_IN_FIXED_ORDER");
  }
}

/** VALUE 6 — section_manifest_digest over the ordered manifest (canonicalJson of the array). */
export function sectionManifestDigest(manifest: OrderedSectionManifest): string {
  assertCanonicalSectionOrder(manifest);
  return `sha256:${sha256Canonical(manifest)}`;
}

/** VALUE 7 — accepted artifact id; computable exactly once at seal time from bounded material. */
export function acceptedArtifactId(input: Omit<SectionedArtifactIdInput, "schema">): string {
  return `wea_${sha256Canonical({
    schema: WORKSPACE_EVIDENCE_ARTIFACT_SCHEMA_V2,
    workspace_instance_id: input.workspace_instance_id,
    workspace_revision_id: input.workspace_revision_id,
    index_configuration_sha256: input.index_configuration_sha256,
    section_manifest_digest: input.section_manifest_digest,
  })}`;
}

/** Convenience: canonical JSON of one record (used by storage layers for the record_json column). */
export function canonicalRecordString(recordBody: unknown): string {
  return canonicalJson(recordBody);
}
