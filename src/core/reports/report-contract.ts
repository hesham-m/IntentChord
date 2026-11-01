export const reportSectionIds = [
  "executive-summary",
  "sources-inspected",
  "evidence-matrix",
  "unsupported-claims",
  "evidence-gaps",
  "validation-results",
  "executor-classification",
  "exact-next-action",
] as const;

export type ReportSectionId = typeof reportSectionIds[number];

export const reportSectionTitles: Record<ReportSectionId, { en: string; ar: string }> = {
  "executive-summary": { en: "Executive summary", ar: "الملخص التنفيذي" },
  "sources-inspected": { en: "Sources inspected", ar: "المصادر التي تم فحصها" },
  "evidence-matrix": { en: "Claim / finding evidence matrix", ar: "مصفوفة الادعاءات والنتائج والأدلة" },
  "unsupported-claims": { en: "Unsupported or contradicted claims", ar: "الادعاءات غير المدعومة أو المتناقضة" },
  "evidence-gaps": { en: "Evidence gaps and access failures", ar: "فجوات الأدلة وفشل الوصول" },
  "validation-results": { en: "Validation results", ar: "نتائج التحقق" },
  "executor-classification": { en: "Executor classification", ar: "تصنيف المنفذ" },
  "exact-next-action": { en: "Exact next action", ar: "الإجراء التالي المحدد" },
};

export const reportHeaderLabels = {
  contractId: "IntentChord Contract",
  runId: "IntentChord Run",
  round: "IntentChord Round",
  executionType: "IntentChord Execution Type",
  parentRunId: "IntentChord Parent Run",
  bindingMarker: "IntentChord Binding",
  executorName: "IntentChord Executor",
  providerId: "IntentChord Provider",
  modelId: "IntentChord Model",
  executionChannelId: "IntentChord Execution Channel",
  reasoningProfile: "IntentChord Reasoning Profile",
  runtimeProfileId: "IntentChord Runtime Profile",
  terminalState: "IntentChord Terminal State",
} as const;

export function canonicalSectionHeading(id: ReportSectionId, locale: "en" | "ar") {
  return `## [IC-SECTION:${id}] ${reportSectionTitles[id][locale]}`;
}
