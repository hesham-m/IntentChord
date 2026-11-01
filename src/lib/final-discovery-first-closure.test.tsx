import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePreflight } from "@/core/policies/preflight";
import { compileAgentPrompt } from "@/core/prompts/compiler";
import { reportBindingMarker } from "@/core/prompts/governance";
import { boundedObjectiveIssue } from "@/core/tasks/objective-quality";
import { createBlankContractInput } from "@/core/tasks/task-input";
import { evaluateVerdict } from "@/core/verdicts/engine";
import { localizeVerdictText, translations } from "@/i18n/translations";
import { authoritativeMarkdown, makeAuthoritativeReport } from "@/test/authoritative-report";
import { approveContract, buildDraftContract, parseImportedReport } from "@/lib/ui-flow";

function discoveryAudit() {
  const input = {
    ...createBlankContractInput("CONTROLLED_AUDIT"),
    objective: "فحص Sophos ومعرفة لماذا Web Filter لا تعمل",
    workspaceRef: "sophos",
    workspaceSource: "MANUAL_UNVERIFIED" as const,
    workspaceFingerprint: "workspace-discovery-first",
    allowedPaths: ["backup/config-a.txt", "backup/config-b.txt"],
    excludedPaths: [],
    evidenceFiles: [],
    identity: "",
  };
  const result = approveContract(buildDraftContract(input, "contract-discovery-first")!);
  expect(result.issues).toEqual([]);
  return result.contract!;
}


function fullWorkspaceDiscoveryAudit() {
  const input = {
    ...createBlankContractInput("CONTROLLED_AUDIT"),
    title: "Update channel version 1.5.3",
    objective: "Determine why installed version 1.5.3 is absent from Self-Update Readiness.",
    workspaces: [{
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Example Server",
      role: "primary",
      referenceType: "LOCAL_PATH" as const,
      source: "WINDOWS_NATIVE_SELECTOR" as const,
      reference: "E:\\Sample Control Platform workspace\\control-server",
      fingerprint: "sha256:server-path",
      discoveryScopeMode: "FULL_WORKSPACE" as const,
      allowedPaths: [],
      excludedPaths: [],
      authorizationContext: "owner-selected local Workspace",
      ordering: 0,
    }],
  };
  const result = approveContract(buildDraftContract(input, "contract-full-workspace-discovery")!);
  expect(result.issues).toEqual([]);
  return result.contract!;
}

describe("final discovery-first audit and navigation closure", () => {
  it("accepts concise professional diagnostic objectives while rejecting generic aliases", () => {
    expect(boundedObjectiveIssue("فحص Sophos ومعرفة لماذا Web Filter لا تعمل")).toBeUndefined();
    expect(boundedObjectiveIssue("Determine why the Sophos Web Filter is not working")).toBeUndefined();
    expect(boundedObjectiveIssue("update channel version 1.5.3")).toBeUndefined();
    expect(boundedObjectiveIssue("نسخة 1.5.3")).toBeUndefined();
    for (const objective of ["test", "audit", "report_review", "hisham audit"]) {
      expect(boundedObjectiveIssue(objective)).toBeDefined();
    }
  });

  it("allows a controlled audit to start from authorized discovery scope without preselected evidence", () => {
    const contract = discoveryAudit();
    expect(validatePreflight(contract).map(issue => issue.code)).not.toContain("MISSING_EVIDENCE_SOURCE");
    expect(contract.scope.allowedPaths).toHaveLength(2);
    expect(contract.scope.evidenceFiles).toEqual([]);
    expect(contract.authorization.readFiles).toBe(true);
    expect(contract.authorization.runStaticValidation).toBe(false);
    expect(contract.authorization.runTests).toBe(false);
    expect(contract.requiredChecks.map(check => check.id)).toEqual(["contract-validation"]);
  });

  it("removes exact duplicate path roles instead of counting discovery scope as supporting evidence", () => {
    const input = {
      ...createBlankContractInput("CONTROLLED_AUDIT"),
      objective: "Determine why the Sophos Web Filter is not working",
      workspaceRef: "sophos",
      workspaceSource: "MANUAL_UNVERIFIED" as const,
      workspaceFingerprint: "workspace-no-duplicate-evidence",
      allowedPaths: ["backup/config-a.txt"],
      evidenceFiles: ["backup/config-a.txt"],
      identity: "Sophos",
    };
    const contract = buildDraftContract(input, "contract-no-duplicate-evidence")!;
    expect(contract.scope.allowedPaths).toEqual(["backup/config-a.txt"]);
    expect(contract.scope.evidenceFiles).toEqual([]);
    expect(contract.scope.normalization.removedRedundantEntries).toContain("backup/config-a.txt");
  });

  it("compiles discovery-first semantics without duplicating scope as supporting evidence", () => {
    const contract = discoveryAudit();
    const prompt = compileAgentPrompt(contract, "en", {
      activeRunId: "run-discovery-first",
      round: 1,
      executionType: "INITIAL",
    });
    expect(prompt).toContain("without modifying source or expanding beyond the approved authority boundary");
    expect(prompt).toContain("Audit start rule");
    expect(prompt).toContain("Begin from the authorized discovery scope and extract the actual evidence during inspection");
    expect(prompt).toContain("Optional preselected read-only supporting evidence: None");
    expect(prompt).not.toContain("without modifying source or expanding beyond approved evidence");
  });


  it("compiles root-bounded discovery without requiring the Owner to pre-identify files", () => {
    const contract = fullWorkspaceDiscoveryAudit();
    expect(contract.scope.workspaces[0].discoveryScopeMode).toBe("FULL_WORKSPACE");
    expect(contract.scope.workspaces[0].effectiveReadBoundary).toBe("WORKSPACE_ROOT");
    expect(contract.scope.workspaces[0].allowedPaths).toEqual([]);
    expect(validatePreflight(contract).map(issue => issue.code)).not.toContain("MISSING_SCOPE");

    const prompt = compileAgentPrompt(contract, "en", {
      activeRunId: "run-root-discovery",
      round: 1,
      executionType: "INITIAL",
    });
    expect(prompt).toContain("WORKSPACE_ROOT (read/discovery only)");
    expect(prompt).toContain("Begin at the approved Workspace roots");
    expect(prompt).toContain("without requiring the Owner to pre-identify root-cause files");
    expect(prompt).toContain("Record the exact discovered paths");
    expect(prompt).not.toContain("Cargo.toml");
    expect(prompt).not.toContain("src/");
  });

  it("keeps internal Workspace provenance out of the owner setup interface", () => {
    const source = readFileSync("src/components/workflow-app.tsx", "utf8");
    expect(source).toContain("Entire Workspace");
    expect(source).toContain("Choose folder");
    expect(source).toContain("Choose file");
    expect(source).toContain("Advanced: enter a relative path");
    expect(source).not.toContain("Selected paths are an authorization boundary");
    expect(source).not.toContain("Workspace references record metadata only");
    expect(source).not.toContain("Content freshness is not proven");
    expect(source).not.toContain("حداثة المحتوى غير مثبتة");
  });

  it("reports authorized scope and inspected paths as separate metrics without inferring evidence", () => {
    const contract = discoveryAudit();
    const runId = "run-discovery-first";
    const marker = reportBindingMarker(contract.contractId, runId, 1);
    const report = makeAuthoritativeReport(contract, {
      runId,
      bindingMarker: marker,
      inspectedPaths: [],
      findings: [{
        requirementId: contract.executionPackage.mandatoryRequirements[0].id,
        claim: "The root cause is not proven because no authorized source path was inspected.",
        status: "EVIDENCE_REQUIRED",
        evidenceRefs: [],
      }],
      executorClassification: "EVIDENCE_REQUIRED",
    });
    const parsed = parseImportedReport(authoritativeMarkdown(report), {
      contractId: contract.contractId,
      runId,
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
    expect(parsed.error).toBeUndefined();
    const verdict = evaluateVerdict(contract, parsed.report!, runId, { round: 1, executionType: "INITIAL", bindingMarker: marker });
    expect(verdict.classification).toBe("EVIDENCE_REQUIRED");
    expect(verdict.evidenceSufficiency?.authorizedScopePathCount).toBe(2);
    expect(verdict.evidenceSufficiency?.inspectedPathCount).toBe(0);
    expect(verdict.evidenceGaps).toContain("No inspected paths were supplied.");
  });

  it("preserves Run History capability without requiring the legacy governed Top Bar placement", () => {
    const shellCss = readFileSync("src/components/product-shell.module.css", "utf8");
    const shellSource = readFileSync("src/components/product-shell.tsx", "utf8");
    expect(shellCss).toMatch(/\.topbar\s*\{[\s\S]*display:\s*grid;/);
    expect(shellCss).toMatch(/\.body\s*\{[\s\S]*grid-template-columns:/);
    expect(shellCss).toContain(".sidebar");
    expect(shellCss).toContain(".canvas");
    expect(translations.en.runs).toBe("Run History");
    expect(translations.ar.runs).toBe("سجل التنفيذ");
    expect(shellSource).toContain('href="/runs"');
    expect(shellSource).toContain("!governedMode");
    expect(shellSource).toContain('href="/tasks/new"');
    expect(shellSource).toContain('href="/tasks"');
  });

  it("keeps the mismatch reason localized in Arabic", () => {
    expect(localizeVerdictText("ar", "REPORT_RUN_MISMATCH: the report binding marker belongs to a different run.")).toContain("علامة ربط التقرير تخص تنفيذًا مختلفًا");
  });
});
