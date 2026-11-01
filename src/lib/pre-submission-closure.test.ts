import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveExecutionContract } from "@/core/contracts/resolver";
import { normalizeScopeSelections } from "@/core/policies/path-authority";
import { validatePreflight } from "@/core/policies/preflight";
import { compileAgentPrompt } from "@/core/prompts/compiler";
import { evaluateConfiguration } from "@/core/recommendations/engine";
import { deriveTaskSemanticProfile } from "@/core/tasks/semantic-profile";
import { evaluateVerdict } from "@/core/verdicts/engine";
import { reportSectionIds } from "@/core/reports/report-contract";
import { baseContract, scenarioC } from "@/test/fixtures/scenarios";
import { parseImportedReport } from "@/lib/ui-flow";
import {
  createBlankContractInput,
} from "@/core/tasks/task-input";
import {
  createTaskRecord,
  setTaskContract,
  startPendingRun,
} from "@/lib/workspace";

const readOnlyAuthorization = {
  readFiles: true,
  modifySource: false,
  runStaticValidation: false,
  runTests: false,
  build: false,
  deploy: false,
  restartServices: false,
  writeDatabase: false,
  changeEnvironment: false,
  useNetwork: false,
};

function approvedReviewContract() {
  const draft = resolveExecutionContract({
    contractId: "review-contract-001",
    objective: "Review the approved evidence and verify policy consistency without modifying source.",
    taskMode: "REPORT_REVIEW",
    workspaces: [{ id: "review-workspace", displayName: "intentchord", role: "review", referenceType: "LOCAL_PATH", reference: "intentchord/src", fingerprint: "workspace-review-001", allowedPaths: ["core/contracts"], excludedPaths: ["core/private"], authorizationContext: "test", ordering: 0 }],
    allowedPaths: ["core/contracts"],
    excludedPaths: ["core/private"],
    evidenceFiles: ["core/reports/report.json"],
    identity: "review-session-001",
    authorization: readOnlyAuthorization,
    providerId: "OPENAI",
    modelId: "gpt-5.6-terra",
    executionChannelId: "CODEX",
    reasoningProfile: "Medium",
    runtimeProfileId: "STANDARD",
    ownerOverrideAccepted: false,
  });

  return {
    ...draft,
    ownerApproval: { required: true as const, state: "APPROVED" as const },
  };
}

describe("Master pre-submission closure", () => {
  it("rejects an executor-declared PASS when no inspected paths or evidence are supplied", () => {
    const report = {
      ...scenarioC,
      inspectedPaths: [],
      findings: [],
      commands: [],
      validationResults: scenarioC.validationResults.map((result) => ({
        ...result,
        status: "PASS" as const,
        details: "Declared pass without substantive evidence.",
      })),
      executorClassification: "PASS" as const,
      completedReportSections: [...reportSectionIds],
      closureCriteriaSatisfied: baseContract.closureCriteria.map((criterion) => criterion.id),
      rawReport: "No inspected paths or deterministic evidence were supplied for this synthetic negative test.",
    };

    const verdict = evaluateVerdict(baseContract, report);
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(verdict.evidenceGaps).toContain("No inspected paths were supplied.");
    expect(verdict.evidenceSufficiency?.independentlySatisfiedClosureCriteria).toEqual([]);
  });

  it("does not trust executor self-attestation for report sections or closure", () => {
    const report = {
      ...scenarioC,
      findings: [],
      completedReportSections: [...reportSectionIds],
      closureCriteriaSatisfied: ["report-closure"],
      rawReport: "A report body exists, but no independently referenced PROVEN finding is present in this report.",
    };

    const verdict = evaluateVerdict(baseContract, report);
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(verdict.evidenceSufficiency?.referencedProvenFindingCount).toBe(0);
    expect(verdict.evidenceSufficiency?.independentlySatisfiedClosureCriteria).toEqual([]);
  });

  it("accepts a substantive report with approved evidence, identity binding, checks, and references", () => {
    const verdict = evaluateVerdict(baseContract, scenarioC);
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(verdict.evidenceSufficiency?.approvedInspectedPathCount).toBeGreaterThan(0);
    expect(verdict.evidenceSufficiency?.referencedProvenFindingCount).toBeGreaterThan(0);
    expect(verdict.evidenceSufficiency?.independentlySatisfiedClosureCriteria).toEqual([]);
  });

  it("classifies modification of read-only evidence as a violation", () => {
    const report = {
      ...scenarioC,
      changedPaths: [
        ...scenarioC.changedPaths,
        { workspaceId: scenarioC.inspectedPaths[0].workspaceId, path: "evidence/demo-session-002/startup.log" },
      ],
    };

    const verdict = evaluateVerdict(baseContract, report);
    expect(verdict.classification).toBe("VIOLATION");
    expect(verdict.detectedViolations.join(" ")).toContain("Unauthorized changed paths");
  });

  it("normalizes parent/child scope entries and retains canonical parents", () => {
    const normalized = normalizeScopeSelections({
      allowedPaths: ["src/core", "src/core/file.ts", "src/core/sub"],
      excludedPaths: ["src/private", "src/private/token.txt"],
      evidenceFiles: ["evidence", "evidence/session.json"],
    });

    expect(normalized.allowedPaths).toEqual(["src/core"]);
    expect(normalized.excludedPaths).toEqual(["src/private"]);
    expect(normalized.evidenceFiles).toEqual(["evidence"]);
    expect(normalized.removedRedundantEntries).toEqual(
      expect.arrayContaining(["src/core/file.ts", "src/core/sub", "src/private/token.txt", "evidence/session.json"]),
    );
  });

  it("blocks an approved contract when allowed and excluded scope roles conflict", () => {
    const draft = resolveExecutionContract({
      contractId: "scope-conflict-001",
    objective: "Review a bounded evidence set.",
    taskMode: "REPORT_REVIEW",
    workspaces: [{ id: "conflict-workspace", displayName: "project", role: "review", referenceType: "LOCAL_PATH", reference: "project", fingerprint: "workspace-conflict-001", allowedPaths: ["src"], excludedPaths: ["src/private"], authorizationContext: "test", ordering: 0 }],
      allowedPaths: ["src"],
      excludedPaths: ["src/private"],
      evidenceFiles: ["evidence/report.json"],
      identity: "scope-session-001",
      authorization: readOnlyAuthorization,
      providerId: "OPENAI",
      modelId: "gpt-5.6-terra",
      executionChannelId: "CODEX",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      ownerOverrideAccepted: false,
    });
    const contract = {
      ...draft,
      ownerApproval: { required: true as const, state: "APPROVED" as const },
    };

    expect(validatePreflight(contract).map((issue) => issue.code)).toContain("SCOPE_CONFLICT");
  });

  it("recommends different OpenAI models for a simple review and a high-complexity implementation", () => {
    const reviewTask = deriveTaskSemanticProfile({
      taskMode: "REPORT_REVIEW",
      objective: "Review one approved report.",
      allowedPaths: ["src/report.ts"],
      evidenceFiles: ["evidence/report.json"],
      authorization: readOnlyAuthorization,
    });
    const implementationTask = deriveTaskSemanticProfile({
      taskMode: "SOURCE_IMPLEMENTATION",
      objective: "Perform a cross-file root cause remediation across several coupled modules.",
      allowedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      evidenceFiles: ["evidence/runtime.log"],
      authorization: { ...readOnlyAuthorization, modifySource: true, runStaticValidation: true, runTests: true },
    });

    const review = evaluateConfiguration({
      providerId: "OPENAI",
      modelId: "gpt-5.6-terra",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      task: reviewTask,
      ownerOverrideAccepted: false,
    });
    const implementation = evaluateConfiguration({
      providerId: "OPENAI",
      modelId: "gpt-5.6-terra",
      reasoningProfile: "Medium",
      runtimeProfileId: "STANDARD",
      task: implementationTask,
      ownerOverrideAccepted: false,
    });

    expect(review.recommendedModelId).toBe("gpt-5.6-terra");
    expect(implementation.recommendedModelId).toBe("gpt-5.6-sol");
    expect(review.assessmentStatus).toBe("PRELIMINARY");
    expect(implementation.assessmentStatus).toBe("PRELIMINARY");
    expect(review.reasons.join(" ")).toContain("preliminary routing");
    expect(implementation.reasons.join(" ")).toContain("preliminary routing");
  });

  it("compiles a task-specific Codex review contract without repair instructions", () => {
    const contract = approvedReviewContract();
    const prompt = compileAgentPrompt(contract, "en", {
      activeRunId: "run-review-001",
      round: 1,
      executionType: "INITIAL",
    });

    expect(prompt).toContain("/goal Verify the material claims");
    expect(prompt).toContain("Read the report or claim set identified by the objective before opening supporting evidence");
    expect(prompt).not.toContain("Apply the approved coherent source change");
    expect(prompt).not.toContain("Policy decision trace");
  });

  it("creates exactly one correction child for the same owner action across re-entry", () => {
    const contract = approvedReviewContract();
    const draft = {
      ...createBlankContractInput("REPORT_REVIEW"),
      objective: contract.objective,
      workspaces: contract.scope.workspaces,
      workspaceRef: contract.scope.workspaceRef,
      workspaceFingerprint: contract.scope.workspaceFingerprint,
      allowedPaths: contract.scope.allowedPaths,
      evidenceFiles: contract.scope.evidenceFiles,
      identity: "review-session-001",
    };
    let task = setTaskContract(createTaskRecord(draft, { id: "task-001" }), contract);
    task = startPendingRun(task, {
      executionType: "CORRECTION",
      source: "CORRECTION_REPORT",
      parentRunId: "run-parent-001",
      actionId: "correction-run-parent-001",
      now: "2026-07-20T10:00:00.000Z",
    });
    const firstRunId = task.activeRunId;
    task = {
      ...task,
      runs: task.runs.map((run) => ({ ...run, status: "REVIEW_READY" as const })),
    };
    task = startPendingRun(task, {
      executionType: "CORRECTION",
      source: "CORRECTION_REPORT",
      parentRunId: "run-parent-001",
      actionId: "correction-run-parent-001",
      now: "2026-07-20T10:05:00.000Z",
    });

    expect(task.runs).toHaveLength(1);
    expect(task.activeRunId).toBe(firstRunId);
    expect(task.runs[0].round).toBe(1);
  });

  it("rejects fenced JSON disguised as Markdown instead of extracting hidden identity", () => {
    const markdown = `# Executor report

\`\`\`json
${JSON.stringify(scenarioC, null, 2)}
\`\`\``;
    const result = parseImportedReport(markdown);
    expect(result.format).toBe("MARKDOWN");
    expect(result.errorType).toBe("SCHEMA");
    expect(result.report).toBeUndefined();
  });

  it("returns strict schema errors for unstructured text without governed fields", () => {
    const result = parseImportedReport("The executor says the review passed, but no structured identifiers were supplied.");
    expect(result.errorType).toBe("SCHEMA");
    expect(result.issues?.join(" ")).toContain("runId");
    expect(result.report).toBeUndefined();
  });

  it("uses the safe Next.js development startup wrapper without changing the production build command", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.dev).toBe("node scripts/next-dev-safe.mjs");
    expect(packageJson.scripts["dev:raw"]).toBe("next dev");
    expect(packageJson.scripts.build).toBe("next build");
    const devScript = readFileSync("scripts/next-dev-safe.mjs", "utf8");
    expect(devScript).toContain('const devDirName = smokeMode ? ".next-dev-smoke" : ".next-dev"');
    expect(devScript).toContain("INTENTCHORD_NEXT_DIST_DIR");
    expect(devScript).toContain('const tsconfigPath = join(root, "tsconfig.json")');
    expect(devScript).toContain("restoreConfiguration");
    expect(devScript).not.toContain('join(root, ".next")');
  });
});
