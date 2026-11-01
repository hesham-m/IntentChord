import { createHash } from "node:crypto";
import {
  intentResolutionSchema,
  type IntentPlannerInput,
  type IntentResolution,
} from "@/core/intelligence/intent-schema";
import { assertProviderExecutionBinding } from "@/core/providers/ai-role-routing";

export interface IntentPlannerProvider {
  readonly adapterId: string;
  resolve(input: IntentPlannerInput): Promise<IntentResolution>;
}

type LocalizedText = { en: string; ar: string };

type TopicProfile = {
  idPrefix: string;
  match: RegExp;
  topic: (objective: string, version?: string) => string;
  concepts: LocalizedText[];
  questions: LocalizedText[];
  requirements: Array<{
    outcome: LocalizedText;
    evidence: IntentResolution["proposedRequirements"][number]["requiredEvidenceTypes"];
  }>;
  unknowns: LocalizedText[];
  forbiddenAssumptions: LocalizedText[];
};

const text = (en: string, ar: string): LocalizedText => ({ en, ar });

const updateChannelProfile: TopicProfile = {
  idPrefix: "UPD",
  match: /(update\s*channel|self[- ]?update|self[- ]?update readiness|native releases?|artifacts?|manifest|قناة\s*التحديث|التحديث\s*الذاتي)/i,
  topic: (_objective, version) => version ? `Update Channel ${version}` : "Update Channel",
  concepts: [
    text("update channel", "قناة التحديث"),
    text("self-update readiness", "جاهزية التحديث الذاتي"),
    text("artifacts", "حزم الإصدار"),
    text("native releases", "الإصدارات الأصلية"),
    text("manifest", "ملف الـManifest"),
    text("version authority", "سلطة تحديد الإصدار"),
    text("backend projection", "إسقاط قرار الـBackend"),
    text("frontend presentation", "عرض الواجهة"),
  ],
  questions: [
    text("Where is the authoritative update-version decision made?", "أين يُتخذ القرار الحاكم لإصدار التحديث؟"),
    text(
      "How do readiness, artifacts, native releases, and manifest data flow through the approved workspaces?",
      "كيف تتدفق بيانات الجاهزية وحزم الإصدار والإصدارات الأصلية والـManifest عبر مساحات العمل المعتمدة؟",
    ),
    text(
      "Does the frontend only project Backend-provided state, or does it contain independent update authority?",
      "هل تعرض الواجهة حالة مقدمة من الـBackend فقط، أم تحتوي على سلطة تحديث مستقلة؟",
    ),
    text(
      "Is the target version represented consistently across the discovered Backend, client, manifest, and release layers?",
      "هل يظهر الإصدار المستهدف بصورة متسقة عبر طبقات الـBackend والعميل والـManifest والإصدار التي سيجري اكتشافها؟",
    ),
    text(
      "Which conclusions can be established from source, and which still require artifact, validation, or runtime evidence?",
      "ما الاستنتاجات التي يمكن إثباتها من المصدر، وما الذي يظل محتاجًا إلى دليل حزمة أو تحقق أو تشغيل فعلي؟",
    ),
  ],
  requirements: [
    {
      outcome: text(
        "Identify the authoritative source of the target update version.",
        "حدد المصدر الحاكم لإصدار التحديث المستهدف.",
      ),
      evidence: ["SOURCE"],
    },
    {
      outcome: text(
        "Trace readiness, artifact, native-release, and manifest data flow across the approved workspaces.",
        "تتبّع تدفق الجاهزية وحزم الإصدار والإصدارات الأصلية والـManifest عبر مساحات العمل المعتمدة.",
      ),
      evidence: ["SOURCE"],
    },
    {
      outcome: text(
        "Determine whether the frontend is a Backend projection or contains independent update authority.",
        "حدد هل الواجهة مجرد إسقاط لقرار الـBackend أم تحتوي على سلطة تحديث مستقلة.",
      ),
      evidence: ["SOURCE"],
    },
    {
      outcome: text(
        "Assess version-identity consistency across every discovered relevant layer.",
        "قيّم اتساق هوية الإصدار عبر كل طبقة ذات صلة يجري اكتشافها.",
      ),
      evidence: ["SOURCE", "ARTIFACT"],
    },
    {
      outcome: text(
        "Separate source findings from remaining validation and runtime claims.",
        "افصل نتائج المصدر عن ادعاءات التحقق والتشغيل التي لم تُثبت بعد.",
      ),
      evidence: ["SOURCE"],
    },
  ],
  unknowns: [
    text("The exact relevant files and symbols have not been discovered yet.", "لم تُكتشف بعد الملفات والرموز الفعلية ذات الصلة."),
    text("Cross-file and cross-workspace coupling has not been assessed yet.", "لم يُقيّم بعد الترابط بين الملفات ومساحات العمل."),
    text("Installed artifact and runtime behavior have not been proven yet.", "لم تُثبت بعد هوية الحزمة المثبتة أو سلوك التشغيل الفعلي."),
  ],
  forbiddenAssumptions: [
    text("The presence of source code does not prove that runtime behavior succeeds.", "وجود كود المصدر لا يثبت نجاح سلوك التشغيل الفعلي."),
    text("A version string in one file does not prove version consistency across all layers.", "ظهور رقم إصدار في ملف واحد لا يثبت اتساقه عبر كل الطبقات."),
    text("A selected workspace is an authority boundary, not proof that every file is relevant.", "مساحة العمل المختارة حد تفويض وليست دليلًا على صلة كل ملفاتها."),
    text("A frontend display is not automatically the source of update authority.", "ما تعرضه الواجهة ليس تلقائيًا مصدر سلطة التحديث."),
  ],
};

const genericProfile: TopicProfile = {
  idPrefix: "INT",
  match: /[\s\S]*/,
  topic: objective => objective.trim().replace(/\s+/g, " ").slice(0, 160),
  concepts: [
    text("objective", "الهدف"),
    text("source behavior", "سلوك المصدر"),
    text("authority boundary", "حدود التفويض"),
    text("evidence gap", "فجوة الدليل"),
  ],
  questions: [
    text("Which source entry points are directly relevant to the approved objective?", "ما نقاط الدخول في المصدر المرتبطة مباشرة بالهدف المعتمد؟"),
    text("What is the actual source behavior across the approved workspaces?", "ما سلوك المصدر الفعلي عبر مساحات العمل المعتمدة؟"),
    text(
      "Which findings are supported by source evidence and which require a different evidence class?",
      "ما النتائج المدعومة بدليل مصدر، وما النتائج التي تحتاج فئة دليل مختلفة؟",
    ),
    text("Are any required paths outside the approved authority boundary?", "هل توجد مسارات مطلوبة خارج حدود التفويض المعتمدة؟"),
  ],
  requirements: [
    {
      outcome: text(
        "Identify the minimum relevant source entry points for the approved objective.",
        "حدد أقل نقاط دخول في المصدر لازمة للهدف المعتمد.",
      ),
      evidence: ["SOURCE"],
    },
    {
      outcome: text(
        "Trace the relevant source behavior without expanding authority.",
        "تتبّع سلوك المصدر ذي الصلة دون توسيع التفويض.",
      ),
      evidence: ["SOURCE"],
    },
    {
      outcome: text(
        "Classify unsupported artifact, validation, and runtime claims as evidence gaps.",
        "صنّف ادعاءات الحزم والتحقق والتشغيل غير المدعومة باعتبارها فجوات دليل.",
      ),
      evidence: ["SOURCE"],
    },
  ],
  unknowns: [
    text("The exact relevant paths and symbols have not been discovered yet.", "لم تُكتشف بعد المسارات والرموز الفعلية ذات الصلة."),
    text("Task complexity and cross-file dependency have not been assessed yet.", "لم يُقيّم بعد تعقيد المهمة أو الترابط بين الملفات."),
  ],
  forbiddenAssumptions: [
    text("Workspace authorization does not prove relevance or completeness.", "تفويض مساحة العمل لا يثبت الصلة أو الاكتمال."),
    text("Source inspection cannot be promoted into runtime acceptance.", "لا يجوز تحويل فحص المصدر إلى قبول للتشغيل الفعلي."),
    text("Executor claims are not independent evidence.", "ادعاءات المنفذ ليست دليلًا مستقلًا."),
  ],
};

const profiles = [updateChannelProfile, genericProfile];

function localized(value: LocalizedText, locale: IntentPlannerInput["locale"]): string {
  return value[locale];
}

function preserveLiterals(objective: string): string[] {
  const values = new Set<string>();
  for (const match of objective.matchAll(/\b[vV]?\d+(?:\.\d+){1,4}\b/g)) values.add(match[0]);
  for (const match of objective.matchAll(/\b[A-Z][A-Z0-9_-]{2,}\b/g)) values.add(match[0]);
  return [...values];
}

function authoritySummary(input: IntentPlannerInput): string {
  const readOnly = input.effectiveCapabilities.includes("readFiles")
    && !input.effectiveCapabilities.includes("modifySource");
  if (input.locale === "ar") {
    const workspaceLabel = input.workspaceDisplayNames.length === 1
      ? `مساحة العمل المعتمدة ${input.workspaceDisplayNames[0]}`
      : `${input.workspaceDisplayNames.length} مساحات عمل معتمدة`;
    return readOnly
      ? `سيفحص IntentChord ${workspaceLabel} باكتشاف للقراءة فقط ولن يعدّل المصدر.`
      : `سيعمل IntentChord فقط داخل ${workspaceLabel} ووفق الصلاحيات الفعالة التي ثبّتها المالك.`;
  }
  const workspaceLabel = input.workspaceDisplayNames.length === 1
    ? `the approved workspace ${input.workspaceDisplayNames[0]}`
    : `${input.workspaceDisplayNames.length} approved workspaces`;
  return readOnly
    ? `IntentChord will inspect ${workspaceLabel} using read-only discovery and will not modify source.`
    : `IntentChord will operate only inside ${workspaceLabel} and the effective capabilities frozen by the owner.`;
}

function clarification(input: IntentPlannerInput): string | undefined {
  const objective = input.literalObjective;
  const implementationWords = /(fix|repair|implement|change|modify|update the code|اصلح|إصلاح|عدل|نفذ)/i;
  const auditWords = /(audit|review|inspect|analy[sz]e|راجع|دقق|افحص|حلل)/i;
  if (input.taskMode === "CONTROLLED_AUDIT" && implementationWords.test(objective) && !auditWords.test(objective)) {
    return input.locale === "ar"
      ? "صياغة الهدف تبدو طلب تنفيذ، بينما نمط المهمة المحدد هو Controlled Audit للقراءة فقط. هل تريد من IntentChord تدقيق المشكلة فقط؟"
      : "The objective sounds like an implementation request, while the selected task mode is read-only Controlled Audit. Should IntentChord audit the problem only?";
  }
  return undefined;
}

export function resolveIntentDeterministically(input: IntentPlannerInput): IntentResolution {
  assertProviderExecutionBinding(input.providerBinding);
  if (input.providerBinding.role !== "INTENT_PLANNER") throw new Error("INTENT_PLANNER_ROLE_REQUIRED");
  const objective = input.literalObjective.trim();
  const profile = profiles.find(item => item.match.test(objective)) ?? genericProfile;
  const preserved = preserveLiterals(objective);
  const version = preserved.find(item => /^v?\d+(?:\.\d+){1,4}$/i.test(item));
  const normalizedTopic = profile.topic(objective, version);
  const clarificationQuestion = clarification(input);
  const workspaceContext = input.workspaceDisplayNames.length
    ? input.locale === "ar"
      ? ` عبر ${input.workspaceDisplayNames.join(" و")}`
      : ` across ${input.workspaceDisplayNames.join(" and ")}`
    : "";
  const ownerSummary = input.locale === "ar"
    ? `${input.taskMode === "CONTROLLED_AUDIT" ? "تدقيق" : "معالجة"} ${normalizedTopic}${workspaceContext}. ${authoritySummary(input)} سيحدد IntentChord نقاط الدخول ذات الصلة تلقائيًا، ويربط كل استنتاج بفئة الدليل الصحيحة، ويترك ادعاءات التشغيل غير المثبتة مفتوحة بوضوح.`
    : `${input.taskMode === "CONTROLLED_AUDIT" ? "Audit" : "Address"} ${normalizedTopic}${workspaceContext}. ${authoritySummary(input)} IntentChord will identify the relevant entry points automatically, map each conclusion to the correct evidence class, and leave unproven runtime claims explicitly open.`;

  return intentResolutionSchema.parse({
    schemaVersion: "0.1",
    locale: input.locale,
    producerKind: "DETERMINISTIC_BASELINE",
    producerAdapterId: "DETERMINISTIC_INTENT_BASELINE",
    literalObjective: objective,
    normalizedTopic,
    preservedLiterals: preserved,
    taskMode: input.taskMode,
    ownerSummary,
    investigationQuestions: profile.questions.map((question, index) => ({
      id: `Q-${profile.idPrefix}-${String(index + 1).padStart(3, "0")}`,
      question: localized(question, input.locale),
      origin: "SYSTEM_INFERRED",
    })),
    proposedRequirements: profile.requirements.map((requirement, index) => ({
      id: `REQ-${profile.idPrefix}-${String(index + 1).padStart(3, "0")}`,
      outcome: localized(requirement.outcome, input.locale),
      origin: "SYSTEM_INFERRED",
      requiredEvidenceTypes: requirement.evidence,
    })),
    expectedConcepts: profile.concepts.map(item => localized(item, input.locale)),
    unknowns: profile.unknowns.map(item => localized(item, input.locale)),
    forbiddenAssumptions: profile.forbiddenAssumptions.map(item => localized(item, input.locale)),
    confidence: profile === genericProfile ? 0.72 : 0.96,
    needsClarification: Boolean(clarificationQuestion),
    ...(clarificationQuestion ? { clarificationQuestion } : {}),
    providerBinding: input.providerBinding,
    authorityEcho: {
      taskMode: input.taskMode,
      workspaceIds: input.workspaceIds,
      effectiveCapabilities: input.effectiveCapabilities,
      authorityFingerprint: input.authorityFingerprint,
    },
  });
}

export class DeterministicIntentPlannerProvider implements IntentPlannerProvider {
  readonly adapterId = "DETERMINISTIC_INTENT_BASELINE";

  async resolve(input: IntentPlannerInput): Promise<IntentResolution> {
    return resolveIntentDeterministically(input);
  }
}

export function intentInputFingerprint(input: IntentPlannerInput): string {
  return createHash("sha256").update(JSON.stringify({
    literalObjective: input.literalObjective,
    locale: input.locale,
    taskMode: input.taskMode,
    workspaceIds: input.workspaceIds,
    effectiveCapabilities: input.effectiveCapabilities,
    authorityFingerprint: input.authorityFingerprint,
    providerBinding: input.providerBinding,
  })).digest("hex");
}
