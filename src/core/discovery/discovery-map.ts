import { createHash } from "node:crypto";
import { localRelativePathKey } from "@/core/workspace-index/local-path-semantics";
import {
  discoveryAssessmentSchema,
  discoveryItemSchema,
  type DiscoveryAssessment,
  type DiscoveryItem,
} from "@/core/discovery/discovery-schema";

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

export function discoveryOutputSha256(input: {
  items: DiscoveryItem[];
  assessment: DiscoveryAssessment;
  findingCount: number;
  evidenceGaps: string[];
}): string {
  return createHash("sha256").update(canonical({
    assessment: input.assessment,
    findingCount: input.findingCount,
    evidenceGaps: [...new Set(input.evidenceGaps)].sort(),
    items: normalizeDiscoveryItems(input.items),
  })).digest("hex");
}

export function normalizeDiscoveryItems(items: DiscoveryItem[]): DiscoveryItem[] {
  const byIdentity = new Map<string, DiscoveryItem>();
  for (const raw of items) {
    const item = discoveryItemSchema.parse(raw);
    const identity = [
      item.workspaceId,
      localRelativePathKey(item.relativePath),
      item.symbol?.toLowerCase() ?? "",
      item.lineStart ?? 0,
      item.lineEnd ?? 0,
      item.contentSha256,
    ].join("|");
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, {
        ...item,
        requirementIds: [...new Set(item.requirementIds)].sort(),
        matchedConcepts: [...new Set(item.matchedConcepts)].sort((left, right) => left.localeCompare(right)),
      });
      continue;
    }
    byIdentity.set(identity, {
      ...(item.matchScore > existing.matchScore ? item : existing),
      requirementIds: [...new Set([...existing.requirementIds, ...item.requirementIds])].sort(),
      matchedConcepts: [...new Set([...existing.matchedConcepts, ...item.matchedConcepts])]
        .sort((left, right) => left.localeCompare(right)),
      matchScore: Math.max(existing.matchScore, item.matchScore),
    });
  }
  return [...byIdentity.values()].sort((left, right) =>
    right.matchScore - left.matchScore
    || left.workspaceId.localeCompare(right.workspaceId)
    || left.relativePath.localeCompare(right.relativePath),
  );
}

export function buildDiscoveryAssessment(input: {
  items: DiscoveryItem[];
  workspaceIds: string[];
  requirementIds: string[];
}): DiscoveryAssessment {
  const items = normalizeDiscoveryItems(input.items);
  const inspected = items.filter(item => item.state === "INSPECTED");
  const activeWorkspaceIds = new Set(items.map(item => item.workspaceId));
  const requirementCoverage = input.requirementIds.map(requirementId => ({
    requirementId,
    discoveredItemCount: items.filter(item => item.requirementIds.includes(requirementId)).length,
  }));
  const crossFileDependency = items.length > 1 ? "YES" as const : "NO" as const;
  const crossWorkspaceDependency = activeWorkspaceIds.size > 1 ? "YES" as const : "NO" as const;

  let complexity: DiscoveryAssessment["complexity"] = "LOW";
  if (crossWorkspaceDependency === "YES" || items.length > 12 || inspected.length > 8) complexity = "HIGH";
  else if (crossFileDependency === "YES" || items.length > 4) complexity = "MEDIUM";

  const reasons = [
    `${items.length} relevant source candidate${items.length === 1 ? "" : "s"} were recorded.`,
    `${inspected.length} candidate${inspected.length === 1 ? " was" : "s were"} inspected with content identity.`,
    crossWorkspaceDependency === "YES"
      ? "Relevant candidates span more than one approved Workspace."
      : "Relevant candidates are confined to one approved Workspace.",
    requirementCoverage.some(item => item.discoveredItemCount === 0)
      ? "At least one mandatory requirement still has no discovered source candidate."
      : "Every mandatory requirement has at least one discovered source candidate.",
  ];

  return discoveryAssessmentSchema.parse({
    assessmentStatus: "ASSESSED",
    complexity,
    crossFileDependency,
    crossWorkspaceDependency,
    workspaceCount: input.workspaceIds.length,
    candidateFileCount: items.length,
    inspectedFileCount: inspected.length,
    requirementCoverage,
    reasons,
  });
}
