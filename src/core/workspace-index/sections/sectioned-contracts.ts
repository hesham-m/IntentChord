import type { JsonValue } from "@/core/truth/project-truth-hash";

/**
 * IntentChord Sectioned Evidence — shared constants and closed vocabularies.
 * SPEC V3 (20260826-033058) Sections 1.2 / 2 / 13. Normative Phase 1 foundations.
 * Additive-only module: nothing in this file mutates historical V1 behavior.
 */

export const WORKSPACE_EVIDENCE_ARTIFACT_SCHEMA_V2 =
  "intentchord.workspace-evidence-artifact/v2" as const;
export const ENGINE_MODE_V2_SECTIONED = "V2_SECTIONED" as const;

export const SECTION_DIGEST_SCHEMA_V2 = "intentchord.evidence-section-digest/v2" as const;
/** Byte framing prefixes for incremental digest computation (SPEC 2.2). */
export const SEGMENT_FRAMING_TAG = "WSEG2\0" as const;
export const SECTION_FRAMING_TAG = "WESD2\0" as const;

export const SOURCE_CONTINUITY_ATTESTATION_ID_SCHEMA_V1 =
  "intentchord.source-continuity-attestation-id/v1" as const;
export const CANDIDATE_EVIDENCE_ID_SCHEMA_V1 = "intentchord.candidate-evidence-id/v1" as const;
export const DELTA_LINEAGE_RECORD_ID_SCHEMA_V1 = "intentchord.delta-lineage-record-id/v1" as const;

export const EXTRACTION_POLICY_VERSION_V1 = "intentchord.extraction-policy/v1" as const;
export const DERIVATION_NORMALIZATION_VERSION_V1 =
  "intentchord.derivation-normalization/v1" as const;
export const DERIVATION_IDENTITY_SCHEMA_V1 = "intentchord.derivation-identity/v1" as const;

/** Closed section-type enum (SPEC 1.2). HEADER is an artifact-level field, not a section. */
export const EVIDENCE_SECTION_TYPES = [
  "FILES",
  "FACTS",
  "RELATIONS",
  "CONTENT_REFERENCES",
  "FAILURES",
  "SEMANTIC_PROJECTION",
  "CONTINUITY_ATTESTATION",
  "DERIVATION_ATTESTATION",
  "DELTA_LINEAGE",
] as const;
export type EvidenceSectionType = (typeof EVIDENCE_SECTION_TYPES)[number];

/** Canonical storage/promotion order (SPEC 1.2 FIXED SECTION ORDER). */
export const FIXED_SECTION_ORDER: ReadonlyArray<EvidenceSectionType> = EVIDENCE_SECTION_TYPES;

/**
 * Canonical JSON key order of the snapshot object under repo canonicalJson (sorted):
 * content_references < facts < files < relations. The streaming whole-form writer MUST
 * emit families in this order regardless of storage section order.
 */
export const CANONICAL_SNAPSHOT_FAMILY_ORDER = [
  "content_references",
  "facts",
  "files",
  "relations",
] as const;
export type CanonicalSnapshotFamily = (typeof CANONICAL_SNAPSHOT_FAMILY_ORDER)[number];

export type SectionManifestEntry = {
  section_type: EvidenceSectionType;
  section_schema_version: string;
  section_digest: string;
  record_count: number;
  segment_count: number;
};

export type SectionedArtifactIdInput = {
  schema: typeof WORKSPACE_EVIDENCE_ARTIFACT_SCHEMA_V2;
  workspace_instance_id: string;
  workspace_revision_id: string;
  index_configuration_sha256: string;
  section_manifest_digest: string;
};

export type PathSensitivity = "PATH_INSENSITIVE" | "PATH_SENSITIVE";

/** Bounded jsonb value carried by one evidence record row. */
export type EvidenceRecordBody = Record<string, JsonValue>;

/** New fail-closed codes introduced by the sectioned topology (SPEC V3 Section 16). */
export const SECTION_FAILURE_CODES = {
  RECORD_OVERBOUND: "WORKSPACE_SECTION_RECORD_OVERBOUND",
  DIGEST_MISMATCH: "WORKSPACE_SECTION_DIGEST_MISMATCH",
  MANIFEST_MISMATCH: "WORKSPACE_ARTIFACT_MANIFEST_MISMATCH",
  MONOLITH_PATH_FORBIDDEN: "WORKSPACE_MONOLITH_PATH_FORBIDDEN",
  SEAL_ONLY_WRITE: "WORKSPACE_SEAL_ONLY_WRITE",
  STAGING_PERSISTENCE_FAILED: "WORKSPACE_STAGING_PERSISTENCE_FAILED",
} as const;

/** Hard persistence bounds (SPEC V3 1.3); enforced by both code and Migration 015 CHECKs. */
export const SECTION_BOUNDS = {
  RECORD_MAX_UTF8_OCTETS: 262_144,
  HEADER_MAX_UTF8_OCTETS: 65_536,
  MANIFEST_MAX_UTF8_OCTETS: 16_384,
  ATTEMPT_EVIDENCE_BLOB_MAX_UTF8_OCTETS: 65_536,
  PROGRESS_ROW_MAX_UTF8_OCTETS: 8_192,
  CONTINUITY_EVIDENCE_MAX_UTF8_OCTETS: 1_048_576,
  OBSERVATION_PROTOCOL_MAX_UTF8_OCTETS: 65_536,
  SEGMENT_MAX_RECORDS: 512,
} as const;
