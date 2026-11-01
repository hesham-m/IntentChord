import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("IG Phase 1 v14 owner-approved usability and retry closure", () => {
  it("uses the available screen with one persistent work sidebar and compact creation progress", () => {
    const shell = read("src/components/product-shell.tsx");
    const shellCss = read("src/components/product-shell.module.css");
    const globalCss = read("src/app/globals.css");
    expect(shell).toContain('aria-label={locale === "ar" ? "الأعمال المفتوحة" : "Open work"}');
    expect(shell).toContain("Search open work");
    expect(shell).toContain("visibleOpenItems");
    expect(shell).toContain("hiddenOpenItems");
    expect(shell).toContain('href="/project-contexts"');
    expect(shell).toContain('locale === "ar" ? "المشاريع" : "Projects"');
    expect(shell).not.toContain("activeEnvironmentId");
    expect(shell).not.toContain("onEnvironmentChange");
    expect(shellCss).toMatch(/\.topbar\s*\{[^}]*display:\s*grid;/);
    expect(shellCss).not.toContain("minmax(220px, 320px)");
    expect(shellCss).toMatch(/@media \(max-width: 980px\)[\s\S]*\.workSearch \{ display: none; \}/);
    expect(shellCss).toMatch(/\.body\s*\{[\s\S]*grid-template-columns:\s*324px minmax\(0, 1fr\);/);
    expect(shellCss).toMatch(/\.canvasInner\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/);
    expect(globalCss).toMatch(/\.welcome-home[\s\S]*max-width:\s*none;/);
    expect(globalCss).toMatch(/\.new-task-page[\s\S]*max-width:\s*none;/);
    expect(globalCss).toContain(".new-task-page .creation-progress");
    expect(globalCss).toContain("grid-template-columns: repeat(5, minmax(150px, 1fr))");
  });

  it("gives first-time users one clear start, plain-language work type guidance, and an obvious next action", () => {
    const workflow = read("src/components/workflow-app.tsx");
    expect(workflow).toContain("What do you want IntentChord to help you accomplish?");
    expect(workflow).toContain("Start a new task");
    expect(workflow).toContain('data-product-journey="objective-first"');
    expect(workflow).toContain('data-primary-action="objective-input"');
    expect(workflow).toContain('data-guided-control="work-type"');
    expect(workflow).toContain("Investigate and explain");
    expect(workflow).toContain("Implement or fix");
    expect(workflow).toContain("Review a report");
    expect(workflow).toContain('data-disclosure="success-conditions"');
    expect(workflow).toContain('data-disclosure="requested-authorization"');
    expect(workflow).toContain("current-step-indicator");
    expect(workflow).toContain("wizard-footer");
    expect(workflow).toContain("draftCanPersist");
    expect(workflow).toContain("Complete the verified Workspace and read scope before saving the Task.");
  });

  it("accepts the owner request naturally and makes clarification recoverable in the same task", () => {
    const workflow = read("src/components/workflow-app.tsx");
    const schemas = read("src/server/schemas.ts");
    const lifecycle = read("src/server/lifecycle.ts");
    expect(workflow).toContain("Write the objective in your own words");
    expect(workflow).toContain("اكتب الهدف بطريقتك");
    expect(workflow).not.toContain("Use a concrete result, not a broad topic or a list of instructions.");
    expect(workflow).not.toContain("اكتب نتيجة محددة، وليس موضوعًا عامًا أو قائمة تعليمات.");
    expect(workflow).toContain('data-owner-action="clarify-objective"');
    expect(workflow).toContain("setStep(1)");
    expect(workflow).toContain("update the same Task instead of creating another one");
    expect(schemas).not.toContain("Source implementation requires at least one explicit Owner-defined mandatory outcome.");
    expect(lifecycle).toContain("confirmedIntent.proposedRequirements.map");
  });

  it("keeps task creation single-flight and compares one canonical persisted draft on replay", () => {
    const workflow = read("src/components/workflow-app.tsx");
    const lifecycle = read("src/server/lifecycle.ts");
    const integration = read("src/server/lifecycle.postgres.integration.test.ts");
    for (const token of [
      "newTaskFlightRef",
      "newTaskCommandIdRef",
      "pendingNewTaskIdRef",
      "pendingNewTaskDraftSignatureRef",
      "submissionLockRef",
      "navigationStarted",
      "requestedTaskId",
    ]) expect(workflow).toContain(token);
    expect(workflow).toContain('method: "PUT"');
    expect(workflow).toContain('setNewTaskOperationPhase("RESUMING_TASK")');
    expect(workflow).toContain("reloadAuthoritativeTask(pendingTaskId)");
    expect(workflow).toContain("pendingNewTaskDraftSignatureRef.current !== draftSignature");
    expect(lifecycle).toContain("normalizeDraftForPersistence");
    expect(lifecycle).toContain("jsonPersistable(synchronizeLegacyWorkspaceProjection");
    expect(lifecycle).toContain("from intentchord.task_draft_revisions");
    expect(lifecycle).toContain("existingDraftSha256 !== normalizedDraftSha256");
    expect(lifecycle).toContain("canonical(existingDraft) !== canonical(normalizedDraft)");
    expect(lifecycle).not.toMatch(/select\s+.*\bdraft\b.*from intentchord\.tasks/i);
    expect(lifecycle).toContain("on conflict(id) do nothing");
    expect(integration).toContain("replays one requested Task identity without creating a duplicate row");
    expect(integration).toContain("expect(replay?.draft).toEqual(first?.draft)");
  });

  it("keeps locale and theme authority shared without route-local reset", () => {
    const provider = read("src/components/product-preferences-provider.tsx");
    const workflow = read("src/components/workflow-app.tsx");
    const shell = read("src/components/product-shell.tsx");
    expect(provider).toContain("document.documentElement.lang");
    expect(provider).toContain("document.documentElement.dir");
    expect(provider).toContain("document.documentElement.dataset.theme");
    expect(provider).toContain("prefers-color-scheme: dark");
    expect(workflow).toContain("useProductPreferences");
    expect(workflow).not.toContain("syncTaskPromptLocale(current, next)");
    expect(workflow).not.toMatch(/fetch\("\/api\/tasks"[\s\S]{0,900}\}, \[locale\]\)/);
    expect(shell).toContain('aria-label={locale === "ar" ? "التنقل الرئيسي" : "Primary navigation"}');
    expect(shell).toContain('locale === "ar" ? "مهمة جديدة" : "New task"');
  });
});
