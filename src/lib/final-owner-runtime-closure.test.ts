import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePreflight } from "@/core/policies/preflight";
import { compileAgentPrompt } from "@/core/prompts/compiler";
import { reportBindingMarker } from "@/core/prompts/governance";
import { formatTechnicalDate } from "@/components/workflow-app";
import { createBlankContractInput } from "@/core/tasks/task-input";
import { evaluateVerdict, type Verdict } from "@/core/verdicts/engine";
import { baseContract } from "@/test/fixtures/scenarios";
import { authoritativeMarkdown, makeAuthoritativeReport } from "@/test/authoritative-report";
import { approveContract, buildDraftContract, parseImportedReport } from "@/lib/ui-flow";
import {
  activeRun,
  appendRun,
  canRecordOwnerDecision,
  createRunRecord,
  createTaskRecord,
  setTaskContract,
  startPendingRun,
} from "@/lib/workspace";

function reviewWithoutEvidence() {
  const input = {
    ...createBlankContractInput("REPORT_REVIEW"),
    objective: "Verify the material claims in the approved CPU topology report.",
    workspaceRef: "ExampleOrganization",
    workspaceSource: "MANUAL_UNVERIFIED" as const,
    workspaceFingerprint: "workspace-final-owner-runtime",
    allowedPaths: ["local ai/AI-Local-CPU-Socket-Load.txt"],
    excludedPaths: [],
    evidenceFiles: [],
    identity: "cpu-topology-report-001",
  };
  return approveContract(buildDraftContract(input, "contract-final-owner-runtime")!).contract!;
}

function nonPassVerdict(classification: Verdict["classification"] = "EVIDENCE_REQUIRED"): Verdict {
  return {
    classification,
    acceptedFacts: [],
    detectedViolations: [],
    evidenceGaps: ["Independent evidence is missing."],
    unsupportedClaims: [],
    contractComplianceSummary: "Evidence is incomplete.",
    nextAction: "Provide the missing evidence.",
    ownerDecisionState: "OWNER_DECISION_REQUIRED",
  };
}

describe("final owner runtime closure", () => {
  it("allows REPORT_REVIEW without forcing unrelated supporting evidence", () => {
    const contract = reviewWithoutEvidence();
    const codes = validatePreflight(contract).map(issue => issue.code);
    expect(codes).not.toContain("MISSING_EVIDENCE_SOURCE");
    expect(contract.requiredChecks.map(check => check.id)).toEqual(["contract-validation"]);
    expect(compileAgentPrompt(contract, "en")).toContain("Missing supporting evidence does not block contract creation");
  });

  it("blocks generic owner objectives before approval", () => {
    const contract = buildDraftContract({
      ...createBlankContractInput("REPORT_REVIEW"),
      objective: "test",
      workspaceRef: "ExampleOrganization",
      workspaceSource: "MANUAL_UNVERIFIED",
      workspaceFingerprint: "workspace-generic-goal",
      allowedPaths: ["local ai/report.md"],
      identity: "generic-goal-report",
    }, "contract-generic-goal")!;
    expect(validatePreflight(contract).map(issue => issue.code)).toContain("CONTRACT_LINT_MISSING_BOUNDED_GOAL");
  });

  it("blocks task-mode aliases and identifier-only objectives semantically", () => {
    for (const objective of ["report_review", "report review", "review files", "check_report"]) {
      const contract = buildDraftContract({
        ...createBlankContractInput("REPORT_REVIEW"),
        objective,
        workspaceRef: "ExampleOrganization",
        workspaceSource: "MANUAL_UNVERIFIED",
        workspaceFingerprint: "workspace-semantic-generic-goal",
        allowedPaths: ["local ai/report.md"],
        identity: "semantic-generic-goal-report",
      }, `contract-${objective.replaceAll(" ", "-")}`)!;
      expect(validatePreflight(contract).map(issue => issue.code)).toContain("CONTRACT_LINT_MISSING_BOUNDED_GOAL");
    }
  });

  it("parses the exact canonical Markdown contract but keeps executor-only closure EVIDENCE_REQUIRED", () => {
    const runId = "run-positive-binding-001";
    const marker = reportBindingMarker(baseContract.contractId, runId, 1);
    const report = makeAuthoritativeReport(baseContract, { runId, bindingMarker: marker });
    const parsed = parseImportedReport(authoritativeMarkdown(report), {
      contractId: baseContract.contractId,
      runId,
      round: 1,
      executionType: "INITIAL",
      executorName: baseContract.agentResolution.executionChannelName,
      providerId: baseContract.selectedConfiguration.providerId,
      modelId: baseContract.selectedConfiguration.modelId,
      executionChannelId: baseContract.selectedConfiguration.executionChannelId,
      reasoningProfile: baseContract.selectedConfiguration.reasoningProfile,
      runtimeProfileId: baseContract.selectedConfiguration.runtimeProfileId,
      bindingMarker: marker,
      evidenceIdentity: baseContract.evidenceIdentity,
    });
    expect(parsed.errorType).toBeUndefined();
    expect(parsed.report?.bindingMarker).toBe(marker);
    expect(parsed.report?.inspectedPaths[0]).toMatchObject({ workspaceId: baseContract.scope.workspaces[0].id });
    const verdict = evaluateVerdict(baseContract, parsed.report!, runId, { round: 1, executionType: "INITIAL", bindingMarker: marker });
    expect(verdict.reportProvenance?.status).toBe("REPORT_BINDING_VERIFIED");
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
  });

  it("rejects Markdown that omits the canonical binding and governed report headers", () => {
    const parsed = parseImportedReport("## [IC-SECTION:executive-summary] Executive summary\nSubstantive but unbound content.");
    expect(parsed.errorType).toBe("SCHEMA");
    expect(parsed.report).toBeUndefined();
    expect(parsed.issues?.join(" ")).toContain("bindingMarker");
  });

  it("accepts only the exact canonical binding header and exact marker value", () => {
    const runId = "run-exact-binding-001";
    const marker = reportBindingMarker(baseContract.contractId, runId, 1);
    const report = makeAuthoritativeReport(baseContract, { runId, bindingMarker: marker });
    const canonical = parseImportedReport(authoritativeMarkdown(report));
    expect(canonical.report?.bindingMarker).toBe(marker);

    const nonCanonical = authoritativeMarkdown(report).replace("IntentChord Binding:", "Report Binding —");
    const rejected = parseImportedReport(nonCanonical);
    expect(rejected.errorType).toBe("SCHEMA");
    expect(rejected.report).toBeUndefined();
  });

  it("issues a unique binding marker for every correction child while preserving parent lineage", () => {
    const contract = reviewWithoutEvidence();
    let task = setTaskContract(createTaskRecord({
      ...createBlankContractInput("REPORT_REVIEW"),
      objective: contract.objective,
      workspaceRef: contract.scope.workspaceRef,
      workspaceSource: contract.scope.workspaceSource,
      workspaceFingerprint: contract.scope.workspaceFingerprint,
      allowedPaths: contract.scope.allowedPaths,
      identity: contract.evidenceIdentity.sessionId ?? "binding-lineage",
    }, { id: "task-binding-lineage" }), contract);
    const parent = createRunRecord({ contract, source: "IMPORTED_REPORT", round: 1, id: "run-binding-parent" });
    task = appendRun(task, parent);
    task = startPendingRun(task, { executionType: "CORRECTION", source: "CORRECTION_REPORT", parentRunId: parent.id, actionId: "correction-binding-lineage" });
    const child = activeRun(task)!;
    expect(child.round).toBe(2);
    expect(child.parentRunId).toBe(parent.id);
    expect(child.bindingMarker).not.toBe(parent.bindingMarker);
    const prompt = compileAgentPrompt(contract, "ar", {
      activeRunId: child.id,
      round: child.round,
      executionType: child.executionType,
      parentRunId: child.parentRunId,
      bindingMarker: child.bindingMarker,
      correctionGaps: ["No inspected paths were supplied."],
    });
    expect(prompt).toContain(child.bindingMarker);
    expect(prompt).toContain(parent.id);
  });

  it("reentry with the same correction action reuses the same child instead of creating a duplicate", () => {
    const contract = reviewWithoutEvidence();
    let task = setTaskContract(createTaskRecord({
      ...createBlankContractInput("REPORT_REVIEW"),
      objective: contract.objective,
      workspaceRef: contract.scope.workspaceRef,
      workspaceSource: contract.scope.workspaceSource,
      workspaceFingerprint: contract.scope.workspaceFingerprint,
      allowedPaths: contract.scope.allowedPaths,
      identity: contract.evidenceIdentity.sessionId ?? "binding-reentry",
    }, { id: "task-binding-reentry" }), contract);
    const parent = createRunRecord({ contract, source: "IMPORTED_REPORT", round: 1, id: "run-binding-initial" });
    task = appendRun(task, parent);
    task = startPendingRun(task, {
      executionType: "CORRECTION",
      source: "CORRECTION_REPORT",
      parentRunId: parent.id,
      actionId: `correction-${parent.id}`,
    });
    const child = activeRun(task)!;
    task = startPendingRun(task, {
      executionType: "CORRECTION",
      source: "CORRECTION_REPORT",
      parentRunId: parent.id,
      actionId: `correction-${parent.id}`,
    });
    expect(activeRun(task)?.id).toBe(child.id);
    expect(activeRun(task)?.bindingMarker).toBe(child.bindingMarker);
    expect(task.runs.filter(run => run.executionType === "CORRECTION")).toHaveLength(1);
  });

  it("enforces explicit owner override semantics in the domain layer", () => {
    const run = createRunRecord({
      contract: baseContract,
      source: "IMPORTED_REPORT",
      round: 1,
      report: undefined,
      verdict: nonPassVerdict(),
      id: "run-owner-override-001",
    });
    expect(canRecordOwnerDecision(run, "ACCEPTED")).toBe(false);
    expect(canRecordOwnerDecision(run, "ACCEPTED_WITH_OVERRIDE")).toBe(false);
    expect(canRecordOwnerDecision({ ...run, correctionNotes: "Owner accepts the documented evidence gap for this demo only." }, "ACCEPTED_WITH_OVERRIDE")).toBe(true);
  });

  it("uses correct preview phases and complete Arabic contract copy", () => {
    const contract = reviewWithoutEvidence();
    const preview = compileAgentPrompt(contract, "ar");
    expect(preview).toContain("OWNER_APPROVED_AWAITING_ACTIVE_RUN");
    expect(preview).toContain("تمت موافقة المالك");
    expect(preview).toContain("قراءة الملفات المعتمدة");
    expect(preview).toContain("نفّذ هدف /goal واحدًا ومحددًا");
    expect(preview).not.toContain("لا تنفذ حتى موافقة المالك");
  });

  it("isolates development output from the production .next directory", () => {
    const config = readFileSync("next.config.ts", "utf8");
    const script = readFileSync("scripts/next-dev-safe.mjs", "utf8");
    expect(config).toContain("INTENTCHORD_NEXT_DIST_DIR");
    expect(script).toContain('const devDirName = smokeMode ? ".next-dev-smoke" : ".next-dev"');
    expect(script).toContain("--intentchord-smoke");
    expect(script).toContain("restoreConfiguration");
    expect(script).toContain('const tsconfigPath = join(root, "tsconfig.json")');
    expect(script).toContain("HTTP_TASKS: PASS");
    expect(script).toContain("INTENTCHORD_DEV_SMOKE: PASS");
    expect(script).not.toContain('join(root, ".next")');
    expect(script).not.toContain("production build artifacts detected");
  });

  it("presents the executing agent first and labels historical test fixtures honestly", () => {
    const source = readFileSync("src/components/workflow-app.tsx", "utf8");
    expect(source).toContain("selected-agent-panel");
    expect(source).toContain("Optional comparison with other agents");
    expect(source).toContain("HISTORICAL TEST DATA · FIXTURE");
    expect(source).toContain("Optional preselected supporting evidence · read only");
  });

  it("renders deterministic LTR timestamps and explicit authority-boundary semantics", () => {
    expect(formatTechnicalDate("2026-07-21T17:35:07.000Z")).toMatch(/^2026-07-21 \d{2}:35:07 (AM|PM)$/);
    const source = readFileSync("src/components/workflow-app.tsx", "utf8");
    const compiler = readFileSync("src/core/prompts/compiler.ts", "utf8");
    expect(source).not.toContain("Selected paths are an authorization boundary—not proof of relevance or completeness.");
    expect(compiler).toContain("authority boundary, not proof that they are complete, sufficient, or relevant");
    expect(compiler).toContain("هذه المسارات حدود تفويض، وليست إثباتًا بأنها كاملة أو كافية أو مرتبطة بالسبب الجذري");
    expect(compiler).toContain("نطاق التعديل المصرح");
    expect(compiler).toContain("stop with EVIDENCE_REQUIRED and name the exact path");
  });

  it("positions IntentChord as governance rather than a prompt generator", () => {
    const readme = readFileSync("README.md", "utf8");
    const positioning = readFileSync("docs/IC_SUBMISSION_POSITIONING_AND_SCOPE_SEMANTICS.md", "utf8");
    expect(readme).toContain("not merely a prompt generator");
    expect(readme).toContain("Scope means authority, not relevance proof");
    expect(positioning).toContain("governance and evidence layer");
    expect(positioning).toContain("final human decision");
  });

  it("keeps compact approved product branding separate from the RTL-safe run ledger", () => {
    const shell = readFileSync("src/components/product-shell.tsx", "utf8");
    const shellCss = readFileSync("src/components/product-shell.module.css", "utf8");
    const source = readFileSync("src/components/workflow-app.tsx", "utf8");
    const css = readFileSync("src/app/globals.css", "utf8");
    const identityManifest = JSON.parse(readFileSync("docs/architecture/INTENTCHORD_APPROVED_IDENTITY_ASSET_MANIFEST_2026_07_29.json", "utf8")) as { approved_tagline: string };
    expect(shell).toContain("/intentchord-assets/intentchord-horizontal-color.webp");
    expect(shell).toContain("priority unoptimized");
    expect(identityManifest.approved_tagline).toBe("هدف واضح • تنفيذ منضبط • نتائج قابلة للتحقق");
    expect(shell).not.toContain(identityManifest.approved_tagline);
    expect(shellCss).toContain(".brand");
    expect(source).toContain("task-group-metrics");
    expect(source).toContain("run-card-technical");
    expect(source).toContain("technical-date");
    expect(source).toContain("No report imported yet");
    expect(source).toContain("latestDecisionRun");
    expect(source).toContain("الفجوات المطلوب إغلاقها فقط");
    expect(source).toContain("معرف المهمة: ${task.id}");
    expect(source).toContain("مساحة العمل: ${contract.scope.workspaceRef}");
    expect(css).toContain(".compact-run-card");
  });
});
