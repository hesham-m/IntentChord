import type { ExecutionContract } from "@/core/contracts/execution-contract";
import {
  defaultDiscoveryScopeMode,
  effectiveDiscoveryScopeMode,
  type TaskDraftInput,
  type DiscoveryScopeMode,
  type WorkspaceReference,
} from "@/core/tasks/task-input";
import type { WorkspaceRegistration } from "@/server/workspace-connector";

export type WorkspaceSetupOwnerView = {
  id: string;
  displayName: string;
  role: string;
  discoveryScopeMode: DiscoveryScopeMode;
  effectiveReadBoundary: "WORKSPACE_ROOT" | "SELECTED_PATHS" | "NONE";
  selectedPathCount: number;
  excludedPathCount: number;
  requiresOwnerAction: boolean;
};

export type TaskSetupOwnerView = {
  title: string;
  taskMode: ExecutionContract["taskMode"];
  workspaces: WorkspaceSetupOwnerView[];
  readableWorkspaceCount: number;
  selectedPathCount: number;
  supportingEvidenceCount: number;
};

export function projectWorkspaceSetup(
  workspace: WorkspaceReference,
  taskMode: ExecutionContract["taskMode"],
): WorkspaceSetupOwnerView {
  const discoveryScopeMode = effectiveDiscoveryScopeMode(workspace, taskMode);
  return {
    id: workspace.id,
    displayName: workspace.displayName,
    role: workspace.role,
    discoveryScopeMode,
    effectiveReadBoundary: discoveryScopeMode === "FULL_WORKSPACE"
      ? "WORKSPACE_ROOT"
      : discoveryScopeMode === "SELECTED_PATHS"
        ? "SELECTED_PATHS"
        : "NONE",
    selectedPathCount: workspace.allowedPaths.length,
    excludedPathCount: workspace.excludedPaths.length,
    requiresOwnerAction:
      discoveryScopeMode === "SELECTED_PATHS" && workspace.allowedPaths.length === 0,
  };
}

export function projectTaskSetup(draft: TaskDraftInput): TaskSetupOwnerView {
  const workspaces = (draft.workspaces ?? []).map(workspace => projectWorkspaceSetup(workspace, draft.taskMode));
  return {
    title: draft.title,
    taskMode: draft.taskMode,
    workspaces,
    readableWorkspaceCount: workspaces.filter(workspace => workspace.discoveryScopeMode !== "NONE").length,
    selectedPathCount: workspaces.reduce((total, workspace) => total + workspace.selectedPathCount, 0),
    supportingEvidenceCount: (draft.evidenceFiles ?? []).length,
  };
}

export function projectWorkspaceRegistration(
  registration: WorkspaceRegistration,
  taskMode: ExecutionContract["taskMode"],
) {
  const discoveryScopeMode = defaultDiscoveryScopeMode(taskMode);
  return {
    workspace: {
      id: registration.id,
      displayName: registration.displayName,
      role: registration.role,
      referenceType: registration.referenceType,
      source: registration.source,
      reference: registration.normalizedReference,
      fingerprint: registration.fingerprint,
      discoveryScopeMode,
      allowedPaths: [],
      excludedPaths: [],
      authorizationContext: registration.authorizationContext,
      ordering: 0,
    } satisfies WorkspaceReference,
    ownerView: {
      id: registration.id,
      displayName: registration.displayName,
      role: registration.role,
      discoveryScopeMode,
      effectiveReadBoundary: discoveryScopeMode === "FULL_WORKSPACE"
        ? "WORKSPACE_ROOT" as const
        : discoveryScopeMode === "SELECTED_PATHS"
          ? "SELECTED_PATHS" as const
          : "NONE" as const,
      selectedPathCount: 0,
      excludedPathCount: 0,
      requiresOwnerAction: discoveryScopeMode === "SELECTED_PATHS",
    },
  };
}
