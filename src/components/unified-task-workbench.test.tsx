import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { governedRailCollapsedForViewport } from "@/components/product-shell";

describe("Unified governed Task product surface", () => {
  it("makes the unified workbench canonical for new/current Task routes and converges the legacy Workspace Analysis route", () => {
    expect(readFileSync("src/app/(protected)/tasks/new/page.tsx", "utf8")).toContain('UnifiedTaskWorkbench mode="NEW"');
    expect(readFileSync("src/app/(protected)/tasks/current/page.tsx", "utf8")).toContain('UnifiedTaskWorkbench mode="CURRENT"');
    const workspaceAnalysis = readFileSync("src/app/(protected)/workspace-analysis/page.tsx", "utf8");
    expect(workspaceAnalysis).toContain('redirect("/tasks/current")');
    expect(workspaceAnalysis).not.toContain("WorkspaceAnalysisWorkbench");
  });

  it("keeps the normal Owner path free of early provider/model selection and uses dedicated governed commands", () => {
    const source = readFileSync("src/components/unified-task-workbench.tsx", "utf8");
    expect(source).toContain("/work-selection");
    expect(source).toContain("workspaceIndexAttemptIdempotencyKey({ taskId: task.id, analysisAttemptId, workspaceId })");
    expect(source).not.toContain("latestReadySnapshotId");
    expect(source).toContain("/scope-confirmation");
    expect(source).toContain("/execution-platform");
    expect(source).toContain("/contract");
    expect(source).toContain("onSelectTask={taskId => void selectOpenTask(taskId)}");
    expect(source).not.toContain("transitionProvider(");
    expect(source).not.toContain("transitionModel(");
    expect(source).not.toContain("modelsForProvider(");
    expect(source).not.toContain("providerRegistry[");
  });

  it("keeps Mapping retry on the current Context revision", () => {
    const source = readFileSync("src/components/unified-task-workbench.tsx", "utf8");
    expect(source).toContain('const isContextMappingRetry = projection.primaryAction.actionKey === "RETRY_CONTEXT_MAPPING"');
    expect(source).toContain("if (!isContextMappingRetry) {");
    expect(source).toContain("await ensureReadySnapshot(workspace.id, analysisAttemptId)");
  });

  it("waits for asynchronous Mapping outcome before showing governed operation success", () => {
    const source = readFileSync("src/components/unified-task-workbench.tsx", "utf8");
    expect(source).toContain("waitForContextMappingOutcome");
    expect(source).toContain('if (next.phaseStatus !== "INDEXING_AND_MAPPING") return next;');
    expect(source).toContain('if (outcome.phaseStatus === "CONTEXT_MAPPING_RETRYABLE")');
  });

  it("uses a compact Open Work rail at 1366px while the governed canvas owns the viewport", () => {
    expect(governedRailCollapsedForViewport(1366)).toBe(true);
    const shellCss = readFileSync("src/components/product-shell.module.css", "utf8");
    expect(shellCss).toContain("height: calc(100dvh - 68px)");
    expect(shellCss).toContain(".governedContentViewport");
    const workbenchCss = readFileSync("src/components/unified-task-workbench.module.css", "utf8");
    expect(workbenchCss).toContain("overflow: auto");
    expect(workbenchCss).toContain(".workGrid");
  });
});
