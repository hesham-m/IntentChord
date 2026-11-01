import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { requestTaskExperienceProjection } from "@/components/task-experience-projection-client";

const payload = {
  taskSummary: { id: "task-1" },
  visiblePhase: "UNDERSTAND",
  phaseStatus: "AWAITING_OBJECTIVE",
};

describe("TaskExperienceProjection client integration", () => {
  it("requests the existing authoritative production projection route", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await requestTaskExperienceProjection("task-1", "en", request);

    expect(request).toHaveBeenCalledWith("/api/tasks/task-1/projection?locale=en", { cache: "no-store" });
    expect(result.visiblePhase).toBe("UNDERSTAND");
  });

  it("fails closed when the projection response identity does not match the requested Task", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ...payload, taskSummary: { id: "task-other" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(requestTaskExperienceProjection("task-1", "en", request))
      .rejects.toThrow("TASK_EXPERIENCE_PROJECTION_IDENTITY_MISMATCH");
  });

  it("converges the Task entry routes while preserving downstream Contract/Run workbenches", () => {
    const workflow = readFileSync("src/components/workflow-app.tsx", "utf8");
    expect(readFileSync("src/app/(protected)/tasks/new/page.tsx", "utf8")).toContain('UnifiedTaskWorkbench mode="NEW"');
    expect(readFileSync("src/app/(protected)/tasks/current/page.tsx", "utf8")).toContain('UnifiedTaskWorkbench mode="CURRENT"');
    expect(readFileSync("src/app/(protected)/workspace-analysis/page.tsx", "utf8")).toContain('redirect("/tasks/current")');
    for (const [path, expected] of [
      ["src/app/(protected)/contracts/current/page.tsx", 'WorkflowApp stage="contract"'],
      ["src/app/(protected)/runs/current/execute/page.tsx", 'WorkflowApp stage="execute"'],
      ["src/app/(protected)/runs/current/review/page.tsx", 'WorkflowApp stage="review"'],
      ["src/app/(protected)/bridge/page.tsx", 'WorkflowApp stage="bridge"'],
    ] as const) {
      expect(readFileSync(path, "utf8")).toContain(expected);
    }
    expect(workflow).toContain("requestTaskExperienceProjection(taskId, locale, ownerFetch)");
  });
});
