import { describe, expect, it } from "vitest";
import { resolveExecutionContract } from "@/core/contracts/resolver";
import { modeDefaultAuthorization } from "@/core/tasks/task-input";
import { lintResolvedContract } from "@/core/prompts/governance";
import { modelRegistry } from "@/core/providers/registry";

function contract() {
  return resolveExecutionContract({ contractId: "execution-package", title: "Package", objective: "Implement a bounded source correction.", taskMode: "SOURCE_IMPLEMENTATION", workspaces: [{ id: "backend-server", displayName: "backend-server", role: "server", referenceType: "LOCAL_PATH", reference: "E:\\backend", fingerprint: "fp", allowedPaths: ["src"], excludedPaths: ["secrets"], authorizationContext: "owner", ordering: 0 }], allowedPaths: [], excludedPaths: [], evidenceFiles: [], identity: "", authorization: modeDefaultAuthorization("SOURCE_IMPLEMENTATION"), providerId: "GOOGLE", modelId: "gemini-3.6-flash", executionChannelId: "GEMINI_CLI", reasoningProfile: "Auto", runtimeProfileId: "STANDARD", ownerOverrideAccepted: false });
}

describe("execution package", () => {
  it("resolves a stable governance profile, skill, ledger, and completion lock", () => {
    const resolved = contract();
    expect(resolved.executionPackage.governanceProfile.id).toBe("intentchord-stable-governance");
    expect(resolved.executionPackage.completionLock.executionState).toBe("CONTINUE");
    expect(resolved.agentResolution.taskSkill.id).toContain("intentchord");
    expect(lintResolvedContract(resolved).map(item => item.code)).not.toContain("MISSING_COMPLETION_LOCK");
  });
  it("pins the stable Gemini 3.6 Flash registry profile", () => {
    expect(modelRegistry["gemini-3.6-flash"].lifecycle).toBe("STABLE");
    expect(modelRegistry["gemini-3.6-flash"].guidance.join(" ")).toMatch(/not treat this model as universally superior/i);
  });
  it("enforces mandatory final-report semantics through deterministic lints", () => {
    const resolved = contract();
    expect(lintResolvedContract(resolved).map(item => item.code)).not.toEqual(
      expect.arrayContaining([
        "MISSING_MANDATORY_FINAL_REPORT",
        "PROGRESS_ONLY_FINAL_RESPONSE",
        "FINAL_RESPONSE_WITHOUT_EVIDENCE_SUMMARY",
        "TERMINAL_STATE_MISSING_FROM_REPORT",
        "VERDICT_MISSING_FROM_REPORT",
        "NEXT_ACTION_MISSING_FROM_REPORT",
        "FINAL_REPORT_CONFUSED_WITH_PASS",
      ]),
    );
    const incomplete = {
      ...resolved,
      agentResolution: { ...resolved.agentResolution, reportInstructions: ["Return a report."] },
    };
    expect(lintResolvedContract(incomplete).map(item => item.code)).toEqual(
      expect.arrayContaining(["MISSING_MANDATORY_FINAL_REPORT", "VERDICT_MISSING_FROM_REPORT"]),
    );
  });
});
