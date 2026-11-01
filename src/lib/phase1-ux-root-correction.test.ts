import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");


describe("Phase 1 first-use, theme, and data-isolation root correction", () => {


  it("keeps the full-width work surface and restores the persistent open-work sidebar", () => {
    const shell = read("src/components/product-shell.tsx");
    const workflow = read("src/components/workflow-app.tsx");
    expect(shell).toContain("Search open work");
    expect(shell).toContain("Open work");
    expect(shell).toContain("visibleOpenItems");
    expect(workflow).toContain("What do you want IntentChord to help you accomplish?");
    expect(workflow).toContain("home-journey");
    expect(workflow).toContain("objective-first-layout");
    expect(workflow).toContain('data-guided-control="work-type"');
    expect(workflow).toContain('data-owner-action="clarify-objective"');
    expect(workflow).toContain("attention.slice(0, 3)");
    expect(workflow).toContain("recent.map(task =>");
    expect(workflow).not.toContain("owner-row-audit");
  });

  it("uses one coherent light/dark token boundary across shell and content surfaces", () => {
    const globalCss = read("src/app/globals.css");
    const shellCss = read("src/components/product-shell.module.css");
    const environmentCss = read("src/components/project-context-workbench.module.css");
    expect((globalCss.match(/(^|\n):root\s*\{/g) ?? []).length).toBe(1);
    expect((globalCss.match(/(^|\n)\.topbar\s*\{/g) ?? []).length).toBe(0);
    expect((shellCss.match(/(^|\n)\.topbar\s*\{/g) ?? []).length).toBe(1);
    expect(shellCss).toContain("--chrome: #ffffff");
    expect(shellCss).toContain("--chrome: #0b1624");
    expect(shellCss).toContain("background: var(--canvas)");
    expect(globalCss).toContain(':root[data-theme="dark"]');
    expect(globalCss).toContain("background: var(--bg)");
    expect(globalCss).toContain("input,\ntextarea,\nselect { background: var(--panel); }");
    expect(environmentCss).toContain("background: var(--panel)");
    expect(environmentCss).toContain("background: var(--surface)");
    expect(environmentCss).not.toMatch(/background:\s*(?:#fff(?:fff)?|white)/i);
  });

  it("makes PostgreSQL integration tests rollback-only and provides guarded stale-data cleanup", () => {
    const db = read("src/server/db.ts");
    const integration = read("src/server/lifecycle.postgres.integration.test.ts");
    const maintenance = read("scripts/integration-data-maintenance.mjs");
    const backup = read("scripts/backup-intentchord-database.mjs");
    expect(db).toContain("bindRollbackOnlyTestClient");
    expect(db).toContain("ROLLBACK_ONLY_TEST_CLIENT_BLOCKED");
    expect(db).toContain("SAVEPOINT");
    expect(integration).toContain('rollbackClient.query("BEGIN")');
    expect(integration).toContain('rollbackClient.query("ROLLBACK")');
    expect(integration).toContain('import type { PoolClient } from "pg";');
    expect(integration).toContain("let rollbackClient: PoolClient | undefined;");
    expect(integration).toContain("rollbackClient?.release()");
    expect(integration).not.toContain('Awaited<ReturnType<ReturnType<typeof databasePool>["connect"]>>');
    expect(maintenance).toContain("exact lifecycle.postgres.integration.test.ts generated title plus enumerated source scenario objectives");
    expect(maintenance).toContain("INTEGRATION_DATA_PLAN_STALE");
    expect(maintenance).toContain("INTEGRATION_DATA_CLEANUP_BACKUP_REQUIRED");
    expect(backup).toContain("pg_dump");
    expect(backup).toContain("INTENTCHORD_DATABASE_BACKUP: PASS");
  });

  it("keeps the normal governed-environment form free of manual slug, UUID, and raw JSON fields", () => {
    const workbench = read("src/components/project-context-workbench.tsx");
    expect(workbench).toContain("IntentChord generates the internal slug");
    expect(workbench).not.toMatch(/<input[^>]+slug/i);
    expect(workbench).not.toMatch(/<input[^>]+workspaceRegistrationId/i);
    expect(workbench).not.toContain("valueJson");
    expect(workbench).not.toContain("provenanceJson");
    expect(workbench).toContain("Advanced Audit");
  });

  it("verifies every installed approved identity asset against the recorded manifest", () => {
    const manifest = JSON.parse(read("docs/architecture/INTENTCHORD_APPROVED_IDENTITY_ASSET_MANIFEST_2026_07_29.json")) as {
      approved_tagline: string;
      assets: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.approved_tagline).toBe("هدف واضح • تنفيذ منضبط • نتائج قابلة للتحقق");
    for (const file of manifest.assets) {
      const bytes = readFileSync(path.join(root, file.path));
      expect(createHash("sha256").update(bytes).digest("hex").toUpperCase()).toBe(file.sha256);
    }
  });

  it("keeps the registered Workspace catalog behind the Owner bootstrap boundary", () => {
    const route = read("src/app/api/workspaces/route.ts");
    expect(route).toContain("ownerReadResponse");
    const responses = read("src/server/responses.ts");
    expect(responses).toContain("await requireOwnerSession(request)");
    expect(route).toContain("listWorkspaceRegistrations");
    expect(route).not.toContain("NextResponse.json");
  });
});
