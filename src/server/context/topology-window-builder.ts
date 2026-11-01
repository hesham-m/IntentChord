import { canonicalJson, estimatedTokensForUtf8, mapperSha256 } from "@/core/ai-context-mapper/canonical";
import type { MappingInputEntry } from "@/core/ai-context-mapper/types";
import { streamAcceptedSemanticProjectionEntries } from "@/server/v2-semantic-projection-reader";
import type { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";

import { DEFAULT_TOPOLOGY_WINDOW_TOKEN_BUDGET } from "@/server/context/governed-token-budget";
export { DEFAULT_TOPOLOGY_WINDOW_TOKEN_BUDGET };

export type TopologyWindowBuildOptions = {
  evidenceRepo: PostgresWorkspaceEvidenceRepository;
  artifactId: string;
  traversalId: string;
  traversalAuthoritySha256: string;
  windowOrdinal: number;
  startCursorRecordSeq: number;
  tokenBudget?: number;
};

export type TopologyWindowBuildResult = {
  windowOrdinal: number;
  startCursorRecordSeq: number;
  endCursorRecordSeq: number;
  tokenCount: number;
  windowInputSha256: string;
  entries: MappingInputEntry[];
  candidateUnitIds: string[];
  candidateUnits: Array<{ logical_unit_id: string; source_file_revision_id: string }>;
  hasMore: boolean;
};

/**
 * Builds a compact topology representation window from HBSP-V2 evidence.
 * Does NOT hydrate detailed signals; uses source-grounded identifiers.
 * When the window fills within governed budget, the window seals and returns
 * the exact cursor range for the next window without aggregate 413 failure.
 */
export async function buildNextTopologyWindow(
  options: TopologyWindowBuildOptions,
): Promise<TopologyWindowBuildResult | null> {
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOPOLOGY_WINDOW_TOKEN_BUDGET;
  const entries: MappingInputEntry[] = [];
  const candidateUnitIds: string[] = [];
  const candidateUnits: Array<{ logical_unit_id: string; source_file_revision_id: string }> = [];
  let accumulatedTokens = 0;
  let currentStartSeq = options.startCursorRecordSeq;
  let lastProcessedSeq = options.startCursorRecordSeq;
  let hasMore = false;

  const stream = streamAcceptedSemanticProjectionEntries(options.evidenceRepo, options.artifactId, {
    startRecordSeqExclusive: options.startCursorRecordSeq,
    topologyMode: true,
  });

  for await (const entry of stream) {
    const entrySeq = entry._recordSeq ?? (lastProcessedSeq + 1);
    const entryTokens = estimatedTokensForUtf8(canonicalJson(entry));

    if (entries.length > 0 && accumulatedTokens + entryTokens > tokenBudget) {
      // Window budget boundary reached cleanly. More records remain for subsequent windows.
      hasMore = true;
      break;
    }

    entries.push(entry);
    accumulatedTokens += entryTokens;
    lastProcessedSeq = entrySeq;

    if (entry._logicalUnitId) {
      if (!candidateUnitIds.includes(entry._logicalUnitId)) {
        candidateUnitIds.push(entry._logicalUnitId);
      }
      if (!candidateUnits.some(c => c.logical_unit_id === entry._logicalUnitId)) {
        candidateUnits.push({
          logical_unit_id: entry._logicalUnitId,
          source_file_revision_id: entry._sourceFileRevisionId ?? entry.entry_id,
        });
      }
    }
  }

  if (entries.length === 0) {
    return null;
  }

  const windowInputSha256 = mapperSha256({
    schema: "intentchord.topology-window-input.v1",
    traversal_authority_sha256: options.traversalAuthoritySha256,
    phase: "TOPOLOGY",
    window_ordinal: options.windowOrdinal,
    start_cursor_record_seq: currentStartSeq,
    end_cursor_record_seq: lastProcessedSeq,
    entries,
  });

  return {
    windowOrdinal: options.windowOrdinal,
    startCursorRecordSeq: currentStartSeq,
    endCursorRecordSeq: lastProcessedSeq,
    tokenCount: accumulatedTokens,
    windowInputSha256,
    entries,
    candidateUnitIds,
    candidateUnits,
    hasMore,
  };
}
