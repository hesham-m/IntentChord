import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/(protected)/page";
import NewTask from "@/app/(protected)/tasks/new/page";
import { ProductPreferencesProvider } from "@/components/product-preferences-provider";
import { createBlankContractInput } from "@/core/tasks/task-input";
import {
  approvalState,
  buildDraftContract,
  compiledPrompt,
  parseImportedReport,
} from "@/lib/ui-flow";

const baseContractInput = createBlankContractInput("SOURCE_IMPLEMENTATION");
const validInput = {
  ...baseContractInput,
  modelOverrideAccepted: true,
  executionSetup: {
    ...baseContractInput.executionSetup!,
    modelOverrideAccepted: true,
  },
  objective: "Validate the supplied startup runtime evidence.",
  workspaceRef: "test-project",
  workspaceSource: "MANUAL_UNVERIFIED" as const,
  allowedPaths: ["src/startup.ts"],
  excludedPaths: ["config/"],
  evidenceFiles: ["evidence/test-session-002/startup.log"],
  identity: "test-session-002",
  runTests: true,
};

describe("IntentChord local UI flow", () => {
  it("explains the first-use journey with one obvious starting action", () => {
    const home = renderToStaticMarkup(<ProductPreferencesProvider><Home /></ProductPreferencesProvider>);
    expect(home).toContain("What do you want IntentChord to help you accomplish?");
    expect(home).toContain("Start a new task");
    expect(home).toContain('href="/tasks/new"');
    expect(home).toContain("Tell IntentChord what you need");
    expect(home).toContain("Review what IntentChord understood");
    expect(home).toContain("Follow the work to a verified decision");
    expect(home).toContain("Open work");
    expect(home).toContain("/intentchord-assets/intentchord-horizontal-color.webp");
  });



  it("keeps Home and New Task in one objective-first product journey", () => {
    const home = renderToStaticMarkup(
      <ProductPreferencesProvider initialLocale="en" initialTheme="light"><Home /></ProductPreferencesProvider>,
    );
    const newTask = renderToStaticMarkup(
      <ProductPreferencesProvider initialLocale="en" initialTheme="light"><NewTask /></ProductPreferencesProvider>,
    );

    expect(home).toContain('data-product-view="home"');
    expect(home).toContain('data-journey-stage="objective"');
    expect(newTask).toContain('data-product-view="new-task"');
    expect(newTask).toContain('data-product-journey="objective-first"');
    expect(newTask).toContain('data-journey-stage="objective"');
    expect(newTask).toContain('data-primary-action="objective-input"');
    expect(newTask.indexOf('data-primary-action="objective-input"')).toBeLessThan(
      newTask.indexOf('data-guided-control="work-type"'),
    );
    expect(newTask).toContain('data-disclosure="success-conditions"');
    expect(newTask).toContain('data-disclosure="requested-authorization"');
    expect(newTask).not.toContain("Build a bounded contract");
  });

  it("renders the Arabic journey from the shared root preference without an English route default", () => {
    const home = renderToStaticMarkup(
      <ProductPreferencesProvider initialLocale="ar" initialTheme="dark"><Home /></ProductPreferencesProvider>,
    );
    const newTask = renderToStaticMarkup(
      <ProductPreferencesProvider initialLocale="ar" initialTheme="dark"><NewTask /></ProductPreferencesProvider>,
    );

    expect(home).toContain("ماذا تريد من IntentChord أن يساعدك فيه؟");
    expect(newTask).toContain("اكتب ما تحتاجه");
    expect(home).toContain('dir="rtl"');
    expect(newTask).toContain('data-theme="dark"');
    expect(newTask).not.toContain("Start with the outcome");
  });

  it("builds an approvable contract and compiles all governed sections", () => {
    const contract = buildDraftContract(validInput, "run-test")!;
    expect(approvalState(contract).canApprove).toBe(true);
    const prompt = compiledPrompt(contract);
    expect(prompt).toContain("Forbidden actions");
    expect(prompt).toContain("Evidence files");
    expect(prompt).toContain("Closure criteria");
    expect(prompt).toContain("Owner approval");
  });

  it("does not approve a contradictory audit contract", () => {
    const invalid = buildDraftContract({ ...validInput, taskMode: "CONTROLLED_AUDIT", modifySource: true }, "run-test")!;
    expect(approvalState(invalid).canApprove).toBe(false);
  });

  it("distinguishes JSON syntax from report schema errors", () => {
    expect(parseImportedReport("{").errorType).toBe("SYNTAX");
    expect(parseImportedReport("{}").errorType).toBe("SCHEMA");
    expect(parseImportedReport("{}").issues?.join(" ")).toContain("runId");
  });


});
