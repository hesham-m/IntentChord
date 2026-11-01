import type { Locale } from "@/i18n/types";
export const localeStorageKey = "intentchord-locale";
export const storedLocale = (value: string | null): Locale => value === "ar" ? "ar" : "en";
