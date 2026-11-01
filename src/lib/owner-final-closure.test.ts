import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createBlankContractInput,
  transitionTaskMode,
} from "@/core/tasks/task-input";
import {
  approvalState,
  buildDraftContract,
  parseImportedReport,
} from "@/lib/ui-flow";

function validReviewInput() {
  return {
    ...createBlankContractInput("REPORT_REVIEW"),
    objective: "Review one approved report and verify its evidence without source modification.",
    workspaceRef: "intentchord",
    workspaceSource: "MANUAL_UNVERIFIED" as const,
    workspaceFingerprint: "workspace-owner-final-001",
    allowedPaths: ["src/core/contracts/"],
    evidenceFiles: ["reports/review.md"],
    identity: "owner-final-session-001",
  };
}

describe("owner-directed final closure", () => {
  it("reconciles REPORT_REVIEW to readFiles-only authorization when the task mode changes", () => {
    const initial = {
      ...createBlankContractInput("SOURCE_IMPLEMENTATION"),
      readFiles: true,
      modifySource: true,
      runStaticValidation: true,
      runTests: true,
      build: true,
    };

    const review = transitionTaskMode(initial, "REPORT_REVIEW");
    expect(review.readFiles).toBe(true);
    expect(review.modifySource).toBe(false);
    expect(review.runStaticValidation).toBe(false);
    expect(review.runTests).toBe(false);
    expect(review.build).toBe(false);
  });

  it("treats owner approval as the next workflow action rather than a visible preflight defect", () => {
    const contract = buildDraftContract(validReviewInput(), "owner-final-contract-r1")!;
    const state = approvalState(contract);

    expect(state.issues.map(issue => issue.code)).not.toContain("MISSING_OWNER_APPROVAL");
    expect(state.canApprove).toBe(true);
    expect(state.canExecute).toBe(false);
  });

  it("never injects governed active-run identity into an incomplete Markdown report", () => {
    const contract = {
      ...buildDraftContract(validReviewInput(), "owner-final-contract-r1")!,
      ownerApproval: { required: true as const, state: "APPROVED" as const },
    };
    const parsed = parseImportedReport(
      "# Execution summary\n\nThe executor supplied no canonical governed headers or report sections.",
      {
        contractId: contract.contractId,
        runId: "run-owner-final-001",
        round: 1,
        executionType: "INITIAL",
        executorName: contract.agentResolution.executionChannelName,
        providerId: contract.selectedConfiguration.providerId,
        modelId: contract.selectedConfiguration.modelId,
        executionChannelId: contract.selectedConfiguration.executionChannelId,
        reasoningProfile: contract.selectedConfiguration.reasoningProfile,
        runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
        evidenceIdentity: contract.evidenceIdentity,
      },
    );

    expect(parsed.errorType).toBe("SCHEMA");
    expect(parsed.format).toBe("MARKDOWN");
    expect(parsed.report).toBeUndefined();
    expect(parsed.boundFields).toEqual([]);
    expect(parsed.issues?.join(" ")).toContain("contractId");
  });

  it("renders the current governed wizard order, explicit Task context, and distinct uploaded evidence", () => {
    const source = readFileSync("src/components/workflow-app.tsx", "utf8");
    const stepLabelsBlock = source.match(/const stepLabels = \[([\s\S]*?)\];/)?.[1] ?? "";
    const objective = stepLabelsBlock.indexOf('text("Objective and context", "الهدف والسياق")');
    const workspace = stepLabelsBlock.indexOf('text("Workspace and scope", "مساحة العمل والنطاق")');
    const policy = stepLabelsBlock.indexOf('text("Authorization", "الصلاحيات")');
    const model = stepLabelsBlock.indexOf('text("Task execution setup", "إعداد تنفيذ المهمة")');
    const review = stepLabelsBlock.indexOf('text("Review", "المراجعة")');

    expect(objective).toBeGreaterThan(-1);
    expect(objective).toBeLessThan(workspace);
    expect(workspace).toBeLessThan(policy);
    expect(policy).toBeLessThan(model);
    expect(model).toBeLessThan(review);
    expect(source).toContain('data-journey-stage="objective"');
    expect(source).toContain('data-guided-control="task-context"');
    expect(source).toContain('value="INDEPENDENT"');
    expect(source).toContain('value="PROJECT_BOUND"');
    expect(source).toContain("Requested authorization");
    expect(source).toContain("Tell IntentChord what you need");
    expect(source).toContain('data-guided-control="work-type"');
    expect(source).toContain('data-disclosure="success-conditions"');
    expect(source).toContain("progressive-disclosure");
    expect(source).toContain("Uploaded external evidence");
    expect(source).toContain("Optional preselected supporting evidence · read only");
  });

  it("uses a fluid Main Canvas and complete light/dark design tokens", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const shellCss = readFileSync("src/components/product-shell.module.css", "utf8");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--surface-raised:");
    expect(css).toContain("--success-soft:");
    expect(shellCss).toMatch(/\.canvasInner\s*\{[\s\S]*width:\s*100%;[\s\S]*max-width:\s*none;/);
    expect(shellCss).toContain('.shell[data-theme="dark"]');
    expect(shellCss).toContain(".iconButton");
    expect(shellCss).toContain(".bodyCollapsed");
  });
});
