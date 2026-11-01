import type { ExecutionContract } from "@/core/contracts/execution-contract";
import type { ExecutorReportEnvelope, ReportEvidenceReference } from "@/core/reports/executor-report";
import { canonicalSectionHeading, reportHeaderLabels, reportSectionIds } from "@/core/reports/report-contract";

const testWorkspaceId = "11111111-1111-4111-8111-111111111111";

function sourceReference(contract: ExecutionContract): Extract<ReportEvidenceReference, { kind: "SOURCE_EVIDENCE" }> {
  const workspace = contract.scope.workspaces[0];
  const relativePath = workspace.allowedPaths[0] || contract.scope.allowedPaths[0] || "src/index.ts";
  return {
    kind: "SOURCE_EVIDENCE",
    workspaceId: workspace.id,
    relativePath,
    contentSha256: "a".repeat(64),
  };
}

function validationReference(requirementId: string, category: string): Extract<ReportEvidenceReference, { kind: "VALIDATION_EVIDENCE" }> {
  return {
    kind: "VALIDATION_EVIDENCE",
    checkId: `requirement:${requirementId}:${category}`,
    producer: "BACKEND",
  };
}

function artifactReference(requirementId: string): Extract<ReportEvidenceReference, { kind: "ARTIFACT_EVIDENCE" }> {
  return {
    kind: "ARTIFACT_EVIDENCE",
    artifactId: `artifact:${requirementId}`,
    artifactSha256: "b".repeat(64),
  };
}

function runtimeReference(requirementId: string, category: string): Extract<ReportEvidenceReference, { kind: "RUNTIME_EVIDENCE" }> {
  return {
    kind: "RUNTIME_EVIDENCE",
    checkId: `requirement:${requirementId}:${category}`,
    producer: "OWNER_RUNTIME",
    runIdentity: "run-authoritative-fixture",
  };
}

export function testRequirementProofs(contract: ExecutionContract): ExecutorReportEnvelope["requirementProofs"] {
  return contract.executionPackage.mandatoryRequirements.map(requirement => {
    const needsTrustedChecks = requirement.requiredEvidenceTypes.some(type => type === "VALIDATION" || type === "RUNTIME");
    const sourceBehaviorRefs: ReportEvidenceReference[] = [];
    const positiveProofRefs: ReportEvidenceReference[] = [];
    const negativeAdversarialProofRefs: ReportEvidenceReference[] = [];
    const persistenceReloadProofRefs: ReportEvidenceReference[] = [];

    if (requirement.requiredEvidenceTypes.includes("SOURCE")) {
      sourceBehaviorRefs.push(sourceReference(contract));
    }
    if (requirement.requiredEvidenceTypes.includes("ARTIFACT")) {
      positiveProofRefs.push(artifactReference(requirement.id));
    }
    if (requirement.requiredEvidenceTypes.includes("RUNTIME")) {
      positiveProofRefs.push(runtimeReference(requirement.id, "positive"));
      if (requirement.proofProfile.persistenceReload) {
        persistenceReloadProofRefs.push(runtimeReference(requirement.id, "persistence-reload"));
      }
    }
    if (needsTrustedChecks) {
      if (requirement.proofProfile.sourceBehavior) {
        sourceBehaviorRefs.push(validationReference(requirement.id, "source-behavior"));
      }
      if (requirement.proofProfile.positive) {
        positiveProofRefs.push(validationReference(requirement.id, "positive"));
      }
      if (requirement.proofProfile.negativeAdversarial) {
        negativeAdversarialProofRefs.push(validationReference(requirement.id, "negative-adversarial"));
      }
      if (requirement.proofProfile.persistenceReload) {
        persistenceReloadProofRefs.push(validationReference(requirement.id, "persistence-reload"));
      }
    }

    return {
      requirementId: requirement.id,
      classification: "PASS" as const,
      actualSourceBehavior: `The source behavior for ${requirement.id} was inspected and exercised in the bounded test fixture.`,
      sourceBehaviorRefs,
      positiveProofRefs,
      negativeAdversarialProofRefs,
      persistenceReloadProofRefs,
      notes: "Executor proof rows are claims; independent evidence remains Backend-governed.",
    };
  });
}

export function makeAuthoritativeReport(
  contract: ExecutionContract,
  options: Partial<ExecutorReportEnvelope> & { runId?: string } = {},
): ExecutorReportEnvelope {
  const workspaceId = contract.scope.workspaces[0]?.id || testWorkspaceId;
  const path = contract.scope.workspaces[0]?.allowedPaths[0] || contract.scope.allowedPaths[0] || "src";
  const runId = options.runId ?? "run-authoritative-001";
  const sections: ExecutorReportEnvelope["reportSections"] = {
    "executive-summary": `The bounded objective was reviewed: ${contract.objective}`,
    "sources-inspected": "Structured Workspace paths are listed in the report envelope.",
    "evidence-matrix": "Every mandatory requirement has one explicit proof row.",
    "unsupported-claims": "No unsupported claim is promoted to trusted evidence.",
    "evidence-gaps": "Independent validation and tool-trace evidence remain separate from executor claims.",
    "validation-results": "Executor validation claims are listed but cannot independently issue PASS.",
    "executor-classification": "EVIDENCE_REQUIRED",
    "exact-next-action": "Record trusted validation and a complete trusted tool trace before Backend Verdict evaluation.",
  };
  const base: ExecutorReportEnvelope = {
    contractId: contract.contractId,
    runId,
    round: 1,
    executionType: "INITIAL",
    bindingMarker: `IC-RUN-TEST-${runId}`,
    executorName: contract.agentResolution.executionChannelName,
    providerId: contract.selectedConfiguration.providerId,
    modelId: contract.selectedConfiguration.modelId,
    executionChannelId: contract.selectedConfiguration.executionChannelId,
    reasoningProfile: contract.selectedConfiguration.reasoningProfile,
    runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
    terminalState: "READY_FOR_FINAL_REPORT",
    inspectedPaths: [{ workspaceId, path }],
    changedPaths: [],
    commands: [],
    evidenceIdentities: [contract.evidenceIdentity],
    findings: (() => {
      const requirement = contract.executionPackage.mandatoryRequirements[0];
      const evidenceRefs: ReportEvidenceReference[] = [];
      if (requirement.requiredEvidenceTypes.includes("SOURCE")) evidenceRefs.push(sourceReference(contract));
      if (requirement.requiredEvidenceTypes.includes("ARTIFACT")) evidenceRefs.push(artifactReference(requirement.id));
      if (requirement.requiredEvidenceTypes.includes("VALIDATION")) evidenceRefs.push(validationReference(requirement.id, "positive"));
      if (requirement.requiredEvidenceTypes.includes("RUNTIME")) evidenceRefs.push(runtimeReference(requirement.id, "positive"));
      return [{
        requirementId: requirement.id,
        claim: "The bounded source behavior was inspected.",
        status: "PROVEN" as const,
        evidenceRefs,
      }];
    })(),
    requirementProofs: testRequirementProofs(contract),
    validationResults: contract.requiredChecks.map(check => ({
      checkId: check.id,
      status: "PASS",
      details: `Executor claims that ${check.id} passed; authoritative evidence is separate.`,
    })),
    executorClassification: "EVIDENCE_REQUIRED",
    nextAction: sections["exact-next-action"],
    reportSections: sections,
    missingRequiredSources: [],
    accessDeniedPaths: [],
    closureCriteriaSatisfied: [],
    rawReport: `The bounded objective was reviewed: ${contract.objective}`,
    completedReportSections: [...reportSectionIds],
  };
  return { ...base, ...options, reportSections: options.reportSections ?? sections };
}

export function authoritativeMarkdown(report: ExecutorReportEnvelope, locale: "en" | "ar" = "en"): string {
  const lines = [
    `${reportHeaderLabels.contractId}: ${report.contractId}`,
    `${reportHeaderLabels.runId}: ${report.runId}`,
    `${reportHeaderLabels.round}: ${report.round}`,
    `${reportHeaderLabels.executionType}: ${report.executionType}`,
    `${reportHeaderLabels.parentRunId}: ${report.parentRunId ?? "NONE"}`,
    `${reportHeaderLabels.bindingMarker}: ${report.bindingMarker}`,
    `${reportHeaderLabels.executorName}: ${report.executorName}`,
    `${reportHeaderLabels.providerId}: ${report.providerId}`,
    `${reportHeaderLabels.modelId}: ${report.modelId}`,
    `${reportHeaderLabels.executionChannelId}: ${report.executionChannelId}`,
    `${reportHeaderLabels.reasoningProfile}: ${report.reasoningProfile}`,
    `${reportHeaderLabels.runtimeProfileId}: ${report.runtimeProfileId}`,
    `${reportHeaderLabels.terminalState}: ${report.terminalState}`,
    "",
    canonicalSectionHeading("executive-summary", locale),
    report.reportSections["executive-summary"],
    "",
    canonicalSectionHeading("sources-inspected", locale),
    ...report.inspectedPaths.map(item => `- [IC-PATH] ${JSON.stringify(item)}`),
    ...report.changedPaths.map(item => `- [IC-CHANGED-PATH] ${JSON.stringify(item)}`),
    ...report.evidenceIdentities.map(item => `- [IC-EVIDENCE-IDENTITY] ${JSON.stringify(item)}`),
    "",
    canonicalSectionHeading("evidence-matrix", locale),
    ...report.findings.map(item => `- [IC-FINDING] ${JSON.stringify(item)}`),
    ...report.requirementProofs.map(item => `- [IC-REQUIREMENT-PROOF] ${JSON.stringify(item)}`),
    "",
    canonicalSectionHeading("unsupported-claims", locale),
    report.reportSections["unsupported-claims"],
    "",
    canonicalSectionHeading("evidence-gaps", locale),
    ...report.missingRequiredSources.map(value => `- [IC-MISSING-SOURCE] ${JSON.stringify({ value })}`),
    ...report.accessDeniedPaths.map(value => `- [IC-ACCESS-DENIED] ${JSON.stringify({ value })}`),
    report.reportSections["evidence-gaps"],
    "",
    canonicalSectionHeading("validation-results", locale),
    ...report.validationResults.map(item => `- [IC-VALIDATION] ${JSON.stringify(item)}`),
    ...report.commands.map(item => `- [IC-COMMAND] ${JSON.stringify(item)}`),
    ...report.closureCriteriaSatisfied.map(id => `- [IC-CLOSURE] ${JSON.stringify({ id })}`),
    "",
    canonicalSectionHeading("executor-classification", locale),
    report.executorClassification,
    "",
    canonicalSectionHeading("exact-next-action", locale),
    report.nextAction,
  ];
  return lines.join("\n");
}
