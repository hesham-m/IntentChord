/**
 * HBSP-V2 FROZEN ARCHITECTURE — Single Physical Byte Authority (Option F).
 *
 * Implements the single authoritative physical byte bound contract:
 * - Single physical authority: PostgreSQL persisted jsonb text representation
 *   enforced by CHECK (octet_length(record_json::text) <= 262144).
 * - Exact pre-persistence equivalent calculation:
 *   exactPersistedOctets(R) = byteLength(canonicalJson(R)) + total_colons + total_commas
 * - Guarantee: DATABASE_REJECT_AFTER_APPLICATION_PASS_POSSIBLE = NO
 * - Incremental worst-case provisional false terminal flag accounting (22 bytes)
 *   with authoritative re-accounting at seal.
 */

import { canonicalJson, sha256Canonical } from "@/core/truth/project-truth-hash";
import { SectionDigestAccumulator } from "@/core/workspace-index/sections/digests";
import {
  HBSP_V2_SECTION_SCHEMA_VERSION,
  OVERSIZED_SYMBOL_MAX_PERSISTED_OCTETS,
  OVERSIZED_RELATION_MAX_PERSISTED_OCTETS,
  assertCanonicalRecordDomain,
  type SemanticProjectionRecord,
  type FileProjectionHeaderRecord,
  type StructuralProjectionEntryRecord,
} from "@/core/workspace-index/sections/hbsp-v2-types";
import type { EvidenceSectionType } from "@/core/workspace-index/sections/sectioned-contracts";

export const HBSP_V2_RECORD_MAX_UTF8_OCTETS = 262_144 as const;

/**
 * Count structural colons and commas in a JSON-compatible value.
 * In PostgreSQL jsonb_out serialization:
 * - Each structural key-value colon receives an extra space (": ")
 * - Each structural comma in objects and arrays receives an extra space (", ")
 * Characters inside string values do NOT receive extra spaces.
 */
export function countStructuralColonsAndCommas(value: unknown): { colons: number; commas: number } {
  if (value === null || typeof value !== "object") {
    return { colons: 0, commas: 0 };
  }
  if (Array.isArray(value)) {
    let colons = 0;
    let commas = Math.max(0, value.length - 1);
    for (const item of value) {
      const child = countStructuralColonsAndCommas(item);
      colons += child.colons;
      commas += child.commas;
    }
    return { colons, commas };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  let colons = entries.length;
  let commas = Math.max(0, entries.length - 1);
  for (const [, childValue] of entries) {
    const child = countStructuralColonsAndCommas(childValue);
    colons += child.colons;
    commas += child.commas;
  }
  return { colons, commas };
}

/**
 * Compute the EXACT persisted byte length of a record when stored in PostgreSQL as jsonb
 * and measured via octet_length(record_json::text).
 *
 * Exact formula proven across the closed canonical value domain:
 * ExactPersistedOctets = byteLength(canonicalJson(R)) + total_structural_colons + total_structural_commas
 */
export function exactPersistedOctetLength(record: unknown): number {
  const canonical = canonicalJson(record);
  const baseBytes = Buffer.byteLength(canonical, "utf8");
  const { colons, commas } = countStructuralColonsAndCommas(record);
  return baseBytes + colons + commas;
}

/**
 * Assert that a record satisfies the single physical persistence bound (<= 262,144 octets).
 * Throws fail-closed on violation.
 */
export function assertEntryByteAuthority(record: unknown): number {
  assertCanonicalRecordDomain(record);
  const octets = exactPersistedOctetLength(record);
  if (octets > HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
    throw new Error(
      `HBSP_V2_ENTRY_BYTE_AUTHORITY_VIOLATION: ${octets} octets exceeds ${HBSP_V2_RECORD_MAX_UTF8_OCTETS} PostgreSQL jsonb-text bound.`,
    );
  }
  return octets;
}

export function assertHeaderByteAuthority(header: unknown): number {
  return assertEntryByteAuthority(header);
}

export function assertExactRecordWithinBounds(record: unknown): void {
  assertEntryByteAuthority(record);
}

export function canonicalEntryBytes(entry: unknown): string {
  return canonicalJson(entry);
}

export function canonicalHeaderBytes(header: unknown): string {
  return canonicalJson(header);
}

export function entryRecordDigest(entry: unknown): string {
  return `sha256:${sha256Canonical(entry)}`;
}

export function headerRecordDigest(header: unknown): string {
  return `sha256:${sha256Canonical(header)}`;
}

// ---------------------------------------------------------------------------
// Incremental section digest (O(1) memory, streaming)
// ---------------------------------------------------------------------------

export function createSemanticProjectionDigestAccumulator(): SemanticProjectionDigestAccumulator {
  return new SemanticProjectionDigestAccumulator();
}

export class SemanticProjectionDigestAccumulator {
  private readonly inner: SectionDigestAccumulator;
  public headerFed = false;
  private fedCount = 0;

  constructor() {
    this.inner = new SectionDigestAccumulator(
      "SEMANTIC_PROJECTION" as EvidenceSectionType,
      HBSP_V2_SECTION_SCHEMA_VERSION,
    );
  }

  get recordCount(): number {
    return this.fedCount;
  }

  get entryCount(): number {
    return this.headerFed ? Math.max(0, this.fedCount - 1) : 0;
  }

  feedHeader(header: unknown): void {
    if (this.headerFed) {
      throw new Error("HEADER_ALREADY_FED: projection header has already been fed to this accumulator");
    }
    this.headerFed = true;
    this.feedRecord(header);
  }

  feedEntry(entry: unknown): void {
    if (!this.headerFed) {
      throw new Error("HEADER_NOT_FED: file projection header must be fed before structural entries");
    }
    this.feedRecord(entry);
  }

  feedRecord(record: unknown): void {
    this.fedCount += 1;
    const digest = `sha256:${sha256Canonical(record)}`;
    this.inner.feedRecordDigest(digest);
  }

  finish(): string {
    if (!this.headerFed) {
      throw new Error("CANNOT_FINISH_WITHOUT_HEADER: file projection header must be fed before finishing");
    }
    return this.inner.finish();
  }
}

export type HBSP_V2_SemanticHashInput = {
  schema: "intentchord.artifact-semantic/v2";
  workspace_revision_id: string;
  section_manifest_digest: string;
  semantic_projection_digest: string;
};

export function computeHBSP_V2SemanticHash(input: HBSP_V2_SemanticHashInput): string {
  return `sha256:${sha256Canonical(input)}`;
}

/**
 * Candidate compatibility adapter: converts a single structural entry to a single MappingInputEntry.
 * Not used on active streaming production call path.
 */
export function structuralEntryToMappingInputEntry(entry: any): any {
  return {
    entry_id: entry.logical_unit_id ?? entry.record_id,
    workspace_id: entry.workspace_id ?? "",
    normalized_path: entry.normalized_path ?? "",
    entry_type: "FILE",
    language_or_format: entry.language_or_format ?? "UNKNOWN",
    size_bytes: entry.size_bytes ?? 0,
    content_or_metadata_fingerprint: entry.content_or_metadata_fingerprint ?? "",
    index_supported_signals: {
      file_kind: entry.index_supported_signals?.file_kind ?? "SOURCE",
      parse_status: entry.index_supported_signals?.parse_status ?? "SUPPORTED",
      coverage_state: entry.index_supported_signals?.coverage_state ?? "FULL",
      fact_signals: entry.index_supported_signals?.fact_signals ?? [],
      relation_signals: entry.index_supported_signals?.relation_signals ?? [],
    },
  };
}
