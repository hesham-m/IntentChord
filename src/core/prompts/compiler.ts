import { requiredCheckSatisfactionMode, type ExecutionContract } from "@/core/contracts/execution-contract";
import {
  contextLease,
  lintCompiledPrompt,
  reportBindingMarker,
  type ContractLintIssue,
  type ExecutionBindingContext,
} from "@/core/prompts/governance";
import { localizeContractText, localizeContractTexts } from "@/i18n/contract-text";
import { localizeVerdictText } from "@/i18n/translations";
import type { Locale } from "@/i18n/types";
import { canonicalSectionHeading, reportHeaderLabels, reportSectionIds } from "@/core/reports/report-contract";

const list = (items: string[], empty: string) =>
  items.length ? items.map(item => `- ${item}`).join("\n") : `- ${empty}`;

const compactCorrectionItem = (value: string): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  const missingCheck = normalized.match(/^Trusted PASS evidence is missing for required check:\s*(.+?)\.?$/i);
  if (missingCheck) return `Missing trusted PASS for ${missingCheck[1]}.`;
  const missingProof = normalized.match(/^Mandatory requirement\s+(.+?)\s+lacks trusted\s+(.+?)\s+proof\.?$/i);
  if (missingProof) return `Missing ${missingProof[2]} proof for ${missingProof[1]}.`;
  const untrustedFinding = normalized.match(/^Proven finding has no matching trusted source, artifact, validation, runtime, or tool-trace evidence:\s*(.+?)\.?$/i);
  if (untrustedFinding) return `Untrusted PROVEN claim: ${untrustedFinding[1]}.`;
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217)}...`;
};

const compactCorrectionItems = (items: string[]): string[] =>
  Array.from(new Set(items.map(compactCorrectionItem).filter(Boolean)));

function workspaceReadBoundary(workspace: ExecutionContract["scope"]["workspaces"][number], empty: string): string {
  if (workspace.discoveryScopeMode === "FULL_WORKSPACE") return "WORKSPACE_ROOT (read/discovery only)";
  if (workspace.discoveryScopeMode === "NONE") return empty;
  return workspace.allowedPaths.join(", ") || empty;
}

function workspaceContext(contract: ExecutionContract, empty: string): string[] {
  return contract.scope.workspaces.map(workspace => `${workspace.displayName} [${workspace.role}]\n  ref: ${workspace.reference}\n  fingerprint: ${workspace.fingerprint}\n  discovery mode: ${workspace.discoveryScopeMode}\n  read boundary: ${workspaceReadBoundary(workspace, empty)}\n  excluded: ${workspace.excludedPaths.join(", ") || empty}`);
}

function authorizedReadScope(contract: ExecutionContract, empty: string): string {
  const entries = contract.scope.workspaces
    .filter(workspace => workspace.discoveryScopeMode !== "NONE")
    .map(workspace => `${workspace.displayName}: ${workspaceReadBoundary(workspace, empty)}`);
  return entries.join("; ") || empty;
}

function authorizedModificationScope(contract: ExecutionContract, empty: string): string {
  if (!hasEffectiveCapability(contract, "modifySource")) return empty;
  const entries = contract.scope.workspaces
    .filter(workspace => workspace.discoveryScopeMode === "SELECTED_PATHS" && workspace.allowedPaths.length > 0)
    .map(workspace => `${workspace.displayName}: ${workspace.allowedPaths.join(", ")}`);
  return entries.join("; ") || empty;
}


function confirmedIntentContext(contract: ExecutionContract, arabic: boolean, empty: string): string {
  const intent = contract.intentResolution;
  if (!intent) return empty;
  const questions = intent.investigationQuestions
    .map((item, index) => `${index + 1}. ${item.question}`)
    .join("\n");
  const concepts = list(intent.expectedConcepts, empty);
  const unknowns = list(intent.unknowns, empty);
  const forbidden = list(intent.forbiddenAssumptions, empty);
  return `${arabic ? "الموضوع المؤكد" : "Confirmed topic"}: ${intent.normalizedTopic}
${arabic ? "ملخص فهم الهدف" : "Confirmed intent summary"}: ${intent.ownerSummary}
${arabic ? "أسئلة التحقيق" : "Investigation questions"}:
${questions}
${arabic ? "مفاهيم البحث المستهدفة" : "Target search concepts"}:
${concepts}
${arabic ? "أمور غير معروفة قبل الاكتشاف" : "Unknown before discovery"}:
${unknowns}
${arabic ? "افتراضات ممنوعة" : "Forbidden assumptions"}:
${forbidden}`;
}

const PROMPT_DISCOVERY_PATHS_PER_REQUIREMENT = 1;
const PROMPT_DISCOVERY_PATHS_TOTAL = 8;
const PROMPT_DISCOVERY_PATH_CONTEXT_LIMIT = 1200;

function boundedDiscoveryContext(contract: ExecutionContract, arabic: boolean, empty: string): string {
  const discovery = contract.discoveryResolution;
  if (!discovery) return empty;
  let remainingPathBudget = PROMPT_DISCOVERY_PATHS_TOTAL;
  let remainingCharacterBudget = PROMPT_DISCOVERY_PATH_CONTEXT_LIMIT;
  const requirementPathLines: string[] = [];
  let hiddenRequirementCount = 0;

  for (const item of discovery.requirementPaths) {
    const totalPathCount = item.totalPathCount ?? item.paths.length;
    const contractOmittedPathCount = item.omittedPathCount ?? Math.max(0, totalPathCount - item.paths.length);
    const availablePaths = item.paths.slice(
      0,
      Math.min(PROMPT_DISCOVERY_PATHS_PER_REQUIREMENT, remainingPathBudget),
    );
    const visiblePaths: string[] = [];
    for (const candidatePath of availablePaths) {
      const nextLength = candidatePath.length + (visiblePaths.length ? 2 : 0);
      if (nextLength > remainingCharacterBudget) break;
      visiblePaths.push(candidatePath);
      remainingCharacterBudget -= nextLength;
      remainingPathBudget -= 1;
    }
    const omittedPathCount = contractOmittedPathCount + Math.max(0, item.paths.length - visiblePaths.length);
    if (!visiblePaths.length && totalPathCount > 0) {
      hiddenRequirementCount += 1;
    }
    const paths = visiblePaths.length ? visiblePaths.join(", ") : empty;
    const countSummary = arabic
      ? `عرض ${visiblePaths.length} من ${totalPathCount}${omittedPathCount ? `؛ محذوف من الـPrompt: ${omittedPathCount}` : ""}`
      : `showing ${visiblePaths.length} of ${totalPathCount}${omittedPathCount ? `; omitted from prompt: ${omittedPathCount}` : ""}`;
    requirementPathLines.push(`- ${item.requirementId}: ${paths} (${countSummary})`);
  }

  if (hiddenRequirementCount) {
    requirementPathLines.push(arabic
      ? `- تم حجب تفاصيل مسارات ${hiddenRequirementCount} متطلب إضافي لحماية ميزانية الـPrompt؛ تظل الخريطة الكاملة محفوظة في Discovery Run.`
      : `- Path details for ${hiddenRequirementCount} additional requirement(s) were withheld to protect the prompt budget; the complete map remains in the Discovery Run.`);
  }
  const requirementPaths = requirementPathLines.join("\n");
  return `${arabic ? "الحالة" : "Status"}: ${discovery.status}
${arabic ? "معرف تشغيل الاكتشاف" : "Discovery Run ID"}: ${discovery.id}
${arabic ? "بصمة ناتج الاكتشاف" : "Discovery output SHA256"}: ${discovery.outputSha256}
${arabic ? "حالة التقييم" : "Assessment status"}: ${discovery.assessment.assessmentStatus}
${arabic ? "التعقيد بعد الاكتشاف" : "Assessed complexity"}: ${discovery.assessment.complexity}
${arabic ? "ترابط بين الملفات" : "Cross-file dependency"}: ${discovery.assessment.crossFileDependency}
${arabic ? "ترابط بين مساحات العمل" : "Cross-workspace dependency"}: ${discovery.assessment.crossWorkspaceDependency}
${arabic ? "الملفات المرشحة" : "Candidate files"}: ${discovery.assessment.candidateFileCount}
${arabic ? "الملفات المفحوصة" : "Inspected files"}: ${discovery.assessment.inspectedFileCount}
${arabic ? "المسارات التمثيلية حسب المتطلب" : "Representative paths by requirement"}:
${requirementPaths || `- ${empty}`}
${arabic ? "فجوات الأدلة" : "Evidence gaps"}:
${list(discovery.evidenceGaps, empty)}
${arabic ? "قاعدة الخريطة" : "Discovery-map rule"}: ${arabic ? "المسارات المعروضة بذور تمثيلية فقط. الخريطة الكاملة المقيّدة والمبصّمة تظل في Discovery Run، ولا يصبح أي مسار دليلًا على ادعاء إلا بعد فحص المحتوى وربط SOURCE_EVIDENCE صالح به." : "Displayed paths are representative seeds only. The complete bounded, hashed map remains in the Discovery Run, and no path proves a claim until inspected content is bound through valid SOURCE_EVIDENCE."}`;
}

function mandatoryRequirementContext(contract: ExecutionContract): string[] {
  return contract.executionPackage.mandatoryRequirements.map(requirement => {
    const requiresTrustedExecutionEvidence = requirement.requiredEvidenceTypes.some(
      evidenceType => evidenceType === "VALIDATION" || evidenceType === "RUNTIME",
    );
    const requiredCheckIds = requiresTrustedExecutionEvidence ? [
      requirement.proofProfile.sourceBehavior ? `requirement:${requirement.id}:source-behavior` : undefined,
      requirement.proofProfile.positive ? `requirement:${requirement.id}:positive` : undefined,
      requirement.proofProfile.negativeAdversarial ? `requirement:${requirement.id}:negative-adversarial` : undefined,
      requirement.proofProfile.persistenceReload ? `requirement:${requirement.id}:persistence-reload` : undefined,
    ].filter((value): value is string => Boolean(value)) : [];
    return JSON.stringify({
      id: requirement.id,
      outcome: requirement.outcome,
      gate: requirement.gate,
      requiredEvidenceTypes: requirement.requiredEvidenceTypes,
      proofProfile: requirement.proofProfile,
      requiredTrustedCheckIds: requiredCheckIds,
    });
  });
}

export type PromptExecutionContext = {
  activeRunId?: string;
  round?: number;
  executionType?: "INITIAL" | "CORRECTION" | "FIXTURE";
  parentRunId?: string;
  bindingMarker?: string;
  correctionGaps?: string[];
  ownerCorrectionInstruction?: string;
  completedFacts?: string[];
  inheritedCheckIds?: string[];
  contextLease?: { revision: string; fingerprint: string };
};

function phase(contract: ExecutionContract, execution?: PromptExecutionContext) {
  const approved = contract.ownerApproval.state === "APPROVED";
  return {
    approved,
    executable: approved && Boolean(execution?.activeRunId),
    reason: !approved ? "OWNER_APPROVAL_PENDING" : !execution?.activeRunId ? "OWNER_APPROVED_AWAITING_ACTIVE_RUN" : "READY",
  } as const;
}

function resolvedExecution(execution: PromptExecutionContext): ExecutionBindingContext {
  return {
    activeRunId: execution.activeRunId!,
    round: execution.round ?? 1,
    executionType: execution.executionType ?? "INITIAL",
    ...(execution.parentRunId ? { parentRunId: execution.parentRunId } : {}),
    ...(execution.bindingMarker ? { bindingMarker: execution.bindingMarker } : {}),
  };
}

function reportEnvelope(contract: ExecutionContract, execution: ExecutionBindingContext) {
  return {
    contractId: contract.contractId,
    runId: execution.activeRunId,
    round: execution.round,
    executionType: execution.executionType,
    ...(execution.parentRunId ? { parentRunId: execution.parentRunId } : {}),
    bindingMarker: execution.bindingMarker ?? reportBindingMarker(contract.contractId, execution.activeRunId, execution.round),
    executorName: contract.agentResolution.executionChannelName,
    providerId: contract.selectedConfiguration.providerId,
    modelId: contract.selectedConfiguration.modelId,
    executionChannelId: contract.selectedConfiguration.executionChannelId,
    reasoningProfile: contract.selectedConfiguration.reasoningProfile,
    runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
    terminalState: "READY_FOR_FINAL_REPORT",
    startedAt: "<ISO-8601 UTC optional>",
    completedAt: "<ISO-8601 UTC optional>",
    inspectedPaths: [],
    changedPaths: [],
    commands: [],
    evidenceIdentities: contract.evidenceIdentityState === "BOUND" ? [contract.evidenceIdentity] : [],
    findings: [],
    requirementProofs: contract.executionPackage.mandatoryRequirements.map(requirement => ({
      requirementId: requirement.id,
      classification: "EVIDENCE_REQUIRED",
      actualSourceBehavior: "<describe the actual implemented or observed behavior>",
      sourceBehaviorRefs: [],
      positiveProofRefs: [],
      negativeAdversarialProofRefs: [],
      persistenceReloadProofRefs: [],
      notes: `Required evidence types: ${requirement.requiredEvidenceTypes.join(", ")}. Add only evidence actually inspected or received; missing proof remains EVIDENCE_REQUIRED.`,
    })),
    validationResults: contract.requiredChecks.map(check => ({
      checkId: check.id,
      status: "NOT_RUN",
      details: "",
    })),
    executorClassification: "EVIDENCE_REQUIRED",
    nextAction: "<exact next action>",
    reportSections: Object.fromEntries(reportSectionIds.map(id => [id, "<required non-empty content>"])),
    rawReport: "<the JSON object itself is the advanced automation report>",
    missingRequiredSources: [],
    accessDeniedPaths: [],
    completedReportSections: [...reportSectionIds],
    closureCriteriaSatisfied: [],
  };
}


export function compileMarkdownReportTemplate(
  contract: ExecutionContract,
  locale: Locale,
  execution: PromptExecutionContext,
): string {
  const resolved = resolvedExecution(execution);
  const envelope = reportEnvelope(contract, resolved);
  const marker = envelope.bindingMarker;
  const lines: string[] = [
    `${reportHeaderLabels.contractId}: ${envelope.contractId}`,
    `${reportHeaderLabels.runId}: ${envelope.runId}`,
    `${reportHeaderLabels.round}: ${envelope.round}`,
    `${reportHeaderLabels.executionType}: ${envelope.executionType}`,
    `${reportHeaderLabels.parentRunId}: ${envelope.parentRunId ?? "NONE"}`,
    `${reportHeaderLabels.bindingMarker}: ${marker}`,
    `${reportHeaderLabels.executorName}: ${envelope.executorName}`,
    `${reportHeaderLabels.providerId}: ${envelope.providerId}`,
    `${reportHeaderLabels.modelId}: ${envelope.modelId}`,
    `${reportHeaderLabels.executionChannelId}: ${envelope.executionChannelId}`,
    `${reportHeaderLabels.reasoningProfile}: ${envelope.reasoningProfile}`,
    `${reportHeaderLabels.runtimeProfileId}: ${envelope.runtimeProfileId}`,
    `${reportHeaderLabels.terminalState}: READY_FOR_FINAL_REPORT`,
    "",
    canonicalSectionHeading("executive-summary", locale),
    locale === "ar"
      ? `قدّم ملخصًا نهائيًا واحدًا للهدف المعتمد: ${contract.objective}`
      : `Provide one current final summary for the approved objective: ${contract.objective}`,
    "",
    canonicalSectionHeading("sources-inspected", locale),
    locale === "ar"
      ? "لم يُثبت فحص مسار بعد. أضف [IC-PATH] فقط بعد فحص المسار فعليًا؛ المسار المصرح به ليس دليلًا على الفحص."
      : "No inspected path has been proven yet. Add [IC-PATH] only after actual inspection; an authorized path is not proof of inspection.",
    ...(contract.evidenceIdentityState === "BOUND"
      ? [`- [IC-EVIDENCE-IDENTITY] ${JSON.stringify(contract.evidenceIdentity)}`]
      : []),
    "",
    canonicalSectionHeading("evidence-matrix", locale),
    ...contract.executionPackage.mandatoryRequirements.flatMap(requirement => {
      const proof = envelope.requirementProofs.find(item => item.requirementId === requirement.id)!;
      return [
        `- [IC-FINDING] ${JSON.stringify({
          requirementId: requirement.id,
          claim: requirement.outcome,
          status: "EVIDENCE_REQUIRED",
          evidenceRefs: proof.sourceBehaviorRefs,
        })}`,
        `- [IC-REQUIREMENT-PROOF] ${JSON.stringify(proof)}`,
      ];
    }),
    "",
    canonicalSectionHeading("unsupported-claims", locale),
    locale === "ar"
      ? "لا تُرقِّ أي ادعاء إلى PASS قبل الدليل الموثوق المنفصل."
      : "Do not promote any claim to PASS before separate trusted evidence exists.",
    "",
    canonicalSectionHeading("evidence-gaps", locale),
    locale === "ar"
      ? "سجّل أي مصدر مفقود أو فشل وصول بوضوح؛ لا تعتبره PASS."
      : "Record any missing source or access failure explicitly; never infer PASS.",
    "",
    canonicalSectionHeading("validation-results", locale),
    ...envelope.validationResults.map(item => `- [IC-VALIDATION] ${JSON.stringify(item)}`),
    "",
    canonicalSectionHeading("executor-classification", locale),
    "EVIDENCE_REQUIRED",
    "",
    canonicalSectionHeading("exact-next-action", locale),
    locale === "ar"
      ? "أكمل صفوف الإثبات المطلوبة وأعد التقرير النهائي الحالي نفسه."
      : "Complete the required proof rows and return the same authoritative current final report.",
  ];
  return lines.join("\n");
}

function configuration(contract: ExecutionContract, arabic: boolean) {
  return `## ${arabic ? "التشغيل المعتمد" : "Approved execution"}
${arabic ? "المزوّد" : "Provider"}: ${contract.selectedConfiguration.providerId}
${arabic ? "الموديل" : "Model"}: ${contract.agentResolution.modelDisplayName} (${contract.selectedConfiguration.modelId})
${arabic ? "قناة التنفيذ" : "Execution channel"}: ${contract.agentResolution.executionChannelName} (${contract.selectedConfiguration.executionChannelId})
${arabic ? "الاستدلال/الجهد" : "Reasoning / effort"}: ${contract.selectedConfiguration.reasoningProfile}
${arabic ? "ملف التشغيل" : "Runtime profile"}: ${contract.selectedConfiguration.runtimeProfileId}`;
}

export function localizedAgentGoal(contract: ExecutionContract, locale: Locale): string {
  if (locale !== "ar") return contract.agentResolution.boundedGoal;
  const action = contract.taskMode === "REPORT_REVIEW"
    ? `تحقّق من الادعاءات الجوهرية الخاصة بالهدف التالي: ${contract.objective}`
    : contract.taskMode === "CONTROLLED_AUDIT"
      ? `أثبت نتائج مدعومة بالأدلة للهدف التالي: ${contract.objective}`
      : `أثبت السبب الجذري ونفّذ التغيير المتماسك المعتمد للهدف التالي: ${contract.objective}`;
  const boundary = contract.taskMode === "SOURCE_IMPLEMENTATION"
    ? "دون توسيع النطاق أو تغيير مصدر غير متعلق"
    : contract.taskMode === "CONTROLLED_AUDIT"
      ? "دون تعديل المصدر أو تجاوز حدود التفويض المعتمدة"
      : contract.scope.evidenceFiles.length
        ? "دون تعديل المصدر أو تجاوز التقرير والنطاق والأدلة الداعمة المعتمدة"
        : "دون تعديل المصدر أو تجاوز التقرير والنطاق المعتمدين";
  return contract.selectedConfiguration.executionChannelId === "CODEX"
    ? `/goal ${action}، ${boundary}.`
    : `${action}، ${boundary}.`;
}

function localizedItems(locale: Locale, items: string[]): string[] {
  return localizeContractTexts(locale, items);
}

function hasEffectiveCapability(contract: ExecutionContract, capability: string): boolean {
  return contract.policyDecisionTrace.some(item => item.capability === capability && item.effective);
}

function scopeExpansionRule(arabic: boolean): string {
  return arabic
    ? "إذا احتجت مسارًا خارج حدود التفويض، فتوقف بتصنيف EVIDENCE_REQUIRED وحدد المسار الدقيق وسبب الحاجة والتوسيع المقترح. لا تفحص المسار ولا تعدله قبل قرار مالك جديد وعقد معتمد."
    : "If a required path is outside the authority boundary, stop with EVIDENCE_REQUIRED and name the exact path, why it is needed, and the proposed scope expansion. Do not inspect or modify it until a new owner decision and approved contract exist.";
}

function previewReadiness(locale: Locale, reason: ReturnType<typeof phase>["reason"]): string {
  if (locale === "ar") {
    if (reason === "OWNER_APPROVAL_PENDING") return "في انتظار موافقة المالك. المعاينة غير قابلة للتنفيذ.";
    if (reason === "OWNER_APPROVED_AWAITING_ACTIVE_RUN") return "تمت موافقة المالك. المعاينة غير قابلة للتنفيذ حتى إنشاء Active Run.";
    return "تم إنشاء Active Run والعقد قابل للتنفيذ.";
  }
  if (reason === "OWNER_APPROVAL_PENDING") return "Awaiting owner approval. This preview is not executable.";
  if (reason === "OWNER_APPROVED_AWAITING_ACTIVE_RUN") return "Owner approval is recorded. This preview is not executable until an Active Run is created.";
  return "An Active Run exists and the contract is executable.";
}

export function compileExecutorNeutralPrompt(
  contract: ExecutionContract,
  locale: Locale = "en",
  execution?: PromptExecutionContext,
): string {
  const arabic = locale === "ar";
  const state = phase(contract, execution);
  const none = arabic ? "لا يوجد" : "None";

  return `# ${arabic ? "معاينة عقد IntentChord" : "IntentChord Contract Preview"}

${arabic ? "الحالة" : "Status"}: ${state.executable ? "EXECUTABLE" : "NOT EXECUTABLE"}
${arabic ? "حالة سير العمل" : "Workflow state"}: ${state.reason}
${arabic ? "جاهزية التنفيذ" : "Execution readiness"}: ${previewReadiness(locale, state.reason)}
${arabic ? "معرف العقد" : "Contract ID"}: ${contract.contractId}

## ${arabic ? "موافقة المالك" : "Owner approval"}
${arabic ? "مطلوبة" : "Required"}: ${contract.ownerApproval.required ? (arabic ? "نعم" : "Yes") : (arabic ? "لا" : "No")}
${arabic ? "الحالة" : "State"}: ${contract.ownerApproval.state}

${configuration(contract, arabic)}

## ${arabic ? "الهدف المحدد" : "Bounded objective"}
${contract.objective}

## ${arabic ? "الهدف المحلول للوكيل" : "Resolved agent goal"}
${localizedAgentGoal(contract, locale)}

## ${arabic ? "سياق العقد" : "Contract context"}
${arabic ? "مساحات العمل المعتمدة" : "Approved workspaces"}:
${list(workspaceContext(contract, none), none)}
${arabic ? "نمط المهمة" : "Task mode"}: ${contract.taskMode}
${arabic ? "المهارة" : "Task skill"}: ${contract.agentResolution.taskSkill.id}@${contract.agentResolution.taskSkill.version}
${arabic ? "حالة التنفيذ" : "Execution state"}: ${contract.executionPackage.completionLock.executionState}
${arabic ? "قفل الإكمال" : "Completion Lock"}: ${contract.executionPackage.completionLock.rule}
${arabic ? "متطلبات إلزامية" : "Mandatory requirements"}:
${list(mandatoryRequirementContext(contract), none)}
${arabic ? "خريطة الاكتشاف المقيّد" : "Bounded Discovery Map"}:
${boundedDiscoveryContext(contract, arabic, none)}
${arabic ? "نطاق الاكتشاف والقراءة المصرح — حدود تفويض وليست إثبات صلة أو كفاية" : "Authorized discovery / read scope — authority boundary, not relevance or completeness proof"}:
${list(contract.scope.workspaces.filter(workspace => workspace.discoveryScopeMode !== "NONE").map(workspace => `${workspace.displayName}: ${workspaceReadBoundary(workspace, none)}`), none)}
${arabic ? "نطاق التعديل المصرح" : "Authorized modification scope"}:
${list(hasEffectiveCapability(contract, "modifySource") ? contract.scope.workspaces.filter(workspace => workspace.discoveryScopeMode === "SELECTED_PATHS").flatMap(workspace => workspace.allowedPaths.map(path => `${workspace.displayName}: ${path}`)) : [], none)}
${arabic ? "النطاق المستبعد" : "Excluded scope"}:
${list(contract.scope.excludedPaths, none)}
${arabic ? "ملفات الأدلة الداعمة الاختيارية (للقراءة فقط)" : "Evidence files — optional supporting evidence (read only)"}:
${list(contract.scope.evidenceFiles, none)}
${arabic ? "قاعدة توسيع النطاق" : "Scope expansion rule"}: ${scopeExpansionRule(arabic)}
${contract.taskMode === "REPORT_REVIEW" && contract.scope.evidenceFiles.length === 0
    ? `\n${arabic ? "ملاحظة" : "Note"}: ${arabic ? "عدم وجود أدلة داعمة لا يمنع إنشاء العقد، لكنه يمنع تحويل الادعاءات غير المثبتة إلى PASS." : "Missing supporting evidence does not block contract creation, but unsupported claims cannot be upgraded to PASS."}`
    : ""}

## ${arabic ? "التفويض الفعّال" : "Effective authority"}
${arabic ? "الصلاحيات الفعّالة" : "Effective capabilities"}:
${list(contract.policyDecisionTrace.filter(item => item.effective).map(item => item.capability), none)}
${arabic ? "الإجراءات المسموحة" : "Allowed actions"}:
${list(localizedItems(locale, contract.allowedActions), none)}
${arabic ? "الإجراءات المحظورة" : "Forbidden actions"}:
${list(localizedItems(locale, contract.forbiddenActions), none)}

## ${arabic ? "استراتيجية التحقيق" : "Investigation strategy"}
${localizedItems(locale, contract.agentResolution.investigationStrategy).map((step, index) => `${index + 1}. ${step}`).join("\n")}

## ${arabic ? "ضوابط الوكيل المحدد" : "Agent controls"}
${list(localizedItems(locale, contract.agentResolution.behaviorControls), none)}

## ${arabic ? "صيغة التقرير" : "Report contract"}
${list(localizedItems(locale, contract.agentResolution.reportInstructions), none)}

## ${arabic ? "الفحوص المطلوبة" : "Required checks"}
${list(contract.requiredChecks.map(check => `${check.id} [${requiredCheckSatisfactionMode(check)}]: ${localizeContractText(locale, check.description)}`), none)}

## ${arabic ? "معايير الإغلاق" : "Closure criteria"}
${list(contract.closureCriteria.map(criterion => `${criterion.id}: ${localizeContractText(locale, criterion.description)} [${criterion.evidenceRequired.join(", ")}]`), none)}

## ${arabic ? "شروط التوقف" : "Stop conditions"}
${list(localizedItems(locale, contract.agentResolution.stopConditions), none)}`;
}

export function compileOptionalJsonTemplate(
  contract: ExecutionContract,
  execution: PromptExecutionContext,
): string {
  return JSON.stringify(reportEnvelope(contract, resolvedExecution(execution)), null, 2);
}

function compileAgentPromptBody(
  contract: ExecutionContract,
  locale: Locale = "en",
  execution?: PromptExecutionContext,
): string {
  const arabic = locale === "ar";
  const state = phase(contract, execution);

  if (!state.executable) {
    return `${compileExecutorNeutralPrompt(contract, locale, execution)}\n\n${previewReadiness(locale, state.reason)}`;
  }

  const resolved = resolvedExecution(execution!);
  const marker = resolved.bindingMarker ?? reportBindingMarker(contract.contractId, resolved.activeRunId, resolved.round);
  const lease = execution?.contextLease ?? contextLease(contract, resolved);
  const none = arabic ? "لا يوجد" : "None";
  const correctionGaps = execution?.correctionGaps ?? [];
  const ownerCorrectionInstruction = execution?.ownerCorrectionInstruction?.trim();
  const localizedCorrectionGaps = compactCorrectionItems(
    correctionGaps.map(gap => localizeVerdictText(locale, gap)),
  );
  const completedFacts = compactCorrectionItems(execution?.completedFacts ?? []);
  const inheritedCheckIds = execution?.inheritedCheckIds ?? [];

  if (resolved.executionType === "CORRECTION") {
    const unresolvedChecks = contract.requiredChecks
      .filter(check => check.required && !inheritedCheckIds.includes(check.id))
      .map(check => `${check.id} [${requiredCheckSatisfactionMode(check)}]: ${localizeContractText(locale, check.description)}`);
    const correctionStrategy = [
      arabic ? "أكد علامة ربط التقرير وإيجار السياق قبل أي فحص." : "Confirm the report binding marker and Context Lease before any inspection.",
      ...localizedCorrectionGaps.map(gap => `${arabic ? "أغلق هذه الفجوة فقط" : "Close only this gap"}: ${gap}`),
      arabic ? "لا تعِد تنفيذ أو فحص الحقائق والفحوص الموروثة إلا إذا أثبتت الفجوة أن سلوكها تغير." : "Do not rerun or re-investigate inherited facts and checks unless the named gap proves their behavior changed.",
      arabic ? "أعد فقط الأدلة الجديدة اللازمة لإغلاق الفجوات المحددة." : "Return only the new evidence needed to close the named gaps.",
    ];

    return `# ${arabic ? "عقد تنفيذ تصحيح IntentChord" : "IntentChord Execution Contract"}

${localizedAgentGoal(contract, locale)}

## ${arabic ? "هوية التنفيذ" : "Run identity"}
${reportHeaderLabels.contractId}: ${contract.contractId}
${reportHeaderLabels.runId}: ${resolved.activeRunId}
${arabic ? "التنفيذ النشط" : "Active Run"}: ${resolved.activeRunId}
${reportHeaderLabels.round}: ${resolved.round}
${reportHeaderLabels.executionType}: ${resolved.executionType}
${reportHeaderLabels.parentRunId}: ${resolved.parentRunId ?? "NONE"}
${reportHeaderLabels.bindingMarker}: ${marker}
${reportHeaderLabels.executorName}: ${contract.agentResolution.executionChannelName}
${reportHeaderLabels.providerId}: ${contract.selectedConfiguration.providerId}
${reportHeaderLabels.modelId}: ${contract.selectedConfiguration.modelId}
${reportHeaderLabels.executionChannelId}: ${contract.selectedConfiguration.executionChannelId}
${reportHeaderLabels.reasoningProfile}: ${contract.selectedConfiguration.reasoningProfile}
${reportHeaderLabels.runtimeProfileId}: ${contract.selectedConfiguration.runtimeProfileId}
${reportHeaderLabels.terminalState}: <STOP_FOR_OWNER|READY_FOR_FINAL_REPORT>

## ${arabic ? "إيجار السياق" : "Context Lease"}
${arabic ? "المراجعة" : "Revision"}: ${lease.revision}
${arabic ? "البصمة" : "Fingerprint"}: ${lease.fingerprint}
${arabic ? "القاعدة" : "Rule"}: ${arabic ? "استخدم هذا السياق فقط. توقف إذا تغيرت البصمة أو مساحة العمل أو هوية التشغيل." : "Use only this run context. Stop if its fingerprint, workspace, or run identity differs."}

${configuration(contract, arabic)}

## ${arabic ? "حدود التصحيح" : "Correction boundary"}
${arabic ? "الهدف الحاكم" : "Governing objective"}: ${contract.objective}
${arabic ? "نمط المهمة" : "Task mode"}: ${contract.taskMode}
${arabic ? "الفجوات الوحيدة المطلوب إغلاقها" : "Only gaps to close"}:
${list(localizedCorrectionGaps, arabic ? "لا توجد فجوة محددة" : "No named gap")}${ownerCorrectionInstruction ? `
${arabic ? "تعليمات المالك المحددة للتصحيح" : "Bounded Owner correction instruction"}:
${ownerCorrectionInstruction}
${arabic ? "لا توسّع هذه التعليمات الهدف أو النطاق أو الصلاحيات المعتمدة." : "This instruction does not expand the approved objective, scope, or authority."}` : ""}
${arabic ? "لا تعِد فحص الحقائق المثبتة التالية" : "Do not re-investigate these already proven facts"}:
${list(completedFacts, none)}
${arabic ? "الفحوص الموثقة الموروثة التي لا تُعاد" : "Inherited trusted checks that must not be rerun"}:
${list(inheritedCheckIds, none)}
${arabic ? "الفحوص غير المحسومة في هذه الجولة" : "Unresolved checks for this round"}:
${list(unresolvedChecks, none)}

## ${arabic ? "دفتر المتطلبات الحاكم" : "Governing requirement ledger"}
${list(mandatoryRequirementContext(contract), none)}

## ${arabic ? "حدود التفويض" : "Authority boundary"}
${arabic ? "مساحات العمل المعتمدة" : "Approved workspaces"}:
${list(workspaceContext(contract, none), none)}
${arabic ? "نطاق القراءة" : "Authorized discovery / read scope"}: ${authorizedReadScope(contract, none)}
${arabic ? "نطاق التعديل" : "Authorized modification scope"}: ${authorizedModificationScope(contract, none)}
${arabic ? "المستبعد" : "Excluded"}: ${contract.scope.excludedPaths.join(", ") || none}
${arabic ? "الصلاحيات الفعالة" : "Effective capabilities"}:
${list(contract.policyDecisionTrace.filter(item => item.effective).map(item => item.capability), none)}
${arabic ? "قاعدة التفويض" : "Authority rule"}: ${arabic ? "حدود التفويض ليست دليلًا، ولا يجوز توسيع الهدف أو النطاق أو الصلاحيات في جولة التصحيح." : "Authorization boundaries are not evidence and the correction round cannot expand the approved objective, scope, or authority."}
${arabic ? "طلب توسيع النطاق" : "Scope expansion request"}: ${scopeExpansionRule(arabic)}

## ${arabic ? "خطة التصحيح بالترتيب" : "Ordered correction strategy"}
${correctionStrategy.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## ${arabic ? "شروط التوقف" : "Stop conditions"}
${list(localizedItems(locale, contract.agentResolution.stopConditions), none)}

## ${arabic ? "عقد الإثبات والتقرير" : "Evidence and report contract"}
${arabic ? "قاعدة الإثبات" : "Proof rule"}: ${arabic ? "كل نتيجة مثبتة يجب أن تشير إلى فئة الدليل المطابقة: SOURCE_EVIDENCE أو ARTIFACT_EVIDENCE أو VALIDATION_EVIDENCE أو RUNTIME_EVIDENCE. اختبارات المسار السلبي/العدائي وإثبات spoofing أو replay مطلوبة عندما تنطبق. لا تمنح PASS لنوع دليل مفقود." : "Every proven finding must cite its matching evidence class: SOURCE_EVIDENCE, ARTIFACT_EVIDENCE, VALIDATION_EVIDENCE, or RUNTIME_EVIDENCE. Applicable negative/adversarial, spoofing, or replay proof remains mandatory. Never assign PASS while a required evidence class is missing."}
${arabic ? "صيغة التقرير" : "Report format"}: ${arabic ? "Markdown منظم افتراضيًا؛ لا تُرجع JSON-only." : "Return structured Markdown by default; never return JSON-only."}
${arabic ? "استخدم قيم الرأس الحاكمة أعلاه حرفيًا." : "Use the governed header values above exactly."}

${arabic ? "الأقسام المطلوبة بعلامات ثابتة" : "Required canonical sections"}:
${reportSectionIds.map(id => canonicalSectionHeading(id, locale)).join("\n")}

${arabic ? "صفوف الأدلة الآلية" : "Machine-readable evidence rows"}:
- [IC-PATH] {"workspaceId":"<uuid>","path":"<relative/path>"}
- [IC-FINDING] {"requirementId":"<id>","claim":"<claim>","status":"PROVEN_BY_SOURCE|PROVEN_BY_ARTIFACT|PROVEN_BY_VALIDATION|PROVEN_BY_RUNTIME|CONTRADICTED|NOT_PROVEN|EVIDENCE_REQUIRED","evidenceRefs":[]}
- [IC-REQUIREMENT-PROOF] {"requirementId":"<id>","classification":"PASS|BLOCKER|VIOLATION|EVIDENCE_REQUIRED","actualSourceBehavior":"<actual behavior>","sourceBehaviorRefs":[],"positiveProofRefs":[],"negativeAdversarialProofRefs":[],"persistenceReloadProofRefs":[],"notes":"<new proof or remaining gap>"}
- [IC-VALIDATION] {"checkId":"<id>","status":"PASS|FAIL|NOT_RUN","details":"<executor claim only>"}
- [IC-COMMAND] {"command":"<exact command>","exitCode":0,"purpose":"<purpose>"}

${arabic ? "قفل الجولة" : "Round lock"}: ${arabic ? "أعد تقريرًا نهائيًا إلزاميًا قبل إغلاق التشغيل. يجب أن يوضح الأدلة الجديدة، والفجوات التي أغلقت، والفجوات الباقية، وتصنيف المنفذ، وحالة التنفيذ النهائية، والإجراء التالي المحدد. جاهزية التقرير منفصلة عن الـDeterministic Verdict." : "Return one mandatory final report before Run closure. It must state the new evidence, gaps closed, gaps still open, executor classification, execution terminal state, and exact next action. Report readiness is separate from the deterministic verdict."}`;
  }

  const orderedStrategy = localizedItems(locale, contract.agentResolution.investigationStrategy);

  const prompt = `# ${arabic ? "عقد تنفيذ IntentChord" : "IntentChord Execution Contract"}

${localizedAgentGoal(contract, locale)}

## ${arabic ? "هوية التنفيذ" : "Run identity"}
${reportHeaderLabels.contractId}: ${contract.contractId}
${reportHeaderLabels.runId}: ${resolved.activeRunId}
${arabic ? "التنفيذ النشط" : "Active Run"}: ${resolved.activeRunId}
${reportHeaderLabels.round}: ${resolved.round}
${reportHeaderLabels.executionType}: ${resolved.executionType}
${reportHeaderLabels.parentRunId}: ${resolved.parentRunId ?? "NONE"}
${reportHeaderLabels.bindingMarker}: ${marker}
${reportHeaderLabels.executorName}: ${contract.agentResolution.executionChannelName}
${reportHeaderLabels.providerId}: ${contract.selectedConfiguration.providerId}
${reportHeaderLabels.modelId}: ${contract.selectedConfiguration.modelId}
${reportHeaderLabels.executionChannelId}: ${contract.selectedConfiguration.executionChannelId}
${reportHeaderLabels.reasoningProfile}: ${contract.selectedConfiguration.reasoningProfile}
${reportHeaderLabels.runtimeProfileId}: ${contract.selectedConfiguration.runtimeProfileId}
${reportHeaderLabels.terminalState}: <STOP_FOR_OWNER|READY_FOR_FINAL_REPORT>

## ${arabic ? "إيجار السياق" : "Context Lease"}
${arabic ? "المراجعة" : "Revision"}: ${lease.revision}
${arabic ? "البصمة" : "Fingerprint"}: ${lease.fingerprint}
${arabic ? "القاعدة" : "Rule"}: ${arabic ? "استخدم هذا السياق فقط. توقف إذا تغيرت البصمة أو مساحة العمل أو هوية التشغيل." : "Use only this run context. Stop if its fingerprint, workspace, or run identity differs."}

${configuration(contract, arabic)}

## ${arabic ? "سياق المهمة المختصر" : "Execution Context Capsule"}
${arabic ? "الهدف" : "Objective"}: ${contract.objective}
${arabic ? "نمط المهمة" : "Task mode"}: ${contract.taskMode}
${arabic ? "فهم الهدف المؤكد" : "Confirmed intent understanding"}:
${confirmedIntentContext(contract, arabic, none)}
${arabic ? "متطلبات الإثبات الإلزامية" : "Mandatory proof requirements"}:
${list(mandatoryRequirementContext(contract), none)}
${arabic ? "خريطة الاكتشاف المقيّد" : "Bounded Discovery Map"}:
${boundedDiscoveryContext(contract, arabic, none)}
${arabic ? "مساحات العمل المعتمدة" : "Approved workspaces"}: ${workspaceContext(contract, none).join("\n") || none}
${arabic ? "حالة هوية الأدلة" : "Evidence identity state"}: ${contract.evidenceIdentityState}
${arabic ? "هوية الأدلة" : "Evidence identity"}: ${contract.evidenceIdentityState === "BOUND" ? JSON.stringify(contract.evidenceIdentity) : "NOT_ESTABLISHED"}
${arabic ? "نطاق الاكتشاف والقراءة المصرح" : "Authorized discovery / read scope"}: ${authorizedReadScope(contract, none)}
${arabic ? "نطاق التعديل المصرح" : "Authorized modification scope"}: ${authorizedModificationScope(contract, none)}
${arabic ? "قاعدة النطاق" : "Scope rule"}: ${arabic ? "هذه المسارات حدود تفويض، وليست إثباتًا بأنها كاملة أو كافية أو مرتبطة بالسبب الجذري." : "These paths are an authority boundary, not proof that they are complete, sufficient, or relevant to the root cause."}
${arabic ? "مستبعد" : "Excluded"}: ${contract.scope.excludedPaths.join(", ") || none}
${arabic ? "أدلة داعمة اختيارية محددة مسبقًا للقراءة فقط" : "Optional preselected read-only supporting evidence"}: ${contract.scope.evidenceFiles.join(", ") || none}
${arabic ? "طلب توسيع النطاق" : "Scope expansion request"}: ${scopeExpansionRule(arabic)}
${contract.taskMode === "CONTROLLED_AUDIT" && contract.scope.evidenceFiles.length === 0 ? `${arabic ? "قاعدة بدء التدقيق" : "Audit start rule"}: ${arabic ? "ابدأ من نطاق الاكتشاف المصرح، واستخرج الدليل الفعلي أثناء الفحص. لا تشترط على المالك معرفة ملف السبب الجذري أو مسار دليل منفصل مسبقًا." : "Begin from the authorized discovery scope and extract the actual evidence during inspection. Do not require the owner to know the root-cause file or a separate evidence path in advance."}
` : ""}

## ${arabic ? "السلطة" : "Authority"}
${arabic ? "مسموح" : "Effective"}:
${list(contract.policyDecisionTrace.filter(item => item.effective).map(item => item.capability), none)}
${arabic ? "غير مسموح" : "Forbidden"}:
${list(contract.policyDecisionTrace.filter(item => !item.effective).map(item => item.capability), none)}

## ${arabic ? "خطة التحقيق بالترتيب" : "Ordered investigation strategy"}
${orderedStrategy.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## ${arabic ? "ضوابط قناة التنفيذ المحددة" : "Selected agent controls"}
${list(localizedItems(locale, [...contract.agentResolution.contextRules, ...contract.agentResolution.behaviorControls]), none)}

## ${arabic ? "التحقق" : "Validation"}
${list(localizedItems(locale, contract.agentResolution.validationWorkflow), none)}

## ${arabic ? "التقرير المطلوب" : "Required report"}
${list(localizedItems(locale, contract.agentResolution.reportInstructions), none)}
${arabic ? "استخدم حقول الرأس الحاكمة أعلاه حرفيًا. لا تغيّر أسماء الحقول ولا تدّعي هوية لم يثبتها التنفيذ." : "Use the governed header fields above exactly. Do not rename them or claim an identity not proven by the Run."}

${arabic ? "الأقسام المطلوبة بعلامات ثابتة" : "Required canonical sections"}:
${reportSectionIds.map(id => canonicalSectionHeading(id, locale)).join("\n")}

${arabic ? "صفوف الأدلة الآلية داخل الأقسام" : "Machine-readable evidence rows inside the sections"}:
- [IC-PATH] {"workspaceId":"<uuid>","path":"<relative/path>"}
- [IC-CHANGED-PATH] {"workspaceId":"<uuid>","path":"<relative/path>"}
- [IC-EVIDENCE-IDENTITY] {"runId":"<id>"} (emit only when a trusted evidence identity is actually bound)
- [IC-FINDING] {"requirementId":"<mandatory requirement id>","claim":"<claim>","status":"PROVEN_BY_SOURCE|PROVEN_BY_ARTIFACT|PROVEN_BY_VALIDATION|PROVEN_BY_RUNTIME|CONTRADICTED|NOT_PROVEN|EVIDENCE_REQUIRED","evidenceRefs":[{"kind":"SOURCE_EVIDENCE","workspaceId":"<uuid>","relativePath":"<relative/path>","symbol":"<optional symbol>","lineStart":1,"lineEnd":1,"contentSha256":"<sha256>"}]}
- [IC-REQUIREMENT-PROOF] {"requirementId":"<mandatory requirement id>","classification":"PASS|BLOCKER|VIOLATION|EVIDENCE_REQUIRED","actualSourceBehavior":"<actual behavior>","sourceBehaviorRefs":[],"positiveProofRefs":[],"negativeAdversarialProofRefs":[],"persistenceReloadProofRefs":[],"notes":"<identify which evidence classes are present or missing>"}
- [IC-VALIDATION] {"checkId":"<id>","status":"PASS|FAIL|NOT_RUN","details":"<executor claim only; independent evidence is recorded separately>"}
- [IC-COMMAND] {"command":"<exact command>","exitCode":0,"purpose":"<purpose>"}

${arabic ? "قاعدة الإثبات" : "Proof rule"}: ${arabic ? "حدود التفويض ليست دليلًا، وادعاءات المنفذ ليست دليلًا مستقلًا. إثبات السورس يحتاج SOURCE_EVIDENCE بمسار نسبي ورمز أو أسطر وبصمة محتوى. إثبات الـartifact يحتاج ARTIFACT_EVIDENCE. نتائج الاختبار والبناء تحتاج VALIDATION_EVIDENCE موثوقة، وسلوك التشغيل يحتاج RUNTIME_EVIDENCE مرتبطة بهوية تشغيل. لا تستخدم السورس لإثبات الـruntime، ولا تمنح PASS إذا كان نوع دليل إلزامي ما زال مفقودًا." : "Authorization boundaries are not evidence, and executor claims are not independent evidence. Source behavior requires exact SOURCE_EVIDENCE with a workspace-relative path, symbol or line range, and content hash. Artifact identity requires ARTIFACT_EVIDENCE. Test or build results require trusted VALIDATION_EVIDENCE, and runtime behavior requires run-bound RUNTIME_EVIDENCE. Never use source evidence to prove runtime behavior, and do not assign PASS while a mandatory evidence type is missing."}

## ${arabic ? "شروط التوقف" : "Stop conditions"}
${list(localizedItems(locale, contract.agentResolution.stopConditions), none)}

${arabic ? "تنبيه" : "Important"}: ${arabic ? "أعد Markdown منظمًا افتراضيًا. لا تعد JSON إلا إذا طلب المالك وضع الأتمتة المتقدم صراحةً." : "Return structured Markdown by default. Do not return JSON unless the owner explicitly enables advanced automation mode."}`;

  return prompt;
}

export type CompiledPromptDiagnostics = {
  prompt: string;
  executable: boolean;
  issues: ContractLintIssue[];
};

export function compileAgentPromptDiagnostics(
  contract: ExecutionContract,
  locale: Locale = "en",
  execution?: PromptExecutionContext,
): CompiledPromptDiagnostics {
  const prompt = compileAgentPromptBody(contract, locale, execution);
  const state = phase(contract, execution);
  const issues = state.executable ? lintCompiledPrompt(prompt, contract) : [];
  return {
    prompt,
    executable: state.executable && issues.length === 0,
    issues,
  };
}

export function compileAgentPrompt(
  contract: ExecutionContract,
  locale: Locale = "en",
  execution?: PromptExecutionContext,
): string {
  const diagnostics = compileAgentPromptDiagnostics(contract, locale, execution);
  if (diagnostics.executable || diagnostics.issues.length === 0) return diagnostics.prompt;
  const arabic = locale === "ar";
  const heading = arabic ? "# أوقف مدقق العقد التنفيذ" : "# CONTRACT LINT BLOCKED";
  const instruction = arabic
    ? "أعد إنشاء العقد بعد تصحيح كل مشكلة. لا تنفذ هذا العقد المحظور."
    : "Regenerate the resolved contract after correcting every lint issue. Do not execute this blocked contract.";
  return `${heading}\nStatus: NOT EXECUTABLE\n\n${diagnostics.issues.map(issue => `- ${issue.code}: ${issue.message}`).join("\n")}\n\n${instruction}`;
}
