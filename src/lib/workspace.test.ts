import { describe, expect, it } from "vitest";
import { approveContract, buildDraftContract, type ContractInput } from "@/lib/ui-flow";
import { scenarioVerdict } from "@/test/fixtures/demo-scenarios";
import { createBlankContractInput } from "@/core/tasks/task-input";
import {
  activeRun,
  appendRun,
  canAccessWorkflowStep,
  createRunRecord,
  createTaskRecord,
  emptyWorkspace,
  recordOwnerDecision,
  restoreWorkspace,
  setTaskContract,
  setTaskPromptLocale,
  syncTaskPromptLocale,
  taskStatus,
  updateTaskDraft,
  upsertTask,
  workflowRoute,
  workflowStepState,
} from "@/lib/workspace";

const blank = createBlankContractInput("SOURCE_IMPLEMENTATION");
const input: ContractInput = {
  ...blank,
  modelOverrideAccepted: true,
  executionSetup: { ...blank.executionSetup, modelOverrideAccepted: true },
  objective: "Validate owner binding.",
  workspaceRef: "demo",
  workspaceSource: "MANUAL_UNVERIFIED",
  allowedPaths: ["src/owner-binding.ts"],
  evidenceFiles: ["evidence/owner.log"],
  identity: "owner-binding-001",
};

function approvedTask() {
  const task = createTaskRecord(input, { id: "task-1", now: "2026-07-19T00:00:00.000Z" });
  const contract = approveContract(buildDraftContract(input, "task-1-contract-r1")!).contract!;
  return setTaskContract(task, contract, "2026-07-19T00:01:00.000Z");
}

describe("authoritative task and run registry", () => {
  it("invalidates active downstream state while preserving historical runs as superseded", () => {
    const task = approvedTask();
    const result = scenarioVerdict("controlled-success", task.contract!);
    const run = createRunRecord({ contract: task.contract!, source: "SYNTHETIC_FIXTURE", scenario: "controlled-success", round: 1, report: result.scenario.report, verdict: result.verdict, id: "run-1", now: "2026-07-19T00:02:00.000Z" });
    const executed = appendRun(task, run);
    const next = updateTaskDraft(executed, { ...input, objective: "Changed objective." }, "2026-07-19T00:03:00.000Z");
    expect(next.contract).toBeUndefined();
    expect(next.activeRunId).toBeUndefined();
    expect(next.runs[0].supersededAt).toBeTruthy();
    expect(taskStatus(next)).toBe("DRAFT");
  });

  it("persists an owner decision on the active run without changing contract authority", () => {
    const task = approvedTask();
    const result = scenarioVerdict("controlled-success", task.contract!);
    const withRun = appendRun(task, createRunRecord({ contract: task.contract!, source: "SYNTHETIC_FIXTURE", round: 1, report: result.scenario.report, verdict: result.verdict, id: "run-1" }));
    const decided = recordOwnerDecision(withRun, "REJECTED", "2026-07-19T00:04:00.000Z");
    expect(decided.contract).toBe(task.contract);
    expect(activeRun(decided)?.decision).toBe("REJECTED");
    expect(decided.reviewTab).toBe("decision");
  });

  it("locks future steps until the authoritative prerequisites exist", () => {
    const draft = createTaskRecord(input, { id: "task-1" });
    expect(canAccessWorkflowStep(draft, "contract")).toBe(false);
    expect(workflowStepState(draft, "task", "contract")).toBe("future");
    const task = approvedTask();
    expect(canAccessWorkflowStep(task, "execution")).toBe(true);
    expect(canAccessWorkflowStep(task, "review")).toBe(false);
    const result = scenarioVerdict("controlled-success", task.contract!);
    const completed = appendRun(task, createRunRecord({ contract: task.contract!, source: "SYNTHETIC_FIXTURE", round: 1, report: result.scenario.report, verdict: result.verdict, id: "run-1" }));
    expect(canAccessWorkflowStep(completed, "review")).toBe(true);
    expect(workflowStepState(completed, "review", "contract")).toBe("complete");
    expect(workflowRoute("decision")).toContain("#decision");
  });

  it("marks Decision complete only after an owner decision", () => {
    const task = approvedTask();
    const result = scenarioVerdict("controlled-success", task.contract!);
    const completed = appendRun(task, createRunRecord({ contract: task.contract!, source: "SYNTHETIC_FIXTURE", round: 1, report: result.scenario.report, verdict: result.verdict, id: "run-1" }));
    expect(workflowStepState(completed, "review", "decision")).toBe("future");
    const decided = recordOwnerDecision(completed, "REJECTED");
    expect(workflowStepState(decided, "review", "decision")).toBe("complete");
  });

  it("keeps prompt locale coupled until the owner explicitly separates it", () => {
    const task = createTaskRecord(input, { id: "task-1" });
    const coupled = syncTaskPromptLocale(task, "ar");
    expect(coupled.promptLocale).toBe("ar");
    const explicit = setTaskPromptLocale(coupled, "en", true);
    expect(syncTaskPromptLocale(explicit, "ar").promptLocale).toBe("en");
  });

  it("preserves discovery scope literal types while migrating stored workspaces", () => {
    const task = createTaskRecord(createBlankContractInput("CONTROLLED_AUDIT"), { id: "task-migrate" });
    const legacy = {
      version: 3,
      tasks: [{
        ...task,
        draft: {
          ...task.draft,
          taskContext: {
            kind: "PROJECT_BOUND",
            projectContextId: "00000000-0000-4000-8000-000000000301",
            projectContextDisplayName: "IntentChord",
            projectContextRevision: 2,
          },
          workspaces: [{
            id: "workspace-1",
            displayName: "Backend",
            role: "primary",
            referenceType: "LOCAL_PATH",
            reference: "E:\\project\\backend",
            fingerprint: "workspace-1",
            discoveryScopeMode: "FULL_WORKSPACE",
            allowedPaths: [],
            excludedPaths: [],
            authorizationContext: "owner-approved",
            ordering: 0,
          }],
        },
      }],
      activeTaskId: task.id,
    };

    const restored = restoreWorkspace(JSON.stringify(legacy));

    expect(restored.tasks[0].draft.workspaces[0].discoveryScopeMode).toBe("FULL_WORKSPACE");
    expect(restored.tasks[0].draft.taskContext).toEqual({
      kind: "PROJECT_BOUND",
      projectContextId: "00000000-0000-4000-8000-000000000301",
      projectContextDisplayName: "IntentChord",
      projectContextRevision: 2,
    });
  });

  it("restores a registry and fails closed for invalid stored contracts", () => {
    const task = approvedTask();
    const workspace = upsertTask(emptyWorkspace(), task);
    expect(restoreWorkspace(JSON.stringify(workspace)).tasks).toHaveLength(1);
    const invalid = { ...workspace, tasks: [{ ...task, contract: { policyVersion: "0.1" } }] };
    const restoredInvalid = restoreWorkspace(JSON.stringify(invalid));
    expect(restoredInvalid.tasks).toHaveLength(1);
    expect(restoredInvalid.tasks[0].contract).toBeUndefined();
    expect(restoredInvalid.tasks[0].activeRunId).toBeUndefined();
  });
});
