import type { ExecutionContract } from "@/core/contracts/execution-contract";
import type { ExecutorReportEnvelope } from "@/core/reports/executor-report";
import { resolveExecutionContract } from "@/core/contracts/resolver";

const authorization: ExecutionContract["authorization"] = {
  readFiles: true,
  modifySource: true,
  runStaticValidation: true,
  runTests: true,
  build: false,
  deploy: false,
  restartServices: false,
  writeDatabase: false,
  changeEnvironment: false,
  useNetwork: false,
};

const draft = resolveExecutionContract({
  contractId: "contract-demo-001",
  objective: "Validate and repair the supplied startup runtime evidence path.",
  taskMode: "SOURCE_IMPLEMENTATION",
  workspaces: [{ id: "11111111-1111-4111-8111-111111111111", displayName: "demo-project", role: "primary", referenceType: "LOCAL_PATH", source: "MANUAL_VERIFIED", reference: "demo-project", fingerprint: "demo-project-fingerprint", allowedPaths: ["src/startup.ts"], excludedPaths: ["config/"], authorizationContext: "fixture", ordering: 0 }],
  allowedPaths: ["src/startup.ts"],
  excludedPaths: ["config/"],
  evidenceFiles: ["evidence/demo-session-002/startup.log"],
  identity: "demo-session-002",
  authorization,
  providerId: "OPENAI",
  modelId: "gpt-5.6-sol",
  executionChannelId: "CODEX",
  reasoningProfile: "High",
  runtimeProfileId: "STANDARD",
  ownerOverrideAccepted: false,
});

export const baseContract: ExecutionContract = {
  ...draft,
  ownerApproval: { required: true, state: "APPROVED" },
};

const reportSections: ExecutorReportEnvelope["reportSections"] = {
  "executive-summary": "Fixture report for deterministic UI rendering only.",
  "sources-inspected": "Structured fixture paths are listed in inspectedPaths.",
  "evidence-matrix": "Fixture findings demonstrate the report envelope shape.",
  "unsupported-claims": "None in the success fixture.",
  "evidence-gaps": "Fixture data is not independent runtime evidence.",
  "validation-results": "Fixture checks are executor claims only.",
  "executor-classification": "PASS",
  "exact-next-action": "Use a real Backend-bound Run for acceptance.",
};

function fixtureRequirementProofs(contract: ExecutionContract): ExecutorReportEnvelope["requirementProofs"] {
  return contract.executionPackage.mandatoryRequirements.map(requirement => ({
    requirementId: requirement.id,
    classification: "PASS" as const,
    actualSourceBehavior: `Synthetic fixture behavior for ${requirement.id}.`,
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
    notes: "Synthetic demo data only; trusted producer proof is intentionally separate from this executor claim.",
  }));
}

const reportBase: ExecutorReportEnvelope = {
  contractId: baseContract.contractId,
  runId: "demo-controlled-success-run",
  round: 1,
  executionType: "FIXTURE",
  bindingMarker: "IC-RUN-FIXTURE-DEMO",
  executorName: "Codex",
  providerId: baseContract.selectedConfiguration.providerId,
  modelId: baseContract.selectedConfiguration.modelId,
  executionChannelId: baseContract.selectedConfiguration.executionChannelId,
  reasoningProfile: baseContract.selectedConfiguration.reasoningProfile,
  runtimeProfileId: baseContract.selectedConfiguration.runtimeProfileId,
  terminalState: "READY_FOR_FINAL_REPORT",
  inspectedPaths: [
    { workspaceId: "11111111-1111-4111-8111-111111111111", path: "src/startup.ts" },
  ],
  changedPaths: [{ workspaceId: "11111111-1111-4111-8111-111111111111", path: "src/startup.ts" }],
  commands: [
    { command: "npx tsc --noEmit", exitCode: 0, purpose: "approved static validation" },
    { command: "npm run test", exitCode: 0, purpose: "approved test suite" },
  ],
  evidenceIdentities: [{ sessionId: "demo-session-002" }],
  findings: [{
    requirementId: baseContract.executionPackage.mandatoryRequirements[0].id,
    claim: "Approved checks completed against the approved source and evidence identity.",
    status: "PROVEN",
    evidenceRefs: [
      { kind: "INSPECTED_PATH", workspaceId: "11111111-1111-4111-8111-111111111111", path: "src/startup.ts" },
      { kind: "SUPPORTING_EVIDENCE", path: "evidence/demo-session-002/startup.log" },
      ...baseContract.requiredChecks.map(item => ({ kind: "VALIDATION_CHECK" as const, checkId: item.id })),
    ],
  }],
  requirementProofs: fixtureRequirementProofs(baseContract),
  validationResults: baseContract.requiredChecks.map(item => ({ checkId: item.id, status: "PASS", details: `The required ${item.id} check completed successfully with approved evidence.` })),
  executorClassification: "PASS",
  nextAction: "Request owner review of the fixture presentation only.",
  reportSections,
  rawReport: "The approved source and identity-bound evidence were inspected. Every required check passed with explicit evidence references and no missing source or access denial.",
  missingRequiredSources: [],
  accessDeniedPaths: [],
  completedReportSections: baseContract.requiredReportSections as ExecutorReportEnvelope["completedReportSections"],
  closureCriteriaSatisfied: baseContract.closureCriteria.map(item => item.id),
};

export const scenarioA: ExecutorReportEnvelope = {
  ...reportBase,
  evidenceIdentities: [{ sessionId: "demo-session-001" }, { sessionId: "demo-session-002" }],
  findings: [{
    requirementId: baseContract.executionPackage.mandatoryRequirements[0].id,
    claim: "The root cause is uncertain.",
    status: "UNSUPPORTED",
    evidenceRefs: [],
  }],
  reportSections: { ...reportSections, "unsupported-claims": "The root cause claim is unsupported." },
};

export const scenarioB: ExecutorReportEnvelope = {
  ...reportBase,
  changedPaths: [
    { workspaceId: "11111111-1111-4111-8111-111111111111", path: "src/startup.ts" },
    { workspaceId: "11111111-1111-4111-8111-111111111111", path: "src/network.ts" },
    { workspaceId: "11111111-1111-4111-8111-111111111111", path: "config/production.json" },
  ],
};

export const scenarioC: ExecutorReportEnvelope = reportBase;
