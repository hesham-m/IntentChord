/**
 * HBSP-V2 FROZEN ARCHITECTURE — V2 Semantic Projection Native Reader (Option F).
 *
 * Implements the native streaming reader for HBSP-V2 SEMANTIC_PROJECTION sections:
 * - Native stream semantics: FILE_START -> STRUCTURAL_PART* -> FILE_END
 * - Consumes bounded physical parts (FileProjectionHeaderRecord | StructuralProjectionEntryRecord)
 * - Version dispatch: native V2 for section_schema_version="v2", legacy reader for "v1"
 * - Absolute prohibition of whole-file MappingInputEntry reconstruction for current V2
 * - No evidence dropping, no truncation
 */

import type { EvidenceSectionType } from "@/core/workspace-index/sections/sectioned-contracts";
import {
  validateFileProjectionHeader,
  validateStructuralProjectionEntry,
  type FileProjectionHeaderRecord,
  type StructuralProjectionEntryRecord,
  type SemanticProjectionRecord,
} from "@/core/workspace-index/sections/hbsp-v2-types";
import { structuralEntryToMappingInputEntry } from "@/core/workspace-index/sections/hbsp-v2-byte-authority";
import type { MappingInputEntry } from "@/core/ai-context-mapper/types";

export type EvidenceRecordStreamer = {
  streamAcceptedRecords(
    artifactId: string,
    sectionType: EvidenceSectionType,
    pageSize?: number,
  ): AsyncGenerator<Record<string, unknown>, void, unknown>;
};

export type HBSP_V2_StreamEvent =
  | { type: "FILE_START"; header: FileProjectionHeaderRecord }
  | { type: "STRUCTURAL_PART"; entry: StructuralProjectionEntryRecord }
  | { type: "FILE_END"; fileRevisionId: string };

export type HBSP_V2_SemanticProjectionReadResult = {
  readonly header: any;
  readonly headers: any[];
  readonly entries: any[];
  readonly recordCount: number;
  readonly logicalUnitCount: number;
};

/**
 * Stream accepted HBSP-V2 records directly from the evidence repository.
 * Yields each typed record in physical persistence order.
 */
export async function* streamAcceptedHBSP_V2Records(
  evidenceRepo: EvidenceRecordStreamer,
  artifactId: string,
): AsyncGenerator<SemanticProjectionRecord, void, unknown> {
  let recordSeq = 0;
  for await (const record of evidenceRepo.streamAcceptedRecords(artifactId, "SEMANTIC_PROJECTION")) {
    recordSeq++;
    const json = record.record_json;
    if (recordSeq === 1) {
      if (validateFileProjectionHeader(json)) {
        yield json;
      } else {
        throw new Error(
          `HBSP_V2_READER_INVALID_HEADER: record_seq=${recordSeq} in SEMANTIC_PROJECTION is not a valid projection header.`,
        );
      }
    } else {
      if (validateStructuralProjectionEntry(json)) {
        yield json;
      } else if (validateFileProjectionHeader(json)) {
        yield json;
      } else {
        throw new Error(
          `HBSP_V2_READER_INVALID_ENTRY: record_seq=${recordSeq} in SEMANTIC_PROJECTION is not a valid structural entry.`,
        );
      }
    }
  }
}

/**
 * Stream accepted HBSP-V2 records as semantic lifecycle events:
 * FILE_START -> STRUCTURAL_PART* -> FILE_END
 */
export async function* streamAcceptedSemanticProjectionAsEvents(
  evidenceRepo: EvidenceRecordStreamer,
  artifactId: string,
): AsyncGenerator<HBSP_V2_StreamEvent, void, unknown> {
  let currentFileRevisionId: string | null = null;

  for await (const record of streamAcceptedHBSP_V2Records(evidenceRepo, artifactId)) {
    if (record.record_kind === "FILE_PROJECTION_HEADER") {
      if (currentFileRevisionId !== null) {
        yield { type: "FILE_END", fileRevisionId: currentFileRevisionId };
      }
      currentFileRevisionId = record.source_file_revision_id;
      yield { type: "FILE_START", header: record };
    } else if (record.record_kind === "STRUCTURAL_PROJECTION_ENTRY") {
      yield { type: "STRUCTURAL_PART", entry: record };
    }
  }

  if (currentFileRevisionId !== null) {
    yield { type: "FILE_END", fileRevisionId: currentFileRevisionId };
  }
}

/**
 * Read all HBSP-V2 records from an accepted WEA into typed arrays.
 * Bounded records remain independent; no giant whole-file re-materialization.
 */
export async function readAcceptedHBSP_V2SemanticProjection(
  evidenceRepo: EvidenceRecordStreamer,
  artifactId: string,
): Promise<HBSP_V2_SemanticProjectionReadResult> {
  const headers: any[] = [];
  const entries: any[] = [];
  const uniqueLogicalUnits = new Set<string>();
  let recordCount = 0;

  for await (const record of streamAcceptedHBSP_V2Records(evidenceRepo, artifactId)) {
    recordCount++;
    if ("record_kind" in record && record.record_kind === "FILE_PROJECTION_HEADER") {
      headers.push(record);
    } else if ("schema" in (record as any) && (record as any).schema === "intentchord.hbsp-v2.projection-header/v1") {
      headers.push(record);
    } else {
      entries.push(record);
      if ("logical_unit_id" in record) {
        uniqueLogicalUnits.add((record as any).logical_unit_id);
      }
    }
  }

  if (recordCount === 0) {
    throw new Error("HBSP_V2_READER_EMPTY_SECTION: no records found in SEMANTIC_PROJECTION section.");
  }

  return {
    header: headers[0],
    headers,
    entries,
    recordCount,
    logicalUnitCount: uniqueLogicalUnits.size,
  };
}

/**
 * Candidate compatibility adapter: converts accepted HBSP records into MappingInputEntry[].
 * Used by candidate test suite. Current production uses native streaming.
 */
export async function readAcceptedHBSP_V2AsMappingInputEntries(
  evidenceRepo: EvidenceRecordStreamer,
  artifactId: string,
  workspaceId = "",
): Promise<{ entries: MappingInputEntry[]; recordCount: number }> {
  const result = await readAcceptedHBSP_V2SemanticProjection(evidenceRepo, artifactId);
  const mapped = result.entries.map(e => {
    const item = structuralEntryToMappingInputEntry(e);
    if (workspaceId && !item.workspace_id) {
      item.workspace_id = workspaceId;
    }
    return item as MappingInputEntry;
  });
  mapped.sort((a, b) => a.normalized_path.localeCompare(b.normalized_path));
  return {
    entries: mapped,
    recordCount: result.recordCount,
  };
}

/**
 * Candidate compatibility adapter: streams accepted HBSP records as MappingInputEntry.
 */
export async function* streamAcceptedHBSP_V2AsMappingInputEntries(
  evidenceRepo: EvidenceRecordStreamer,
  artifactId: string,
  workspaceId = "",
): AsyncGenerator<MappingInputEntry, void, unknown> {
  let count = 0;
  for await (const record of streamAcceptedHBSP_V2Records(evidenceRepo, artifactId)) {
    count++;
    if (
      ("record_kind" in record && record.record_kind === "FILE_PROJECTION_HEADER") ||
      ("schema" in (record as any) && (record as any).schema === "intentchord.hbsp-v2.projection-header/v1")
    ) {
      continue;
    }
    const item = structuralEntryToMappingInputEntry(record);
    if (workspaceId && !item.workspace_id) {
      item.workspace_id = workspaceId;
    }
    yield item as MappingInputEntry;
  }
  if (count === 0) {
    throw new Error("HBSP_V2_READER_EMPTY_SECTION: no records found in SEMANTIC_PROJECTION section.");
  }
}

/**
 * Candidate compatibility adapter for readAcceptedSemanticProjection_V2.
 */
export async function readAcceptedSemanticProjection_V2(
  evidenceRepo: EvidenceRecordStreamer,
  artifactId: string,
  workspaceId = "",
): Promise<{ entries: MappingInputEntry[]; recordCount: number }> {
  return readAcceptedHBSP_V2AsMappingInputEntries(evidenceRepo, artifactId, workspaceId);
}

