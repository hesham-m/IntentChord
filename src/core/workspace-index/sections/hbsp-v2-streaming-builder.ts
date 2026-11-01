/**
 * HBSP-V2 FROZEN ARCHITECTURE — Streaming Semantic Projection Builder (Option F).
 *
 * Implements the Owner-Frozen Option F streaming semantic projection:
 * - Hierarchy: File -> Structural Units -> Bounded Physical Parts
 * - Forward streaming without part_count or precount
 * - Hard physical limit: 262,144 PostgreSQL jsonb-text octets
 * - Minimal bounded oversized reference fallback (SYMBOL <= 254, RELATION <= 260)
 * - Deterministic, collision-safe logical_unit_id derivation
 * - No workspace file exclusions for scale
 */

import { createHash } from "node:crypto";
import {
  HBSP_V2_SECTION_SCHEMA_VERSION,
  HBSP_V2_PROJECTION_HEADER_SCHEMA,
  HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
  OVERSIZED_SYMBOL_MAX_PERSISTED_OCTETS,
  OVERSIZED_RELATION_MAX_PERSISTED_OCTETS,
  fileProjectionHeaderId,
  structuralEntryRecordId,
  deriveLogicalUnitId,
  type FileProjectionHeaderRecord,
  type StructuralProjectionEntryRecord,
  type SemanticProjectionRecord,
  type ProjectionSymbolSignal,
  type ProjectionRelationSignal,
  type MinimalOversizedSymbolReference,
  type MinimalOversizedRelationReference,
  type StructuralLabelAuthority,
} from "@/core/workspace-index/sections/hbsp-v2-types";
import {
  HBSP_V2_RECORD_MAX_UTF8_OCTETS,
  exactPersistedOctetLength,
  assertEntryByteAuthority,
  createSemanticProjectionDigestAccumulator,
  type SemanticProjectionDigestAccumulator,
} from "@/core/workspace-index/sections/hbsp-v2-byte-authority";
import type {
  WorkspaceFileRecord,
  WorkspaceFactRecord,
  WorkspaceRelationRecord,
} from "@/core/workspace-index/types";

export type StreamingBuilderInput = {
  workspaceId: string;
  revisionId: string;
  files: ReadonlyArray<any>;
  parsedResults?: Map<string, any>;
};

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Represent a logical structural grouping of facts & relations within a file.
 */
type LogicalStructuralUnit = {
  unitKind: string;
  unitLabel: string;
  labelAuthority: StructuralLabelAuthority;
  structuralScopePath: string;
  sourceAnchor?: {
    start_line: number;
    end_line: number;
    start_byte?: number;
    end_byte?: number;
  };
  facts: WorkspaceFactRecord[];
  relations: WorkspaceRelationRecord[];
};

/**
 * Group file facts and relations into structural units according to the
 * capability-driven structural grouping model (Option F).
 */
function groupIntoStructuralUnits(
  facts: WorkspaceFactRecord[],
  relations: WorkspaceRelationRecord[],
): LogicalStructuralUnit[] {
  if (facts.length === 0 && relations.length === 0) {
    return [];
  }

  const units: LogicalStructuralUnit[] = [];

  // 1. Imports / Dependencies Unit
  const importFacts = facts.filter(f => f.fact_type === "IMPORT" || f.fact_type === "DEPENDENCY");
  if (importFacts.length > 0) {
    const impRelIds = new Set(importFacts.map(f => f.fact_revision_id));
    const impRels = relations.filter(r =>
      impRelIds.has(r.source.entity_revision_id) || impRelIds.has(r.target.entity_revision_id)
    );
    units.push({
      unitKind: "IMPORTS",
      unitLabel: "imports",
      labelAuthority: "STRUCTURAL_DERIVED",
      structuralScopePath: "root",
      facts: importFacts,
      relations: impRels,
    });
  }

  // 2. Component / Class / Service Units
  const classFacts = facts.filter(f =>
    f.fact_type === "COMPONENT" || f.fact_type === "SERVICE" || f.fact_type === "DATABASE_ENTITY"
  );
  for (const cf of classFacts) {
    const rels = relations.filter(r =>
      r.source.entity_revision_id === cf.fact_revision_id || r.target.entity_revision_id === cf.fact_revision_id
    );
    units.push({
      unitKind: "CLASS",
      unitLabel: cf.display_name || cf.qualified_name.split(/[:#.]/).pop() || "Class",
      labelAuthority: "SOURCE_NATIVE",
      structuralScopePath: "root",
      sourceAnchor: cf.source_location?.line_range ? {
        start_line: cf.source_location.line_range.start,
        end_line: cf.source_location.line_range.end,
      } : undefined,
      facts: [cf],
      relations: rels,
    });
  }

  // 3. Function / Route Units
  const funcFacts = facts.filter(f =>
    f.fact_type === "ROUTE" || f.fact_type === "SCRIPT" || f.fact_type === "TEST"
  );
  for (const ff of funcFacts) {
    const rels = relations.filter(r =>
      r.source.entity_revision_id === ff.fact_revision_id || r.target.entity_revision_id === ff.fact_revision_id
    );
    units.push({
      unitKind: "FUNCTION",
      unitLabel: ff.display_name || ff.qualified_name.split(/[:#.]/).pop() || "Function",
      labelAuthority: "SOURCE_NATIVE",
      structuralScopePath: "root",
      sourceAnchor: ff.source_location?.line_range ? {
        start_line: ff.source_location.line_range.start,
        end_line: ff.source_location.line_range.end,
      } : undefined,
      facts: [ff],
      relations: rels,
    });
  }

  // 4. Remaining unassigned facts
  const assignedFactIds = new Set(units.flatMap(u => u.facts.map(f => f.fact_revision_id)));
  const remainingFacts = facts.filter(f => !assignedFactIds.has(f.fact_revision_id));

  if (remainingFacts.length > 0 || (units.length === 0 && relations.length > 0)) {
    const assignedRelIds = new Set(units.flatMap(u => u.relations.map(r => r.relation_revision_id)));
    const remainingRels = relations.filter(r => !assignedRelIds.has(r.relation_revision_id));

    // Partition remaining facts into bounded chunks of up to 100 facts each
    const CHUNK_SIZE = 100;
    for (let i = 0; i < Math.max(1, remainingFacts.length); i += CHUNK_SIZE) {
      const chunkFacts = remainingFacts.slice(i, i + CHUNK_SIZE);
      const chunkFactIds = new Set(chunkFacts.map(f => f.fact_revision_id));
      const chunkRels = remainingRels.filter(r =>
        chunkFactIds.has(r.source.entity_revision_id) || chunkFactIds.has(r.target.entity_revision_id)
      );

      const chunkOrdinal = Math.floor(i / CHUNK_SIZE);
      units.push({
        unitKind: "UNCLASSIFIED_REGION",
        unitLabel: `unclassified_${chunkOrdinal}`,
        labelAuthority: "SOURCE_ANCHORED_UNCLASSIFIED",
        structuralScopePath: "root",
        facts: chunkFacts,
        relations: chunkRels,
      });
    }
  }

  return units;
}

/**
 * Main generator: yields HBSP-V2 physical records in streaming order.
 * FILE_PROJECTION_HEADER followed by STRUCTURAL_PROJECTION_ENTRY parts.
 */
export function* buildStreamingSemanticProjectionRecords(
  input: StreamingBuilderInput,
): Generator<SemanticProjectionRecord> {
  const workspaceId = input.workspaceId;
  const sortedFiles = [...input.files].sort((a, b) => {
    const pathA = normalizePath(a.relativePath ?? a.relative_path ?? "");
    const pathB = normalizePath(b.relativePath ?? b.relative_path ?? "");
    return pathA.localeCompare(pathB);
  });

  for (const file of sortedFiles) {
    const relPath = normalizePath(file.relativePath ?? file.relative_path ?? "");
    const fileId = file.workspaceFileId ?? file.workspace_file_id ?? `file_${relPath}`;
    const fileRevisionId = file.fileRevisionId ?? file.file_revision_id ?? `fre_${createHash("sha256").update(`${fileId}:v2`).digest("hex")}`;
    const fingerprint = file.contentHash ?? file.content_hash ?? file.metadataHash ?? file.metadata_hash ?? "unknown";
    const languageOrFormat = file.language ?? file.fileKind ?? file.file_kind ?? "UNKNOWN";
    const sizeBytes = Number(file.sizeBytes ?? file.size_bytes ?? 0);
    const parseStatus = file.parseStatus ?? file.parse_status ?? "SUPPORTED";
    const coverageState = file.coverageState ?? file.coverage_state ?? "FULL";

    // 1. Emit bounded O(1) FILE_PROJECTION_HEADER
    const headerRecordId = fileProjectionHeaderId(workspaceId, fileRevisionId);
    const header: FileProjectionHeaderRecord = {
      record_kind: "FILE_PROJECTION_HEADER",
      record_id: headerRecordId,
      workspace_id: workspaceId,
      source_file_revision_id: fileRevisionId,
      normalized_path: relPath,
      language_or_format: languageOrFormat,
      size_bytes: sizeBytes,
      content_or_metadata_fingerprint: fingerprint,
      file_kind: file.fileKind ?? file.file_kind ?? "UNKNOWN",
      parse_status: parseStatus,
      coverage_state: coverageState,
    };
    assertEntryByteAuthority(header);
    yield header;

    // Retrieve facts and relations for this file
    const parsed = input.parsedResults?.get(file.relativePath ?? file.relative_path);
    const facts: WorkspaceFactRecord[] = parsed?.facts ?? [];
    const relations: WorkspaceRelationRecord[] = parsed?.relations ?? [];

    // Group into logical structural units
    const structuralUnits = groupIntoStructuralUnits(facts, relations);

    // 2. Emit bounded STRUCTURAL_PROJECTION_ENTRY parts for each unit
    for (let unitOrdinal = 0; unitOrdinal < structuralUnits.length; unitOrdinal++) {
      const unit = structuralUnits[unitOrdinal];
      const anchorSig = unit.sourceAnchor
        ? `line:${unit.sourceAnchor.start_line}:${unit.sourceAnchor.end_line}`
        : `ord:${unitOrdinal}`;

      const logicalUnitId = deriveLogicalUnitId({
        parent_file_revision_id: fileRevisionId,
        unit_kind: unit.unitKind,
        structural_scope_path: unit.structuralScopePath,
        unit_label: unit.unitLabel,
        source_anchor_signature: anchorSig,
        structural_ordinal: unitOrdinal,
      });

      // Candidate record builder under exact byte-accounting
      const buildCandidateRecord = (
        pIndex: number,
        isFinal: boolean,
        syms: ProjectionSymbolSignal[],
        rels: ProjectionRelationSignal[],
      ): StructuralProjectionEntryRecord => ({
        record_kind: "STRUCTURAL_PROJECTION_ENTRY",
        record_id: structuralEntryRecordId(logicalUnitId, pIndex),
        workspace_id: workspaceId,
        parent_file_entry_id: headerRecordId,
        parent_file_revision_id: fileRevisionId,
        logical_unit_id: logicalUnitId,
        parent_logical_unit_id: null,
        unit_kind: unit.unitKind,
        unit_label: unit.unitLabel,
        label_authority: unit.labelAuthority,
        ...(unit.sourceAnchor ? {
          source_anchor: {
            start_line: unit.sourceAnchor.start_line,
            end_line: unit.sourceAnchor.end_line,
            ...(unit.sourceAnchor.start_byte != null ? { start_byte: unit.sourceAnchor.start_byte } : {}),
            ...(unit.sourceAnchor.end_byte != null ? { end_byte: unit.sourceAnchor.end_byte } : {}),
          },
        } : {}),
        part_index: pIndex,
        is_final_part: isFinal,
        projection_signals: {
          symbols: syms,
          relations: rels,
        },
      });

      // Prepare projection signals: fallback to reference ONLY when an atomic signal cannot fit inside an otherwise empty physical HBSP record
      const symbols: ProjectionSymbolSignal[] = unit.facts.map(f => {
        const localName =
          (f as any).local_name ||
          f.display_name ||
          (f.qualified_name ? f.qualified_name.split(/[:#.]/).pop() : "symbol") ||
          "symbol";
        const sym: ProjectionSymbolSignal = {
          local_name: localName,
          qualified_suffix: (f as any).qualified_suffix || `#symbol:${localName}`,
          kind: f.fact_type,
          evidence_role: f.evidence_role,
          certainty: f.certainty,
          fact_ref: f.fact_revision_id || (f as any).workspace_fact_id || "fr_unknown",
        };
        const testSingleSymbolRecord = buildCandidateRecord(0, false, [sym], []);
        if (exactPersistedOctetLength(testSingleSymbolRecord) > HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
          return {
            reference_mode: "AUTHORITATIVE_SECTION_REFERENCE",
            signal_type: "SYMBOL",
            fact_ref: sym.fact_ref,
          };
        }
        return sym;
      });

      const relSignals: ProjectionRelationSignal[] = unit.relations.map(r => {
        const targetId = r.target?.entity_revision_id || (r as any).target_entity_revision_id || (r as any).target_entity_id || "target";
        const relRef = r.relation_revision_id || (r as any).workspace_relation_id || "rel_unknown";
        const relSig: ProjectionRelationSignal = {
          relation_type: r.relation_type,
          direction: r.direction,
          target_entity_id: targetId,
          relation_ref: relRef,
        };
        const testSingleRelRecord = buildCandidateRecord(0, false, [], [relSig]);
        if (exactPersistedOctetLength(testSingleRelRecord) > HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
          return {
            reference_mode: "AUTHORITATIVE_SECTION_REFERENCE",
            signal_type: "RELATION",
            relation_ref: relRef,
          };
        }
        return relSig;
      });

      // Forward streaming packing without part pre-count
      let currentPartIndex = 0;
      let packedSymbols: ProjectionSymbolSignal[] = [];
      let packedRelations: ProjectionRelationSignal[] = [];

      // Accumulate symbols
      for (const sym of symbols) {
        // Test fit with provisional is_final_part: false (worst-case 22 bytes)
        const candidate = buildCandidateRecord(currentPartIndex, false, [...packedSymbols, sym], packedRelations);
        if (exactPersistedOctetLength(candidate) <= HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
          packedSymbols.push(sym);
        } else {
          // Current part is full — emit with authoritative is_final_part: false
          if (packedSymbols.length === 0 && packedRelations.length === 0) {
            // Single candidate exceeds part bound — fallback to minimal pointer
            const minRef: MinimalOversizedSymbolReference = {
              reference_mode: "AUTHORITATIVE_SECTION_REFERENCE",
              signal_type: "SYMBOL",
              fact_ref: (sym as any).fact_ref,
            };
            packedSymbols.push(minRef);
          }
          const recordToEmit = buildCandidateRecord(currentPartIndex, false, packedSymbols, packedRelations);
          assertEntryByteAuthority(recordToEmit);
          yield recordToEmit;

          currentPartIndex++;
          packedSymbols = [sym];
          packedRelations = [];
        }
      }

      // Accumulate relations
      for (const rel of relSignals) {
        const candidate = buildCandidateRecord(currentPartIndex, false, packedSymbols, [...packedRelations, rel]);
        if (exactPersistedOctetLength(candidate) <= HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
          packedRelations.push(rel);
        } else {
          if (packedSymbols.length === 0 && packedRelations.length === 0) {
            const minRelRef: MinimalOversizedRelationReference = {
              reference_mode: "AUTHORITATIVE_SECTION_REFERENCE",
              signal_type: "RELATION",
              relation_ref: (rel as any).relation_ref,
            };
            packedRelations.push(minRelRef);
          }
          const recordToEmit = buildCandidateRecord(currentPartIndex, false, packedSymbols, packedRelations);
          assertEntryByteAuthority(recordToEmit);
          yield recordToEmit;

          currentPartIndex++;
          packedSymbols = [];
          packedRelations = [rel];
        }
      }

      // Unit end: emit final part with authoritative is_final_part: true (shrinks by 1 byte)
      const finalRecord = buildCandidateRecord(currentPartIndex, true, packedSymbols, packedRelations);
      assertEntryByteAuthority(finalRecord);
      yield finalRecord;
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate Compatibility Builder Adapters (for isolated candidate tests)
// NOTE: Not used on active production call path (engine-v2 uses streaming generator)
// ---------------------------------------------------------------------------

export type StreamingFileEvidence = {
  workspace_file_id: string;
  file_revision_id: string;
  relative_path: string;
  file_kind?: string;
  language?: string;
  size_bytes: number;
  content_hash: string;
  metadata_hash?: string;
  sensitivity_state?: string;
  parse_status?: string;
  coverage_state?: string;
};

export type StreamingFactEvidence = {
  source_file_revision_id: string;
  fact_type: string;
  qualified_name: string;
  display_name: string;
  attributes?: Record<string, unknown>;
  certainty: string;
  evidence_role: string;
};

export type StreamingRelationEvidence = {
  source_entity_revision_id: string;
  target_entity_revision_id: string;
  relation_type: string;
  direction: string;
  certainty: string;
  evidence_role: string;
};

export function buildStreamingSemanticProjection(
  workspaceId: string,
  workspaceRevisionId: string,
  workspaceIndexSha256: string,
  files: ReadonlyArray<StreamingFileEvidence>,
  facts: ReadonlyArray<StreamingFactEvidence> = [],
  relations: ReadonlyArray<StreamingRelationEvidence> = [],
): {
  header: any;
  records: any[];
  sectionDigest: string;
  totalRecordCount: number;
  totalEntryCount: number;
  excludedCount: number;
  segmentCount: number;
} {
  const eligibleFiles = files
    .filter(f => !f.sensitivity_state || f.sensitivity_state === "NORMAL")
    .slice()
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const excludedFiles = files.filter(f => f.sensitivity_state && f.sensitivity_state !== "NORMAL");

  const header = {
    schema: HBSP_V2_PROJECTION_HEADER_SCHEMA,
    workspace_revision_id: workspaceRevisionId,
    workspace_index_sha256: workspaceIndexSha256,
    eligible_entry_count: eligibleFiles.length,
    excluded_entry_count: excludedFiles.length,
    projection_created_at: "1970-01-01T00:00:00.000Z",
  };

  const records: any[] = [header];

  for (const file of eligibleFiles) {
    const fileFacts = facts
      .filter(f => f.source_file_revision_id === file.file_revision_id)
      .slice()
      .sort((a, b) => a.qualified_name.localeCompare(b.qualified_name));
    const fileRelations = relations.filter(
      r => r.source_entity_revision_id === file.file_revision_id || r.target_entity_revision_id === file.file_revision_id,
    );

    const makeCandidate = (partIndex: number, isFinal: boolean, factList: any[], relList: any[]) => ({
      schema: HBSP_V2_STRUCTURAL_ENTRY_SCHEMA,
      logical_unit_id: deriveLogicalUnitId(file.relative_path, file.content_hash),
      part_index: partIndex,
      is_final_part: isFinal,
      normalized_path: file.relative_path,
      entry_type: "FILE" as const,
      language_or_format: file.language ?? "UNKNOWN",
      size_bytes: file.size_bytes,
      content_or_metadata_fingerprint: file.content_hash,
      index_supported_signals: {
        file_kind: file.file_kind ?? "SOURCE",
        parse_status: file.parse_status ?? "SUPPORTED",
        coverage_state: file.coverage_state ?? "FULL",
        fact_signals: factList,
        relation_signals: relList,
      },
    });

    const singleCandidate = makeCandidate(0, true, fileFacts, fileRelations);
    if (exactPersistedOctetLength(singleCandidate) <= HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
      records.push(singleCandidate);
    } else {
      let partIndex = 0;
      let packedFacts: any[] = [];
      let packedRels: any[] = [];

      for (const fact of fileFacts) {
        const testCand = makeCandidate(partIndex, false, [...packedFacts, fact], packedRels);
        if (exactPersistedOctetLength(testCand) <= HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
          packedFacts.push(fact);
        } else {
          if (packedFacts.length > 0 || packedRels.length > 0) {
            records.push(makeCandidate(partIndex, false, packedFacts, packedRels));
            partIndex++;
            packedFacts = [fact];
            packedRels = [];
          } else {
            records.push(makeCandidate(partIndex, false, [fact], []));
            partIndex++;
            packedFacts = [];
          }
        }
      }

      for (const rel of fileRelations) {
        const testCand = makeCandidate(partIndex, false, packedFacts, [...packedRels, rel]);
        if (exactPersistedOctetLength(testCand) <= HBSP_V2_RECORD_MAX_UTF8_OCTETS) {
          packedRels.push(rel);
        } else {
          if (packedFacts.length > 0 || packedRels.length > 0) {
            records.push(makeCandidate(partIndex, false, packedFacts, packedRels));
            partIndex++;
            packedFacts = [];
            packedRels = [rel];
          } else {
            records.push(makeCandidate(partIndex, false, [], [rel]));
            partIndex++;
            packedRels = [];
          }
        }
      }

      records.push(makeCandidate(partIndex, true, packedFacts, packedRels));
    }
  }

  const acc = createSemanticProjectionDigestAccumulator();
  acc.feedHeader(header);
  for (let i = 1; i < records.length; i++) {
    acc.feedEntry(records[i]);
  }
  const sectionDigest = acc.finish();

  return {
    header,
    records,
    sectionDigest,
    totalRecordCount: records.length,
    totalEntryCount: records.length - 1,
    excludedCount: excludedFiles.length,
    segmentCount: Math.max(1, Math.ceil(records.length / 512)),
  };
}

export function buildStreamingProjectionAsMappingInputEntries(
  workspaceId: string,
  workspaceRevisionId: string,
  workspaceIndexSha256: string,
  files: ReadonlyArray<StreamingFileEvidence>,
  facts: ReadonlyArray<StreamingFactEvidence> = [],
  relations: ReadonlyArray<StreamingRelationEvidence> = [],
): any[] {
  const result = buildStreamingSemanticProjection(
    workspaceId,
    workspaceRevisionId,
    workspaceIndexSha256,
    files,
    facts,
    relations,
  );
  return result.records.slice(1).map(r => ({
    entry_id: r.logical_unit_id,
    workspace_id: workspaceId,
    normalized_path: r.normalized_path,
    entry_type: "FILE",
    language_or_format: r.language_or_format,
    size_bytes: r.size_bytes,
    content_or_metadata_fingerprint: r.content_or_metadata_fingerprint,
    index_supported_signals: r.index_supported_signals,
  }));
}

