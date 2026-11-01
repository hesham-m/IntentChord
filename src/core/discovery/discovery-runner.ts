import { createHash } from "node:crypto";
import {
  buildDiscoveryAssessment,
  normalizeDiscoveryItems,
} from "@/core/discovery/discovery-map";
import {
  discoveryItemSchema,
  type DiscoveryAssessment,
  type DiscoveryItem,
} from "@/core/discovery/discovery-schema";
import {
  LocalBoundedDiscoveryTools,
  type DiscoveryWorkspaceBoundary,
} from "@/core/discovery/discovery-tools";
import type { IntentResolution } from "@/core/intelligence/intent-schema";
import { terminalRuntimeGovernanceCode } from "@/core/workspace-index/adapters/filesystem-errors";

export type BoundedDiscoveryInput = {
  taskId: string;
  intentResolutionId: string;
  authorityFingerprint: string;
  intent: IntentResolution;
  workspaces: DiscoveryWorkspaceBoundary[];
  /** Runtime governance only; intentionally excluded from deterministic discovery input identity. */
  signal?: AbortSignal;
  deadlineAt?: number;
};

export type BoundedDiscoveryResult = {
  items: DiscoveryItem[];
  assessment: DiscoveryAssessment;
  evidenceGaps: string[];
  inputSha256: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function significantWords(value: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "of", "to", "for", "from", "in", "on", "is", "are", "be", "with",
    "across", "whether", "every", "which", "what", "how", "where", "identify", "determine", "assess", "trace",
    "حدد", "هل", "كيف", "أين", "ما", "عبر", "كل", "من", "في", "إلى", "على", "أو", "و", "التي", "الذي",
  ]);
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map(word => word.trim())
    .filter(word => word.length >= 3 && !stop.has(word));
}

function requirementConcepts(intent: IntentResolution, requirementId: string, outcome: string): string[] {
  const preserved = intent.preservedLiterals;
  const topicWords = significantWords(intent.normalizedTopic);
  const outcomeWords = significantWords(outcome);
  const questionWords = intent.investigationQuestions
    .filter(question => question.id.replace(/^Q-/, "REQ-") === requirementId)
    .flatMap(question => significantWords(question.question));
  return [...new Set([
    intent.normalizedTopic,
    ...intent.expectedConcepts,
    ...preserved,
    ...topicWords,
    ...outcomeWords,
    ...questionWords,
  ])].slice(0, 60);
}

export function boundedDiscoveryInputSha256(input: BoundedDiscoveryInput): string {
  return createHash("sha256").update(canonical({
    taskId: input.taskId,
    intentResolutionId: input.intentResolutionId,
    authorityFingerprint: input.authorityFingerprint,
    intentSha: createHash("sha256").update(canonical(input.intent)).digest("hex"),
    workspaces: input.workspaces.map(workspace => ({
      id: workspace.id,
      displayName: workspace.displayName,
      rootReference: workspace.rootReference,
      authorizedRootRealPath: workspace.authorizedRootRealPath,
      authorizedRootObjectIdentity: workspace.authorizedRootObjectIdentity,
      discoveryScopeMode: workspace.discoveryScopeMode,
      allowedPaths: workspace.allowedPaths,
      excludedPaths: workspace.excludedPaths,
    })),
  })).digest("hex");
}


export async function runDeterministicBoundedDiscovery(
  input: BoundedDiscoveryInput,
  tools?: LocalBoundedDiscoveryTools,
): Promise<BoundedDiscoveryResult> {
  const activeTools = tools ?? new LocalBoundedDiscoveryTools();
  const ownsTools = !tools;
  const items: DiscoveryItem[] = [];
  const evidenceGaps: string[] = [];
  const readableWorkspaces = input.workspaces.filter(workspace => workspace.discoveryScopeMode !== "NONE");

  try {
  for (const requirement of input.intent.proposedRequirements) {
    const concepts = requirementConcepts(input.intent, requirement.id, requirement.outcome);
    let requirementHitCount = 0;
    for (const workspace of readableWorkspaces) {
      let hits;
      try {
        hits = await activeTools.searchWorkspaceText(workspace, concepts, { signal: input.signal, deadlineAt: input.deadlineAt });
      } catch (error) {
        // Abort/deadline are operation-governance terminal conditions, not semantic evidence gaps.
        // Re-throw them so the Discovery Run fails boundedly instead of continuing after cancellation.
        if (terminalRuntimeGovernanceCode(error)) throw error;
        evidenceGaps.push(`${requirement.id}: ${workspace.displayName}: ${error instanceof Error ? error.message : "DISCOVERY_TOOL_FAILURE"}`);
        continue;
      }
      for (const hit of hits.slice(0, 40)) {
        requirementHitCount += 1;
        items.push(discoveryItemSchema.parse({
          workspaceId: workspace.id,
          relativePath: hit.relativePath,
          ...(hit.lineStart ? { lineStart: hit.lineStart, lineEnd: hit.lineEnd } : {}),
          contentSha256: hit.contentSha256,
          requirementIds: [requirement.id],
          relevanceReason: `Matched the approved ${requirement.id} investigation vocabulary: ${hit.matchedConcepts.join(", ")}.`,
          matchedConcepts: hit.matchedConcepts,
          matchScore: hit.score,
          state: "INSPECTED",
        }));
      }
    }
    if (!requirementHitCount) {
      evidenceGaps.push(`${requirement.id}: no relevant source candidate was discovered inside the approved read boundaries.`);
    }
  }

  const normalizedItems = normalizeDiscoveryItems(items).slice(0, 500);
  const assessment = buildDiscoveryAssessment({
    items: normalizedItems,
    workspaceIds: input.workspaces.map(workspace => workspace.id),
    requirementIds: input.intent.proposedRequirements.map(requirement => requirement.id),
  });
  return {
    items: normalizedItems,
    assessment,
    evidenceGaps: [...new Set(evidenceGaps)],
    inputSha256: boundedDiscoveryInputSha256(input),
  };
  } finally {
    if (ownsTools) await activeTools.close();
  }
}
