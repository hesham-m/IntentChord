import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

describe("Phase 1 first-use, theme, and operational isolation acceptance contract", () => {
  it("explains the product before exposing operational density", () => {
    const workflow = read("src/components/workflow-app.tsx");
    expect(workflow).toContain("Start a new task");
    expect(workflow).toContain("What do you want IntentChord to help you accomplish?");
    expect(workflow).toContain("No conclusion without evidence");
    expect(workflow).toContain("objective-first-layout");
    expect(workflow).toContain("progressive-disclosure");
    expect(workflow).toContain('data-guided-control="work-type"');
    expect(workflow).toContain('data-disclosure="success-conditions"');
    expect(workflow).toContain("attention.slice(0, 3)");
    expect(workflow).toContain("recent.map(task =>");
    expect(workflow).not.toContain("What needs your decision now?");
  });



  it("keeps the Topbar compact while preserving the approved tagline outside the shell", () => {
    const shell = read("src/components/product-shell.tsx");
    const shellCss = read("src/components/product-shell.module.css");
    const globalCss = read("src/app/globals.css");
    const identityManifest = JSON.parse(read("docs/architecture/INTENTCHORD_APPROVED_IDENTITY_ASSET_MANIFEST_2026_07_29.json")) as { approved_tagline: string };
    expect(identityManifest.approved_tagline).toBe("هدف واضح • تنفيذ منضبط • نتائج قابلة للتحقق");
    expect(shell).not.toContain(identityManifest.approved_tagline);
    expect(shellCss).toMatch(/\.canvasInner\s*\{[\s\S]*width:\s*100%;[\s\S]*max-width:\s*none;/);
    expect(globalCss).toMatch(/\.welcome-home[\s\S]*max-width:\s*none;/);
  });

  it("keeps theme ownership continuous from document root through shell and cards", () => {
    const globalCss = read("src/app/globals.css");
    const shellCss = read("src/components/product-shell.module.css");
    const environmentCss = read("src/components/project-context-workbench.module.css");
    for (const token of ["--bg", "--panel", "--surface", "--text", "--border"]) {
      expect(globalCss).toContain(token);
    }
    for (const token of ["--chrome", "--canvas", "--panel", "--chrome-text", "--chrome-line"]) {
      expect(shellCss).toContain(token);
    }
    expect(shellCss).toContain(':global(html[data-theme="dark"]) .shell');
    expect(shellCss).toContain("background: var(--canvas)");
    expect(globalCss).toContain("background: var(--panel)");
    expect(environmentCss).not.toMatch(/background:\s*(?:#fff(?:fff)?|white)/i);
    expect(environmentCss).toContain("background: var(--panel)");
  });

  it("uses one root Locale and Theme authority for every production route surface", () => {
    const layout = read("src/app/layout.tsx");
    const provider = read("src/components/product-preferences-provider.tsx");
    const environmentWorkbench = read("src/components/project-context-workbench.tsx");
    const workflow = read("src/components/workflow-app.tsx");
    const environment = read("src/components/project-context-workbench.tsx");
    const css = read("src/app/globals.css");
    expect(layout).toContain("ProductPreferencesProvider");
    for (const source of [workflow, environment]) {
      expect(source).toContain("useProductPreferences");
      expect(source).not.toMatch(/useState<Locale>\(|localStorage\.getItem\(localeStorageKey\)/);
    }
    for (const contract of ["document.documentElement.lang", "document.documentElement.dir", "document.documentElement.dataset.theme", "prefers-color-scheme: dark", "intentchord-locale", "intentchord-theme", "useLayoutEffect"]) {
      expect(provider).toContain(contract);
    }
    expect(layout).toContain("await cookies()");
    expect(workflow).toContain("tasks.some((item) => item.id === current.activeTaskId)");
    expect(workflow).not.toMatch(/fetch\("\/api\/tasks"[\s\S]{0,900}\}, \[locale\]\)/);
    expect(environmentWorkbench).toContain("Locale changes are presentation-only");
    expect(environmentWorkbench).not.toContain("}, [locale]); // eslint-disable-line react-hooks/exhaustive-deps");
    expect(css).not.toMatch(/(?:align-items|align-self|justify-content)\s*:\s*end\s*;/);
    for (const legacySelector of [
      ".generated-task-title",
      ".task-definition-layout",
      ".task-identity-panel",
      ".task-primary-stack",
      ".step-count-summary",
    ]) {
      expect(css).not.toContain(legacySelector);
    }
  });

  it("prevents future integration rows and deletes only a fingerprinted legacy family after backup", () => {
    const db = read("src/server/db.ts");
    const integration = read("src/server/lifecycle.postgres.integration.test.ts");
    const cleanup = read("scripts/integration-data-maintenance.mjs");
    expect(db).toContain("rollbackOnlyTestClient");
    expect(integration).toContain('await rollbackClient.query("BEGIN")');
    expect(integration).toContain('await rollbackClient.query("ROLLBACK")');
    expect(integration).toContain('import type { PoolClient } from "pg";');
    expect(integration).toContain("let rollbackClient: PoolClient | undefined;");
    expect(integration).toContain("rollbackClient?.release()");
    expect(integration).not.toContain('Awaited<ReturnType<ReturnType<typeof databasePool>["connect"]>>');
    expect(cleanup).toContain("candidateFingerprint");
    expect(cleanup).toContain("testScenarioSuffixes");
    expect(cleanup).toContain("PROVEN_TEST_DATA");
    expect(cleanup).toContain("INTEGRATION_DATA_CLEANUP_BACKUP_REQUIRED");
    expect(cleanup).toContain("INTEGRATION_DATA_PLAN_STALE");
    expect(cleanup).toContain('await client.query("BEGIN")');
    expect(cleanup).toContain('await client.query("ROLLBACK")');
  });
});
