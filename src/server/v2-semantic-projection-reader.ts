/**
 * V2 ACCEPTED SEMANTIC PROJECTION READER (Option F)
 *
 * Consumes pre-computed projection records from the accepted WEA.
 * - Version dispatch authority (Phase 3 fail-closed):
 *     section_schema_version === "v2" -> native HBSP reader
 *     section_schema_version === "v1" -> historical V1 reader
 *     unknown / unsupported           -> FAIL CLOSED (HttpCommandError 422)
 * - Record shape authority:
 *     No silent skip, no continue on unknown shape, no best-effort guessing.
 *     Any malformed or unrecognized record throws immediately.
 * - Native streaming consumption:
 *     Yields bounded MappingInputEntry parts without whole-file aggregation.
 */

import { HttpCommandError } from "@/server/errors";
import type { MappingInputEntry } from "@/core/ai-context-mapper/types";
import type { EvidenceSectionType } from "@/core/workspace-index/sections/sectioned-contracts";
import {
  streamAcceptedHBSP_V2Records,
  readAcceptedHBSP_V2SemanticProjection,
  streamAcceptedSemanticProjectionAsEvents,
  type HBSP_V2_SemanticProjectionReadResult,
  type HBSP_V2_StreamEvent,
} from "@/server/v2-semantic-projection-reader-hbsp";
import {
  validateFileProjectionHeader,
  validateStructuralProjectionEntry,
  type FileProjectionHeaderRecord,
  type StructuralProjectionEntryRecord,
} from "@/core/workspace-index/sections/hbsp-v2-types";

export {
  streamAcceptedHBSP_V2Records,
  readAcceptedHBSP_V2SemanticProjection,
  streamAcceptedSemanticProjectionAsEvents,
  type HBSP_V2_SemanticProjectionReadResult,
  type HBSP_V2_StreamEvent,
};

export class UnsupportedSectionSchemaVersionError extends HttpCommandError {
  constructor(version: string, detail?: unknown) {
    super(
      422,
      "UNSUPPORTED_SECTION_SCHEMA_VERSION",
      `Unsupported SEMANTIC_PROJECTION section schema version: '${version}'. Supported version is 'v2'.`,
      detail,
    );
    this.name = "UnsupportedSectionSchemaVersionError";
  }
}

export class InvalidSemanticProjectionRecordError extends HttpCommandError {
  constructor(message: string, detail?: unknown) {
    super(422, "INVALID_SEMANTIC_PROJECTION_RECORD", message, detail);
    this.name = "InvalidSemanticProjectionRecordError";
  }
}

export type ContextTraversalCursor = {
  readonly accepted_workspace_evidence_artifact_id: string;
  readonly section_id: number;
  readonly section_type: "SEMANTIC_PROJECTION";
  readonly section_schema_version: "v2";
  readonly record_seq: number;
};

export type SemanticProjectionReadResult = {
  entries: MappingInputEntry[];
  sectionDigest: string;
  recordCount: number;
};

export type SemanticProjectionRecordStreamer = {
  streamAcceptedRecords(
    artifactId: string,
    sectionType: EvidenceSectionType,
    pageSize?: number,
    startRecordSeqExclusive?: number,
    endRecordSeqInclusive?: number,
  ): AsyncGenerator<Record<string, unknown>, void, unknown>;
};

export function structuralPartToMappingInputEntry(
  header: FileProjectionHeaderRecord | null,
  entry: StructuralProjectionEntryRecord,
): MappingInputEntry {
  const filePath = header?.normalized_path ?? `unit_${entry.logical_unit_id}`;
  const lang = header?.language_or_format ?? "UNKNOWN";
  const size = header?.size_bytes ?? 0;
  const fp = header?.content_or_metadata_fingerprint ?? "";
  const fKind = header?.file_kind ?? "SOURCE_CODE";
  const pStatus = header?.parse_status ?? "SUPPORTED";
  const cState = header?.coverage_state ?? "FULL";

  return {
    entry_id: entry.record_id,
    workspace_id: entry.workspace_id,
    normalized_path: filePath,
    entry_type: "FILE",
    language_or_format: lang,
    size_bytes: size,
    content_or_metadata_fingerprint: fp,
    index_supported_signals: {
      file_kind: fKind,
      parse_status: pStatus,
      coverage_state: cState,
      fact_signals: entry.projection_signals.symbols.map(s => {
        const attrs: Record<string, any> = "reference_mode" in s
          ? { reference_mode: s.reference_mode }
          : { fact_ref: s.fact_ref, qualified_suffix: s.qualified_suffix, logical_unit_id: entry.logical_unit_id };
        return {
          fact_type: "reference_mode" in s ? "SYMBOL" : s.kind,
          qualified_name: "reference_mode" in s ? s.fact_ref : s.local_name,
          display_name: "reference_mode" in s ? s.fact_ref : s.local_name,
          attributes: attrs,
          certainty: "reference_mode" in s ? "EXACT" : s.certainty,
          evidence_role: "reference_mode" in s ? "CANONICAL_EVIDENCE" : s.evidence_role,
        };
      }),
      relation_signals: entry.projection_signals.relations.map(r => {
        if ("reference_mode" in r) {
          return {
            relation_type: "REFERENCES",
            direction: "DIRECTED",
            source_entry_or_entity_id: entry.record_id,
            target_entry_or_entity_id: r.relation_ref,
            certainty: "EXACT",
            evidence_role: "CANONICAL_EVIDENCE",
          };
        }
        return {
          relation_type: r.relation_type,
          direction: r.direction,
          source_entry_or_entity_id: entry.record_id,
          target_entry_or_entity_id: r.target_entity_id,
          certainty: "EXACT",
          evidence_role: "CANONICAL_EVIDENCE",
        };
      }),
    },
  };
}

export function structuralPartToTopologyInputEntry(
  header: FileProjectionHeaderRecord | null,
  entry: StructuralProjectionEntryRecord,
): MappingInputEntry {
  const filePath = header?.normalized_path ?? `unit_${entry.logical_unit_id}`;
  const lang = header?.language_or_format ?? "UNKNOWN";
  const size = header?.size_bytes ?? 0;
  const fp = header?.content_or_metadata_fingerprint ?? "";
  const fKind = header?.file_kind ?? "SOURCE_CODE";
  const pStatus = header?.parse_status ?? "SUPPORTED";
  const cState = header?.coverage_state ?? "FULL";

  return {
    entry_id: entry.record_id,
    workspace_id: entry.workspace_id,
    normalized_path: filePath,
    entry_type: "FILE",
    language_or_format: lang,
    size_bytes: size,
    content_or_metadata_fingerprint: fp,
    index_supported_signals: {
      file_kind: fKind,
      parse_status: pStatus,
      coverage_state: cState,
      fact_signals: [
        {
          fact_type: "LOGICAL_UNIT_DESCRIPTOR",
          qualified_name: entry.unit_label ?? `unit_${entry.logical_unit_id}`,
          display_name: entry.unit_label ?? `unit_${entry.logical_unit_id}`,
          attributes: {
            logical_unit_id: entry.logical_unit_id,
            unit_kind: entry.unit_kind,
            unit_label: entry.unit_label,
            symbol_count: entry.projection_signals.symbols.length,
            relation_count: entry.projection_signals.relations.length,
          },
          certainty: "EXACT",
          evidence_role: "CANONICAL_EVIDENCE",
        },
      ],
      relation_signals: [],
    },
  };
}

export type StreamSemanticProjectionOptions = {
  expectedVersion?: string;
  cursor?: ContextTraversalCursor;
  startRecordSeqExclusive?: number;
  endRecordSeqInclusive?: number;
  topologyMode?: boolean;
};

/**
 * Stream accepted SEMANTIC_PROJECTION entries with explicit V2-exclusive fail-closed dispatch,
 * continuation cursor support, and optional compact topology-mode projection.
 */
export async function* streamAcceptedSemanticProjectionEntries(
  evidenceRepo: SemanticProjectionRecordStreamer,
  artifactId: string,
  options?: StreamSemanticProjectionOptions,
): AsyncGenerator<MappingInputEntry & { _recordSeq?: number; _logicalUnitId?: string; _sourceFileRevisionId?: string }, void, unknown> {
  let detectedVersion: "v2" | null = null;
  let currentHeader: FileProjectionHeaderRecord | null = null;

  if (options?.cursor) {
    if (options.cursor.accepted_workspace_evidence_artifact_id !== artifactId) {
      throw new HttpCommandError(
        422,
        "CURSOR_ARTIFACT_MISMATCH",
        `Cursor artifact ID ${options.cursor.accepted_workspace_evidence_artifact_id} does not match ${artifactId}`,
      );
    }
    if (options.cursor.section_type !== "SEMANTIC_PROJECTION") {
      throw new HttpCommandError(
        422,
        "CURSOR_SECTION_MISMATCH",
        `Cursor section type ${options.cursor.section_type} must be SEMANTIC_PROJECTION`,
      );
    }
    if (options.cursor.section_schema_version !== "v2") {
      throw new HttpCommandError(
        422,
        "CURSOR_SCHEMA_VERSION_MISMATCH",
        `Cursor schema version ${options.cursor.section_schema_version} must be v2`,
      );
    }
  }

  const startSeq = options?.cursor?.record_seq ?? options?.startRecordSeqExclusive ?? 0;
  const endSeq = options?.endRecordSeqInclusive;
  let recordSeq = startSeq;

  for await (const row of evidenceRepo.streamAcceptedRecords(
    artifactId,
    "SEMANTIC_PROJECTION",
    512,
    startSeq,
    endSeq,
  )) {
    recordSeq = typeof row.record_seq === "number" ? row.record_seq : recordSeq + 1;
    const json = row.record_json as Record<string, unknown>;

    // 1. Authoritative Version Dispatch (V2 Only)
    if (detectedVersion === null) {
      const explicitVersion = (row.section_schema_version as string | undefined) ?? options?.expectedVersion;
      if (explicitVersion !== undefined) {
        if (explicitVersion === "v2" || explicitVersion === "intentchord.section-schema/v2") {
          detectedVersion = "v2";
        } else {
          throw new UnsupportedSectionSchemaVersionError(explicitVersion, {
            artifactId,
            recordSeq,
          });
        }
      } else {
        if (validateFileProjectionHeader(json)) {
          detectedVersion = "v2";
        } else {
          throw new UnsupportedSectionSchemaVersionError("UNKNOWN_OR_MALFORMED", {
            artifactId,
            recordSeq,
            recordSnippet: JSON.stringify(json).slice(0, 120),
          });
        }
      }
    }

    // 2. Governed Record Processing (V2 Only)
    if (validateFileProjectionHeader(json)) {
      currentHeader = json as FileProjectionHeaderRecord;
      continue;
    }
    if (validateStructuralProjectionEntry(json)) {
      if (!currentHeader && startSeq > 0) {
        // Active header recovery across multi-window boundary
        try {
          const { databasePool } = await import("@/server/db");
          const headerRes = await databasePool().query<{ record_json: unknown }>(
            `SELECT r.record_json
               FROM intentchord.workspace_evidence_section_records r
               JOIN intentchord.workspace_evidence_sections s ON s.id = r.section_id
              WHERE s.artifact_id = $1
                AND s.section_type = 'SEMANTIC_PROJECTION'
                AND r.record_seq <= $2
                AND (r.record_json->>'record_kind') = 'FILE_PROJECTION_HEADER'
              ORDER BY r.record_seq DESC
              LIMIT 1`,
            [artifactId, recordSeq],
          );
          if (headerRes.rows.length > 0 && validateFileProjectionHeader(headerRes.rows[0].record_json)) {
            currentHeader = headerRes.rows[0].record_json as FileProjectionHeaderRecord;
          }
        } catch {
          // If database lookup is unavailable, fall through to strict validation error
        }
      }

      if (!currentHeader) {
        throw new InvalidSemanticProjectionRecordError(
          `HBSP_V2_READER_INVALID_HEADER: record_seq=${recordSeq} in SEMANTIC_PROJECTION is not preceded by a valid projection header.`,
          { artifactId, recordSeq },
        );
      }
      const entryRecord = json as StructuralProjectionEntryRecord;
      const mapped = options?.topologyMode
        ? structuralPartToTopologyInputEntry(currentHeader, entryRecord)
        : structuralPartToMappingInputEntry(currentHeader, entryRecord);

      yield {
        ...mapped,
        _recordSeq: recordSeq,
        _logicalUnitId: entryRecord.logical_unit_id,
        _sourceFileRevisionId: entryRecord.parent_file_revision_id,
      };
      continue;
    }
    throw new InvalidSemanticProjectionRecordError(
      `HBSP_V2_READER_INVALID_RECORD: record_seq=${recordSeq} in SEMANTIC_PROJECTION is neither a valid FILE_PROJECTION_HEADER nor a valid STRUCTURAL_PROJECTION_ENTRY.`,
      { artifactId, recordSeq, record: json },
    );
  }
}

/**
 * Read SEMANTIC_PROJECTION records with version-aware dispatch.
 * Backwards-compatibility adapter for test harnesses; production uses streaming.
 */
export async function readAcceptedSemanticProjection(
  evidenceRepo: SemanticProjectionRecordStreamer,
  artifactId: string,
): Promise<SemanticProjectionReadResult> {
  const entries: MappingInputEntry[] = [];
  let recordCount = 0;

  for await (const entry of streamAcceptedSemanticProjectionEntries(evidenceRepo, artifactId)) {
    entries.push(entry);
    recordCount++;
  }

  return {
    entries,
    sectionDigest: "",
    recordCount,
  };
}
