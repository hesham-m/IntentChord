import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync("src/components/product-shell.tsx", "utf8");
const workflow = readFileSync("src/components/workflow-app.tsx", "utf8");
const lifecycle = readFileSync("src/server/lifecycle.ts", "utf8");
const schemas = readFileSync("src/server/schemas.ts", "utf8");
const preferences = readFileSync("src/lib/product-preferences.ts", "utf8");
const workspaceRegistry = readFileSync("src/lib/workspace.ts", "utf8");

describe("IG Phase 1 Runtime Gate 1 Task/Project context correction", () => {
  it("removes the misleading global Project selection", () => {
    expect(shell).toContain('href="/project-contexts"');
    expect(shell).toContain('"المشاريع"');
    expect(shell).not.toContain("activeEnvironmentId");
    expect(shell).not.toContain("onEnvironmentChange");
    expect(shell).not.toContain("Governed environment");
    expect(workflow).not.toContain("readActiveEnvironmentPreference");
    expect(workflow).not.toContain("writeActiveEnvironmentPreference");
    expect(preferences).toContain('globalProjectAutoSelection = "FORBIDDEN"');
  });

  it("preserves explicit Owner Task-context choice while governed presentation comes from the projection", () => {
    expect(workflow).toContain('value="INDEPENDENT"');
    expect(workflow).toContain('value="PROJECT_BOUND"');
    expect(workflow).toContain("changeTaskContext(independentTaskContext())");
    expect(workflow).toContain("selectProjectContext(event.target.value)");
    expect(schemas).toContain('kind: z.literal("INDEPENDENT")');
    expect(schemas).toContain('kind: z.literal("PROJECT_BOUND")');
    expect(shell).toContain('data-topbar-context-source="projection"');
    expect(shell).toContain('data-task-context={governedProjection.taskSummary.taskContext.kind}');
    expect(shell).toContain('data-project-context-role="reference-only"');
    expect(shell).not.toContain("projectSwitcher");
    expect(shell).not.toContain("PROJECT_SWITCH");
    expect(shell).not.toContain('data-project-authority-switcher');
  });

  it("canonicalizes Project membership in the authoritative Task revision without granting Workspace authority", () => {
    expect(lifecycle).toContain("normalizeTaskContextForPersistence");
    expect(lifecycle).toContain("from intentchord.project_contexts");
    expect(lifecycle).toContain("from intentchord.project_context_workspaces");
    expect(lifecycle).toContain("PROJECT_WORKSPACE_LINK_REQUIRED");
    expect(lifecycle).toContain("Project membership still grants no Task authority by itself");
    expect(lifecycle).toContain("taskContext,");
    expect(preferences).toContain('taskProjectContextPersistence = "POSTGRESQL_TASK_REVISION_ONLY"');
    expect(workspaceRegistry).toContain("migrateTaskContext");
    expect(workspaceRegistry).toContain("taskContext: migrateTaskContext(raw.taskContext)");
  });
});
