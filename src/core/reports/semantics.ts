import type { ExecutionContract } from "@/core/contracts/execution-contract";
import type { ExecutorReportEnvelope, ReportEvidenceReference } from "@/core/reports/executor-report";

function isPlaceholder(value: string, minimumLength = 8): boolean {
  const normalized = value.trim();
  return normalized.length < minimumLength
    || /^<[^>]+>$/.test(normalized)
    || /^(?:todo|tbd|n\/?a|none|placeholder|fill\s+this|not\s+provided)$/i.test(normalized);
}

function evidenceKindSatisfied(
  evidenceType: "SOURCE" | "ARTIFACT" | "VALIDATION" | "RUNTIME",
  references: ReportEvidenceReference[],
): boolean {
  if (evidenceType === "SOURCE") return references.some(reference => reference.kind === "SOURCE_EVIDENCE");
  if (evidenceType === "ARTIFACT") return references.some(reference => reference.kind === "ARTIFACT_EVIDENCE");
  if (evidenceType === "VALIDATION") {
    return references.some(reference => reference.kind === "VALIDATION_EVIDENCE" || reference.kind === "VALIDATION_CHECK");
  }
  return references.some(reference => reference.kind === "RUNTIME_EVIDENCE");
}

function allRequirementReferences(
  report: ExecutorReportEnvelope,
  requirementId: string,
): ReportEvidenceReference[] {
  const proof = report.requirementProofs.find(item => item.requirementId === requirementId);
  const proofReferences = proof ? [
    ...proof.sourceBehaviorRefs,
    ...proof.positiveProofRefs,
    ...proof.negativeAdversarialProofRefs,
    ...proof.persistenceReloadProofRefs,
  ] : [];
  const findingReferences = report.findings
    .filter(finding => finding.requirementId === requirementId)
    .flatMap(finding => finding.evidenceRefs);
  return [...proofReferences, ...findingReferences];
}

function validateFindingStatusEvidence(
  finding: ExecutorReportEnvelope["findings"][number],
): string | undefined {
  const statusToKind: Partial<Record<typeof finding.status, ReportEvidenceReference["kind"]>> = {
    PROVEN_BY_SOURCE: "SOURCE_EVIDENCE",
    PROVEN_BY_ARTIFACT: "ARTIFACT_EVIDENCE",
    PROVEN_BY_VALIDATION: "VALIDATION_EVIDENCE",
    PROVEN_BY_RUNTIME: "RUNTIME_EVIDENCE",
  };
  const requiredKind = statusToKind[finding.status];
  if (requiredKind && !finding.evidenceRefs.some(reference => reference.kind === requiredKind)) {
    return `${finding.status} finding for ${finding.requirementId} must reference ${requiredKind}.`;
  }
  if (finding.status === "PROVEN" && !finding.evidenceRefs.some(reference => [
    "SOURCE_EVIDENCE",
    "ARTIFACT_EVIDENCE",
    "VALIDATION_EVIDENCE",
    "RUNTIME_EVIDENCE",
    "VALIDATION_CHECK",
    "TOOL_TRACE_EVENT",
  ].includes(reference.kind))) {
    return `Legacy PROVEN finding for ${finding.requirementId} must reference its own exact source, artifact, validation, runtime, or trusted trace evidence.`;
  }
  if (finding.status === "CONTRADICTED" && finding.evidenceRefs.length === 0) {
    return `CONTRADICTED finding for ${finding.requirementId} must include evidence.`;
  }
  return undefined;
}

export function validateReportSemantics(
  contract: ExecutionContract,
  report: ExecutorReportEnvelope,
): string[] {
  const issues: string[] = [];

  for (const [sectionId, content] of Object.entries(report.reportSections)) {
    const minimumLength = sectionId === "executor-classification" ? 4 : 8;
    if (typeof content !== "string" || isPlaceholder(content, minimumLength)) {
      issues.push(`Canonical report section ${sectionId} contains placeholder or non-substantive content.`);
    }
  }
  if (isPlaceholder(report.nextAction)) {
    issues.push("The exact next action contains placeholder or non-substantive content.");
  }
  for (const proof of report.requirementProofs) {
    if (isPlaceholder(proof.actualSourceBehavior)) {
      issues.push(`Mandatory requirement ${proof.requirementId} has placeholder or non-substantive actual-source behavior.`);
    }
  }

  const expectedRequirements = contract.executionPackage.mandatoryRequirements;
  const expectedIds = new Set(expectedRequirements.map(requirement => requirement.id));
  const counts = new Map<string, number>();
  for (const proof of report.requirementProofs) {
    counts.set(proof.requirementId, (counts.get(proof.requirementId) ?? 0) + 1);
    if (!expectedIds.has(proof.requirementId)) {
      issues.push(`Unknown mandatory requirement proof: ${proof.requirementId}.`);
    }
  }

  for (const requirement of expectedRequirements) {
    const count = counts.get(requirement.id) ?? 0;
    if (count !== 1) {
      issues.push(`Mandatory requirement ${requirement.id} must have exactly one proof row; received ${count}.`);
    }
    const proof = report.requirementProofs.find(item => item.requirementId === requirement.id);
    if (!proof) continue;

    const references = allRequirementReferences(report, requirement.id);
    if (proof.classification === "PASS") {
      for (const evidenceType of requirement.requiredEvidenceTypes) {
        if (!evidenceKindSatisfied(evidenceType, references)) {
          issues.push(`Mandatory requirement ${requirement.id} cannot be PASS without ${evidenceType} evidence.`);
        }
      }
    }

    const requiresTrustedChecks = requirement.requiredEvidenceTypes.some(
      evidenceType => evidenceType === "VALIDATION" || evidenceType === "RUNTIME",
    );
    if (proof.classification === "PASS" && requiresTrustedChecks) {
      const proofCategories: Array<[string, boolean, ReportEvidenceReference[]]> = [
        ["source-behavior", requirement.proofProfile.sourceBehavior, proof.sourceBehaviorRefs],
        ["positive", requirement.proofProfile.positive, proof.positiveProofRefs],
        ["negative-adversarial", requirement.proofProfile.negativeAdversarial, proof.negativeAdversarialProofRefs],
        ["persistence-reload", requirement.proofProfile.persistenceReload, proof.persistenceReloadProofRefs],
      ];
      for (const [category, required, categoryReferences] of proofCategories) {
        if (!required) continue;
        const expectedCheckId = `requirement:${requirement.id}:${category}`;
        if (!categoryReferences.some(reference =>
          (reference.kind === "VALIDATION_CHECK" || reference.kind === "VALIDATION_EVIDENCE")
          && reference.checkId === expectedCheckId
        )) {
          issues.push(`Mandatory requirement ${requirement.id} ${category} PASS must reference exact governed check ${expectedCheckId}.`);
        }
      }
    }
  }

  for (const finding of report.findings) {
    const requirement = expectedRequirements.find(item => item.id === finding.requirementId);
    if (!requirement) {
      issues.push(`Finding references an unknown mandatory requirement: ${finding.requirementId}.`);
      continue;
    }
    const statusIssue = validateFindingStatusEvidence(finding);
    if (statusIssue) issues.push(statusIssue);

    const allowedCheckIds = new Set([
      `requirement:${requirement.id}:source-behavior`,
      `requirement:${requirement.id}:positive`,
      ...(requirement.proofProfile.negativeAdversarial ? [`requirement:${requirement.id}:negative-adversarial`] : []),
      ...(requirement.proofProfile.persistenceReload ? [`requirement:${requirement.id}:persistence-reload`] : []),
    ]);
    for (const reference of finding.evidenceRefs) {
      if ((reference.kind === "VALIDATION_CHECK" || reference.kind === "VALIDATION_EVIDENCE")
        && !allowedCheckIds.has(reference.checkId)) {
        issues.push(`Finding for ${finding.requirementId} references unrelated validation check ${reference.checkId}.`);
      }
    }
  }

  const attached = new Set(contract.scope.workspaces.map(workspace => workspace.id));
  const workspaceIds: string[] = [];
  for (const path of [...report.inspectedPaths, ...report.changedPaths]) {
    workspaceIds.push(path.workspaceId);
  }
  for (const finding of report.findings) {
    for (const reference of finding.evidenceRefs) {
      if ("workspaceId" in reference && reference.workspaceId) workspaceIds.push(reference.workspaceId);
    }
  }
  for (const proof of report.requirementProofs) {
    for (const reference of [
      ...proof.sourceBehaviorRefs,
      ...proof.positiveProofRefs,
      ...proof.negativeAdversarialProofRefs,
      ...proof.persistenceReloadProofRefs,
    ]) {
      if ("workspaceId" in reference && reference.workspaceId) workspaceIds.push(reference.workspaceId);
    }
  }
  for (const workspaceId of new Set(workspaceIds)) {
    if (!attached.has(workspaceId)) {
      issues.push(`Report reference names a Workspace not attached to the Task: ${workspaceId}.`);
    }
  }

  return Array.from(new Set(issues));
}
