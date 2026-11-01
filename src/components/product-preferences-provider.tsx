"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { localeStorageKey, storedLocale } from "@/i18n/locale";
import type { Locale } from "@/i18n/types";

export type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

// Locale and Theme are a navigation preference only; they never grant execution authority.
type ProductPreferences = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  resolvedTheme: ResolvedTheme;
};

const fallbackPreferences: ProductPreferences = {
  locale: "en",
  setLocale: () => undefined,
  theme: "system",
  setTheme: () => undefined,
  resolvedTheme: "light",
};
const ProductPreferencesContext = createContext<ProductPreferences>(fallbackPreferences);

function storedTheme(value: string | null): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function writePreferenceCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function ProductPreferencesProvider({
  children,
  initialLocale = "en",
  initialTheme = "system",
}: {
  children: ReactNode;
  initialLocale?: Locale;
  initialTheme?: ThemePreference;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [theme, setThemeState] = useState<ThemePreference>(initialTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");

  useLayoutEffect(() => {
    const documentLocale = document.documentElement.lang === "ar" ? "ar" : "en";
    const documentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    setLocaleState(storedLocale(window.localStorage.getItem(localeStorageKey) ?? documentLocale));
    setThemeState(storedTheme(window.localStorage.getItem("intentchord-theme") ?? initialTheme));
    setSystemTheme(documentTheme);
  }, [initialTheme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemTheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
    window.localStorage.setItem(localeStorageKey, locale);
    writePreferenceCookie("intentchord-locale", locale);
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    window.localStorage.setItem("intentchord-theme", theme);
    writePreferenceCookie("intentchord-theme", theme);
  }, [resolvedTheme, theme]);

  const setLocale = useCallback((nextLocale: Locale) => {
    document.documentElement.lang = nextLocale;
    document.documentElement.dir = nextLocale === "ar" ? "rtl" : "ltr";
    window.localStorage.setItem(localeStorageKey, nextLocale);
    writePreferenceCookie("intentchord-locale", nextLocale);
    setLocaleState(nextLocale);
  }, []);
  const setTheme = useCallback((nextTheme: ThemePreference) => {
    window.localStorage.setItem("intentchord-theme", nextTheme);
    writePreferenceCookie("intentchord-theme", nextTheme);
    setThemeState(nextTheme);
  }, []);
  const value = useMemo(
    () => ({ locale, setLocale, theme, setTheme, resolvedTheme }),
    [locale, resolvedTheme, setLocale, setTheme, theme],
  );

  return <ProductPreferencesContext.Provider value={value}>{children}</ProductPreferencesContext.Provider>;
}

export function useProductPreferences(): ProductPreferences {
  return useContext(ProductPreferencesContext);
}
