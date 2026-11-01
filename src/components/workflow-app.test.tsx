import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContractWorkbench, PolicyDecisionTrace } from "@/components/workflow-app";
import { baseContract } from "@/test/fixtures/scenarios";
import { translations } from "@/i18n/translations";
import { approveContract, buildDraftContract, type ContractInput } from "@/lib/ui-flow";
import { createBlankContractInput } from "@/core/tasks/task-input";

const baseWorkflowInput = createBlankContractInput("SOURCE_IMPLEMENTATION");
const input: ContractInput = {
  ...baseWorkflowInput,
  modelOverrideAccepted: true,
  executionSetup: {
    ...baseWorkflowInput.executionSetup!,
    modelOverrideAccepted: true,
  },
  objective: "Validate owner binding.",
  workspaceRef: "owner-project",
  workspaceSource: "MANUAL_UNVERIFIED",
  allowedPaths: ["src/owner-binding.ts"],
  excludedPaths: ["config/"],
  evidenceFiles: ["evidence/owner.json"],
  identity: "owner-binding-001",
  runTests: false,
};

describe("PolicyDecisionTrace", () => {
  it("renders all stored decisions without calculating policy results", () => {
    const decisions = baseContract.policyDecisionTrace.map(decision => decision.capability === "build"
      ? { ...decision, requested: true, effective: false, source: "TASK_MODE_POLICY" as const, reason: "Stored contract reason." }
      : decision);
    const html = renderToStaticMarkup(<PolicyDecisionTrace decisions={decisions} copy={translations.en} locale="en" />);
    expect((html.match(/data-testid="policy-decision-/g) ?? [])).toHaveLength(10);
    expect(html).toContain("Requested");
    expect(html).toContain("TASK_MODE_POLICY");
    expect(html).toContain("Stored contract reason.");
  });

  it("renders Arabic labels while preserving technical authority values", () => {
    const html = renderToStaticMarkup(<PolicyDecisionTrace decisions={baseContract.policyDecisionTrace} copy={translations.ar} locale="ar" />);
    expect(html).toContain("سجل قرارات السياسة");
    expect(html).toContain("الجهة الحاكمة");
    expect(html).toContain(baseContract.policyDecisionTrace[0].source);
  });
});

describe("ContractWorkbench", () => {
  it("renders a compact approved summary without an active approval button", () => {
    const contract = approveContract(buildDraftContract(input)!).contract!;
    const html = renderToStaticMarkup(<ContractWorkbench contract={contract} copy={translations.en} locale="en" tab="summary" setTab={() => undefined} approve={() => undefined} prepareExecution={() => undefined} promptLocale="en" setPromptLocale={() => undefined} notice="" continueHref="/runs/current/execute" />);
    expect(html).toContain("Contract Approval");
    expect(html).toContain("APPROVED");
    expect(html).toContain("Continue to Execution");
    expect(html).not.toContain(">Approve Contract<");
  });

  it("renders all Arabic workbench tabs and an independent prompt language selector", () => {
    const contract = approveContract(buildDraftContract(input)!).contract!;
    const html = renderToStaticMarkup(<ContractWorkbench contract={contract} copy={translations.ar} locale="ar" tab="prompt" setTab={() => undefined} approve={() => undefined} prepareExecution={() => undefined} promptLocale="en" setPromptLocale={() => undefined} notice="" continueHref="/runs/current/execute" />);
    for (const label of ["الملخص", "النطاق", "الصلاحيات", "قرارات السياسة", "الفحوص ومعايير الإغلاق", "مطالبة الوكيل"]) expect(html).toContain(label);
    expect(html).toContain("لغة مطالبة الوكيل");
    expect(html).toContain("Approved execution");
    expect(html).toContain("IntentChord Contract Preview");
  });
});
