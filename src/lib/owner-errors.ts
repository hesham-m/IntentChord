import type { Locale } from "@/i18n/types";

type ErrorPayload = {
  error?: string;
  code?: string;
  details?: unknown;
};

const messages: Record<string, { en: string; ar: string; actionEn: string; actionAr: string }> = {
  OWNER_SESSION_REQUIRED: {
    en: "Your session has expired.",
    ar: "انتهت صلاحية جلستك.",
    actionEn: "Please sign in again.",
    actionAr: "يرجى تسجيل الدخول مرة أخرى.",
  },
  OWNER_SESSION_INVALID: {
    en: "Your session is no longer valid.",
    ar: "جلستك لم تعد صالحة.",
    actionEn: "Please sign in again.",
    actionAr: "يرجى تسجيل الدخول مرة أخرى.",
  },
  PROJECT_CONTEXT_SLUG_CONFLICT: {
    en: "An environment with the same internal name already exists.",
    ar: "توجد بيئة حاكمة بنفس الاسم الداخلي بالفعل.",
    actionEn: "Use a more specific display name. The internal name remains system-managed.",
    actionAr: "استخدم اسم عرض أكثر تحديدًا؛ الاسم الداخلي يديره النظام تلقائيًا.",
  },
  WORKSPACE_NOT_FOUND: {
    en: "The selected Workspace is no longer available.",
    ar: "مساحة العمل المختارة لم تعد متاحة.",
    actionEn: "Refresh the Workspace list or register the Workspace again.",
    actionAr: "حدّث قائمة مساحات العمل أو سجّل مساحة العمل مرة أخرى.",
  },
  INVALID_IDENTIFIER: {
    en: "IntentChord could not resolve the selected record.",
    ar: "تعذر على IntentChord تحديد السجل المختار.",
    actionEn: "Refresh the page and select the item again.",
    actionAr: "حدّث الصفحة واختر العنصر مرة أخرى.",
  },
  REVISION_CONFLICT: {
    en: "The authoritative state changed after this page was loaded.",
    ar: "تغيرت الحالة الحاكمة بعد تحميل هذه الصفحة.",
    actionEn: "Refresh the authoritative state before repeating the decision.",
    actionAr: "حدّث الحالة الحاكمة قبل تكرار القرار.",
  },
  REQUEST_BODY_INVALID: {
    en: "Some submitted values are incomplete or invalid.",
    ar: "بعض القيم المدخلة ناقصة أو غير صحيحة.",
    actionEn: "Review the highlighted fields and submit again.",
    actionAr: "راجع الحقول المحددة ثم أرسل الأمر مرة أخرى.",
  },
};

export function ownerErrorMessage(
  payload: ErrorPayload,
  locale: Locale,
  fallback?: string,
): string {
  const known = payload.code ? messages[payload.code] : undefined;
  if (known) {
    return locale === "ar"
      ? `${known.ar} ${known.actionAr}`
      : `${known.en} ${known.actionEn}`;
  }

  const safeFallback = fallback?.trim();
  if (safeFallback) return safeFallback;

  return locale === "ar"
    ? "تعذر إكمال الأمر. راجع المدخلات ثم حاول مرة أخرى."
    : "The command could not be completed. Review the inputs and try again.";
}

export type { ErrorPayload };
