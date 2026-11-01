import { describe, expect, it } from "vitest";
import { compileAgentPrompt } from "@/core/prompts/compiler";
import { createBlankContractInput, transitionProvider } from "@/core/tasks/task-input";
import { approveContract, buildDraftContract } from "@/lib/ui-flow";
import { scenarioVerdict } from "@/test/fixtures/demo-scenarios";
import {
  activeRun,
  appendRun,
  createRunRecord,
  createTaskRecord,
  emptyWorkspace,
  recordOwnerDecision,
  restoreWorkspace,
  setTaskContract,
  taskStatus,
  upsertTask,
} from "@/lib/workspace";
import type { ProviderId } from "@/core/providers/registry";

function taskWithContract(providerId: ProviderId = "OPENAI") {
  const selected = transitionProvider(createBlankContractInput("SOURCE_IMPLEMENTATION"), providerId);
  const input = {
    ...selected,
    modelOverrideAccepted: true,
    executionSetup: selected.executionSetup ? { ...selected.executionSetup, modelOverrideAccepted: true } : undefined,
    objective: "Implement one bounded source change across the approved workspace.",
    workspaceRef: "intentchord",
    workspaceSource: "MANUAL_UNVERIFIED" as const,
    allowedPaths: ["src/"],
    excludedPaths: ["config/"],
    evidenceFiles: ["evidence/run.json"],
    identity: "session-001",
  };
  const task = createTaskRecord(input, { id: `task-${providerId.toLowerCase()}`, now: "2026-07-19T00:00:00.000Z" });
  const contract = approveContract(buildDraftContract(input, `${task.id}-contract-r1`)!).contract!;
  return setTaskContract(task, contract, "2026-07-19T00:01:00.000Z");
}

describe("master closure lifecycle", () => {
  it("preserves the original correction decision and a new corrected PASS round after restore", () => {
    let task = taskWithContract();
    const firstResult = scenarioVerdict("evidence-mixing", task.contract!, "run-001");
    const first = createRunRecord({ contract: task.contract!, source: "SYNTHETIC_FIXTURE", scenario: "evidence-mixing", round: 1, report: firstResult.scenario.report, verdict: firstResult.verdict, id: "run-001", now: "2026-07-19T00:02:00.000Z" });
    task = recordOwnerDecision(appendRun(task, first), "CORRECTION_REQUESTED", "2026-07-19T00:03:00.000Z");

    const correctedResult = scenarioVerdict("controlled-success", task.contract!, "run-002");
    const corrected = createRunRecord({ contract: task.contract!, source: "IMPORTED_REPORT", executionType: "CORRECTION", parentRunId: "run-001", round: 2, report: correctedResult.scenario.report, verdict: correctedResult.verdict, id: "run-002", now: "2026-07-19T00:04:00.000Z" });
    task = appendRun(task, corrected);

    const restored = restoreWorkspace(JSON.stringify(upsertTask(emptyWorkspace(), task)));
    const restoredTask = restored.tasks[0];
    expect(restoredTask.runs).toHaveLength(2);
    expect(restoredTask.runs[0].decision).toBe("CORRECTION_REQUESTED");
    expect(activeRun(restoredTask)?.verdict?.classification).toBe("EVIDENCE_REQUIRED");
    expect(activeRun(restoredTask)?.decision).toBe("NONE");
    expect(taskStatus(restoredTask)).toBe("AWAITING_DECISION");
  });

  it("keeps the demo catalog outside the user task registry", () => {
    const workspace = upsertTask(emptyWorkspace(), taskWithContract());
    expect(workspace.tasks).toHaveLength(1);
    expect("demo" in workspace).toBe(false);
  });

  it("generates materially different runtime contracts without changing canonical owner authority", () => {
    const codex = taskWithContract("OPENAI").contract!;
    const claude = taskWithContract("ANTHROPIC").contract!;
    const codexPrompt = compileAgentPrompt(codex, "en", { activeRunId: "run-codex", round: 1, executionType: "INITIAL" });
    const claudePrompt = compileAgentPrompt(claude, "en", { activeRunId: "run-claude", round: 1, executionType: "INITIAL" });
    expect(codex.agentResolution.profileId).toBe("CODEX");
    expect(claude.agentResolution.profileId).toBe("CLAUDE_CODE");
    expect(codexPrompt).toContain("/goal Prove the root cause");
    expect(codexPrompt).toContain("run-codex");
    expect(claudePrompt).toContain("CLAUDE.md");
    expect(claudePrompt).toContain("run-claude");
    expect(claudePrompt).not.toContain("/goal ");
    expect(codexPrompt).not.toBe(claudePrompt);
    expect(codex.objective).toBe(claude.objective);
    expect(codex.scope.allowedPaths).toEqual(claude.scope.allowedPaths);
  });
});
