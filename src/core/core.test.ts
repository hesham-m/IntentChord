import { describe, expect, it } from "vitest";
import { executionContractSchema } from "@/core/contracts/execution-contract";
import { executorReportEnvelopeSchema } from "@/core/reports/executor-report";
import { validatePreflight } from "@/core/policies/preflight";
import { compileExecutorNeutralPrompt } from "@/core/prompts/compiler";
import { evaluateVerdict, isAuthorizedReportPath } from "@/core/verdicts/engine";
import { baseContract, scenarioA, scenarioB, scenarioC } from "@/test/fixtures/scenarios";

describe("deterministic core", () => {
  it("accepts a valid contract and report envelope", () => { expect(executionContractSchema.safeParse(baseContract).success).toBe(true); expect(executorReportEnvelopeSchema.safeParse(scenarioC).success).toBe(true); });
  it("rejects invalid contract schema", () => { expect(executionContractSchema.safeParse({ ...baseContract, taskMode: "BAD" }).success).toBe(false); expect(executionContractSchema.safeParse({ ...baseContract, objective: "" }).success).toBe(false); });
  it("detects preflight contradictions and missing owner approval", () => { const contract = { ...baseContract, taskMode: "CONTROLLED_AUDIT" as const, authorization: { ...baseContract.authorization, modifySource: true }, ownerApproval: { required: true as const, state: "AWAITING_OWNER_APPROVAL" as const } }; const codes = validatePreflight(contract).map(issue => issue.code); expect(codes).toContain("AUDIT_MODIFICATION"); expect(codes).toContain("MISSING_OWNER_APPROVAL"); });
  it("allows discovery-first runtime work before evidence identity exists", () => { const contract = { ...baseContract, objective: "Validate runtime startup behavior.", evidenceIdentity: {} }; const codes = validatePreflight(contract).map(issue => issue.code); expect(codes).not.toContain("MISSING_RUNTIME_IDENTITY"); expect(codes).not.toContain("MISSING_EVIDENCE_IDENTITY"); });
  it("preserves controls in an executor-neutral prompt", () => { const prompt = compileExecutorNeutralPrompt(baseContract); expect(prompt).toContain(baseContract.objective); expect(prompt).toContain("src/startup.ts"); expect(prompt).toContain("Effective authority"); expect(prompt).toContain("Agent controls"); expect(prompt).toContain("IntentChord Contract Preview"); expect(prompt).toContain("NOT EXECUTABLE"); expect(prompt).not.toContain("Resolved Agent Contract"); });
  it("authorizes discovered report paths under a full-Workspace read boundary while exclusions still win", () => {
    const workspace = baseContract.scope.workspaces[0];
    const contract = {
      ...baseContract,
      taskMode: "CONTROLLED_AUDIT" as const,
      authorization: { ...baseContract.authorization, modifySource: false },
      scope: {
        ...baseContract.scope,
        workspaces: [{
          ...workspace,
          discoveryScopeMode: "FULL_WORKSPACE" as const,
          effectiveReadBoundary: "WORKSPACE_ROOT" as const,
          allowedPaths: [],
          excludedPaths: ["private"],
        }],
      },
    };
    expect(isAuthorizedReportPath({ workspaceId: workspace.id, path: "src/update/channel.ts" }, contract)).toBe(true);
    expect(isAuthorizedReportPath({ workspaceId: workspace.id, path: "private/secret.ts" }, contract)).toBe(false);
  });

  it("classifies mixed identities as evidence required", () => { expect(evaluateVerdict(baseContract, scenarioA).classification).toBe("EVIDENCE_REQUIRED"); });
  it("classifies unauthorized paths as violation", () => { expect(evaluateVerdict(baseContract, scenarioB).classification).toBe("VIOLATION"); });
  it("keeps missing source as evidence required until independently proven", () => { expect(evaluateVerdict(baseContract, { ...scenarioC, missingRequiredSources: ["evidence/demo-session-002/startup.log"] }).classification).toBe("EVIDENCE_REQUIRED"); });
  it("never promotes executor-only controlled success to PASS", () => { expect(evaluateVerdict(baseContract, scenarioC).classification).toBe("EVIDENCE_REQUIRED"); });
  it("counts provenance-specific proven findings as proven evidence claims", () => {
    const workspaceId = baseContract.scope.workspaces[0].id;
    const report = {
      ...scenarioC,
      findings: [{
        ...scenarioC.findings[0],
        status: "PROVEN_BY_SOURCE" as const,
        evidenceRefs: [{
          kind: "SOURCE_EVIDENCE" as const,
          workspaceId,
          relativePath: "src/startup.ts",
          symbol: "startup",
          contentSha256: "a".repeat(64),
        }],
      }],
    };
    const verdict = evaluateVerdict(baseContract, report);
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(verdict.evidenceGaps).not.toContain("No PROVEN finding was supplied.");
    expect(verdict.evidenceSufficiency?.provenFindingCount).toBe(1);
    expect(verdict.evidenceSufficiency?.referencedProvenFindingCount).toBe(1);
  });
  it("does not allow executor PASS to override a hard failure", () => { expect(evaluateVerdict(baseContract, { ...scenarioB, executorClassification: "PASS" }).classification).toBe("VIOLATION"); });

  it("does not invent an evidence-identity gap when the approved Contract has no governed identity", () => {
    const contract = {
      ...baseContract,
      objective: "Apply the approved source correction and validate the changed source.",
      evidenceIdentity: {},
    };
    const report = { ...scenarioC, evidenceIdentities: [] };
    const verdict = evaluateVerdict(contract, report);
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(verdict.evidenceGaps.join(" ")).not.toContain("exactly matches the approved identity");
  });

  it("requires an exact full evidence identity rather than matching only one shared field", () => {
    const contract = { ...baseContract, evidenceIdentity: { sessionId: "demo-session-002", commitSha: "approved-commit" } };
    const report = { ...scenarioC, evidenceIdentities: [{ sessionId: "demo-session-002", commitSha: "different-commit" }] };
    const verdict = evaluateVerdict(contract, report);
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(verdict.evidenceGaps.join(" ")).toContain("exactly matches the approved identity");
  });

  it("rejects unapproved supporting-evidence references instead of treating them as inspected scope", () => {
    const report = {
      ...scenarioC,
      findings: scenarioC.findings.map((finding, index) => index === 0 ? {
        ...finding,
        evidenceRefs: [
          ...finding.evidenceRefs,
          { kind: "SUPPORTING_EVIDENCE" as const, path: "evidence/unapproved.log" },
        ],
      } : finding),
    };
    const verdict = evaluateVerdict(baseContract, report);
    expect(verdict.classification).toBe("VIOLATION");
    expect(verdict.detectedViolations.join(" ")).toContain("Unapproved report context references");
  });

  it("requires the imported report runId to match the active execution run", () => { const verdict = evaluateVerdict(baseContract, { ...scenarioC, runId: "wrong-run" }, "run-active-001"); expect(verdict.classification).toBe("EVIDENCE_REQUIRED"); expect(verdict.evidenceGaps.join(" ")).toContain("run-active-001"); expect(verdict.nextAction).toBe("Resubmit the report using the active Run ID: run-active-001."); });

  it("classifies an unapproved model fallback as a contract violation", () => {
    const verdict = evaluateVerdict(baseContract, { ...scenarioC, modelId: "gpt-5.6-luna" });
    expect(verdict.classification).toBe("VIOLATION");
    expect(verdict.detectedViolations[0]).toContain("Unapproved runtime configuration");
    expect(verdict.nextAction).toContain("owner reapproval");
  });
  it("binds correction reports to the approved round and parent run", () => {
    const report = { ...scenarioC, executionType: "CORRECTION" as const, round: 2, parentRunId: "run-parent-wrong" };
    const verdict = evaluateVerdict(baseContract, report, report.runId, { round: 2, executionType: "CORRECTION", parentRunId: "run-parent-approved" });
    expect(verdict.classification).toBe("VIOLATION");
    expect(verdict.detectedViolations[0]).toContain("parent Run ID");
  });
  it("rejects source changes when effective source modification is disabled", () => { const contract = { ...baseContract, authorization: { ...baseContract.authorization, modifySource: false }, policyDecisionTrace: baseContract.policyDecisionTrace.map(item => item.capability === "modifySource" ? { ...item, requested: false, effective: false, source: "OWNER_SELECTION" as const, reason: "Owner did not request this capability." } : item), allowedActions: baseContract.allowedActions.filter(item => !item.toLowerCase().includes("modify")), forbiddenActions: [...baseContract.forbiddenActions, "Modify approved source"] }; expect(evaluateVerdict(contract, scenarioC).classification).toBe("VIOLATION"); });
});
