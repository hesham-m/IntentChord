import { describe, expect, it } from "vitest";
import { createBlankContractInput } from "@/core/tasks/task-input";
import { buildDraftContract, compiledPromptForLocale } from "@/lib/ui-flow";

function pilotContract() {
  const input = createBlankContractInput("SOURCE_IMPLEMENTATION");
  input.objective = "Correct the bounded pilot implementation.";
  input.title = "Bounded pilot correction";
  input.workspaces = [
    { id: "backend-server", displayName: "backend-server", role: "server", referenceType: "LOCAL_PATH", reference: "E:\\backend", fingerprint: "backend-fp", allowedPaths: ["src"], excludedPaths: ["config/secrets"], authorizationContext: "owner", ordering: 0 },
    { id: "windows-client", displayName: "windows-client", role: "client", referenceType: "LOCAL_PATH", reference: "E:\\client", fingerprint: "client-fp", allowedPaths: ["src"], excludedPaths: ["target"], authorizationContext: "owner", ordering: 1 },
  ];
  return buildDraftContract(input, "pilot-contract")!;
}

describe("multi-workspace contract and Codex stop policy", () => {
  it("keeps two workspace snapshots with distinct scope", () => {
    const contract = pilotContract();
    expect(contract.scope.workspaces.map(workspace => workspace.id)).toEqual(["backend-server", "windows-client"]);
    expect(contract.scope.workspaces[0].excludedPaths).toEqual(["config/secrets"]);
    expect(contract.scope.allowedPaths).toEqual(["backend-server:src", "windows-client:src"]);
  });

  it("distinguishes hard blockers, validation failures, and runner timeouts", () => {
    const contract = pilotContract();
    const stops = contract.agentResolution.stopConditions.join("\n");
    expect(stops).toContain("HARD_EXECUTION_BLOCKER");
    expect(stops).toContain("VALIDATION_GATE_FAILURE");
    expect(stops).toContain("TOOL_OR_RUNNER_TIMEOUT");
    expect(stops).toContain("EVIDENCE_REQUIRED");
    expect(stops).not.toMatch(/first real blocker/i);
    const prompt = compiledPromptForLocale(contract, "en", { activeRunId: "run-1", round: 1, executionType: "INITIAL" });
    expect(prompt).toContain("backend-server");
    expect(prompt).toContain("windows-client");
  });
});
