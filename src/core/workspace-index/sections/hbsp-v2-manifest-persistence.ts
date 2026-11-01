/**
 * HBSP-V2 FROZEN ARCHITECTURE — Section Manifest, Artifact Manifest, Semantic Hash, Persistence (Packages 4-7).
 *
 * Implements section manifest entries, full section manifests, semantic hash,
 * and persistence staging interfaces for HBSP-V2 Option F.
 */

import { createHash } from "node:crypto";
import { canonicalJson, sha256Canonical } from "@/core/truth/project-truth-hash";
import {
  HBSP_V2_SECTION_SCHEMA_VERSION,
  type FileProjectionHeaderRecord,
  type StructuralProjectionEntryRecord,
  type SemanticProjectionRecord,
  type HBSP_V2_FileProjectionHeader,
  type HBSP_V2_StructuralProjectionEntry,
} from "@/core/workspace-index/sections/hbsp-v2-types";
import {
  HBSP_V2_RECORD_MAX_UTF8_OCTETS,
  exactPersistedOctetLength,
  entryRecordDigest,
  headerRecordDigest,
  computeHBSP_V2SemanticHash,
  type HBSP_V2_SemanticHashInput,
} from "@/core/workspace-index/sections/hbsp-v2-byte-authority";
import {
  FIXED_SECTION_ORDER,
  type EvidenceSectionType,
  type SectionManifestEntry,
} from "@/core/workspace-index/sections/sectioned-contracts";
import { acceptedArtifactId } from "@/core/workspace-index/sections/digests";

// ---------------------------------------------------------------------------
// Section Manifest Builders
// ---------------------------------------------------------------------------

export function buildHBSP_V2SectionManifestEntry(
  sectionDigest: string,
  recordCount: number,
  segmentCount: number,
): SectionManifestEntry {
  return {
    section_type: "SEMANTIC_PROJECTION",
    section_schema_version: HBSP_V2_SECTION_SCHEMA_VERSION,
    section_digest: sectionDigest,
    record_count: recordCount,
    segment_count: segmentCount,
  };
}

export function buildHBSP_V2FullSectionManifest(
  sectionDigests: Partial<Record<EvidenceSectionType, {
    digest: string;
    recordCount: number;
    segmentCount: number;
    schemaVersion?: string;
  }>>,
  projectionDigest: string,
  projectionRecordCount: number,
  projectionSegmentCount: number,
): ReadonlyArray<SectionManifestEntry> {
  const manifest: SectionManifestEntry[] = [];
  for (const sectionType of FIXED_SECTION_ORDER) {
    if (sectionType === "SEMANTIC_PROJECTION") {
      manifest.push(buildHBSP_V2SectionManifestEntry(projectionDigest, projectionRecordCount, projectionSegmentCount));
    } else {
      const sd = sectionDigests[sectionType];
      if (!sd) {
        throw new Error(`HBSP_V2_MANIFEST_MISSING_SECTION_DIGEST: ${sectionType}`);
      }
      manifest.push({
        section_type: sectionType,
        section_schema_version: sd.schemaVersion ?? "v1",
        section_digest: sd.digest,
        record_count: sd.recordCount,
        segment_count: sd.segmentCount,
      });
    }
  }
  return manifest;
}

export function computeArtifactManifestSha256(manifest: ReadonlyArray<SectionManifestEntry>): string {
  return `sha256:${sha256Canonical(manifest)}`;
}

export function computeCanonicalCompatSha256(manifest: ReadonlyArray<SectionManifestEntry>): string {
  return computeArtifactManifestSha256(manifest);
}

export function computeHBSP_V2ArtifactSemanticSha256(
  workspaceRevisionId: string,
  sectionManifestDigest: string,
  semanticProjectionDigest: string,
): string {
  const input: HBSP_V2_SemanticHashInput = {
    schema: "intentchord.artifact-semantic/v2",
    workspace_revision_id: workspaceRevisionId,
    section_manifest_digest: sectionManifestDigest,
    semantic_projection_digest: semanticProjectionDigest,
  };
  return computeHBSP_V2SemanticHash(input);
}

export function computeHBSP_V2AcceptedArtifactId(
  workspaceInstanceId: string,
  workspaceRevisionId: string,
  indexConfigurationSha256: string,
  sectionManifestDigest: string,
): string {
  return acceptedArtifactId({
    workspace_instance_id: workspaceInstanceId,
    workspace_revision_id: workspaceRevisionId,
    index_configuration_sha256: indexConfigurationSha256,
    section_manifest_digest: sectionManifestDigest,
  });
}

// ---------------------------------------------------------------------------
// Staged Records
// ---------------------------------------------------------------------------

export type HBSP_V2_StagedRecord = {
  readonly snapshot_operation_id: string;
  readonly section_type: "SEMANTIC_PROJECTION";
  readonly record_seq: number;
  readonly record_id: string;
  readonly record_digest: string;
  readonly source_file_revision_id: string | null;
  readonly record_json: unknown;
};

export function buildStagedRecordsFromProjection(
  snapshotOperationId: string,
  header: HBSP_V2_FileProjectionHeader,
  structuralEntries: ReadonlyArray<HBSP_V2_StructuralProjectionEntry>,
): HBSP_V2_StagedRecord[] {
  const records: HBSP_V2_StagedRecord[] = [];

  const headerRecordId = "record_id" in header && typeof header.record_id === "string"
    ? header.record_id
    : `fph_${createHash("sha256").update(canonicalJson(header)).digest("hex")}`;
  const headerSourceFileRevisionId = "source_file_revision_id" in header && typeof header.source_file_revision_id === "string"
    ? header.source_file_revision_id
    : null;

  // Record 1: FILE_PROJECTION_HEADER
  records.push({
    snapshot_operation_id: snapshotOperationId,
    section_type: "SEMANTIC_PROJECTION",
    record_seq: 1,
    record_id: headerRecordId,
    record_digest: headerRecordDigest(header),
    source_file_revision_id: headerSourceFileRevisionId,
    record_json: header,
  });

  // Records 2..N: STRUCTURAL_PROJECTION_ENTRY
  for (let i = 0; i < structuralEntries.length; i++) {
    const entry = structuralEntries[i];
    const entryRecordId = "record_id" in entry && typeof entry.record_id === "string"
      ? entry.record_id
      : `spe_${createHash("sha256").update(canonicalJson(entry)).digest("hex")}`;
    const entrySourceFileRevisionId = "parent_file_revision_id" in entry && typeof entry.parent_file_revision_id === "string"
      ? entry.parent_file_revision_id
      : null;

    records.push({
      snapshot_operation_id: snapshotOperationId,
      section_type: "SEMANTIC_PROJECTION",
      record_seq: i + 2,
      record_id: entryRecordId,
      record_digest: entryRecordDigest(entry),
      source_file_revision_id: entrySourceFileRevisionId,
      record_json: entry,
    });
  }

  return records;
}

export function assertAllStagedRecordsWithinBounds(records: ReadonlyArray<HBSP_V2_StagedRecord>): void {
  for (const record of records) {
    const octets = exactPersistedOctetLength(record.record_json);
    if (octets > HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
      throw new Error(
        `HBSP_V2_STAGED_RECORD_OVERBOUND: record_seq=${record.record_seq} record_id=${record.record_id} ${octets} octets exceeds ${HBSP_V2_RECORD_MAX_UTF8_OCTETS} bound`,
      );
    }
  }
}

export function buildSectionInsert(
  registrationId: string,
  artifactId: string,
  sectionDigest: string,
  recordCount: number,
  segmentCount: number,
): Record<string, unknown> {
  return {
    workspace_registration_id: registrationId,
    artifact_id: artifactId,
    section_type: "SEMANTIC_PROJECTION",
    section_order: 6,
    section_schema_version: HBSP_V2_SECTION_SCHEMA_VERSION,
    section_digest: sectionDigest,
    record_count: recordCount,
    segment_count: segmentCount,
  };
}

export function buildArtifactHeader(
  revisionId: string,
  instanceId: string,
  manifestDigest: string,
): Record<string, unknown> {
  return {
    schema: "intentchord.workspace-evidence-artifact/v2",
    workspace_revision_id: revisionId,
    workspace_instance_id: instanceId,
    section_manifest_digest: manifestDigest,
    engine_mode: "V2_SECTIONED",
  };
}

