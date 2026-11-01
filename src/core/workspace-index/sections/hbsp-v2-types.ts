/**
 * HBSP-V2 FROZEN ARCHITECTURE — Types / Validation Contract (Option F).
 *
 * Implements the Owner-Frozen Option F hierarchical bounded semantic projection types:
 * - File -> Structural Units -> Bounded Physical Parts
 * - FILE_PROJECTION_HEADER: bounded O(1), no child manifest
 * - STRUCTURAL_PROJECTION_ENTRY: bounded physical parts carrying projection signals
 * - Minimal oversized reference fallbacks (SYMBOL <= 254 octets, RELATION <= 260 octets)
 * - Closed canonical value domain (REJECT_FAIL_CLOSED, no silent stripping)
 * - Deterministic, collision-safe logical_unit_id derivation
 */

import { createHash } from "node:crypto";
import { canonicalJson, sha256Canonical } from "@/core/truth/project-truth-hash";
import { SECTION_BOUNDS } from "@/core/workspace-index/sections/sectioned-contracts";

// ---------------------------------------------------------------------------
// Schema version constants
// ---------------------------------------------------------------------------

export const HBSP_V2_SECTION_SCHEMA_VERSION = "intentchord.section-schema/v2" as const;
export const HBSP_V2_SHORT_SECTION_SCHEMA_VERSION = "v2" as const;
export const HBSP_V2_LOGICAL_UNIT_ID_SCHEMA = "intentchord.hbsp-v2.logical-unit-id/v1" as const;
export const HBSP_V2_PROJECTION_HEADER_SCHEMA = "intentchord.hbsp-v2.projection-header/v1" as const;
export const HBSP_V2_STRUCTURAL_ENTRY_SCHEMA = "intentchord.hbsp-v2.structural-entry/v1" as const;

export const HBSP_V2_ENTRY_TYPES = ["FILE"] as const;
export type HBSP_V2_EntryType = (typeof HBSP_V2_ENTRY_TYPES)[number];

export const HBSP_V2_COVERAGE_STATES = [
  "UNSUPPORTED",
  "PARTIAL",
  "FULL",
] as const;
export type HBSP_V2_CoverageState = (typeof HBSP_V2_COVERAGE_STATES)[number];

export const HBSP_V2_PARSE_STATUSES = [
  "NOT_APPLICABLE",
  "SUPPORTED",
  "PARTIAL",
  "FAILED",
] as const;
export type HBSP_V2_ParseStatus = (typeof HBSP_V2_PARSE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Oversized signal fallback bounds (Owner-Authoritative Frozen)
// ---------------------------------------------------------------------------

export const OVERSIZED_SYMBOL_MAX_PERSISTED_OCTETS = 254 as const;
export const OVERSIZED_RELATION_MAX_PERSISTED_OCTETS = 260 as const;

// Backwards-compat aliases for earlier candidate imports
export const HBSP_OVERSIZED_SYMBOL_FALLBACK_MAX_OCTETS = OVERSIZED_SYMBOL_MAX_PERSISTED_OCTETS;
export const HBSP_OVERSIZED_RELATION_FALLBACK_MAX_OCTETS = OVERSIZED_RELATION_MAX_PERSISTED_OCTETS;

// ---------------------------------------------------------------------------
// Core Record Definitions (Option F)
// ---------------------------------------------------------------------------

/**
 * Record Kind 1: FILE_PROJECTION_HEADER
 * Strictly bounded O(1), no child manifest, no all-child array.
 * Emitted at the start of a file's projection stream.
 */
export type FileProjectionHeaderRecord = {
  record_kind: "FILE_PROJECTION_HEADER";
  record_id: string; // fph_<sha256>
  workspace_id: string;
  source_file_revision_id: string;
  normalized_path: string;
  language_or_format: string;
  size_bytes: number;
  content_or_metadata_fingerprint: string;
  file_kind: string;
  parse_status: string;
  coverage_state: string;
};

/**
 * Minimal Bounded Oversized Fallbacks (Freeze Micro Correction 3).
 * Contains only fixed discriminators plus authoritative reference pointer.
 * Bounded by construction (<= 254 and <= 260 persisted octets).
 */
export type MinimalOversizedSymbolReference = {
  reference_mode: "AUTHORITATIVE_SECTION_REFERENCE";
  signal_type: "SYMBOL";
  fact_ref: string; // Governed by idSchema (max 160 bytes)
};

export type MinimalOversizedRelationReference = {
  reference_mode: "AUTHORITATIVE_SECTION_REFERENCE";
  signal_type: "RELATION";
  relation_ref: string; // Governed by idSchema (max 160 bytes)
};

export type ProjectionSymbolSignal =
  | {
      local_name: string;
      qualified_suffix: string;
      kind: string;
      evidence_role: string;
      certainty: string;
      fact_ref: string;
    }
  | MinimalOversizedSymbolReference;

export type ProjectionRelationSignal =
  | {
      relation_type: string;
      direction: string;
      target_entity_id: string;
      relation_ref: string;
    }
  | MinimalOversizedRelationReference;

export type StructuralLabelAuthority =
  | "SOURCE_NATIVE"
  | "STRUCTURAL_DERIVED"
  | "SOURCE_ANCHORED_UNCLASSIFIED";

/**
 * Record Kind 2: STRUCTURAL_PROJECTION_ENTRY
 * Flat physical part carrying signals for one structural unit.
 * Uses part_index and is_final_part (NO part_count, NO pre-count).
 */
export type StructuralProjectionEntryRecord = {
  record_kind: "STRUCTURAL_PROJECTION_ENTRY";
  record_id: string; // spe_<sha256>
  workspace_id: string;
  parent_file_entry_id: string; // Points to FileProjectionHeaderRecord.record_id
  parent_file_revision_id: string;
  logical_unit_id: string;
  parent_logical_unit_id: string | null;
  unit_kind: string; // "CLASS" | "FUNCTION" | "IMPORTS" | "UNCLASSIFIED_REGION" | ...
  unit_label: string;
  label_authority: StructuralLabelAuthority;
  source_anchor?: {
    start_line: number;
    end_line: number;
    start_byte?: number;
    end_byte?: number;
  };
  part_index: number;
  is_final_part: boolean;
  projection_signals: {
    symbols: ProjectionSymbolSignal[];
    relations: ProjectionRelationSignal[];
  };
};

export type SemanticProjectionRecord =
  | FileProjectionHeaderRecord
  | StructuralProjectionEntryRecord;

// Type aliases for candidate compatibility
export type CandidateFileProjectionHeader = {
  schema: typeof HBSP_V2_PROJECTION_HEADER_SCHEMA;
  workspace_revision_id: string;
  workspace_index_sha256: string;
  eligible_entry_count: number;
  excluded_entry_count: number;
  projection_created_at: string;
};

export type CandidateStructuralProjectionEntry = {
  schema: typeof HBSP_V2_STRUCTURAL_ENTRY_SCHEMA;
  logical_unit_id: string;
  part_index: number;
  is_final_part: boolean;
  normalized_path: string;
  entry_type: HBSP_V2_EntryType;
  language_or_format: string;
  size_bytes: number;
  content_or_metadata_fingerprint: string;
  index_supported_signals: {
    file_kind: string;
    parse_status: string;
    coverage_state: string;
    fact_signals: ReadonlyArray<any>;
    relation_signals: ReadonlyArray<any>;
  };
};

export type HBSP_V2_FileProjectionHeader = FileProjectionHeaderRecord | CandidateFileProjectionHeader;

export type HBSP_V2_StructuralProjectionEntry = StructuralProjectionEntryRecord | CandidateStructuralProjectionEntry;

export type HBSP_V2_SemanticProjectionRecord = SemanticProjectionRecord;

// ---------------------------------------------------------------------------
// ID Derivations
// ---------------------------------------------------------------------------

export function fileProjectionHeaderId(workspaceId: string, sourceFileRevisionId: string): string {
  return `fph_${createHash("sha256").update(`${workspaceId}:${sourceFileRevisionId}`, "utf8").digest("hex")}`;
}

export function structuralEntryRecordId(logicalUnitId: string, partIndex: number): string {
  return `spe_${createHash("sha256").update(`${logicalUnitId}:${partIndex}`, "utf8").digest("hex")}`;
}

/**
 * Derive deterministic, collision-safe logical_unit_id from source-grounded material.
 * Supports both Option F structured input and candidate (path, fingerprint) signature.
 */
export function deriveLogicalUnitId(
  inputOrPath: string | {
    parent_file_revision_id: string;
    unit_kind: string;
    structural_scope_path: string;
    unit_label: string;
    source_anchor_signature: string;
    structural_ordinal: number;
  },
  fingerprint?: string,
): string {
  if (typeof inputOrPath === "string") {
    const material = `${inputOrPath}\0${fingerprint ?? ""}`;
    const digest = createHash("sha256").update(material, "utf8").digest("hex");
    return `${HBSP_V2_LOGICAL_UNIT_ID_SCHEMA.replace("/", ".")}_${digest}`;
  }
  const hash = sha256Canonical({
    schema: HBSP_V2_LOGICAL_UNIT_ID_SCHEMA,
    parent_file_revision_id: inputOrPath.parent_file_revision_id,
    unit_kind: inputOrPath.unit_kind,
    structural_scope_path: inputOrPath.structural_scope_path,
    unit_label: inputOrPath.unit_label,
    source_anchor_signature: inputOrPath.source_anchor_signature,
    structural_ordinal: inputOrPath.structural_ordinal,
  });
  return `wsu_${hash}`;
}

export function deriveFileLogicalUnitId(
  parentFileRevisionId: string,
  normalizedPath: string,
  fingerprint: string,
): string {
  return deriveLogicalUnitId({
    parent_file_revision_id: parentFileRevisionId,
    unit_kind: "MODULE_ROOT",
    structural_scope_path: "root",
    unit_label: normalizedPath.split(/[/\\]/).pop() ?? normalizedPath,
    source_anchor_signature: `fp:${fingerprint}`,
    structural_ordinal: 0,
  });
}

// ---------------------------------------------------------------------------
// Closed Canonical Value Domain & Validation (Freeze Micro Correction 1)
// ---------------------------------------------------------------------------

export class HBSPNonCanonicalValueError extends Error {
  constructor(message: string, public readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "HBSPNonCanonicalValueError";
  }
}

export function assertCanonicalNonNegativeSafeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new HBSPNonCanonicalValueError(
      `HBSP_NON_CANONICAL_NUMERIC_VALUE: ${fieldName} must be a non-negative safe integer. Received: ${String(value)}`,
      { field: fieldName, value },
    );
  }
  return value;
}

export function hasLoneSurrogate(value: string): boolean {
  if (typeof (value as any).isWellFormed === "function") {
    return !(value as any).isWellFormed();
  }
  return /(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(value);
}

export function assertCanonicalString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new HBSPNonCanonicalValueError(
      `HBSP_NON_CANONICAL_STRING_VALUE: ${fieldName} must be a string. Received: ${typeof value}`,
      { field: fieldName, value },
    );
  }
  if (value.includes("\u0000")) {
    throw new HBSPNonCanonicalValueError(
      `HBSP_NULL_BYTE_FORBIDDEN: ${fieldName} contains null codepoint U+0000.`,
      { field: fieldName },
    );
  }
  if (hasLoneSurrogate(value)) {
    throw new HBSPNonCanonicalValueError(
      `HBSP_LONE_SURROGATE_FORBIDDEN: ${fieldName} contains lone surrogate codepoint.`,
      { field: fieldName },
    );
  }
  return value;
}

export function assertCanonicalRecordDomain(record: unknown): void {
  if (record === null || typeof record !== "object") {
    throw new HBSPNonCanonicalValueError("HBSP record must be a non-null plain object.");
  }
  const checkValue = (val: unknown, path: string): void => {
    if (val === null) return;
    if (typeof val === "boolean") return;
    if (typeof val === "number") {
      if (!Number.isSafeInteger(val) || val < 0 || Object.is(val, -0)) {
        throw new HBSPNonCanonicalValueError(`Non-canonical number at ${path}: ${String(val)}`);
      }
      return;
    }
    if (typeof val === "string") {
      if (val.includes("\u0000") || hasLoneSurrogate(val)) {
        throw new HBSPNonCanonicalValueError(`Illegal character in string at ${path}`);
      }
      return;
    }
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) checkValue(val[i], `${path}[${i}]`);
      return;
    }
    if (typeof val === "object") {
      const proto = Object.getPrototypeOf(val);
      if (proto !== Object.prototype && proto !== null) {
        throw new HBSPNonCanonicalValueError(`Custom object instance forbidden at ${path}`);
      }
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        assertCanonicalString(k, `${path}.key`);
        checkValue(v, `${path}.${k}`);
      }
      return;
    }
    throw new HBSPNonCanonicalValueError(`Non-canonical runtime type at ${path}: ${typeof val}`);
  };
  checkValue(record, "record");
}

export function isValidHBSP_V2EntryType(value: string): value is HBSP_V2_EntryType {
  return (HBSP_V2_ENTRY_TYPES as readonly string[]).includes(value);
}

export function isValidHBSP_V2CoverageState(value: string): value is HBSP_V2_CoverageState {
  return (HBSP_V2_COVERAGE_STATES as readonly string[]).includes(value);
}

export function isValidHBSP_V2ParseStatus(value: string): value is HBSP_V2_ParseStatus {
  return (HBSP_V2_PARSE_STATUSES as readonly string[]).includes(value);
}

export function clampOversizedSymbol(value: string): string {
  const max = OVERSIZED_SYMBOL_MAX_PERSISTED_OCTETS;
  const buf = Buffer.from(value, "utf8");
  if (buf.byteLength <= max) return value;
  return buf.subarray(0, max).toString("utf8").replace(/\uFFFD/g, "");
}

export function clampOversizedRelation(value: string): string {
  const max = OVERSIZED_RELATION_MAX_PERSISTED_OCTETS;
  const buf = Buffer.from(value, "utf8");
  if (buf.byteLength <= max) return value;
  return buf.subarray(0, max).toString("utf8").replace(/\uFFFD/g, "");
}

export function assertStructuralEntryWithinBounds(entry: unknown): void {
  const canonical = canonicalJson(entry);
  const octets = Buffer.byteLength(canonical, "utf8");
  if (octets > SECTION_BOUNDS.RECORD_MAX_UTF8_OCTETS) {
    throw new Error(
      `HBSP_V2_STRUCTURAL_ENTRY_OVERBOUND: ${octets} octets exceeds ${SECTION_BOUNDS.RECORD_MAX_UTF8_OCTETS} bound`,
    );
  }
}

export function assertProjectionHeaderWithinBounds(header: unknown): void {
  const canonical = canonicalJson(header);
  const octets = Buffer.byteLength(canonical, "utf8");
  if (octets > SECTION_BOUNDS.RECORD_MAX_UTF8_OCTETS) {
    throw new Error(
      `HBSP_V2_PROJECTION_HEADER_OVERBOUND: ${octets} octets exceeds ${SECTION_BOUNDS.RECORD_MAX_UTF8_OCTETS} bound`,
    );
  }
}

export function assertLogicalUnitIdSourceGrounded(logicalUnitId: string): void {
  if (!logicalUnitId.startsWith("wsu_") && !logicalUnitId.startsWith(HBSP_V2_LOGICAL_UNIT_ID_SCHEMA.replace("/", "."))) {
    throw new Error(
      `HBSP_V2_LOGICAL_UNIT_ID_NOT_SOURCE_GROUNDED: must start with wsu_ or ${HBSP_V2_LOGICAL_UNIT_ID_SCHEMA}`,
    );
  }
}

export function assertFactSignalsCanonical(signals: ReadonlyArray<any>): void {
  for (const s of signals) {
    if (!s.fact_type || !s.certainty || !s.evidence_role) {
      throw new Error("HBSP_NONCANONICAL_FACT_SIGNAL: missing required canonical fields");
    }
  }
}

export function assertRelationSignalsCanonical(signals: ReadonlyArray<any>): void {
  for (const s of signals) {
    if (!s.relation_type || !s.certainty || !s.evidence_role) {
      throw new Error("HBSP_NONCANONICAL_RELATION_SIGNAL: missing required canonical fields");
    }
  }
}

export function validateFileProjectionHeader(value: unknown): value is FileProjectionHeaderRecord {
  if (!value || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  if (h.record_kind === "FILE_PROJECTION_HEADER") {
    return (
      typeof h.record_id === "string" &&
      typeof h.workspace_id === "string" &&
      typeof h.source_file_revision_id === "string" &&
      typeof h.normalized_path === "string" &&
      typeof h.size_bytes === "number" &&
      h.size_bytes >= 0
    );
  }
  if (h.schema === HBSP_V2_PROJECTION_HEADER_SCHEMA) {
    if (typeof h.eligible_entry_count === "number" && h.eligible_entry_count < 0) return false;
    if (typeof h.excluded_entry_count === "number" && h.excluded_entry_count < 0) return false;
    return (
      typeof h.workspace_revision_id === "string" &&
      typeof h.workspace_index_sha256 === "string"
    );
  }
  return false;
}

export function validateStructuralProjectionEntry(value: unknown): value is StructuralProjectionEntryRecord {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    (e.record_kind === "STRUCTURAL_PROJECTION_ENTRY" &&
      typeof e.record_id === "string" &&
      typeof e.workspace_id === "string" &&
      typeof e.parent_file_entry_id === "string" &&
      typeof e.logical_unit_id === "string" &&
      typeof e.part_index === "number" &&
      e.part_index >= 0 &&
      typeof e.is_final_part === "boolean" &&
      typeof e.projection_signals === "object" &&
      e.projection_signals !== null) ||
    (e.schema === HBSP_V2_STRUCTURAL_ENTRY_SCHEMA &&
      typeof e.logical_unit_id === "string" &&
      (e.logical_unit_id.startsWith("wsu_") || e.logical_unit_id.startsWith(HBSP_V2_LOGICAL_UNIT_ID_SCHEMA.replace("/", "."))) &&
      (e.entry_type === "FILE" || e.entry_type === "STRUCTURAL_UNIT") &&
      typeof e.part_index === "number" &&
      e.part_index >= 0 &&
      typeof e.is_final_part === "boolean" &&
      typeof e.index_supported_signals === "object")
  );
}
