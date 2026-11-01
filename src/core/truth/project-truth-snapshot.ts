import { projectTruthSnapshotHash, type ProjectTruthSnapshotHashEntry } from "@/core/truth/project-truth-hash";
import type { ProjectFactStatus } from "@/core/truth/project-fact-types";

export type SnapshotFactCandidate = ProjectTruthSnapshotHashEntry & {
  revisionStatus: ProjectFactStatus;
  validFrom: string;
  validUntil?: string;
  supersedesRevisionId?: string;
};

export type FrozenProjectTruthSnapshot = {
  projectContextId: string;
  snapshotVersion: string;
  effectiveAt: string;
  selectedFactRevisionIds: string[];
  facts: ProjectTruthSnapshotHashEntry[];
  contentSha256: string;
};

export class ProjectTruthSnapshotError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function parsedTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProjectTruthSnapshotError("INVALID_SNAPSHOT_TIME", `${label} must be a valid timestamp.`);
  }
  return parsed;
}

function isEffectiveAt(candidate: SnapshotFactCandidate, effectiveAt: number): boolean {
  const validFrom = parsedTimestamp(candidate.validFrom, "fact validFrom");
  const validUntil = candidate.validUntil
    ? parsedTimestamp(candidate.validUntil, "fact validUntil")
    : undefined;
  return validFrom <= effectiveAt && (validUntil === undefined || effectiveAt < validUntil);
}

function compareCandidate(left: SnapshotFactCandidate, right: SnapshotFactCandidate): number {
  if (left.factKey !== right.factKey) return left.factKey < right.factKey ? -1 : 1;
  if (left.projectFactRevisionId === right.projectFactRevisionId) return 0;
  return left.projectFactRevisionId < right.projectFactRevisionId ? -1 : 1;
}

function effectiveOwnerApprovedCandidates(
  candidates: SnapshotFactCandidate[],
  effectiveAt: number,
): SnapshotFactCandidate[] {
  const byFact = new Map<string, SnapshotFactCandidate[]>();
  for (const candidate of candidates) {
    const rows = byFact.get(candidate.projectFactId) ?? [];
    rows.push(candidate);
    byFact.set(candidate.projectFactId, rows);
  }

  const selected: SnapshotFactCandidate[] = [];
  for (const [projectFactId, revisions] of byFact) {
    const eligible = revisions.filter(candidate => {
      if (candidate.revisionStatus !== "OWNER_APPROVED" || !isEffectiveAt(candidate, effectiveAt)) {
        return false;
      }
      return !revisions.some(revision =>
        revision.supersedesRevisionId === candidate.projectFactRevisionId
        && parsedTimestamp(revision.validFrom, "superseding revision validFrom") <= effectiveAt,
      );
    });

    if (eligible.length > 1) {
      throw new ProjectTruthSnapshotError(
        "AMBIGUOUS_EFFECTIVE_PROJECT_FACT",
        `Project Fact ${projectFactId} has more than one owner-approved revision effective at the snapshot time.`,
      );
    }
    if (eligible[0]) selected.push(eligible[0]);
  }
  return selected.sort(compareCandidate);
}

export function freezeProjectTruthSnapshot(input: {
  projectContextId: string;
  snapshotVersion: string;
  effectiveAt: string;
  candidates: SnapshotFactCandidate[];
  requestedFactRevisionIds?: string[];
}): FrozenProjectTruthSnapshot {
  const snapshotTime = parsedTimestamp(input.effectiveAt, "effectiveAt");
  const requested = input.requestedFactRevisionIds
    ? new Set(input.requestedFactRevisionIds)
    : undefined;
  if (requested && requested.size !== input.requestedFactRevisionIds?.length) {
    throw new ProjectTruthSnapshotError(
      "DUPLICATE_SNAPSHOT_FACT_REVISION",
      "A truth snapshot cannot contain duplicate fact revision IDs.",
    );
  }

  const effective = effectiveOwnerApprovedCandidates(input.candidates, snapshotTime);
  const selected = requested
    ? effective.filter(candidate => requested.has(candidate.projectFactRevisionId))
    : effective;

  if (requested) {
    const selectedIds = new Set(selected.map(candidate => candidate.projectFactRevisionId));
    const missing = [...requested].filter(id => !selectedIds.has(id));
    if (missing.length) {
      throw new ProjectTruthSnapshotError(
        "SNAPSHOT_FACT_NOT_EFFECTIVE_OWNER_APPROVED",
        `Every selected fact must be the effective owner-approved revision at the snapshot time. Rejected IDs: ${missing.join(", ")}.`,
      );
    }
  }
  if (!selected.length) {
    throw new ProjectTruthSnapshotError(
      "SNAPSHOT_REQUIRES_EFFECTIVE_APPROVED_FACT",
      "A Project Truth snapshot requires at least one owner-approved fact effective at the snapshot time.",
    );
  }

  const facts: ProjectTruthSnapshotHashEntry[] = selected.map(candidate => ({
    factKey: candidate.factKey,
    factType: candidate.factType,
    projectFactId: candidate.projectFactId,
    projectFactRevisionId: candidate.projectFactRevisionId,
    revision: candidate.revision,
    contentSha256: candidate.contentSha256,
  }));
  const contentSha256 = projectTruthSnapshotHash({
    schemaVersion: "project-truth-snapshot/v1",
    projectContextId: input.projectContextId,
    snapshotVersion: input.snapshotVersion,
    effectiveAt: input.effectiveAt,
    facts,
  });
  return {
    projectContextId: input.projectContextId,
    snapshotVersion: input.snapshotVersion,
    effectiveAt: input.effectiveAt,
    selectedFactRevisionIds: facts.map(fact => fact.projectFactRevisionId),
    facts,
    contentSha256,
  };
}
