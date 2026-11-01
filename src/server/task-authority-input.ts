import { createHash } from "node:crypto";
import type { TaskDraftInput, WorkspaceScopedPath } from "@/core/tasks/task-input";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function scopedPaths(paths: WorkspaceScopedPath[] | undefined) {
  return [...(paths ?? [])]
    .map(item => ({ workspaceId: item.workspaceId, path: item.path.replaceAll("\\", "/").replace(/^\.\//, "") }))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.path.localeCompare(b.path));
}

/**
 * Exact Task inputs proven by the current Contract/Run path to affect execution authority.
 * Presentation-only title metadata and intentionally-late execution platform/model selection are
 * excluded. Execution setup is separately frozen by Contract/Run provenance after Scope freeze.
 */
export function taskAuthorityInputMaterialV1(
  draft: TaskDraftInput,
  confirmationOverride?: { confirmedAllowedPaths: WorkspaceScopedPath[]; confirmedExcludedPaths: WorkspaceScopedPath[] },
) {
  const confirmation = confirmationOverride ?? draft.scopeConfirmation;
  return {
    schema: "intentchord.task-authority-input.v1",
    orchestrationVersion: draft.orchestrationVersion ?? null,
    objective: draft.objective,
    ownerRequirements: [...draft.ownerRequirements].sort((a, b) => a.id.localeCompare(b.id)),
    taskContext: draft.taskContext ?? { kind: "INDEPENDENT" },
    taskMode: draft.taskMode,
    workspaces: [...draft.workspaces]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(workspace => ({
        id: workspace.id,
        role: workspace.role,
        referenceType: workspace.referenceType,
        source: workspace.source,
        reference: workspace.reference,
        repositoryIdentity: workspace.repositoryIdentity ?? null,
        branch: workspace.branch ?? null,
        commitSha: workspace.commitSha ?? null,
        fingerprint: workspace.fingerprint,
        discoveryScopeMode: workspace.discoveryScopeMode,
        allowedPaths: [...workspace.allowedPaths].sort(),
        excludedPaths: [...workspace.excludedPaths].sort(),
        authorizationContext: workspace.authorizationContext,
        ordering: workspace.ordering,
      })),
    evidenceFiles: [...draft.evidenceFiles].sort(),
    evidenceIdentity: draft.identity,
    authorization: {
      readFiles: draft.readFiles,
      modifySource: draft.modifySource,
      runStaticValidation: draft.runStaticValidation,
      runTests: draft.runTests,
      build: draft.build,
      deploy: draft.deploy,
      restartServices: draft.restartServices,
      writeDatabase: draft.writeDatabase,
      changeEnvironment: draft.changeEnvironment,
      useNetwork: draft.useNetwork,
    },
    contextAssemblyBinding: draft.contextAssemblyBinding ?? null,
    candidateScope: draft.candidateScope ?? null,
    confirmedAllowedPaths: scopedPaths(confirmation?.confirmedAllowedPaths),
    confirmedExcludedPaths: scopedPaths(confirmation?.confirmedExcludedPaths),
  };
}

export function taskAuthorityInputSha256V1(
  draft: TaskDraftInput,
  confirmationOverride?: { confirmedAllowedPaths: WorkspaceScopedPath[]; confirmedExcludedPaths: WorkspaceScopedPath[] },
): string {
  return sha256(taskAuthorityInputMaterialV1(draft, confirmationOverride));
}

export const TASK_AUTHORITY_INPUT_V1_PRESENTATION_ONLY_FIELDS = ["title", "titleManuallyEdited"] as const;
export const TASK_AUTHORITY_INPUT_V1_LATE_EXECUTION_FIELDS = [
  "executionSetup",
  "providerId",
  "modelId",
  "executionChannelId",
  "reasoningProfile",
  "runtimeProfileId",
  "modelOverrideAccepted",
  "modelOverrideReason",
] as const;
