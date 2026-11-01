import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/(protected)/page";
import { ProductShell } from "@/components/product-shell";
import { ProductPreferencesProvider } from "@/components/product-preferences-provider";
import { localeStorageKey, storedLocale } from "@/i18n/locale";
import { localizeVerdictText, translations } from "@/i18n/translations";
import { compiledPromptForLocale } from "@/lib/ui-flow";
import { demoScenarioVerdict } from "@/test/fixtures/demo-scenarios";
import { baseContract } from "@/test/fixtures/scenarios";

describe("IntentChord localization", () => {
  it("renders deterministic language controls in both directions", () => {
    const english = renderToStaticMarkup(<ProductPreferencesProvider><Home /></ProductPreferencesProvider>);
    expect(english).toContain('aria-label="التبديل إلى العربية"');
    expect(english).toContain("Start a new task");
    expect(english).not.toContain('href="/demo"');

    const arabic = renderToStaticMarkup(
      <ProductShell
        locale="ar"
        stage="home"
        theme="light"
        onLocaleChange={() => undefined}
        onThemeChange={() => undefined}
      >
        <p>محتوى</p>
      </ProductShell>,
    );
    expect(arabic).toContain('aria-label="Switch to English"');
    expect(arabic).not.toContain('href="/demo"');
  });

  it("uses the owner-approved Arabic hero and scenario copy", () => {
    expect(translations.ar.hero).toContain("حوكمة واضحة");
    expect(translations.ar.heroText).toContain("حدود التفويض");
    expect(translations.ar.evidenceMixing).toBe("أدلة مختلطة");
    expect(translations.ar.scopeViolation).toBe("تجاوز النطاق");
  });

  it("keeps canonical classifications available in Arabic presentation", () => {
    expect(translations.ar.pass).toBe("ناجح\nPASS");
    expect(translations.ar.evidenceRequired).toContain("EVIDENCE_REQUIRED");
  });

  it("uses a stable local persistence key", () => {
    expect(localeStorageKey).toBe("intentchord-locale");
    expect(storedLocale(null)).toBe("en");
    expect(storedLocale("ar")).toBe("ar");
    expect(storedLocale("en")).toBe("en");
  });

  it("localizes explanations while preserving paths and technical classifications", () => {
    const localized = localizeVerdictText("ar", "Unauthorized changed paths: src/startup.ts.");
    expect(localized).toContain("src/startup.ts");
    expect(localized).toContain("خارج النطاق");
    expect(localizeVerdictText("ar", "REPORT_RUN_MISMATCH: the report binding marker belongs to a different run.")).toBe("REPORT_RUN_MISMATCH: علامة ربط التقرير تخص تنفيذًا مختلفًا.");
    expect(demoScenarioVerdict("controlled-success").verdict.classification).toBe("EVIDENCE_REQUIRED");
  });

  it("compiles independent English and Arabic prompts with unchanged technical values", () => {
    const english = compiledPromptForLocale(baseContract, "en");
    const arabic = compiledPromptForLocale(baseContract, "ar");
    expect(english).toContain("## Approved execution");
    expect(english).toContain("# IntentChord Contract Preview");
    expect(arabic).toContain("## التشغيل المعتمد");
    expect(arabic).toContain("# معاينة عقد IntentChord");
    expect(arabic).toContain("src/startup.ts");
    expect(arabic).toContain("## صيغة التقرير");
  });
});
