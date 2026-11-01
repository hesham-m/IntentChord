import { randomUUID } from "node:crypto";
import { canonicalJson, estimatedTokensForUtf8, mapperSha256 } from "@/core/ai-context-mapper/canonical";
import type {
  ContextComponentV2,
  ContextRelationshipV2,
  MissingEvidenceRequestV2,
  MaterialContradictionV2,
  ModelContextAnalysisV2,
} from "@/core/ai-context-mapper/v2";
import type { ContextMappingTraversalRepository } from "@/server/context-mapping-traversal-repository";
import { getGovernedReductionWindowTokenBudget } from "@/server/context/governed-token-budget";
import type {
  ReductionSynthesisAdapter,
  ChildAnalysisInputItem,
} from "@/server/context/reduction-synthesis-adapter";

/** Maximum inputs consumed in a single reduction window fallback (for backwards compatibility). */
export const MAX_REDUCTION_INPUTS_PER_WINDOW = 10;

export type ReductionSourceItem = {
  sourceType: "MAPPING_WINDOW" | "REDUCTION_WINDOW";
  sourceId: string;
  sourceOutputSha256: string;
  reductionLevel?: number;
  payload: {
    catalog_summary?: string;
    components?: ContextComponentV2[];
    relationships?: ContextRelationshipV2[];
    missing_evidence_requests?: MissingEvidenceRequestV2[];
    material_contradictions?: MaterialContradictionV2[];
  };
};

export type ReductionLevelExecutionResult = {
  level: number;
  windowCount: number;
  outputItems: ReductionSourceItem[];
};

export type SynthesizerResult = {
  totalReductionLevels: number;
  totalReductionWindows: number;
  rootReductionWindowId: string;
  rootOutputSha256: string;
  finalAnalysis: ModelContextAnalysisV2;
};

/**
 * Deterministically synthesizes and deduplicates components across bounded windows.
 * Retains all evidence identities with zero arbitrary truncation.
 */
export function mergeAnalysisPayloads(
  items: Array<ReductionSourceItem["payload"]>,
): ModelContextAnalysisV2 {
  const componentMap = new Map<string, ContextComponentV2>();
  const relationshipMap = new Map<string, ContextRelationshipV2>();
  const missingEvidenceMap = new Map<string, MissingEvidenceRequestV2>();
  const contradictionMap = new Map<string, MaterialContradictionV2>();
  const summaries: string[] = [];

  for (const item of items) {
    if (item.catalog_summary && !summaries.includes(item.catalog_summary)) {
      summaries.push(item.catalog_summary);
    }

    for (const comp of item.components ?? []) {
      const existing = componentMap.get(comp.component_id);
      if (!existing) {
        componentMap.set(comp.component_id, {
          ...comp,
          responsibilities: [...comp.responsibilities],
          workspace_ids: [...comp.workspace_ids],
          evidence_entry_ids: [...comp.evidence_entry_ids],
          interfaces: [...comp.interfaces],
          unknowns: [...comp.unknowns],
        });
      } else {
        // Deterministic merge of sets
        for (const resp of comp.responsibilities) {
          if (!existing.responsibilities.includes(resp)) existing.responsibilities.push(resp);
        }
        for (const ws of comp.workspace_ids) {
          if (!existing.workspace_ids.includes(ws)) existing.workspace_ids.push(ws);
        }
        for (const ev of comp.evidence_entry_ids) {
          if (!existing.evidence_entry_ids.includes(ev)) existing.evidence_entry_ids.push(ev);
        }
        for (const iface of comp.interfaces) {
          if (!existing.interfaces.includes(iface)) existing.interfaces.push(iface);
        }
        for (const unk of comp.unknowns) {
          if (!existing.unknowns.includes(unk)) existing.unknowns.push(unk);
        }
        if (comp.rationale && !existing.rationale.includes(comp.rationale)) {
          existing.rationale = `${existing.rationale} | ${comp.rationale}`;
        }
      }
    }

    for (const rel of item.relationships ?? []) {
      const key = `${rel.from_component_id}->${rel.to_component_id}:${rel.relationship_type}`;
      const existing = relationshipMap.get(key);
      if (!existing) {
        relationshipMap.set(key, {
          ...rel,
          evidence_entry_ids: [...rel.evidence_entry_ids],
        });
      } else {
        for (const ev of rel.evidence_entry_ids) {
          if (!existing.evidence_entry_ids.includes(ev)) existing.evidence_entry_ids.push(ev);
        }
      }
    }

    for (const gap of item.missing_evidence_requests ?? []) {
      if (!missingEvidenceMap.has(gap.gap_id)) {
        missingEvidenceMap.set(gap.gap_id, { ...gap });
      }
    }

    for (const contra of item.material_contradictions ?? []) {
      if (!contradictionMap.has(contra.contradiction_id)) {
        contradictionMap.set(contra.contradiction_id, { ...contra });
      }
    }
  }

  const combinedSummary = summaries.length > 0
    ? summaries.join("; ")
    : "Synthesized multi-window workspace architectural topology and domain components.";

  return {
    schema_version: "intentchord.model-context-analysis.v2",
    analysis_outcome: missingEvidenceMap.size > 0
      ? "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE"
      : "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP",
    catalog_summary: combinedSummary,
    components: Array.from(componentMap.values()),
    relationships: Array.from(relationshipMap.values()),
    missing_evidence_requests: Array.from(missingEvidenceMap.values()),
    material_contradictions: Array.from(contradictionMap.values()),
    global_unknowns: [],
    warnings: [],
  };
}

export class OversizedReductionChildError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly itemTokens: number,
    public readonly tokenBudget: number,
    reason: string,
  ) {
    super(
      `OVERSIZED_REDUCTION_CHILD: Child analysis '${sourceId}' exceeds effective reduction budget (${itemTokens} > ${tokenBudget}). ${reason}`,
    );
    this.name = "OversizedReductionChildError";
  }
}

/**
 * Decomposes an oversized child analysis recursively if divisible into smaller bounded analyses.
 * If the child analysis has <= 1 component and still exceeds the budget, it is indivisible
 * and cannot be split without semantic truncation. In that case, fails closed.
 */
export function decomposeOversizedReductionSource(
  source: ReductionSourceItem,
  tokenBudget: number,
): ReductionSourceItem[] {
  const itemTokens = estimatedTokensForUtf8(canonicalJson(source.payload));
  if (itemTokens <= tokenBudget) {
    return [source];
  }

  const comps = source.payload.components ?? [];
  if (comps.length <= 1) {
    throw new OversizedReductionChildError(
      source.sourceId,
      itemTokens,
      tokenBudget,
      `Child analysis is indivisible (${comps.length} component(s)) and exceeds budget. Bounded reduction cannot proceed without semantic truncation. Failing closed.`,
    );
  }

  const mid = Math.ceil(comps.length / 2);
  const leftComps = comps.slice(0, mid);
  const rightComps = comps.slice(mid);

  const leftCompIds = new Set(leftComps.map(c => c.component_id));
  const rightCompIds = new Set(rightComps.map(c => c.component_id));

  const leftAnalysis: ReductionSourceItem["payload"] = {
    ...source.payload,
    components: leftComps,
    relationships: (source.payload.relationships ?? []).filter(r =>
      leftCompIds.has(r.from_component_id) || leftCompIds.has(r.to_component_id),
    ),
    missing_evidence_requests: (source.payload.missing_evidence_requests ?? []).filter(g =>
      g.affected_component_ids.some(id => leftCompIds.has(id)),
    ),
    material_contradictions: (source.payload.material_contradictions ?? []).filter(c =>
      c.affected_component_ids.some(id => leftCompIds.has(id)),
    ),
  };

  const rightAnalysis: ReductionSourceItem["payload"] = {
    ...source.payload,
    components: rightComps,
    relationships: (source.payload.relationships ?? []).filter(r =>
      rightCompIds.has(r.from_component_id) || rightCompIds.has(r.to_component_id),
    ),
    missing_evidence_requests: (source.payload.missing_evidence_requests ?? []).filter(g =>
      g.affected_component_ids.some(id => rightCompIds.has(id)),
    ),
    material_contradictions: (source.payload.material_contradictions ?? []).filter(c =>
      c.affected_component_ids.some(id => rightCompIds.has(id)),
    ),
  };

  const leftItem: ReductionSourceItem = {
    sourceId: `${source.sourceId}.1`,
    sourceType: source.sourceType,
    sourceOutputSha256: mapperSha256(leftAnalysis),
    payload: leftAnalysis,
  };

  const rightItem: ReductionSourceItem = {
    sourceId: `${source.sourceId}.2`,
    sourceType: source.sourceType,
    sourceOutputSha256: mapperSha256(rightAnalysis),
    payload: rightAnalysis,
  };

  return [
    ...decomposeOversizedReductionSource(leftItem, tokenBudget),
    ...decomposeOversizedReductionSource(rightItem, tokenBudget),
  ];
}

/**
 * Chunks reduction source items strictly bounded by token budget.
 * Enforces that no oversized child is forwarded directly, truncated, or accepted into a chunk.
 */
export function chunkSourcesByTokenBudget(
  sources: ReductionSourceItem[],
  tokenBudget: number,
): ReductionSourceItem[][] {
  if (tokenBudget <= 0) {
    throw new Error(`INVALID_TOKEN_BUDGET: Budget must be positive, got ${tokenBudget}`);
  }

  // 1. Normalize sources: recursively decompose divisible oversized items or fail closed
  const normalizedSources: ReductionSourceItem[] = [];
  for (const source of sources) {
    const itemTokens = estimatedTokensForUtf8(canonicalJson(source.payload));
    if (itemTokens > tokenBudget) {
      const decomposed = decomposeOversizedReductionSource(source, tokenBudget);
      normalizedSources.push(...decomposed);
    } else {
      normalizedSources.push(source);
    }
  }

  // 2. Pack bounded items into chunks
  const chunks: ReductionSourceItem[][] = [];
  let currentChunk: ReductionSourceItem[] = [];
  let currentChunkTokens = 0;

  for (const source of normalizedSources) {
    const itemTokens = estimatedTokensForUtf8(canonicalJson(source.payload));
    if (itemTokens > tokenBudget) {
      throw new OversizedReductionChildError(
        source.sourceId,
        itemTokens,
        tokenBudget,
        "Normalized source item unexpectedly exceeds budget.",
      );
    }

    if (currentChunk.length > 0 && currentChunkTokens + itemTokens > tokenBudget) {
      chunks.push(currentChunk);
      currentChunk = [source];
      currentChunkTokens = itemTokens;
    } else {
      currentChunk.push(source);
      currentChunkTokens += itemTokens;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  // 3. Invariant check: guarantee every chunk is bounded
  for (const chunk of chunks) {
    const totalChunkTokens = chunk.reduce(
      (sum, s) => sum + estimatedTokensForUtf8(canonicalJson(s.payload)),
      0,
    );
    if (totalChunkTokens > tokenBudget) {
      throw new Error(
        `EVERY_REDUCTION_AI_INPUT_BOUNDED_VIOLATION: Chunk tokens (${totalChunkTokens}) exceeds budget (${tokenBudget}).`,
      );
    }
  }

  return chunks;
}

export type HierarchicalReductionOptions = {
  reductionAdapter?: ReductionSynthesisAdapter;
  tokenBudget?: number;
};

/**
 * Executes multi-level bounded hierarchical reduction.
 * Consumes source mapping windows or lower-level reduction windows.
 * Enforces cryptographic output hash binding and strict DAG lineage direction.
 * Uses token-bounded window chunking and executes reduction synthesis adapter.
 */
export async function executeHierarchicalReduction(
  traversalRepo: ContextMappingTraversalRepository,
  traversalId: string,
  traversalAuthoritySha256: string,
  workerId: string,
  leaseEpoch: number,
  initialSources: ReductionSourceItem[],
  options?: HierarchicalReductionOptions,
): Promise<SynthesizerResult> {
  if (initialSources.length === 0) {
    throw new Error("HIERARCHICAL_REDUCTION_EMPTY_SOURCES: At least one succeeded source is required.");
  }

  const effectiveBudget = options?.tokenBudget ?? getGovernedReductionWindowTokenBudget();

  let currentLevelSources = initialSources;
  let currentLevel = 1;
  let totalWindowsCount = 0;
  let lastOutputSummary: ModelContextAnalysisV2 | null = null;
  let lastWindowId = "";
  let lastOutputSha256 = "";

  while (true) {
    const nextLevelSources: ReductionSourceItem[] = [];
    const chunks = chunkSourcesByTokenBudget(currentLevelSources, effectiveBudget);

    let ordinal = 1;
    for (const chunk of chunks) {
      const inputSetSha256 = mapperSha256({
        traversal_authority_sha256: traversalAuthoritySha256,
        reduction_level: currentLevel,
        reduction_ordinal: ordinal,
        input_sha256s: chunk.map(c => c.sourceOutputSha256),
      });

      let analysis: ModelContextAnalysisV2;
      let inputTokens: number;
      let outputTokens: number;
      let outputSha256: string;

      if (options?.reductionAdapter) {
        const childItems: ChildAnalysisInputItem[] = chunk.map(c => ({
          sourceId: c.sourceId,
          sourceType: c.sourceType,
          sourceOutputSha256: c.sourceOutputSha256,
          payload: c.payload as ModelContextAnalysisV2,
        }));

        const synthesized = await options.reductionAdapter.synthesizeReductionWindow(
          {
            traversalId,
            traversalAuthoritySha256,
            reductionLevel: currentLevel,
            reductionOrdinal: ordinal,
            childItems,
          },
          traversalRepo,
          workerId,
          leaseEpoch,
        );
        analysis = synthesized.parentAnalysis;
        inputTokens = synthesized.inputEstimatedTokens;
        outputTokens = synthesized.outputEstimatedTokens;
        outputSha256 = synthesized.parentAnalysisSha256;
      } else {
        const serializedInput = canonicalJson(chunk.map(c => c.payload));
        inputTokens = estimatedTokensForUtf8(serializedInput);
        analysis = mergeAnalysisPayloads(chunk.map(c => c.payload));
        outputTokens = estimatedTokensForUtf8(canonicalJson(analysis));
        outputSha256 = mapperSha256(analysis);
      }

      const windowId = randomUUID();

      // Persist reduction window atomically with lease fencing and separate input/output tokens
      await traversalRepo.insertReductionWindow({
        id: windowId,
        traversalId,
        traversalAuthoritySha256,
        reductionLevel: currentLevel,
        reductionOrdinal: ordinal,
        inputSetSha256,
        inputItemCount: chunk.length,
        inputEstimatedTokens: inputTokens,
        outputEstimatedTokens: outputTokens,
        tokenCount: outputTokens,
        status: "SUCCEEDED",
        outputSha256,
        outputSummary: analysis,
        workerId,
        leaseEpoch,
      });

      totalWindowsCount++;

      // Persist normalized reduction inputs with cryptographic lineage
      const inputInserts = chunk.map((item, idx) => ({
        id: randomUUID(),
        reductionWindowId: windowId,
        traversalId,
        inputOrdinal: idx + 1,
        sourceMappingWindowId: item.sourceType === "MAPPING_WINDOW" ? item.sourceId : undefined,
        sourceReductionWindowId: item.sourceType === "REDUCTION_WINDOW" ? item.sourceId : undefined,
        sourceOutputSha256: item.sourceOutputSha256,
      }));

      await traversalRepo.insertReductionInputs(inputInserts, workerId, leaseEpoch);

      nextLevelSources.push({
        sourceType: "REDUCTION_WINDOW",
        sourceId: windowId,
        sourceOutputSha256: outputSha256,
        reductionLevel: currentLevel,
        payload: analysis,
      });

      lastOutputSummary = analysis;
      lastWindowId = windowId;
      lastOutputSha256 = outputSha256;
      ordinal++;
    }

    if (nextLevelSources.length <= 1) {
      // Reached single root synthesis window
      break;
    }

    currentLevelSources = nextLevelSources;
    currentLevel++;
  }

  if (!lastOutputSummary || !lastWindowId) {
    throw new Error("HIERARCHICAL_REDUCTION_FAILED: Root synthesis was not produced.");
  }

  return {
    totalReductionLevels: currentLevel,
    totalReductionWindows: totalWindowsCount,
    rootReductionWindowId: lastWindowId,
    rootOutputSha256: lastOutputSha256,
    finalAnalysis: lastOutputSummary,
  };
}
