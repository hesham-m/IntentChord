import { describe, expect, it } from "vitest";
import {
  createBlankContractInput,
  generatedTaskTitle,
  synchronizeLegacyWorkspaceProjection,
  transitionTaskMode,
  workspaceDisplayNameFromReference,
  workspaceRootScopePath,
} from "@/core/tasks/task-input";

describe("task input mode defaults", () => {
  it("starts a clean task without demo identifiers or paths", () => {
    const input = createBlankContractInput();
    expect(input.objective).toBe("");
    expect(input.workspaceRef).toBe("");
    expect(input.identity).toBe("");
    expect(input.allowedPaths).toEqual([]);
  });



  it("preserves dotted version numbers in the generated task title", () => {
    expect(generatedTaskTitle("update channel version 1.5.3.")).toBe("update channel version 1.5.3");
    expect(generatedTaskTitle("Review 2.4.10 release. Then verify deployment.")).toBe("Review 2.4.10 release");
  });

  it("derives the editable Workspace display name from the final path segment", () => {
    expect(workspaceDisplayNameFromReference("E:\\Sample Control Platform workspace\\control-server")).toBe("control-server");
    expect(workspaceDisplayNameFromReference("E:\\example-client-root\\ui\\login\\5\\example-client\\")).toBe("example-client");
    expect(workspaceDisplayNameFromReference("/srv/intentchord/client/")).toBe("client");
  });

  it("starts controlled audit in discovery-first read-only mode", () => {
    const input = createBlankContractInput("CONTROLLED_AUDIT");
    expect(input.readFiles).toBe(true);
    expect(input.modifySource).toBe(false);
    expect(input.runStaticValidation).toBe(false);
    expect(input.runTests).toBe(false);
    expect(input.build).toBe(false);
  });

  it("makes the Backend-controlled audit default a full-workspace read boundary", () => {
    const input = synchronizeLegacyWorkspaceProjection({
      ...createBlankContractInput("CONTROLLED_AUDIT"),
      workspaces: [{
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Example Server",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\Sample Control Platform workspace\\control-server",
        fingerprint: "sha256:path",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "owner",
        ordering: 0,
      }],
    });
    expect(input.workspaces[0].discoveryScopeMode).toBe("FULL_WORKSPACE");
    expect(input.allowedPaths).toEqual([
      `11111111-1111-4111-8111-111111111111:${workspaceRootScopePath}`,
    ]);
  });

  it("requires explicit selected paths when changing to source implementation", () => {
    const controlled = synchronizeLegacyWorkspaceProjection({
      ...createBlankContractInput("CONTROLLED_AUDIT"),
      workspaces: [{
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Example Server",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\ExampleWorkspace",
        fingerprint: "sha256:path",
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "owner",
        ordering: 0,
      }],
    });
    const implementation = transitionTaskMode(controlled, "SOURCE_IMPLEMENTATION");
    expect(implementation.workspaces[0].discoveryScopeMode).toBe("SELECTED_PATHS");
    expect(implementation.workspaces[0].allowedPaths).toEqual([]);
  });

  it("never broadens an explicit selected-path boundary when the task mode changes", () => {
    const source = synchronizeLegacyWorkspaceProjection({
      ...createBlankContractInput("SOURCE_IMPLEMENTATION"),
      workspaces: [{
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Example Client",
        role: "primary",
        referenceType: "LOCAL_PATH",
        source: "WINDOWS_NATIVE_SELECTOR",
        reference: "E:\\example-client-root",
        fingerprint: "sha256:path",
        discoveryScopeMode: "SELECTED_PATHS",
        allowedPaths: ["src"],
        excludedPaths: [],
        authorizationContext: "owner",
        ordering: 0,
      }],
    });
    const audit = transitionTaskMode(source, "CONTROLLED_AUDIT");
    expect(audit.workspaces[0].discoveryScopeMode).toBe("SELECTED_PATHS");
    expect(audit.workspaces[0].allowedPaths).toEqual(["src"]);
  });

  it("reconciles incompatible requests immediately when the task mode changes", () => {
    const input = createBlankContractInput("SOURCE_IMPLEMENTATION");
    const next = transitionTaskMode(input, "REPORT_REVIEW");
    expect(next.readFiles).toBe(true);
    expect(next.modifySource).toBe(false);
    expect(next.runStaticValidation).toBe(false);
    expect(next.runTests).toBe(false);
    expect(next.build).toBe(false);
  });

  it("does not preserve a customized capability that the new mode forbids", () => {
    const input = { ...createBlankContractInput("SOURCE_IMPLEMENTATION"), build: true };
    const next = transitionTaskMode(input, "REPORT_REVIEW");
    expect(next.build).toBe(false);
  });
});
