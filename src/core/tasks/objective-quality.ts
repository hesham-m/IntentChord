const genericObjectives = new Set([
  "test",
  "check",
  "review",
  "fix",
  "fix it",
  "do it",
  "do the task",
  "analyze",
  "audit",
  "task",
  "مراجعة",
  "راجع",
  "تحقق",
  "اختبر",
  "اختبار",
  "اصلح",
  "إصلاح",
  "حل المشكلة",
  "نفذ المهمة",
  "المهمة",
  "report review",
  "report_review",
  "source audit",
  "source_audit",
  "source implementation",
  "source_implementation",
  "controlled audit",
  "controlled_audit",
  "runtime investigation",
  "runtime_investigation",
  "مراجعة تقرير",
  "تدقيق مصدر",
  "تنفيذ مصدر",
  "تحقيق تشغيل",
]);

// Keep this list limited to filler words and generic verbs. Domain nouns such as
// report, evidence, source, file, binding, or workspace are useful specificity
// signals and must remain available to the semantic check below.
const genericTokens = new Set([
  "test", "check", "review", "task", "mode", "implementation", "investigation", "controlled", "fix", "issue", "problem", "validate", "verify", "analyze", "audit", "please", "perform", "do", "the",
  "مراجعة", "راجع", "مهمة", "المهمة", "تحقق", "اختبر", "اختبار", "اصلح", "إصلاح", "حل", "مشكلة", "المشكلة", "نفذ", "فحص", "تحليل",
]);

const actionPattern = /\b(?:verify|validate|review|compare|classify|prove|determine|identify|confirm|audit|inspect|trace|implement|repair|remediate|perform|fix|measure|check|investigate|diagnose)\b|(?:تحق(?:ق|ّق)|راجع|قارن|صنّف|أثبت|حدد|حدّد|أكد|أكّد|افحص|فحص|حلّل|حلل|تحليل|شخّص|شخص|تتبّع|تتبع|نفّذ|نفذ|أصلح|اصلح|قس|اختبر)/i;
const proofPattern = /\b(?:evidence|claims?|findings?|results?|conditions?|criteria|criterion|paths?|files?|reports?|sessions?|runs?|contracts?|logs?|statuses?|outputs?|bindings?|markers?|sources?|workspaces?|modules?|regressions?|against|whether|root cause|cause)\b|(?:دليل|أدلة|ادعاء|ادعاءات|نتيجة|نتائج|شرط|معيار|معايير|مسار|مسارات|ملف|ملفات|تقرير|تقارير|جلسة|جلسات|تشغيل|عقد|عقود|سجل|سجلات|حالة|حالات|مقابل|ما إذا|ربط|علامة|مصدر|مصادر|مساحة العمل|سبب|السبب الجذري)/i;
const explicitIdentifierPattern = /\b(?:v(?:ersion)?\s*)?\d+(?:\.\d+){1,3}\b|\b[A-Z]{2,}(?:[-_][A-Z0-9]+)+\b/i;
const conciseSubjectPattern = /\b(?:update\s+channel|self[- ]?update|version|release|workbench|readiness|backend|client|server|api|database|postgres|workspace|report|evidence|runtime|startup|session|service|screen|workflow|policy|module|file|source|filter|firewall|sophos)\b|(?:قناة\s*التحديث|التحديث\s*الذاتي|إصدار|نسخة|جاهزية|واجهة|خادم|عميل|قاعدة\s*البيانات|مساحة\s*العمل|تقرير|دليل|تشغيل|جلسة|خدمة|سياسة|ملف|مصدر|سوفوس|فلتر)/i;

const diagnosticPattern = /\b(?:why|root cause|cause of|not working|does not work|fails?|failure|broken|stopped|stops|unavailable|issue with|problem with)\b|(?:لماذا|لمَ|سبب|السبب|لا تعمل|لا يعمل|لا يفتح|لا يظهر|لا يستجيب|تعطل|متعطل|متوقف|توقف|فشل|يفشل|مشكلة في)/i;

function lexicalForm(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function boundedObjectiveIssue(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  const lexical = lexicalForm(normalized);
  if (!normalized) return "The owner objective is required.";
  const shortConcreteIdentifier = conciseSubjectPattern.test(normalized) && explicitIdentifierPattern.test(normalized);
  if (genericObjectives.has(lower) || genericObjectives.has(lexical) || normalized.length < 6 || (normalized.length < 12 && !shortConcreteIdentifier)) {
    return "The owner objective is generic. Name the bounded subject and the problem or outcome to investigate.";
  }

  const tokens = lexical.split(/[^\p{L}\p{N}.]+/u).filter(Boolean);
  const meaningful = tokens.filter(token => token.length >= 3 && !genericTokens.has(token));
  const hasConcreteReference = /(?:[\\/]|\.[a-z0-9]{1,8}\b|\b(?:run|session|contract|report|service|module|policy|screen|workflow|binding|marker|runtime|startup|ldap|cpu|vm|firewall|source|evidence|file|workspace|filter|sophos)s?(?:[-_ ][a-z0-9]+)*)/i.test(normalized)
    || /(?:ملف|ملفات|مسار|مسارات|جلسة|جلسات|تشغيل|عقد|عقود|سياسة|تقرير|تقارير|خدمة|وحدة|واجهة|ربط|علامة|دليل|أدلة|خادم|جدار|معالج|مساحة العمل|مصدر|مصادر|سوفوس|فلتر)/i.test(normalized);
  const diagnostic = diagnosticPattern.test(normalized);
  const conciseConcreteObjective =
    meaningful.length >= 2
    && conciseSubjectPattern.test(normalized)
    && (explicitIdentifierPattern.test(normalized) || hasConcreteReference);

  if (meaningful.length < 2) {
    return "The owner objective is not specific enough to identify one bounded subject.";
  }
  if (!actionPattern.test(normalized) && !diagnostic && !conciseConcreteObjective) {
    return "The owner objective must identify a concrete subject, problem, or expected result.";
  }
  if (!proofPattern.test(normalized) && !hasConcreteReference && !diagnostic && !explicitIdentifierPattern.test(normalized)) {
    return "The owner objective must identify the bounded subject or observable result.";
  }
  return undefined;
}

export function isBoundedObjective(value: string): boolean {
  return boundedObjectiveIssue(value) === undefined;
}
