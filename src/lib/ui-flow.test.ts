import { describe, expect, it } from "vitest";
import { createBlankContractInput, transitionProvider } from "@/core/tasks/task-input";
import { approveContract, buildDraftContract, compiledPromptForLocale, configurationPreview, type ContractInput } from "@/lib/ui-flow";
import { scenarioVerdict } from "@/test/fixtures/demo-scenarios";

const baseUiInput = createBlankContractInput("SOURCE_IMPLEMENTATION");
const input: ContractInput = {
  ...baseUiInput,
  objective: "Validate startup evidence and implement a bounded cross-file repair.",
  workspaceRef: "demo-project",
  workspaceSource: "MANUAL_UNVERIFIED",
  allowedPaths: ["src/startup.ts", "src/runtime.ts"],
  excludedPaths: ["config/"],
  evidenceFiles: ["evidence/demo.log"],
  identity: "demo-session-002",
  modelId: "gpt-5.6-sol",
  reasoningProfile: "High",
  build: true,
  executionSetup: {
    ...baseUiInput.executionSetup!,
    modelId: "gpt-5.6-sol",
    reasoningProfile: "High",
  },
};

describe("UI flow authorization and provider parity", () => {
  it("propagates every visible authorization control to the contract mapping", () => {
    const contract = buildDraftContract(input)!;
    expect(contract.authorization).toEqual({ readFiles: true, modifySource: true, runStaticValidation: true, runTests: true, build: true, deploy: false, restartServices: false, writeDatabase: false, changeEnvironment: false, useNetwork: false });
  });

  it("retains provider, model, channel, workspace, evidence, and identity inputs", () => {
    const contract = buildDraftContract(input)!;
    expect(contract.selectedConfiguration.providerId).toBe("OPENAI");
    expect(contract.agentResolution.executionChannelId).toBe("CODEX");
    expect(contract.scope.workspaceRef).toBe("demo-project");
    expect(contract.scope.evidenceFiles).toEqual(["evidence/demo.log"]);
    expect(contract.evidenceIdentity.sessionId).toBe("demo-session-002");
  });

  it("evaluates a synthetic report against the supplied active contract", () => {
    const contract = buildDraftContract({ ...input, allowedPaths: ["src/other.ts"] })!;
    expect(scenarioVerdict("controlled-success", contract).verdict.classification).toBe("EVIDENCE_REQUIRED");
  });

  it("blocks invalid preflight approval and creates a contract-bound controlled success", () => {
    const invalid = buildDraftContract({ ...input, taskMode: "CONTROLLED_AUDIT", modifySource: true })!;
    expect(approveContract(invalid).contract).toBeUndefined();
    const active = buildDraftContract({
      ...input,
      modelOverrideAccepted: true,
      allowedPaths: ["src/owner-binding.ts"],
      identity: "owner-binding-001",
      executionSetup: {
        ...input.executionSetup!,
        modelOverrideAccepted: true,
      },
    })!;
    const approved = approveContract(active).contract!;
    expect(approved.ownerApproval.approvedAt).toBeTruthy();
    const success = scenarioVerdict("controlled-success", approved, "run-owner-001");
    expect(success.verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(success.scenario.report.changedPaths).toEqual([{ workspaceId: success.scenario.report.inspectedPaths[0].workspaceId, path: "src/owner-binding.ts" }]);
    expect(JSON.stringify(success.scenario.report)).not.toContain("src/startup.ts");
    expect(JSON.stringify(success.scenario.report)).not.toContain("demo-session-002");
  });

  it("provides an independently localizable preview without claiming execution authority", () => {
    const contract = buildDraftContract(input)!;
    const prompt = compiledPromptForLocale(contract, "ar");
    expect(prompt).toContain("التشغيل المعتمد");
    expect(prompt).toContain("معاينة عقد IntentChord");
    expect(prompt).toContain("NOT EXECUTABLE");
    expect(prompt).toContain("src/startup.ts");
    expect(prompt).toContain("صيغة التقرير");
    expect(prompt).not.toContain("Required Executor Report Envelope");
  });

  it("changes provider, model, and channel together and invalidates any previous override", () => {
    const next = transitionProvider({ ...input, modelOverrideAccepted: true }, "ANTHROPIC");
    expect(next.providerId).toBe("ANTHROPIC");
    expect(next.executionChannelId).toBe("CLAUDE_CODE");
    expect(next.modelId).toBe("claude-sonnet-5");
    expect(next.modelOverrideAccepted).toBe(false);
  });

  it("requires an explicit warning acceptance for a weak model on a high-complexity task", () => {
    const weak = {
      ...input,
      modelId: "gpt-5.6-luna" as const,
      reasoningProfile: "Light" as const,
      executionSetup: {
        ...input.executionSetup!,
        modelId: "gpt-5.6-luna" as const,
        reasoningProfile: "Light" as const,
      },
    };
    const preview = configurationPreview(weak);
    expect(preview.recommendation!.status).toBe("SUPPORTED_WITH_WARNING");
    expect(approveContract(buildDraftContract(weak)!).contract).toBeUndefined();
  });

  it("does not synthesize changed paths when effective source modification is disabled", () => {
    const reviewInput = { ...createBlankContractInput("REPORT_REVIEW"), objective: "Review the approved report evidence.", workspaceRef: "demo", allowedPaths: ["reports/report.md"], evidenceFiles: ["evidence/report.json"], identity: "report-1" };
    const contract = approveContract(buildDraftContract(reviewInput)!).contract!;
    const success = scenarioVerdict("controlled-success", contract, "run-review-001");
    expect(success.scenario.report.changedPaths).toEqual([]);
    expect(success.verdict.classification).toBe("EVIDENCE_REQUIRED");
  });
});
