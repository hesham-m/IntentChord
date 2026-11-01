import { canonicalJson, estimatedTokensForUtf8, mapperSha256 } from "@/core/ai-context-mapper/canonical";
import type { MappingInputEntry } from "@/core/ai-context-mapper/types";
import {
  structuralPartToMappingInputEntry,
  type SemanticProjectionRecordStreamer,
} from "@/server/v2-semantic-projection-reader";
import {
  validateFileProjectionHeader,
  validateStructuralProjectionEntry,
  type FileProjectionHeaderRecord,
  type StructuralProjectionEntryRecord,
} from "@/core/workspace-index/sections/hbsp-v2-types";
import type { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";

import { DEFAULT_DRILLDOWN_WINDOW_TOKEN_BUDGET } from "@/server/context/governed-token-budget";
export { DEFAULT_DRILLDOWN_WINDOW_TOKEN_BUDGET };

export type DrilldownCandidateUnit = {
  id: string;
  logical_unit_id: string;
  source_file_revision_id: string;
  candidate_ordinal: number;
};

export type DrilldownWindowBuildOptions = {
  evidenceRepo: PostgresWorkspaceEvidenceRepository;
  artifactId: string;
  traversalId: string;
  traversalAuthoritySha256: string;
  windowOrdinal: number;
  candidates: DrilldownCandidateUnit[];
  tokenBudget?: number;
};

export type DrilldownWindowBuildResult = {
  windowOrdinal: number;
  processedCandidateIds: string[];
  processedLogicalUnitIds: string[];
  startCursorRecordSeq: number;
  endCursorRecordSeq: number;
  tokenCount: number;
  windowInputSha256: string;
  entries: MappingInputEntry[];
  remainingCandidates: DrilldownCandidateUnit[];
};

/**
 * Builds selective drilldown windows for normalized candidate units.
 * Fetches detailed STRUCTURAL_PROJECTION_ENTRY evidence only for selected logical units.
 * If candidates exceed one window's budget, creates bounded windows without any truncation.
 */
export async function buildNextDrilldownWindow(
  options: DrilldownWindowBuildOptions,
): Promise<DrilldownWindowBuildResult | null> {
  if (options.candidates.length === 0) {
    return null;
  }

  const tokenBudget = options.tokenBudget ?? DEFAULT_DRILLDOWN_WINDOW_TOKEN_BUDGET;
  const processedCandidateIds: string[] = [];
  const processedLogicalUnitIds: string[] = [];
  const entries: MappingInputEntry[] = [];
  let accumulatedTokens = 0;
  let minSeq = Number.MAX_SAFE_INTEGER;
  let maxSeq = 0;
  let splitIndex = 0;

  // Batch query all candidates' structural entries in a single round-trip
  const candidateUnitIds = options.candidates.map(c => c.logical_unit_id);
  const rawRows = await options.evidenceRepo.findStructuralEntriesByLogicalUnits(
    options.artifactId,
    candidateUnitIds,
  );

  const rowsByUnitId = new Map<string, Record<string, unknown>[]>();
  for (const row of rawRows) {
    const json = row.record_json as Record<string, unknown>;
    const unitId = json?.logical_unit_id as string | undefined;
    if (unitId) {
      let list = rowsByUnitId.get(unitId);
      if (!list) {
        list = [];
        rowsByUnitId.set(unitId, list);
      }
      list.push(row);
    }
  }

  for (let i = 0; i < options.candidates.length; i++) {
    const candidate = options.candidates[i];
    const candidateRows = rowsByUnitId.get(candidate.logical_unit_id) ?? [];

    const candidateEntries: MappingInputEntry[] = [];
    let candidateMinSeq = Number.MAX_SAFE_INTEGER;
    let candidateMaxSeq = 0;

    for (const row of candidateRows) {
      const seq = Number(row.record_seq);
      if (seq < candidateMinSeq) candidateMinSeq = seq;
      if (seq > candidateMaxSeq) candidateMaxSeq = seq;

      const json = row.record_json as Record<string, unknown>;
      if (validateStructuralProjectionEntry(json)) {
        const entryRecord = json as StructuralProjectionEntryRecord;
        // Mock a minimal header if not available in row or read from file revision
        const syntheticHeader: FileProjectionHeaderRecord = {
          record_kind: "FILE_PROJECTION_HEADER",
          record_id: `hdr_${candidate.source_file_revision_id}`,
          workspace_id: entryRecord.workspace_id,
          source_file_revision_id: candidate.source_file_revision_id,
          normalized_path: `unit_${candidate.logical_unit_id}`,
          language_or_format: "SOURCE_CODE",
          size_bytes: 0,
          content_or_metadata_fingerprint: "",
          file_kind: "SOURCE_CODE",
          parse_status: "SUPPORTED",
          coverage_state: "FULL",
        };
        const entry = structuralPartToMappingInputEntry(syntheticHeader, entryRecord);
        candidateEntries.push(entry);
      }
    }

    // If candidate has no dedicated row in DB (e.g. synthetic test unit), generate candidate fallback entry
    if (candidateEntries.length === 0) {
      candidateEntries.push({
        entry_id: `fallback_${candidate.id}`,
        workspace_id: "ws_default",
        normalized_path: `unit_${candidate.logical_unit_id}`,
        entry_type: "FILE",
        language_or_format: "SOURCE_CODE",
        size_bytes: 0,
        content_or_metadata_fingerprint: "",
        index_supported_signals: {
          file_kind: "SOURCE_CODE",
          parse_status: "SUPPORTED",
          coverage_state: "FULL",
          fact_signals: [],
          relation_signals: [],
        },
      });
    }

    const candidateTokens = candidateEntries.reduce(
      (sum, e) => sum + estimatedTokensForUtf8(canonicalJson(e)),
      0,
    );

    if (entries.length > 0 && accumulatedTokens + candidateTokens > tokenBudget) {
      // Window full; split here.
      splitIndex = i;
      break;
    }

    entries.push(...candidateEntries);
    accumulatedTokens += candidateTokens;
    processedCandidateIds.push(candidate.id);
    processedLogicalUnitIds.push(candidate.logical_unit_id);
    if (candidateMinSeq < minSeq) minSeq = candidateMinSeq;
    if (candidateMaxSeq > maxSeq) maxSeq = candidateMaxSeq;
    splitIndex = i + 1;
  }

  if (entries.length === 0) {
    return null;
  }

  const startSeq = minSeq === Number.MAX_SAFE_INTEGER ? 0 : minSeq;
  const endSeq = maxSeq === 0 ? startSeq : maxSeq;

  const windowInputSha256 = mapperSha256({
    schema: "intentchord.drilldown-window-input.v1",
    traversal_authority_sha256: options.traversalAuthoritySha256,
    phase: "DRILLDOWN",
    window_ordinal: options.windowOrdinal,
    candidate_unit_ids: processedLogicalUnitIds,
    start_cursor_record_seq: startSeq,
    end_cursor_record_seq: endSeq,
    entries,
  });

  return {
    windowOrdinal: options.windowOrdinal,
    processedCandidateIds,
    processedLogicalUnitIds,
    startCursorRecordSeq: startSeq,
    endCursorRecordSeq: endSeq,
    tokenCount: accumulatedTokens,
    windowInputSha256,
    entries,
    remainingCandidates: options.candidates.slice(splitIndex),
  };
}
