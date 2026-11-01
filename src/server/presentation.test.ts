import { describe, expect, it } from "vitest";
import { createBlankContractInput, synchronizeLegacyWorkspaceProjection, type WorkspaceReference } from "@/core/tasks/task-input";
import { projectTaskSetup, projectWorkspaceRegistration } from "@/server/presentation";
import type { WorkspaceRegistration } from "@/server/workspace-connector";

const workspace: WorkspaceReference = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Example Server",
  role: "primary",
  referenceType: "LOCAL_PATH",
  source: "WINDOWS_NATIVE_SELECTOR",
  reference: "E:\\Sample Control Platform workspace\\control-server",
  repositoryIdentity: "E:\\Sample Control Platform workspace\\control-server",
  branch: "main",
  commitSha: "1234567890abcdef",
  fingerprint: "sha256:path-identity",
  provenance: JSON.stringify({ gitDiagnostics: [{ command: "git status" }] }),
  discoveryScopeMode: "FULL_WORKSPACE",
  allowedPaths: [],
  excludedPaths: [],
  authorizationContext: "owner-selected local Workspace",
  ordering: 0,
};

describe("owner-facing Backend presentation projections", () => {
  it("projects only decision-relevant setup state", () => {
    const draft = synchronizeLegacyWorkspaceProjection({
      ...createBlankContractInput("CONTROLLED_AUDIT"),
      title: "Update channel version 1.5.3",
      objective: "Update channel version 1.5.3",
      workspaces: [workspace],
    });
    const view = projectTaskSetup(draft);
    expect(view).toEqual({
      title: "Update channel version 1.5.3",
      taskMode: "CONTROLLED_AUDIT",
      workspaces: [{
        id: workspace.id,
        displayName: "Example Server",
        role: "primary",
        discoveryScopeMode: "FULL_WORKSPACE",
        effectiveReadBoundary: "WORKSPACE_ROOT",
        selectedPathCount: 0,
        excludedPathCount: 0,
        requiresOwnerAction: false,
      }],
      readableWorkspaceCount: 1,
      selectedPathCount: 0,
      supportingEvidenceCount: 0,
    });
    expect(JSON.stringify(view)).not.toContain("fingerprint");
    expect(JSON.stringify(view)).not.toContain("provenance");
    expect(JSON.stringify(view)).not.toContain("repositoryIdentity");
    expect(JSON.stringify(view)).not.toContain("gitDiagnostics");
    expect(JSON.stringify(view)).not.toContain(workspace.reference);
  });

  it("returns a controlled-audit Workspace with full read discovery as the Backend default", () => {
    const registration: WorkspaceRegistration = {
      id: workspace.id,
      revision: 0,
      displayName: workspace.displayName,
      role: workspace.role,
      referenceType: "LOCAL_PATH",
      source: "WINDOWS_NATIVE_SELECTOR",
      reference: workspace.reference,
      normalizedReference: workspace.reference,
      verificationStatus: "VERIFIED",
      verificationMethod: "WINDOWS_FOLDER_BROWSER_DIALOG_V1",
      verifiedAt: "2026-07-26T00:00:00.000Z",
      verificationAuthority: "BACKEND",
      fingerprint: workspace.fingerprint,
      provenance: { internalDiagnostic: "not owner-facing" },
      authorizationContext: workspace.authorizationContext,
    };
    const result = projectWorkspaceRegistration(registration, "CONTROLLED_AUDIT");
    expect(result.ownerView.discoveryScopeMode).toBe("FULL_WORKSPACE");
    expect(result.ownerView.effectiveReadBoundary).toBe("WORKSPACE_ROOT");
    expect(result.ownerView.requiresOwnerAction).toBe(false);
    expect(JSON.stringify(result)).not.toContain("internalDiagnostic");
    expect(JSON.stringify(result.workspace)).not.toContain("repositoryIdentity");
    expect(JSON.stringify(result.workspace)).not.toContain("commitSha");
    expect(JSON.stringify(result.workspace)).not.toContain("provenance");
  });
});
