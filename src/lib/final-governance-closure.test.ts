import { describe, expect, it } from "vitest";
import { agentBehaviorProfile } from "@/core/agents/profiles";
import { lintCompiledPrompt, lintResolvedContract, reportBindingMarker } from "@/core/prompts/governance";
import { compileAgentPrompt, compileOptionalJsonTemplate } from "@/core/prompts/compiler";
import { evaluateVerdict } from "@/core/verdicts/engine";
import { authoritativeMarkdown, makeAuthoritativeReport } from "@/test/authoritative-report";
import { createBlankContractInput, transitionProvider } from "@/core/tasks/task-input";
import { approveContract, buildDraftContract, parseImportedReport, type ContractInput } from "@/lib/ui-flow";
import { createRunRecord, createTaskRecord, recordOwnerDecision, restoreWorkspace, setTaskContract, taskStatus, updateCorrectionNotes } from "@/lib/workspace";

function reviewInput(provider: ContractInput["providerId"] = "OPENAI"): ContractInput {
  const transitioned = transitionProvider(createBlankContractInput("REPORT_REVIEW"), provider);
  return {
    ...transitioned,
    objective: "Verify the approved firewall report against the approved local evidence.",
    workspaceRef: "local-ai",
    workspaceSource: "MANUAL_UNVERIFIED",
    allowedPaths: ["local ai"],
    excludedPaths: [],
    evidenceFiles: ["upload:firewall.txt", "local ai/policy.ps1"],
    identity: "session-final-001",
  };
}

function approvedReview(provider: ContractInput["providerId"] = "OPENAI") {
  return approveContract(buildDraftContract(reviewInput(provider), `contract-${provider.toLowerCase()}-001`)!).contract!;
}

const runContext = {
  activeRunId: "run-final-001",
  round: 1,
  executionType: "INITIAL" as const,
};

describe("final agent-contract and report-provenance closure", () => {
  it("compiles a concise Codex /goal contract with a Context Lease and Markdown-first reporting", () => {
    const contract = approvedReview();
    const prompt = compileAgentPrompt(contract, "en", runContext);
    const marker = reportBindingMarker(contract.contractId, runContext.activeRunId, runContext.round);

    expect(prompt).toContain("/goal Verify the material claims");
    expect(prompt).toContain("Context Lease");
    expect(prompt).toContain(`IntentChord Binding: ${marker}`);
    expect(prompt).toContain("Return structured Markdown by default");
    expect(prompt).not.toMatch(/Return exactly one.*JSON/i);
    expect(prompt).not.toContain('"inspectedPaths": []');
    expect(lintResolvedContract(contract)).toEqual([]);
    expect(lintCompiledPrompt(prompt, contract)).toEqual([]);
  });

  it("blocks contradictory JSON-only and Markdown-by-default report instructions before execution", () => {
    const contract = approvedReview();
    const contradictory = {
      ...contract,
      agentResolution: {
        ...contract.agentResolution,
        reportInstructions: [
          "Return exactly one Executor Report Envelope JSON.",
          "Return a structured Markdown report by default.",
        ],
      },
    };
    expect(lintResolvedContract(contradictory).map(issue => issue.code)).toContain("CONTRADICTORY_OUTPUT_FORMAT");
  });

  it("blocks a Contract that weakens the per-finding trusted-proof rule", () => {
    const contract = approvedReview();
    const weakened = {
      ...contract,
      agentResolution: {
        ...contract.agentResolution,
        reportInstructions: contract.agentResolution.reportInstructions.filter(
          instruction => !instruction.includes("SOURCE_EVIDENCE")
            && !instruction.includes("ARTIFACT_EVIDENCE"),
        ),
      },
    };

    expect(lintResolvedContract(weakened).map(issue => issue.code)).toContain(
      "MISSING_PROVEN_TRUSTED_REFERENCE_RULE",
    );
  });

  it("keeps the optional JSON transport separate and run-bound", () => {
    const contract = approvedReview();
    const template = JSON.parse(compileOptionalJsonTemplate(contract, runContext));
    expect(template.runId).toBe(runContext.activeRunId);
    expect(template.bindingMarker).toBe(reportBindingMarker(contract.contractId, runContext.activeRunId, 1));
    expect(template.executorClassification).toBe("EVIDENCE_REQUIRED");
  });

  it("resolves materially different behavior controls for Codex, Claude Code, and Gemini CLI", () => {
    const codex = agentBehaviorProfile("CODEX").behaviorControls.join(" ");
    const claude = agentBehaviorProfile("CLAUDE_CODE").behaviorControls.join(" ");
    const gemini = agentBehaviorProfile("GEMINI_CLI").behaviorControls.join(" ");
    expect(codex).toContain("bounded /goal");
    expect(codex).toContain("Context Lease");
    expect(claude).toContain("unsolicited improvements");
    expect(claude).toContain("smallest coherent change");
    expect(gemini).toContain("exact order");
    expect(gemini).toContain("Do not skip, merge, substitute, or infer");
  });

  it("extracts exact governed headers, structured paths, findings, proof rows, and checks from canonical Markdown", () => {
    const contract = approvedReview();
    const marker = reportBindingMarker(contract.contractId, runContext.activeRunId, 1);
    const workspaceId = contract.scope.workspaces[0].id;
    const report = makeAuthoritativeReport(contract, {
      runId: runContext.activeRunId,
      bindingMarker: marker,
      inspectedPaths: [
        { workspaceId, path: "local ai" },
        { workspaceId, path: "upload:firewall.txt" },
      ],
    });
    const parsed = parseImportedReport(authoritativeMarkdown(report), {
      contractId: contract.contractId,
      runId: runContext.activeRunId,
      round: 1,
      executionType: "INITIAL",
      executorName: contract.agentResolution.executionChannelName,
      providerId: contract.selectedConfiguration.providerId,
      modelId: contract.selectedConfiguration.modelId,
      executionChannelId: contract.selectedConfiguration.executionChannelId,
      reasoningProfile: contract.selectedConfiguration.reasoningProfile,
      runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
      bindingMarker: marker,
      evidenceIdentity: contract.evidenceIdentity,
    });

    expect(parsed.errorType).toBeUndefined();
    expect(parsed.report?.bindingMarker).toBe(marker);
    expect(parsed.report?.inspectedPaths).toEqual(expect.arrayContaining([
      { workspaceId, path: "local ai" },
      { workspaceId, path: "upload:firewall.txt" },
    ]));
    expect(parsed.report?.findings[0]?.status).toBe("PROVEN");
    expect(parsed.report?.requirementProofs).toHaveLength(contract.executionPackage.mandatoryRequirements.length);
  });

  it("does not inject active-run identity into Markdown without canonical governed headers", () => {
    const contract = approvedReview();
    const parsed = parseImportedReport("## [IC-SECTION:executive-summary] Executive summary\nUnbound report content.", {
      contractId: contract.contractId,
      runId: runContext.activeRunId,
      round: 1,
      executionType: "INITIAL",
      executorName: contract.agentResolution.executionChannelName,
      providerId: contract.selectedConfiguration.providerId,
      modelId: contract.selectedConfiguration.modelId,
      executionChannelId: contract.selectedConfiguration.executionChannelId,
      reasoningProfile: contract.selectedConfiguration.reasoningProfile,
      runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
      evidenceIdentity: contract.evidenceIdentity,
    });
    expect(parsed.errorType).toBe("SCHEMA");
    expect(parsed.report).toBeUndefined();
    expect(parsed.boundFields).toEqual([]);
  });

  it("rejects a canonical report carrying a marker from another run", () => {
    const contract = approvedReview();
    const wrong = reportBindingMarker(contract.contractId, "run-other-999", 1);
    const report = makeAuthoritativeReport(contract, {
      runId: runContext.activeRunId,
      bindingMarker: wrong,
    });
    const parsed = parseImportedReport(authoritativeMarkdown(report));
    const verdict = evaluateVerdict(contract, parsed.report!, runContext.activeRunId, {
      round: 1,
      executionType: "INITIAL",
      bindingMarker: reportBindingMarker(contract.contractId, runContext.activeRunId, 1),
    });
    expect(verdict.classification).toBe("VIOLATION");
    expect(verdict.reportProvenance?.status).toBe("REPORT_RUN_MISMATCH");
  });

  it("migrates an older agent-profile contract without silently preserving approval or active execution", () => {
    const contract = approvedReview();
    const task = setTaskContract(createTaskRecord(reviewInput(), { id: "task-profile-migration", now: "2026-07-20T10:00:00.000Z" }), contract, "2026-07-20T10:01:00.000Z");
    const legacy = {
      version: 4,
      tasks: [{
        ...task,
        contract: { ...contract, agentResolution: { ...contract.agentResolution, profileVersion: "0.2" } },
        activeRunId: "legacy-active-run",
        runs: [{
          id: "legacy-active-run", round: 1, createdAt: "2026-07-20T10:02:00.000Z", updatedAt: "2026-07-20T10:02:00.000Z",
          contractId: contract.contractId, source: "IMPORTED_REPORT", executionType: "INITIAL", status: "AWAITING_REPORT",
          executor: "Codex", agentProfileId: "CODEX", providerId: "OPENAI", modelId: contract.selectedConfiguration.modelId,
          reasoningProfile: contract.selectedConfiguration.reasoningProfile, runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
          executionCompleted: false, decision: "NONE", correctionNotes: "", correctionStarted: false,
        }],
      }],
      activeTaskId: task.id,
    };
    const restored = restoreWorkspace(JSON.stringify(legacy));
    expect(restored.tasks[0].contract?.agentResolution.profileVersion).toBe("0.3");
    expect(restored.tasks[0].contract?.ownerApproval.state).toBe("AWAITING_OWNER_APPROVAL");
    expect(restored.tasks[0].activeRunId).toBeUndefined();
    expect(restored.tasks[0].runs[0].supersededAt).toBeTruthy();
  });

  it("keeps non-PASS acknowledgement open and closes only with an explicit override decision", () => {
    const contract = approvedReview();
    let task = createTaskRecord(reviewInput(), { id: "task-owner-decision", now: "2026-07-20T12:00:00.000Z" });
    task = setTaskContract(task, contract, "2026-07-20T12:01:00.000Z");
    const report = makeAuthoritativeReport(contract, {
      runId: "run-owner-decision",
      executionType: "FIXTURE",
      bindingMarker: "IC-RUN-FIXTURE-OWNER-DECISION",
      inspectedPaths: [],
      findings: [],
      executorClassification: "EVIDENCE_REQUIRED",
      rawReport: "Evidence is incomplete and remains unverified by an independent producer.",
    });
    const verdict = evaluateVerdict(contract, report);
    const run = createRunRecord({ contract, source: "SYNTHETIC_FIXTURE", round: 1, report, verdict, id: "run-owner-decision", now: "2026-07-20T12:02:00.000Z" });
    task = { ...task, activeRunId: run.id, runs: [run] };
    const acknowledged = recordOwnerDecision(task, "ACKNOWLEDGED", "2026-07-20T12:03:00.000Z");
    expect(taskStatus(acknowledged)).toBe("AWAITING_DECISION");
    const rejectedWithoutReason = recordOwnerDecision(acknowledged, "ACCEPTED_WITH_OVERRIDE", "2026-07-20T12:04:00.000Z");
    expect(taskStatus(rejectedWithoutReason)).toBe("AWAITING_DECISION");
    const withReason = updateCorrectionNotes(acknowledged, "Owner accepts this documented evidence gap for the bounded demo only.", "2026-07-20T12:04:30.000Z");
    const overridden = recordOwnerDecision(withReason, "ACCEPTED_WITH_OVERRIDE", "2026-07-20T12:05:00.000Z");
    expect(taskStatus(overridden)).toBe("CLOSED");
  });
});
