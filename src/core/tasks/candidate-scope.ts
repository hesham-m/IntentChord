import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import type {
  MappingInputEntry,
  ModelProposedContextCatalogV1,
  OwnerContextDecisionView,
} from "@/core/ai-context-mapper/types";
import { localRelativePathKey } from "@/core/workspace-index/local-path-semantics";
import { candidateScopeIdentityMatches } from "@/core/tasks/task-input";
import type {
  CandidateScopeIdentity,
  LegacyTaskCandidateScope,
  LegacyTaskCandidateScopeEntry,
  TaskCandidateScope,
  TaskContextAnalysisBinding,
  TaskDraftInput,
  TaskScopeConfirmation,
  WorkspaceScopedPath,
} from "@/core/tasks/task-input";

export class TaskContextBindingError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "TaskContextBindingError";
    this.code = code;
    this.details = details;
  }
}

export function validateStaleContextAnalysisBinding(input: {
  binding: TaskContextAnalysisBinding;
  currentWorkspaceIndexSnapshotId: string;
  currentMappingRunId: string;
  currentProposalId: string;
  currentProposalSha256: string;
}): void {
  const { binding, currentWorkspaceIndexSnapshotId, currentMappingRunId, currentProposalId, currentProposalSha256 } = input;
  if (binding.workspaceIndexSnapshotId !== currentWorkspaceIndexSnapshotId) {
    throw new TaskContextBindingError(
      "STALE_WORKSPACE_INDEX_SNAPSHOT_BINDING",
      `Task context binding workspaceIndexSnapshotId ${binding.workspaceIndexSnapshotId} does not match current snapshot ${currentWorkspaceIndexSnapshotId}.`,
    );
  }
  if (binding.mappingRunId !== currentMappingRunId) {
    throw new TaskContextBindingError(
      "STALE_MAPPING_RUN_BINDING",
      `Task context binding mappingRunId ${binding.mappingRunId} does not match current mapping run ${currentMappingRunId}.`,
    );
  }
  if (binding.proposalId !== currentProposalId) {
    throw new TaskContextBindingError(
      "STALE_PROPOSAL_BINDING",
      `Task context binding proposalId ${binding.proposalId} does not match current proposal ${currentProposalId}.`,
    );
  }
  if (binding.proposalSha256 !== currentProposalSha256) {
    throw new TaskContextBindingError(
      "STALE_PROPOSAL_SHA_BINDING",
      `Task context binding proposalSha256 ${binding.proposalSha256} does not match current proposal SHA ${currentProposalSha256}.`,
    );
  }
}

export function resolveCandidateScopeFromMappingInput(input: {
  binding: TaskContextAnalysisBinding;
  workspaceIndexSnapshotId: string;
  mappingRunId: string;
  proposalId: string;
  proposalSha256: string;
  ownerVerdictState: "PENDING" | "ACCEPTED" | "REJECTED";
  catalog: ModelProposedContextCatalogV1;
  ownerContextDecisions: OwnerContextDecisionView[];
  mappingInputEntries: MappingInputEntry[];
  boundWorkspaceIds: string[];
}): LegacyTaskCandidateScope {
  // Check 1 & 2: mapping run tied to requested workspaceIndexSnapshotId
  if (input.binding.workspaceIndexSnapshotId !== input.workspaceIndexSnapshotId) {
    throw new TaskContextBindingError(
      "MAPPING_RUN_WORKSPACE_SNAPSHOT_MISMATCH",
      "Context-analysis binding workspaceIndexSnapshotId does not match current snapshot.",
    );
  }
  if (input.binding.mappingRunId !== input.mappingRunId) {
    throw new TaskContextBindingError(
      "MAPPING_RUN_ID_MISMATCH",
      "Context-analysis binding mappingRunId does not match current mapping run.",
    );
  }

  // Check 3, 4 & 5: validated proposal exists, id matches, sha256 matches
  if (input.binding.proposalId !== input.proposalId) {
    throw new TaskContextBindingError(
      "PROPOSAL_ID_MISMATCH",
      "Context-analysis binding proposalId does not match current proposal.",
    );
  }
  if (input.binding.proposalSha256 !== input.proposalSha256) {
    throw new TaskContextBindingError(
      "PROPOSAL_SHA_MISMATCH",
      "Context-analysis binding proposalSha256 does not match current proposal hash.",
    );
  }

  // Check 6: Owner review has reached the valid accepted state
  if (input.ownerVerdictState !== "ACCEPTED") {
    throw new TaskContextBindingError(
      "OWNER_REVIEW_NOT_ACCEPTED",
      `Context-analysis binding requires an ACCEPTED owner review state, found: ${input.ownerVerdictState}.`,
    );
  }

  const decisionsById = new Map(input.ownerContextDecisions.map(d => [d.id, d]));
  const contextsById = new Map(input.catalog.contexts.map(c => [c.context_id, c]));
  const entriesById = new Map(input.mappingInputEntries.map(e => [e.entry_id, e]));
  // Check 6.5: Reject duplicate decision IDs fail-closed
  const uniqueDecisionIds = Array.from(new Set(input.binding.acceptedContextDecisionIds));
  if (uniqueDecisionIds.length !== input.binding.acceptedContextDecisionIds.length) {
    throw new TaskContextBindingError(
      "DUPLICATE_ACCEPTED_DECISION_IDS",
      "Context-analysis binding acceptedContextDecisionIds contains duplicate decision IDs.",
    );
  }

  const boundWorkspaceIdSet = new Set(input.boundWorkspaceIds);
  const candidateEntries: LegacyTaskCandidateScopeEntry[] = [];
  const seenScopeKeys = new Set<string>();

  for (const decisionId of input.binding.acceptedContextDecisionIds) {
    // Check 7: decision exists
    const decision = decisionsById.get(decisionId);
    if (!decision) {
      throw new TaskContextBindingError(
        "ACCEPTED_DECISION_NOT_FOUND",
        `Accepted context decision ${decisionId} was not found in mapping run decisions.`,
      );
    }

    // Check 8: belongs to exact mapping run
    if (decision.runId && decision.runId !== input.mappingRunId) {
      throw new TaskContextBindingError(
        "DECISION_MAPPING_RUN_MISMATCH",
        `Decision ${decisionId} belongs to mapping run ${decision.runId}, expected ${input.mappingRunId}.`,
      );
    }

    // Check 9: belongs to exact proposal
    if (decision.proposalId && decision.proposalId !== input.proposalId) {
      throw new TaskContextBindingError(
        "DECISION_PROPOSAL_MISMATCH",
        `Decision ${decisionId} belongs to proposal ${decision.proposalId}, expected ${input.proposalId}.`,
      );
    }

    // Check 10: decision is ACCEPT (rejects REJECT decisions)
    if (decision.decision !== "ACCEPT") {
      throw new TaskContextBindingError(
        "NON_ACCEPTED_DECISION_IN_BINDING",
        `Decision ${decisionId} has state ${decision.decision}, but only ACCEPT decisions may enter context binding.`,
      );
    }

    // Check 11: context_id exists in proposal
    const context = contextsById.get(decision.contextId);
    if (!context) {
      throw new TaskContextBindingError(
        "CONTEXT_NOT_IN_PROPOSAL",
        `Decision context_id ${decision.contextId} does not exist in the proposal.`,
      );
    }

    // Check 12: context_sha256 matches exact context object
    const computedContextSha = mapperSha256(context);
    if (decision.contextSha256 && decision.contextSha256 !== computedContextSha) {
      throw new TaskContextBindingError(
        "CONTEXT_SHA_MISMATCH",
        `Decision context_sha256 ${decision.contextSha256} does not match computed context hash ${computedContextSha}.`,
      );
    }

    // Process evidence entries
    for (const evidenceEntryId of context.evidence_entry_ids) {
      // Check 13: evidence entry exists in mapping input entries
      const entry = entriesById.get(evidenceEntryId);
      if (!entry) {
        throw new TaskContextBindingError(
          "EVIDENCE_ENTRY_NOT_FOUND",
          `Context ${context.context_id} references evidence_entry_id ${evidenceEntryId} which is missing from mapping input entries.`,
        );
      }

      // Check 14: belongs to a Workspace bound to the Task
      // Defect 8 fix: NEVER infer workspace ID. Use only the authoritative MappingInputEntry.workspace_id.
      const entryWorkspaceId = entry.workspace_id;
      if (!entryWorkspaceId) {
        throw new TaskContextBindingError(
          "EVIDENCE_WORKSPACE_IDENTITY_MISSING",
          `Evidence entry ${evidenceEntryId} has no authoritative workspace_id. The governed Mapper Input contract requires Workspace identity.`,
        );
      }
      if (!boundWorkspaceIdSet.has(entryWorkspaceId)) {
        throw new TaskContextBindingError(
          "EVIDENCE_WORKSPACE_UNBOUND",
          `Evidence entry ${evidenceEntryId} belongs to workspace ${entryWorkspaceId} which is not bound to the Task.`,
        );
      }

      // Check 15: normalized_path is reused from the governed MappingInputEntry (never trust model-generated path)
      const normalizedPath = entry.normalized_path.replaceAll("\\", "/").replace(/^\.\//, "");
      const scopeKey = `${entryWorkspaceId}:${localRelativePathKey(normalizedPath)}`;

      if (!seenScopeKeys.has(scopeKey)) {
        seenScopeKeys.add(scopeKey);
        candidateEntries.push({
          workspaceId: entryWorkspaceId,
          normalizedPath,
          contextId: context.context_id,
          evidenceEntryId: entry.entry_id,
        });
      }
    }
  }

  // Check 16: duplicates are canonicalized deterministically
  candidateEntries.sort((a, b) => {
    const wsCmp = a.workspaceId.localeCompare(b.workspaceId);
    if (wsCmp !== 0) return wsCmp;
    return a.normalizedPath.localeCompare(b.normalizedPath);
  });

  const candidateAllowedPaths: WorkspaceScopedPath[] = [];
  const seenPaths = new Set<string>();
  for (const entry of candidateEntries) {
    const key = `${entry.workspaceId}:${localRelativePathKey(entry.normalizedPath)}`;
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      candidateAllowedPaths.push({ workspaceId: entry.workspaceId, path: entry.normalizedPath });
    }
  }

  // Deterministically sort accepted decision IDs to ensure order-independent hashing
  const sortedDecisionIds = [...input.binding.acceptedContextDecisionIds].sort();
  const acceptedContextDecisionIdsSha256 = mapperSha256(sortedDecisionIds);
  const candidateScopeSha256 = mapperSha256(candidateAllowedPaths);

  return {
    workspaceIndexSnapshotId: input.binding.workspaceIndexSnapshotId,
    mappingRunId: input.binding.mappingRunId,
    proposalId: input.binding.proposalId,
    proposalSha256: input.binding.proposalSha256,
    acceptedContextDecisionIdsSha256,
    candidateScopeSha256,
    entries: candidateEntries,
    candidateAllowedPaths,
  };
}

/**
 * Backend-authoritative Owner Scope Confirmation.
 *
 * This function validates that:
 * 1. The confirmation is bound to the exact current candidate scope identity (all 6 cryptographic fields).
 * 2. Every confirmed allowed path exists within the authoritative candidate scope (no expansion).
 * 3. Workspace allowedPaths are rebuilt deterministically from confirmed candidate entries.
 * 4. Top-level allowedPaths/excludedPaths are synchronized from workspace truth.
 */
export function applyOwnerScopeConfirmation(
  draft: TaskDraftInput,
  confirmation: TaskScopeConfirmation,
  authoritativeCandidateScope: TaskCandidateScope,
): TaskDraftInput {
  // Validate confirmation is bound to exact candidate scope identity (including Owner selection & scope hash)
  const ci = confirmation.candidateIdentity;
  if (!candidateScopeIdentityMatches(ci, authoritativeCandidateScope)) {
    throw new TaskContextBindingError(
      "SCOPE_CONFIRMATION_IDENTITY_MISMATCH",
      "Owner Scope Confirmation candidate identity does not match the current authoritative Candidate Scope.",
    );
  }

  // Build a lookup of candidate scope entries by workspace-scoped key
  const candidateScopeKeys = new Set(
    authoritativeCandidateScope.candidateAllowedPaths.map(
      p => `${p.workspaceId}:${localRelativePathKey(p.path)}`,
    ),
  );

  // Defect 2: Every confirmed allowed path must exist in candidate scope
  for (const confirmed of confirmation.confirmedAllowedPaths) {
    const key = `${confirmed.workspaceId}:${localRelativePathKey(confirmed.path)}`;
    if (!candidateScopeKeys.has(key)) {
      throw new TaskContextBindingError(
        "CONFIRMED_PATH_NOT_IN_CANDIDATE_SCOPE",
        `Confirmed allowed path ${confirmed.workspaceId}:${confirmed.path} is not present in the authoritative Candidate Scope. Scope expansion requires a separate mechanism.`,
      );
    }
  }

  // Ensure no overlap between confirmed allowed and excluded
  const confirmedAllowedKeys = new Set(
    confirmation.confirmedAllowedPaths.map(p => `${p.workspaceId}:${localRelativePathKey(p.path)}`),
  );
  for (const excluded of confirmation.confirmedExcludedPaths) {
    const key = `${excluded.workspaceId}:${localRelativePathKey(excluded.path)}`;
    if (confirmedAllowedKeys.has(key)) {
      throw new TaskContextBindingError(
        "SCOPE_CONFIRMATION_OVERLAP",
        `Path ${excluded.workspaceId}:${excluded.path} cannot be both allowed and excluded in scope confirmation.`,
      );
    }
  }

  // Defect 4: Rebuild workspace allowedPaths deterministically from confirmed candidate entries
  const confirmedByWorkspace = new Map<string, string[]>();
  const excludedByWorkspace = new Map<string, string[]>();
  for (const path of confirmation.confirmedAllowedPaths) {
    const existing = confirmedByWorkspace.get(path.workspaceId) ?? [];
    existing.push(path.path);
    confirmedByWorkspace.set(path.workspaceId, existing);
  }
  for (const path of confirmation.confirmedExcludedPaths) {
    const existing = excludedByWorkspace.get(path.workspaceId) ?? [];
    existing.push(path.path);
    excludedByWorkspace.set(path.workspaceId, existing);
  }

  const updatedWorkspaces = draft.workspaces.map(ws => {
    const wsConfirmedPaths = confirmedByWorkspace.get(ws.id) ?? [];
    const wsExcludedPaths = excludedByWorkspace.get(ws.id) ?? [];
    return {
      ...ws,
      allowedPaths: wsConfirmedPaths.sort(),
      excludedPaths: Array.from(new Set([...ws.excludedPaths, ...wsExcludedPaths])).sort(),
      discoveryScopeMode: (wsConfirmedPaths.length > 0 ? "SELECTED_PATHS" : "NONE") as typeof ws.discoveryScopeMode,
    };
  });

  return {
    ...draft,
    workspaces: updatedWorkspaces,
    allowedPaths: confirmation.confirmedAllowedPaths.map(p => `${p.workspaceId}:${p.path}`),
    excludedPaths: confirmation.confirmedExcludedPaths.map(p => `${p.workspaceId}:${p.path}`),
    scopeConfirmation: confirmation,
  };
}
