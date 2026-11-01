import type { ExecutionContract, RunClassification } from "@/core/contracts/execution-contract";
import type { ExecutorReportEnvelope, ReportPathReference } from "@/core/reports/executor-report";
import { normalizeContractPath } from "@/core/policies/path-authority";
import { reportBindingMarker } from "@/core/prompts/governance";

export type EvidenceSufficiency = {
  authorizedScopePathCount: number;
  inspectedPathCount: number;
  approvedInspectedPathCount: number;
  evidencePathCount: number;
  matchedEvidenceIdentityCount: number;
  requiredChecksPassed: number;
  requiredChecksTotal: number;
  provenFindingCount: number;
  referencedProvenFindingCount: number;
  missingSourcesCount: number;
  accessDeniedCount: number;
  independentlySatisfiedSections: string[];
  independentlySatisfiedClosureCriteria: string[];
};

export type ProvenanceTraceItem = {
  label: "Owner Objective" | "Approved Scope" | "Approved Evidence" | "Report Binding" | "Report Content";
  status: "PASS" | "FAIL" | "EVIDENCE_REQUIRED" | "NOT_APPLICABLE";
  details: string;
};

export type ReportProvenance = {
  status:
    | "REPORT_BINDING_VERIFIED"
    | "REPORT_BINDING_UNPROVEN"
    | "REPORT_RUN_MISMATCH"
    | "REPORT_SEMANTIC_DRIFT"
    | "REPORT_SCOPE_VIOLATION"
    | "REPORT_EVIDENCE_MISMATCH"
    | "FIXTURE";
  expectedMarker: string;
  receivedMarker?: string;
  objectiveAlignment: "MATCHED" | "NOT_PROVEN" | "DRIFT";
  scopeAlignment: "MATCHED" | "NOT_PROVEN" | "VIOLATION";
  evidenceAlignment: "MATCHED" | "NOT_PROVEN" | "MISMATCH";
  trace: ProvenanceTraceItem[];
};

export type Verdict = {
  classification: RunClassification;
  acceptedFacts: string[];
  detectedViolations: string[];
  evidenceGaps: string[];
  unsupportedClaims: string[];
  contractComplianceSummary: string;
  nextAction: string;
  ownerDecisionState: "OWNER_DECISION_REQUIRED";
  evidenceSufficiency?: EvidenceSufficiency;
  reportProvenance?: ReportProvenance;
  /** Trusted required checks that may be inherited by one correction child. */
  trustedSatisfiedCheckIds?: string[];
  /** Required checks still unresolved when the Verdict was issued. */
  unresolvedCheckIds?: string[];
};

export type ExpectedRunContext = {
  round: number;
  executionType: ExecutorReportEnvelope["executionType"];
  parentRunId?: string;
  bindingMarker?: string;
};

const effective = (contract: ExecutionContract, capability: keyof ExecutionContract["authorization"]) =>
  contract.policyDecisionTrace.find(item => item.capability === capability)?.effective === true;

const commandCapabilities: Array<{ capability: keyof ExecutionContract["authorization"]; pattern: RegExp }> = [
  { capability: "runTests", pattern: /\b(test|vitest|jest|pytest|cargo test)\b/i },
  { capability: "build", pattern: /\b(build|cargo build|next build|npm run build)\b/i },
  { capability: "deploy", pattern: /\b(deploy|publish|release)\b/i },
  { capability: "restartServices", pattern: /\b(restart|systemctl\s+(restart|reload))\b/i },
  { capability: "writeDatabase", pattern: /\b(insert|update|delete|alter|drop|migrate|psql)\b/i },
  { capability: "changeEnvironment", pattern: /\b(export|setx|environment|\.env)\b/i },
  { capability: "useNetwork", pattern: /\b(curl|wget|invoke-webrequest|https?:\/\/)\b/i },
  { capability: "runStaticValidation", pattern: /\b(lint|tsc|typecheck|check)\b/i },
];

function contains(parent: string, child: string): boolean {
  const normalizedParent = normalizeContractPath(parent)?.toLowerCase();
  const normalizedChild = normalizeContractPath(child)?.toLowerCase();
  if (!normalizedParent || !normalizedChild) return false;
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function workspaceFor(contract: ExecutionContract, workspaceId: string) {
  return contract.scope.workspaces.find(workspace => workspace.id === workspaceId);
}

export function isAuthorizedReportPath(reference: ReportPathReference, contract: ExecutionContract): boolean {
  const workspace = workspaceFor(contract, reference.workspaceId);
  if (!workspace) return false;
  const normalized = normalizeContractPath(reference.path);
  if (!normalized) return false;
  const allowed = workspace.discoveryScopeMode === "FULL_WORKSPACE"
    || (workspace.discoveryScopeMode === "SELECTED_PATHS"
      && workspace.allowedPaths.some(path => contains(path, normalized)));
  const excluded = workspace.excludedPaths.some(path => contains(path, normalized));
  return allowed && !excluded;
}

export function isApprovedSupportingEvidenceReference(
  reference: Extract<ExecutorReportEnvelope["findings"][number]["evidenceRefs"][number], { kind: "SUPPORTING_EVIDENCE" }>,
  contract: ExecutionContract,
): boolean {
  if (reference.workspaceId && !workspaceFor(contract, reference.workspaceId)) return false;
  const normalized = normalizeContractPath(reference.path);
  if (!normalized) return false;
  return contract.scope.evidenceFiles.some(path => contains(path, normalized));
}

function reportEvidenceReferences(report: ExecutorReportEnvelope) {
  return [
    ...report.findings.flatMap(finding => finding.evidenceRefs),
    ...report.requirementProofs.flatMap(proof => [
      ...proof.sourceBehaviorRefs,
      ...proof.positiveProofRefs,
      ...proof.negativeAdversarialProofRefs,
      ...proof.persistenceReloadProofRefs,
    ]),
  ];
}

function supportingEvidenceReferences(report: ExecutorReportEnvelope) {
  return reportEvidenceReferences(report).filter(
    (reference): reference is Extract<typeof reference, { kind: "SUPPORTING_EVIDENCE" }> => reference.kind === "SUPPORTING_EVIDENCE",
  );
}

function runtimeMismatch(contract: ExecutionContract, report: ExecutorReportEnvelope) {
  const expected = contract.selectedConfiguration;
  return [
    ["provider", expected.providerId, report.providerId],
    ["model", expected.modelId, report.modelId],
    ["execution channel", expected.executionChannelId, report.executionChannelId],
    ["reasoning profile", expected.reasoningProfile, report.reasoningProfile],
    ["runtime profile", expected.runtimeProfileId, report.runtimeProfileId],
  ].filter(([, approved, received]) => approved !== received)
    .map(([label, approved, received]) => `${label} expected ${approved}; received ${received}`);
}

function hasGovernedEvidenceIdentity(identity: ExecutionContract["evidenceIdentity"]): boolean {
  return Boolean(
    identity.runId
    || identity.sessionId
    || identity.releaseId
    || identity.commitSha
    || identity.processId
    || identity.viewerId
    || identity.utcWindow
    || identity.unknownFields?.length,
  );
}

function canonicalEvidenceIdentity(
  identity: ExecutorReportEnvelope["evidenceIdentities"][number] | ExecutionContract["evidenceIdentity"],
): string {
  const ordered = {
    runId: identity.runId ?? null,
    sessionId: identity.sessionId ?? null,
    releaseId: identity.releaseId ?? null,
    commitSha: identity.commitSha ?? null,
    processId: identity.processId ?? null,
    viewerId: identity.viewerId ?? null,
    utcWindow: identity.utcWindow ?? null,
    unknownFields: [...(identity.unknownFields ?? [])].sort(),
  };
  return JSON.stringify(ordered);
}

function metrics(contract: ExecutionContract, report: ExecutorReportEnvelope): EvidenceSufficiency {
  const approved = report.inspectedPaths.filter(path => isAuthorizedReportPath(path, contract));
  const evidence = supportingEvidenceReferences(report).filter(reference => isApprovedSupportingEvidenceReference(reference, contract));
  const expectedIdentity = canonicalEvidenceIdentity(contract.evidenceIdentity);
  const matched = report.evidenceIdentities.filter(identity => canonicalEvidenceIdentity(identity) === expectedIdentity);
  const provenStatuses = new Set([
    "PROVEN",
    "PROVEN_BY_SOURCE",
    "PROVEN_BY_ARTIFACT",
    "PROVEN_BY_VALIDATION",
    "PROVEN_BY_RUNTIME",
  ]);
  const proven = report.findings.filter(item => provenStatuses.has(item.status));
  const referenced = proven.filter(item => item.evidenceRefs.length > 0);
  return {
    authorizedScopePathCount: contract.scope.workspaces.reduce((total, workspace) => total + (workspace.discoveryScopeMode === "FULL_WORKSPACE" ? 1 : workspace.discoveryScopeMode === "SELECTED_PATHS" ? workspace.allowedPaths.length : 0), 0),
    inspectedPathCount: report.inspectedPaths.length,
    approvedInspectedPathCount: approved.length,
    evidencePathCount: evidence.length,
    matchedEvidenceIdentityCount: matched.length,
    requiredChecksPassed: 0,
    requiredChecksTotal: contract.requiredChecks.filter(item => item.required).length,
    provenFindingCount: proven.length,
    referencedProvenFindingCount: referenced.length,
    missingSourcesCount: report.missingRequiredSources.length,
    accessDeniedCount: report.accessDeniedPaths.length,
    independentlySatisfiedSections: [],
    independentlySatisfiedClosureCriteria: [],
  };
}

function meaningfulTokens(value: string): string[] {
  const stop = new Set(["with", "from", "that", "this", "into", "only", "using", "review", "report", "task", "test", "validate", "approved", "evidence", "source", "المهمة", "التقرير", "مراجعة", "الأدلة", "المعتمد"]);
  return value.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(token => token.length >= 4 && !stop.has(token));
}

function provenance(contract: ExecutionContract, report: ExecutorReportEnvelope, expectedRunId: string, expectedRun?: ExpectedRunContext): ReportProvenance {
  const round = expectedRun?.round ?? report.round;
  const expectedMarker = expectedRun?.bindingMarker ?? reportBindingMarker(contract.contractId, expectedRunId, round);
  if (report.executionType === "FIXTURE") {
    return {
      status: "FIXTURE",
      expectedMarker,
      receivedMarker: report.bindingMarker,
      objectiveAlignment: "MATCHED",
      scopeAlignment: "MATCHED",
      evidenceAlignment: "MATCHED",
      trace: [{ label: "Report Binding", status: "NOT_APPLICABLE", details: "Historical test fixtures are isolated to tests and cannot prove a real execution." }],
    };
  }

  const raw = report.rawReport.toLowerCase();
  const objectiveTokens = meaningfulTokens(contract.objective);
  const objectiveMatched = objectiveTokens.length > 0 && objectiveTokens.some(token => raw.includes(token));
  const approvedInspected = report.inspectedPaths.filter(path => isAuthorizedReportPath(path, contract));
  const unauthorized = report.inspectedPaths.filter(path => !isAuthorizedReportPath(path, contract));
  const evidenceReferences = supportingEvidenceReferences(report);
  const approvedEvidenceReferences = evidenceReferences.filter(reference => isApprovedSupportingEvidenceReference(reference, contract));
  const rejectedEvidenceReferences = evidenceReferences.filter(reference => !isApprovedSupportingEvidenceReference(reference, contract));
  const scopeNames = contract.scope.workspaces.flatMap(workspace => [
      workspace.displayName,
      workspace.role,
      ...(workspace.discoveryScopeMode === "SELECTED_PATHS" ? workspace.allowedPaths : []),
    ])
    .concat(contract.scope.evidenceFiles)
    .flatMap(path => meaningfulTokens(path.split(/[\\/]/).pop() ?? path));
  const contentScopeMatched = scopeNames.some(token => raw.includes(token));

  const markerStatus = !report.bindingMarker
    ? "REPORT_BINDING_UNPROVEN"
    : report.bindingMarker !== expectedMarker
      ? "REPORT_RUN_MISMATCH"
      : "REPORT_BINDING_VERIFIED";
  const scopeAlignment = unauthorized.length ? "VIOLATION" : approvedInspected.length ? "MATCHED" : "NOT_PROVEN";
  const evidenceAlignment = rejectedEvidenceReferences.length
    ? "MISMATCH"
    : contract.scope.evidenceFiles.length === 0
      ? "MATCHED"
      : approvedEvidenceReferences.length > 0
        ? "MATCHED"
        : "NOT_PROVEN";
  const objectiveAlignment = objectiveMatched || contentScopeMatched ? "MATCHED" : report.rawReport.trim().length ? "NOT_PROVEN" : "DRIFT";

  let status: ReportProvenance["status"] = markerStatus;
  if (markerStatus === "REPORT_BINDING_VERIFIED") {
    if (scopeAlignment === "VIOLATION") status = "REPORT_SCOPE_VIOLATION";
    else if (objectiveAlignment !== "MATCHED") status = "REPORT_SEMANTIC_DRIFT";
    else if (evidenceAlignment === "MISMATCH") status = "REPORT_EVIDENCE_MISMATCH";
  }
  return {
    status,
    expectedMarker,
    receivedMarker: report.bindingMarker,
    objectiveAlignment,
    scopeAlignment,
    evidenceAlignment,
    trace: [
      { label: "Owner Objective", status: objectiveAlignment === "MATCHED" ? "PASS" : "EVIDENCE_REQUIRED", details: `Objective alignment: ${objectiveAlignment}.` },
      { label: "Approved Scope", status: scopeAlignment === "MATCHED" ? "PASS" : scopeAlignment === "VIOLATION" ? "FAIL" : "EVIDENCE_REQUIRED", details: `${approvedInspected.length}/${report.inspectedPaths.length} inspected paths are approved.` },
      { label: "Approved Evidence", status: contract.scope.evidenceFiles.length === 0 ? "NOT_APPLICABLE" : evidenceAlignment === "MATCHED" ? "PASS" : "EVIDENCE_REQUIRED", details: `Evidence alignment: ${evidenceAlignment}.` },
      { label: "Report Binding", status: markerStatus === "REPORT_BINDING_VERIFIED" ? "PASS" : markerStatus === "REPORT_RUN_MISMATCH" ? "FAIL" : "EVIDENCE_REQUIRED", details: `Expected ${expectedMarker}; received ${report.bindingMarker || "none"}.` },
      { label: "Report Content", status: report.rawReport.trim().length >= 30 ? "PASS" : "EVIDENCE_REQUIRED", details: "The raw report is preserved and evaluated separately from trusted validation evidence." },
    ],
  };
}

function out(
  classification: RunClassification,
  acceptedFacts: string[],
  detectedViolations: string[],
  evidenceGaps: string[],
  unsupportedClaims: string[],
  summary: string,
  nextAction: string,
  evidenceSufficiency?: EvidenceSufficiency,
  reportProvenance?: ReportProvenance,
): Verdict {
  return {
    classification,
    acceptedFacts,
    detectedViolations,
    evidenceGaps,
    unsupportedClaims,
    contractComplianceSummary: summary,
    nextAction,
    ownerDecisionState: "OWNER_DECISION_REQUIRED",
    evidenceSufficiency,
    reportProvenance,
  };
}

/**
 * Evaluate only executor-report consistency, scope, binding, and obvious violations.
 * This function deliberately cannot return PASS from executor self-report. The Backend
 * may upgrade an EVIDENCE_REQUIRED result only after trusted validation and complete
 * tool-trace evidence are read from authoritative persistence.
 */
export function evaluateVerdict(
  contract: ExecutionContract,
  report: ExecutorReportEnvelope,
  expectedRunId = report.runId,
  expectedRun?: ExpectedRunContext,
): Verdict {
  const hardBindingViolations: string[] = [];
  if (report.contractId !== contract.contractId) {
    hardBindingViolations.push(`Contract ID mismatch: expected ${contract.contractId}; received ${report.contractId}.`);
  }
  const runtimeConfigurationMismatches = runtimeMismatch(contract, report);
  hardBindingViolations.push(...runtimeConfigurationMismatches.map(item => `Unapproved runtime configuration: ${item}.`));
  if (expectedRun) {
    if (report.round !== expectedRun.round) hardBindingViolations.push(`Round mismatch: expected ${expectedRun.round}; received ${report.round}.`);
    if (report.executionType !== expectedRun.executionType) hardBindingViolations.push(`Execution type mismatch: expected ${expectedRun.executionType}; received ${report.executionType}.`);
    if ((report.parentRunId ?? "") !== (expectedRun.parentRunId ?? "")) {
      hardBindingViolations.push(`Report parent Run ID does not match the active run. Expected ${expectedRun.parentRunId ?? "none"}; received ${report.parentRunId ?? "none"}.`);
    }
  }
  if (hardBindingViolations.length) {
    const nextAction = runtimeConfigurationMismatches.length
      ? "Regenerate the contract for the actual runtime configuration and obtain owner reapproval before retrying."
      : "Correct the report identity and resubmit it for the same authoritative Run.";
    return out("VIOLATION", [], hardBindingViolations, [], [], "The report is not bound to the approved execution context.", nextAction);
  }
  if (report.runId !== expectedRunId) {
    return out(
      "EVIDENCE_REQUIRED",
      [],
      [],
      [`Report Run ID does not match the active Run ID ${expectedRunId}; received ${report.runId}.`],
      [],
      "The report is not yet attributable to the active authoritative Run.",
      `Resubmit the report using the active Run ID: ${expectedRunId}.`,
    );
  }

  const reportProvenance = provenance(contract, report, expectedRunId, expectedRun);
  if (reportProvenance.status === "REPORT_RUN_MISMATCH") {
    return out("VIOLATION", [], ["REPORT_RUN_MISMATCH: the report binding marker belongs to a different Run."], [], [], "The imported report does not belong to the active Run.", `Resubmit with the exact marker ${reportProvenance.expectedMarker}.`, undefined, reportProvenance);
  }
  if (reportProvenance.status === "REPORT_BINDING_UNPROVEN") {
    return out("EVIDENCE_REQUIRED", [], [], [`REPORT_BINDING_UNPROVEN: expected ${reportProvenance.expectedMarker}.`], [], "The report cannot be attributed to the active Run.", `Add the exact marker ${reportProvenance.expectedMarker} and resubmit.`, metrics(contract, report), reportProvenance);
  }

  const violations: string[] = [];
  const unauthorizedInspected = report.inspectedPaths.filter(path => !isAuthorizedReportPath(path, contract));
  if (unauthorizedInspected.length) violations.push(`Unauthorized inspected paths: ${unauthorizedInspected.map(item => `${item.workspaceId}:${item.path}`).join(", ")}.`);
  const invalidContextReferences = reportEvidenceReferences(report).filter(reference => {
    if (reference.kind === "INSPECTED_PATH") return !isAuthorizedReportPath(reference, contract);
    if (reference.kind === "SUPPORTING_EVIDENCE") return !isApprovedSupportingEvidenceReference(reference, contract);
    return false;
  });
  if (invalidContextReferences.length) {
    violations.push(`Unapproved report context references: ${invalidContextReferences.map(reference => JSON.stringify(reference)).join(", ")}.`);
  }
  const unauthorizedChanged = report.changedPaths.filter(path => !isAuthorizedReportPath(path, contract));
  if (unauthorizedChanged.length) violations.push(`Unauthorized changed paths: ${unauthorizedChanged.map(item => `${item.workspaceId}:${item.path}`).join(", ")}.`);
  if (report.changedPaths.length && !effective(contract, "modifySource")) violations.push("Source changes were not authorized.");
  if (report.inspectedPaths.length && !effective(contract, "readFiles")) violations.push("File inspection was not authorized.");
  const forbidden = report.commands.filter(command => commandCapabilities.some(rule => rule.pattern.test(command.command) && !effective(contract, rule.capability)));
  if (forbidden.length) violations.push(`Forbidden commands claimed by the executor: ${forbidden.map(item => item.command).join(", ")}.`);
  if (violations.length) {
    return out("VIOLATION", [], violations, [], [], "The executor report declares actions outside the approved Contract.", "Create a correction Run and do not repeat unauthorized actions.", undefined, reportProvenance);
  }

  if (reportProvenance.status === "REPORT_SCOPE_VIOLATION") {
    return out("VIOLATION", [], ["REPORT_SCOPE_VIOLATION: the report names paths outside the approved Workspace scope."], [], [], "The report violates the approved scope.", "Create a correction Run restricted to the approved Workspace scope.", metrics(contract, report), reportProvenance);
  }
  if (reportProvenance.status === "REPORT_SEMANTIC_DRIFT" || reportProvenance.status === "REPORT_EVIDENCE_MISMATCH") {
    return out("EVIDENCE_REQUIRED", [], [], [`${reportProvenance.status}: semantic alignment is not proven.`], [], "The report is Run-bound but not sufficiently aligned with the approved objective and scope.", "Submit a corrected report that names the approved objective and structured Workspace paths.", metrics(contract, report), reportProvenance);
  }

  const evidence = metrics(contract, report);
  const unsupported = report.findings.filter(item => ["UNSUPPORTED", "EVIDENCE_REQUIRED", "CONTRADICTED"].includes(item.status)).map(item => item.claim);
  const gaps: string[] = [];
  const evidenceIdentityRequired = hasGovernedEvidenceIdentity(contract.evidenceIdentity);
  const expectedIdentity = canonicalEvidenceIdentity(contract.evidenceIdentity);
  const identities = report.evidenceIdentities.map(canonicalEvidenceIdentity);
  if (evidenceIdentityRequired && evidence.matchedEvidenceIdentityCount === 0) {
    gaps.push(`No executor evidence identity exactly matches the approved identity ${expectedIdentity}.`);
  }
  if (new Set(identities).size > 1) gaps.push("Multiple distinct executor evidence identities were mixed.");
  if (report.inspectedPaths.length === 0) gaps.push("No inspected paths were supplied.");
  if (evidence.approvedInspectedPathCount !== evidence.inspectedPathCount) gaps.push("One or more inspected paths are outside approved scope.");
  if (evidence.provenFindingCount === 0) gaps.push("No PROVEN finding was supplied.");
  if (evidence.referencedProvenFindingCount < evidence.provenFindingCount) gaps.push("One or more PROVEN findings have no structured evidence reference.");
  if (report.missingRequiredSources.length || report.accessDeniedPaths.length) {
    gaps.push("Missing-source or access claims require independent proof before they can become an Owner blocker.");
  }
  gaps.push("Executor claims, command outputs, inspected paths, and self-reported checks are not independent evidence.");

  return out(
    "EVIDENCE_REQUIRED",
    [],
    [],
    Array.from(new Set(gaps)),
    unsupported,
    "The executor report passed binding and scope checks, but Backend-trusted validation and complete tool trace are still required.",
    "Record trusted validation evidence and a complete signed tool trace, then evaluate the Run again.",
    evidence,
    reportProvenance,
  );
}
