import { describe, expect, it } from "vitest";
import { generatedTaskTitle, createBlankContractInput } from "@/core/tasks/task-input";
import { buildDraftContract } from "@/lib/ui-flow";
import { createTaskRecord, updateTaskDraft } from "@/lib/workspace";

describe("PostgreSQL multi-workspace vertical slice domain", () => {
  it("derives the final task title from the objective and ignores manual title input", () => {
    const draft = { ...createBlankContractInput(), objective: "Correct the bounded client pilot blocker and verify the bounded result." };
    expect(generatedTaskTitle(draft.objective)).toContain("Correct the bounded");
    const created = createTaskRecord(draft, { id: "00000000-0000-4000-8000-000000000001" });
    const objective = "Update channel version 1.5.3";
    const revised = updateTaskDraft(created, { ...created.draft, title: "Manual title must be ignored", titleManuallyEdited: true, objective });
    expect(revised.draft.title).toBe(generatedTaskTitle(objective));
    expect(revised.draft.titleManuallyEdited).toBe(false);
  });

  it("freezes each workspace and its own authority boundaries in the contract", () => {
    const draft = createBlankContractInput();
    draft.objective = "Audit the two bounded pilot workspaces.";
    draft.identity = "pilot-identity";
    draft.workspaces = [
      { id: "backend-server", displayName: "backend-server", role: "service", referenceType: "LOCAL_PATH", reference: "E:\\Projects\\backend-server", fingerprint: "backend-fp", allowedPaths: ["src"], excludedPaths: ["secrets"], authorizationContext: "owner approval", ordering: 0 },
      { id: "windows-client", displayName: "windows-client", role: "client", referenceType: "LOCAL_PATH", reference: "E:\\Projects\\windows-client", fingerprint: "client-fp", allowedPaths: ["src"], excludedPaths: ["target"], authorizationContext: "owner approval", ordering: 1 },
    ];
    draft.allowedPaths = ["src"]; draft.excludedPaths = ["target"];
    const contract = buildDraftContract(draft)!;
    expect(contract.scope.workspaces).toHaveLength(2);
    expect(contract.scope.workspaces[1].excludedPaths).toEqual(["target"]);
  });
});
