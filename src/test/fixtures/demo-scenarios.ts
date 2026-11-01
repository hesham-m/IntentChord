import type { ExecutionContract } from "@/core/contracts/execution-contract";
import type { ExecutorReportEnvelope } from "@/core/reports/executor-report";
import { evaluateVerdict } from "@/core/verdicts/engine";
import { baseContract } from "@/test/fixtures/scenarios";

export const demoRuns = [
  { id: "evidence-mixing", title: "Evidence Mixing", explanation: "Two session identities are mixed with an unsupported root-cause claim." },
  { id: "scope-violation", title: "Scope Violation", explanation: "The report changes paths outside the approved scope." },
  { id: "controlled-success", title: "Controlled Success", explanation: "One approved identity and path meet all closure criteria." },
] as const;

function effective(contract: ExecutionContract, capability: keyof ExecutionContract["authorization"]): boolean {
  return contract.policyDecisionTrace.find(item => item.capability === capability)?.effective === true;
}

function fixtureRequirementProofs(contract: ExecutionContract): ExecutorReportEnvelope["requirementProofs"] {
  return contract.executionPackage.mandatoryRequirements.map(requirement => ({
    requirementId: requirement.id,
    classification: "PASS" as const,
    actualSourceBehavior: `Synthetic test behavior for ${requirement.id}.`,
    sourceBehaviorRefs: requirement.proofProfile.sourceBehavior
      ? [{ kind: "VALIDATION_CHECK" as const, checkId: `requirement:${requirement.id}:source-behavior` }]
      : [],
    positiveProofRefs: requirement.proofProfile.positive
      ? [{ kind: "VALIDATION_CHECK" as const, checkId: `requirement:${requirement.id}:positive` }]
      : [],
    negativeAdversarialProofRefs: requirement.proofProfile.negativeAdversarial
      ? [{ kind: "VALIDATION_CHECK" as const, checkId: `requirement:${requirement.id}:negative-adversarial` }]
      : [],
    persistenceReloadProofRefs: requirement.proofProfile.persistenceReload
      ? [{ kind: "VALIDATION_CHECK" as const, checkId: `requirement:${requirement.id}:persistence-reload` }]
      : [],
    notes: "Synthetic test claim only; final trust requires a separate authoritative producer.",
  }));
}

export function scenarioVerdict(id: string, contract: ExecutionContract, activeRunId = "run-synthetic") {
  const scenario = demoRuns.find(run => run.id === id) ?? demoRuns[2];
  const workspace = contract.scope.workspaces[0];
  const workspaceId = workspace.id;
  const inspectedPaths = effective(contract, "readFiles")
    ? workspace.allowedPaths.map(path => ({ workspaceId, path }))
    : [];
  const changedPaths = effective(contract, "modifySource")
    ? workspace.allowedPaths.slice(0, 1).map(path => ({ workspaceId, path }))
    : [];
  const reportSections: ExecutorReportEnvelope["reportSections"] = {
    "executive-summary": "Synthetic test summary.",
    "sources-inspected": "Fixture paths are structured and test-only.",
    "evidence-matrix": "Fixture finding demonstrates deterministic evaluation.",
    "unsupported-claims": "None in the success fixture.",
    "evidence-gaps": "Synthetic data is not independent runtime evidence.",
    "validation-results": "Fixture validation results are executor claims only.",
    "executor-classification": "PASS",
    "exact-next-action": "Use a real Backend-bound Run for acceptance.",
  };
  const successReport: ExecutorReportEnvelope = {
    contractId: contract.contractId,
    runId: activeRunId,
    round: 1,
    executionType: "FIXTURE",
    bindingMarker: `IC-RUN-FIXTURE-${activeRunId}`,
    executorName: contract.agentResolution.executionChannelName,
    providerId: contract.selectedConfiguration.providerId,
    modelId: contract.selectedConfiguration.modelId,
    executionChannelId: contract.selectedConfiguration.executionChannelId,
    reasoningProfile: contract.selectedConfiguration.reasoningProfile,
    runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
    terminalState: "READY_FOR_FINAL_REPORT",
    inspectedPaths,
    changedPaths,
    commands: [],
    evidenceIdentities: [contract.evidenceIdentity],
    findings: [{
      requirementId: contract.executionPackage.mandatoryRequirements[0].id,
      claim: "Approved checks completed.",
      status: "PROVEN",
      evidenceRefs: contract.requiredChecks.filter(check => check.required).map(check => ({ kind: "VALIDATION_CHECK" as const, checkId: check.id })),
    }],
    requirementProofs: fixtureRequirementProofs(contract),
    validationResults: contract.requiredChecks.map(check => ({ checkId: check.id, status: "PASS" as const, details: `The required ${check.id} check completed successfully against approved inputs.` })),
    executorClassification: "PASS",
    nextAction: "Request owner review of test presentation only.",
    reportSections,
    rawReport: "Synthetic Contract-bound report. It is test data and is not a real execution.",
    missingRequiredSources: [],
    accessDeniedPaths: [],
    completedReportSections: contract.requiredReportSections as ExecutorReportEnvelope["completedReportSections"],
    closureCriteriaSatisfied: contract.closureCriteria.map(item => item.id),
  };
  const report = scenario.id === "controlled-success"
    ? successReport
    : scenario.id === "evidence-mixing"
      ? {
          ...successReport,
          evidenceIdentities: [{ ...contract.evidenceIdentity }, { sessionId: "mixed-session" }],
          findings: [{
            requirementId: contract.executionPackage.mandatoryRequirements[0].id,
            claim: "The root cause is uncertain.",
            status: "UNSUPPORTED" as const,
            evidenceRefs: [],
          }],
          reportSections: { ...reportSections, "unsupported-claims": "The root cause is unsupported." },
        }
      : { ...successReport, changedPaths: [...successReport.changedPaths, { workspaceId, path: "outside/approved-scope.ts" }] };
  return {
    scenario: { ...scenario, report },
    verdict: evaluateVerdict(contract, report, activeRunId, { round: 1, executionType: "FIXTURE" }),
  };
}

export function demoScenarioVerdict(id: string) {
  return scenarioVerdict(id, baseContract, `test-${id}-run`);
}
