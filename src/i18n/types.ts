export type Locale = "en" | "ar";
export type TranslationKey = keyof typeof import("./translations").translations.en;
