import { SECTION_BOUNDS, SECTION_FAILURE_CODES } from "@/core/workspace-index/sections/sectioned-contracts";
import { canonicalJson } from "@/core/truth/project-truth-hash";

/**
 * Fail-closed bound enforcement for sectioned evidence (SPEC V3 1.3 / 13.x CHECK mirrors).
 * Violations NEVER split or grow rows; they abort the operation with a primary failure code.
 */

export class WorkspaceSectionBoundError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    // Repository convention: the primary failure CODE is the Error message; structured detail rides alongside.
    super(code);
    this.name = "WorkspaceSectionBoundError";
    void message;
  }
}

export function utf8OctetLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function assertRecordWithinBounds(recordBody: unknown): void {
  const serialized = canonicalJson(recordBody);
  const octets = utf8OctetLength(serialized);
  if (octets > SECTION_BOUNDS.RECORD_MAX_UTF8_OCTETS) {
    throw new WorkspaceSectionBoundError(
      SECTION_FAILURE_CODES.RECORD_OVERBOUND,
      "Evidence record exceeds the hard 262144-octet persistence bound.",
      { octets, maxOctets: SECTION_BOUNDS.RECORD_MAX_UTF8_OCTETS },
    );
  }
}

export function assertHeaderWithinBounds(headerJson: unknown): void {
  const octets = utf8OctetLength(canonicalJson(headerJson));
  if (octets > SECTION_BOUNDS.HEADER_MAX_UTF8_OCTETS) {
    throw new WorkspaceSectionBoundError(
      "WORKSPACE_ARTIFACT_HEADER_OVERBOUND",
      "Artifact header exceeds the hard 65536-octet persistence bound.",
      { octets, maxOctets: SECTION_BOUNDS.HEADER_MAX_UTF8_OCTETS },
    );
  }
}

export function assertSectionManifestWithinBounds(manifestJson: unknown): void {
  const octets = utf8OctetLength(canonicalJson(manifestJson));
  if (octets > SECTION_BOUNDS.MANIFEST_MAX_UTF8_OCTETS) {
    throw new WorkspaceSectionBoundError(
      "WORKSPACE_SECTION_MANIFEST_OVERBOUND",
      "Section manifest exceeds the hard 16384-octet persistence bound.",
      { octets, maxOctets: SECTION_BOUNDS.MANIFEST_MAX_UTF8_OCTETS },
    );
  }
}

export function assertSegmentRecordCount(recordCount: number): void {
  if (!Number.isSafeInteger(recordCount) || recordCount < 1 || recordCount > SECTION_BOUNDS.SEGMENT_MAX_RECORDS) {
    throw new WorkspaceSectionBoundError(
      "WORKSPACE_SEGMENT_RECORD_COUNT_INVALID",
      "Segment record count outside the closed [1..512] range.",
      { recordCount, maxRecords: SECTION_BOUNDS.SEGMENT_MAX_RECORDS },
    );
  }
}

export function isWithinBlobBound(serializedUtf8Octets: number): boolean {
  return serializedUtf8Octets <= SECTION_BOUNDS.ATTEMPT_EVIDENCE_BLOB_MAX_UTF8_OCTETS;
}
