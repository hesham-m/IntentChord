import type { ExecutionContract } from "@/core/contracts/execution-contract";
import { boundedObjectiveIssue } from "@/core/tasks/objective-quality";
import { reportHeaderLabels, reportSectionIds } from "@/core/reports/report-contract";

export type ExecutionBindingContext = {
  activeRunId: string;
  round: number;
  executionType: "INITIAL" | "CORRECTION" | "FIXTURE";
  parentRunId?: string;
  bindingMarker?: string;
};

export type ContractLintCode =
  | "CONTRADICTORY_OUTPUT_FORMAT"
  | "DUPLICATED_INSTRUCTION"
  | "MISSING_BOUNDED_GOAL"
  | "MISSING_INVESTIGATION_ORDER"
  | "MISSING_STOP_CONDITIONS"
  | "UNAUTHORIZED_CAPABILITY_REFERENCED"
  | "GENERIC_AGENT_CONTRACT"
  | "EXCESSIVE_CONTEXT"
  | "MISSING_REQUIREMENT_LEDGER"
  | "MISSING_REQUIREMENT_PROOF_ROW"
  | "MANDATORY_REQUIREMENT_UNMAPPED"
  | "MISSING_COMPLETION_LOCK"
  | "PREMATURE_FINAL_REPORT_ALLOWED"
  | "SELF_REPORTED_INCOMPLETE_CLOSURE"
  | "IN_SCOPE_DEFECT_TREATED_AS_STOP"
  | "GATE_EXIT_CRITERIA_MISSING"
  | "GATE_EVIDENCE_MISSING"
  | "PERSISTENT_GOVERNANCE_DUPLICATED_IN_PROMPT"
  | "TASK_SKILL_NOT_RESOLVED"
  | "RUN_CONTRACT_NOT_BOUND"
  | "MISSING_MANDATORY_FINAL_REPORT"
  | "PROGRESS_ONLY_FINAL_RESPONSE"
  | "FINAL_RESPONSE_WITHOUT_EVIDENCE_SUMMARY"
  | "TERMINAL_STATE_MISSING_FROM_REPORT"
  | "VERDICT_MISSING_FROM_REPORT"
  | "NEXT_ACTION_MISSING_FROM_REPORT"
  | "FINAL_REPORT_CONFUSED_WITH_PASS"
  | "REPORT_FILE_REQUESTED_IN_PURE_READ_ONLY_MODE"
  | "REPORT_PATH_REQUIRED_BUT_MISSING"
  | "MISSING_CANONICAL_REPORT_HEADER"
  | "MISSING_CANONICAL_REPORT_SECTION"
  | "MISSING_TRUST_BOUNDARY_RULE"
  | "MISSING_ADVERSARIAL_PROOF_RULE"
  | "MISSING_PROVEN_TRUSTED_REFERENCE_RULE";

export type ContractLintIssue = {
  code: ContractLintCode;
  severity: "BLOCKER" | "VIOLATION";
  message: string;
};

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0").slice(-7);
}

function compact(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function reportBindingMarker(contractId: string, runId: string, round: number): string {
  const runTail = compact(runId).slice(-6) || "RUN";
  return `IC-RUN-${runTail}-${fnv1a(`${contractId}|${runId}|${round}`).slice(-6)}`;
}

export function contextLease(contract: ExecutionContract, execution: ExecutionBindingContext) {
  const fingerprint = fnv1a([
    contract.contractId,
    JSON.stringify(contract.scope.workspaces),
    contract.objective,
    contract.taskMode,
    contract.scope.allowedPaths.join("|"),
    contract.scope.excludedPaths.join("|"),
    contract.scope.evidenceFiles.join("|"),
    JSON.stringify(contract.policyDecisionTrace),
    JSON.stringify(contract.selectedConfiguration),
    execution.activeRunId,
    execution.round,
    execution.executionType,
    execution.parentRunId ?? "",
    execution.bindingMarker ?? "",
  ].join("\n"));

  return {
    revision: `${contract.contractId}:r${execution.round}`,
    fingerprint: `IC-CTX-${fingerprint}`,
    invalidatesOn: [
      "objective change",
      "scope change",
      "evidence change",
      "authorization change",
      "execution configuration change",
      "owner approval revocation",
      "run lineage change",
    ],
  } as const;
}

function normalizedLines(values: string[]): string[] {
  return values.map(value => value.trim().replace(/\s+/g, " ").toLowerCase());
}

export function lintResolvedContract(contract: ExecutionContract): ContractLintIssue[] {
  const issues: ContractLintIssue[] = [];
  const resolution = contract.agentResolution;
  const reportLines = normalizedLines(resolution.reportInstructions);
  const reportText = reportLines.join("\n");
  const allLines = normalizedLines([
    ...resolution.contextRules,
    ...resolution.behaviorControls,
    ...resolution.investigationStrategy,
    ...resolution.validationWorkflow,
    ...resolution.reportInstructions,
    ...resolution.stopConditions,
  ]);
  const pkg = contract.executionPackage;

  if (!pkg.mandatoryRequirements.length) {
    issues.push({ code: "MISSING_REQUIREMENT_LEDGER", severity: "BLOCKER", message: "A resolved Contract requires a mandatory requirement ledger." });
  }
  if (pkg.mandatoryRequirements.some(item => !item.evidence.length)) {
    issues.push({ code: "MANDATORY_REQUIREMENT_UNMAPPED", severity: "BLOCKER", message: "Every mandatory requirement requires mapped evidence." });
  }
  if (!pkg.completionLock?.rule) {
    issues.push({ code: "MISSING_COMPLETION_LOCK", severity: "BLOCKER", message: "A resolved Contract requires a Completion Lock." });
  }
  if (pkg.completionLock.executionState === "READY_FOR_FINAL_REPORT") {
    issues.push({ code: "PREMATURE_FINAL_REPORT_ALLOWED", severity: "VIOLATION", message: "A newly resolved Contract cannot begin in READY_FOR_FINAL_REPORT." });
  }
  if (!pkg.gates.length || pkg.gates.some(gate => !gate.exitCriteria.length)) {
    issues.push({ code: "GATE_EXIT_CRITERIA_MISSING", severity: "BLOCKER", message: "Every sequential gate requires explicit exit criteria." });
  }
  if (!resolution.taskSkill?.id) {
    issues.push({ code: "TASK_SKILL_NOT_RESOLVED", severity: "BLOCKER", message: "A task-specific skill must be resolved." });
  }

  if (!/mandatory final report.*before run closure/.test(reportText)) {
    issues.push({ code: "MISSING_MANDATORY_FINAL_REPORT", severity: "BLOCKER", message: "Every generated Contract must require a complete final report before Run closure." });
  }
  if (!/progress-only final response.*forbidden/.test(reportText)) {
    issues.push({ code: "PROGRESS_ONLY_FINAL_RESPONSE", severity: "VIOLATION", message: "The Contract must forbid a progress-only final response." });
  }
  if (!/(evidence mapping|requirement-to-proof)/.test(reportText)) {
    issues.push({ code: "FINAL_RESPONSE_WITHOUT_EVIDENCE_SUMMARY", severity: "BLOCKER", message: "The final report must contain an evidence mapping or requirement-to-proof ledger." });
  }
  if (!/execution terminal state/.test(reportText)) {
    issues.push({ code: "TERMINAL_STATE_MISSING_FROM_REPORT", severity: "BLOCKER", message: "The final report instructions must require one execution terminal state." });
  }
  if (!/(executor classification|deterministic verdict)/.test(reportText)) {
    issues.push({ code: "VERDICT_MISSING_FROM_REPORT", severity: "BLOCKER", message: "The report instructions must separate executor classification from the deterministic verdict." });
  }
  if (!/exact next action/.test(reportText)) {
    issues.push({ code: "NEXT_ACTION_MISSING_FROM_REPORT", severity: "BLOCKER", message: "The final report instructions must require one exact next action." });
  }
  if (!/report readiness.*separate.*deterministic verdict/.test(reportText)) {
    issues.push({ code: "FINAL_REPORT_CONFUSED_WITH_PASS", severity: "VIOLATION", message: "The Contract must state that report readiness is separate from the deterministic verdict." });
  }
  if (!/authorization boundaries.*never evidence|authorization boundaries.*not independent proof/.test(reportText)) {
    issues.push({ code: "MISSING_TRUST_BOUNDARY_RULE", severity: "BLOCKER", message: "The report Contract must state that authorization boundaries are not evidence." });
  }
  if (!["source_evidence", "artifact_evidence", "validation_evidence", "runtime_evidence"].every(token => reportText.includes(token))) {
    issues.push({ code: "MISSING_PROVEN_TRUSTED_REFERENCE_RULE", severity: "BLOCKER", message: "The report Contract must require every proven finding to cite exact evidence of the matching source, artifact, validation, or runtime class." });
  }
  if (!/(negative\/adversarial|spoofing|replay)/.test(reportText)) {
    issues.push({ code: "MISSING_ADVERSARIAL_PROOF_RULE", severity: "BLOCKER", message: "The report Contract must require applicable adversarial, spoofing, replay, or negative-path proof." });
  }

  const requestsReportFile = /write .*report file|report path/.test(reportText);
  if ((contract.taskMode === "REPORT_REVIEW" || contract.taskMode === "CONTROLLED_AUDIT") && requestsReportFile) {
    issues.push({ code: "REPORT_FILE_REQUESTED_IN_PURE_READ_ONLY_MODE", severity: "VIOLATION", message: "A pure read-only Contract cannot request a report file write." });
  }
  if (requestsReportFile && !/report path:/.test(reportText)) {
    issues.push({ code: "REPORT_PATH_REQUIRED_BUT_MISSING", severity: "BLOCKER", message: "A Contract that requests a report file must provide its approved report path." });
  }

  const objectiveIssue = boundedObjectiveIssue(contract.objective);
  if (!resolution.boundedGoal.trim() || objectiveIssue) {
    issues.push({ code: "MISSING_BOUNDED_GOAL", severity: "BLOCKER", message: objectiveIssue ?? "The resolved agent Contract has no bounded goal." });
  }
  if (!resolution.investigationStrategy.length) {
    issues.push({ code: "MISSING_INVESTIGATION_ORDER", severity: "BLOCKER", message: "The resolved agent Contract has no ordered investigation strategy." });
  }
  if (!resolution.stopConditions.length) {
    issues.push({ code: "MISSING_STOP_CONDITIONS", severity: "BLOCKER", message: "The resolved agent Contract has no stop conditions." });
  }

  const requiresJson = reportLines.some(line => /return exactly one.*json|json only|must return.*json/.test(line));
  const markdownDefault = reportLines.some(line => /markdown.*default|structured markdown/.test(line));
  if (requiresJson && markdownDefault) {
    issues.push({ code: "CONTRADICTORY_OUTPUT_FORMAT", severity: "VIOLATION", message: "The report Contract simultaneously requires JSON-only output and Markdown-by-default output." });
  }

  const duplicates = allLines.filter((line, index) => allLines.indexOf(line) !== index);
  if (duplicates.length) {
    issues.push({ code: "DUPLICATED_INSTRUCTION", severity: "BLOCKER", message: `Duplicate Contract instruction: ${duplicates[0]}` });
  }

  const channel = resolution.executionChannelId;
  if (channel === "CODEX" && !resolution.boundedGoal.startsWith("/goal ")) {
    issues.push({ code: "GENERIC_AGENT_CONTRACT", severity: "BLOCKER", message: "The Codex Contract must start with one bounded /goal." });
  }
  if (channel === "GEMINI_CLI" && !resolution.behaviorControls.some(line => /exact order|ordered steps/i.test(line))) {
    issues.push({ code: "GENERIC_AGENT_CONTRACT", severity: "BLOCKER", message: "The Gemini CLI Contract must require explicit ordered steps." });
  }
  if (channel === "CLAUDE_CODE" && !resolution.behaviorControls.some(line => /unrequested|adjacent|unsolicited|out of scope/i.test(line))) {
    issues.push({ code: "GENERIC_AGENT_CONTRACT", severity: "BLOCKER", message: "The Claude Code Contract must explicitly bound unsolicited refactoring and enhancements." });
  }

  const effective = new Set(contract.policyDecisionTrace.filter(item => item.effective).map(item => item.capability));
  const capabilityChecks: Array<{ label: string; capability: keyof ExecutionContract["authorization"]; imperative: RegExp }> = [
    { label: "source modification", capability: "modifySource", imperative: /\b(apply|edit|modify|change|write|repair)\b.*\b(source|file|code|implementation)\b/i },
    { label: "test execution", capability: "runTests", imperative: /\b(run|execute)\b.*\b(tests?|vitest|jest|pytest)\b|\bcargo\s+test\b/i },
    { label: "build execution", capability: "build", imperative: /\b(run|execute)\b.*\bbuild\b|\b(?:npm\s+run|next|cargo)\s+build\b/i },
    { label: "deployment", capability: "deploy", imperative: /\b(deploy|publish|release)\b/i },
    { label: "network access", capability: "useNetwork", imperative: /\b(curl|wget|invoke-webrequest|network request|internet access)\b|https?:\/\//i },
  ];
  for (const check of capabilityChecks) {
    const unauthorizedImperative = resolution.investigationStrategy.some(line => {
      if (/do not|without|forbidden|not authorized|no repair|لا تعدل|دون تعديل/i.test(line)) return false;
      return check.imperative.test(line);
    });
    if (!effective.has(check.capability) && unauthorizedImperative) {
      issues.push({ code: "UNAUTHORIZED_CAPABILITY_REFERENCED", severity: "VIOLATION", message: `The Contract references ${check.label} although ${String(check.capability)} is not effective.` });
    }
  }

  return issues;
}

export function lintCompiledPrompt(prompt: string, contract: ExecutionContract): ContractLintIssue[] {
  const issues = [...lintResolvedContract(contract)];
  if (prompt.length > 14_000) {
    issues.push({ code: "EXCESSIVE_CONTEXT", severity: "BLOCKER", message: `The executable prompt is ${prompt.length} characters; the bounded Contract limit is 14000.` });
  }
  const jsonOnly = /return exactly one[^\n]*json|json only/i.test(prompt);
  const markdown = /structured markdown|markdown report/i.test(prompt);
  if (jsonOnly && markdown && !issues.some(issue => issue.code === "CONTRADICTORY_OUTPUT_FORMAT")) {
    issues.push({ code: "CONTRADICTORY_OUTPUT_FORMAT", severity: "VIOLATION", message: "The compiled prompt contains contradictory report-format instructions." });
  }
  for (const label of Object.values(reportHeaderLabels)) {
    if (!prompt.includes(`${label}:`)) {
      issues.push({ code: "MISSING_CANONICAL_REPORT_HEADER", severity: "BLOCKER", message: `The executable prompt is missing the governed report header: ${label}.` });
    }
  }
  for (const section of reportSectionIds) {
    if (!prompt.includes(`[IC-SECTION:${section}]`)) {
      issues.push({ code: "MISSING_CANONICAL_REPORT_SECTION", severity: "BLOCKER", message: `The executable prompt is missing canonical section ${section}.` });
    }
  }
  if (!prompt.includes("[IC-REQUIREMENT-PROOF]")) {
    issues.push({ code: "MISSING_REQUIREMENT_PROOF_ROW", severity: "BLOCKER", message: "The executable prompt does not require one structured proof row per mandatory requirement." });
  }
  for (const requirement of contract.executionPackage.mandatoryRequirements) {
    if (!prompt.includes(`\"id\":\"${requirement.id}\"`) && !prompt.includes(`"id":"${requirement.id}"`)) {
      issues.push({ code: "MANDATORY_REQUIREMENT_UNMAPPED", severity: "BLOCKER", message: `The executable prompt does not expose mandatory requirement ${requirement.id}.` });
    }
  }
  if (!/authorization boundaries are not evidence|authorization boundaries.*not independent proof|حدود التفويض ليست دليلًا/i.test(prompt)) {
    issues.push({ code: "MISSING_TRUST_BOUNDARY_RULE", severity: "BLOCKER", message: "The executable prompt does not preserve the authorization-is-not-evidence rule." });
  }
  const normalizedPrompt = prompt.toLowerCase();
  if (!["source_evidence", "artifact_evidence", "validation_evidence", "runtime_evidence"].every(token => normalizedPrompt.includes(token))) {
    issues.push({ code: "MISSING_PROVEN_TRUSTED_REFERENCE_RULE", severity: "BLOCKER", message: "The executable prompt does not require every proven finding to cite evidence of the matching source, artifact, validation, or runtime class." });
  }
  if (!/negative\/adversarial|spoofing|replay|سلبي|عدائي/i.test(prompt)) {
    issues.push({ code: "MISSING_ADVERSARIAL_PROOF_RULE", severity: "BLOCKER", message: "The executable prompt does not require applicable negative or adversarial proof." });
  }
  return issues;
}

