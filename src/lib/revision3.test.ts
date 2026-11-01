import { describe, expect, it } from "vitest";
import { validatePreflight } from "@/core/policies/preflight";
import { compileAgentPrompt } from "@/core/prompts/compiler";
import {
  createBlankContractInput,
  transitionModel,
  transitionProvider,
} from "@/core/tasks/task-input";
import {
  approveContract,
  buildDraftContract,
  type ContractInput,
} from "@/lib/ui-flow";

function inputFor(mode: ContractInput["taskMode"] = "CONTROLLED_AUDIT"): ContractInput {
  return {
    ...createBlankContractInput(mode),
    objective: mode === "REPORT_REVIEW"
      ? "Review one approved local evidence report."
      : mode === "SOURCE_IMPLEMENTATION"
        ? "Prove and repair one bounded source defect across approved files."
        : "Audit one bounded source area without modifying it.",
    workspaceRef: "intentchord-r3-test",
    workspaceSource: "MANUAL_UNVERIFIED",
    allowedPaths: mode === "REPORT_REVIEW" ? ["evidence/session-001.json"] : ["src/core/"],
    excludedPaths: ["src/private/"],
    evidenceFiles: ["evidence/session-001.json"],
    identity: "r3-session-001",
  };
}

function approved(input: ContractInput) {
  const executionSetup = input.executionSetup ? { ...input.executionSetup, modelOverrideAccepted: true } : undefined;
  return approveContract(buildDraftContract({ ...input, modelOverrideAccepted: true, ...(executionSetup ? { executionSetup } : {}) }, "contract-r3-test")!).contract!;
}

describe("revision 3 resolved contract gates", () => {
  it("keeps an unapproved contract preview non-executable and free of a report envelope", () => {
    const contract = buildDraftContract(inputFor())!;
    const prompt = compileAgentPrompt(contract, "en");
    expect(prompt).toContain("IntentChord Contract Preview");
    expect(prompt).toContain("NOT EXECUTABLE");
    expect(prompt).toContain("OWNER_APPROVAL_PENDING");
    expect(prompt).not.toContain("Required Executor Report Envelope");
    expect(prompt).not.toContain("Use this exact active Run ID");
  });

  it("keeps an approved contract non-executable until an Active Run ID exists", () => {
    const contract = approved(inputFor());
    const prompt = compileAgentPrompt(contract, "en");
    expect(prompt).toContain("NOT EXECUTABLE");
    expect(prompt).toContain("OWNER_APPROVED_AWAITING_ACTIVE_RUN");
    expect(prompt).not.toContain("Required Executor Report Envelope");
  });

  it("emits a concise executable contract only with the pre-created authoritative Run ID", () => {
    const contract = approved(inputFor("SOURCE_IMPLEMENTATION"));
    const prompt = compileAgentPrompt(contract, "en", {
      activeRunId: "run-r3-authoritative-001",
      round: 2,
      executionType: "CORRECTION",
      parentRunId: "run-r3-parent-001",
      correctionGaps: ["Complete the missing build evidence."],
      completedFacts: ["Root cause is already proven."],
    });
    expect(prompt).toContain("IntentChord Execution Contract");
    expect(prompt).toContain("Active Run: run-r3-authoritative-001");
    expect(prompt).toContain("Round: 2");
    expect(prompt).toContain("Parent Run: run-r3-parent-001");
    expect(prompt).toContain("IntentChord Binding:");
    expect(prompt).toContain("Context Lease");
    expect(prompt).toContain("Close only this gap: Complete the missing build evidence.");
    expect(prompt).toContain("Do not re-investigate these already proven facts");
    expect(prompt).toContain("Only gaps to close");
    expect(prompt).toContain("Governing requirement ledger");
    expect(prompt).not.toContain("Confirmed intent understanding");
    expect(prompt).not.toContain("Bounded Discovery Map");
    expect(prompt).toContain("Return structured Markdown by default");
    expect(prompt).not.toContain('"inspectedPaths": []');
    expect(prompt).not.toMatch(/Return exactly one.*JSON/i);
  });

  it("keeps a correction prompt executable when trust gaps are repetitive and verbose", () => {
    const contract = approved(inputFor("SOURCE_IMPLEMENTATION"));
    const prompt = compileAgentPrompt(contract, "en", {
      activeRunId: "run-r3-correction-budget-001",
      round: 2,
      executionType: "CORRECTION",
      parentRunId: "run-r3-parent-budget-001",
      correctionGaps: [
        "Trusted PASS evidence is missing for required check: requirement:BACKEND-AUTHORITY:positive.",
        "Trusted PASS evidence is missing for required check: requirement:BACKEND-AUTHORITY:negative-adversarial.",
        "Trusted PASS evidence is missing for required check: requirement:BACKEND-AUTHORITY:persistence-reload.",
        "Mandatory requirement BACKEND-AUTHORITY lacks trusted positive proof.",
        "Mandatory requirement BACKEND-AUTHORITY lacks trusted negative-adversarial proof.",
        "Mandatory requirement BACKEND-AUTHORITY lacks trusted persistence-reload proof.",
        "Proven finding has no matching trusted source, artifact, validation, runtime, or tool-trace evidence: The approved Backend authority behavior was inspected inside the authorized Workspace.",
      ],
      completedFacts: ["Backend source behavior is already proven by trusted evidence."],
      inheritedCheckIds: ["requirement:BACKEND-AUTHORITY:source-behavior"],
    });
    expect(prompt).not.toContain("CONTRACT LINT BLOCKED");
    expect(prompt).toContain("Missing trusted PASS for requirement:BACKEND-AUTHORITY:positive");
    expect(prompt.length).toBeLessThanOrEqual(14_000);
  });

  it("resolves workflow from effective authorization instead of a generic repair template", () => {
    const audit = buildDraftContract(inputFor("CONTROLLED_AUDIT"))!;
    const review = buildDraftContract(inputFor("REPORT_REVIEW"))!;
    const implementation = buildDraftContract(inputFor("SOURCE_IMPLEMENTATION"))!;

    expect(audit.agentResolution.executionWorkflow.join(" ")).toContain("do not repair source");
    expect(audit.agentResolution.executionWorkflow.join(" ")).not.toContain("Apply the approved coherent source change");
    expect(review.agentResolution.boundedGoal).toContain("without modifying source");
    expect(implementation.agentResolution.executionWorkflow.join(" ")).toContain("Apply the approved coherent source change");
  });

  it("blocks missing workspace and scope but allows discovery-first controlled audit without preselected evidence", () => {
    const input = {
      ...inputFor("CONTROLLED_AUDIT"),
      workspaceRef: "",
      allowedPaths: [],
      evidenceFiles: [],
    };
    const contract = buildDraftContract(input)!;
    const codes = validatePreflight(contract).map(issue => issue.code);
    expect(codes).toContain("MISSING_WORKSPACE");
    expect(codes).toContain("MISSING_APPROVED_SCOPE");
    expect(codes).not.toContain("MISSING_EVIDENCE_SOURCE");
  });

  it("rejects evidence that is simultaneously placed inside excluded scope", () => {
    const contract = buildDraftContract({
      ...inputFor("REPORT_REVIEW"),
      allowedPaths: ["reports/report.md"],
      excludedPaths: ["evidence/"],
      evidenceFiles: ["evidence/session-001.json"],
    })!;
    expect(validatePreflight(contract).map(issue => issue.code)).toContain("EVIDENCE_SCOPE_CONFLICT");
  });

  it("requires explicit owner acknowledgement for a preview model", () => {
    let input = transitionProvider(inputFor("CONTROLLED_AUDIT"), "GOOGLE");
    input = transitionModel(input, "gemini-3.1-pro-preview");
    input = {
      ...input,
      objective: "Audit one bounded source area without modifying it.",
      workspaceRef: "intentchord-r3-test",
      workspaceSource: "MANUAL_UNVERIFIED",
      allowedPaths: ["src/core/"],
      evidenceFiles: ["evidence/session-001.json"],
      identity: "r3-session-001",
    };
    const blocked = buildDraftContract(input)!;
    expect(blocked.configurationRecommendation.status).toBe("OWNER_DECISION_REQUIRED");
    expect(validatePreflight(blocked).map(issue => issue.code)).toContain("MODEL_RECOMMENDATION_ACK_REQUIRED");

    const executionSetup = input.executionSetup ? { ...input.executionSetup, modelOverrideAccepted: true } : undefined;
    const accepted = buildDraftContract({ ...input, modelOverrideAccepted: true, ...(executionSetup ? { executionSetup } : {}) })!;
    expect(validatePreflight(accepted).map(issue => issue.code)).not.toContain("MODEL_RECOMMENDATION_ACK_REQUIRED");
  });


  it("recommends Claude Opus rather than the maximum-capability Fable model for ordinary high-complexity coding", () => {
    const input = transitionProvider(inputFor("SOURCE_IMPLEMENTATION"), "ANTHROPIC");
    const contract = buildDraftContract({
      ...input,
      objective: "Prove and repair one bounded source defect across several coupled modules and validate regressions.",
      workspaceRef: "intentchord-r3-test",
      workspaceSource: "MANUAL_UNVERIFIED",
      allowedPaths: ["src/core/", "src/lib/", "src/components/"],
      evidenceFiles: ["evidence/session-001.json"],
      identity: "r3-session-001",
    })!;
    expect(contract.configurationRecommendation.recommendedModelId).toBe("claude-opus-4-8");
  });

  it("preserves provider, model, channel, and reasoning in the resolved runtime contract", () => {
    const input = transitionProvider(inputFor("REPORT_REVIEW"), "ANTHROPIC");
    const contract = buildDraftContract({
      ...input,
      objective: "Review one approved local evidence report.",
      workspaceRef: "intentchord-r3-test",
      evidenceFiles: ["evidence/session-001.json"],
      identity: "r3-session-001",
    })!;
    expect(contract.selectedConfiguration.providerId).toBe("ANTHROPIC");
    expect(contract.agentResolution.modelId).toBe(contract.selectedConfiguration.modelId);
    expect(contract.agentResolution.executionChannelId).toBe("CLAUDE_CODE");
    expect(contract.agentResolution.reasoningProfile).toBe(contract.selectedConfiguration.reasoningProfile);
    expect(contract.agentResolution.runtimeProfileId).toBe(contract.selectedConfiguration.runtimeProfileId);
  });
});
