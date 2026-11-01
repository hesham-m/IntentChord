import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("IG Phase 1 v14 owner-approved usability and retry root closure", () => {
  it("uses the full product surface and restores the persistent work sidebar", () => {
    const shell = read("src/components/product-shell.tsx");
    const shellCss = read("src/components/product-shell.module.css");
    const globalCss = read("src/app/globals.css");
    expect(shell).toContain("Search open work");
    expect(shell).toContain("visibleOpenItems");
    expect(shell).toContain("hiddenOpenItems");
    expect(shellCss).toContain(".openList");
    expect(shellCss).toContain(".workSearch");
    expect(globalCss).toMatch(/\.welcome-home\s*\{[\s\S]*?max-width:\s*none;/);
    expect(globalCss).toMatch(/\.new-task-page\s*\{[\s\S]*?max-width:\s*none;/);
  });

  it("accepts the owner objective in free form and prevents duplicate task creation", () => {
    const workflow = read("src/components/workflow-app.tsx");
    const schemas = read("src/server/schemas.ts");
    const lifecycle = read("src/server/lifecycle.ts");
    expect(workflow).toMatch(/const objective = input\.objective\.trim\(\);[\s\S]{0,180}if \(!objective\)/);
    expect(workflow).toContain("Write the objective in your own words");
    expect(workflow).toContain("اكتب الهدف بطريقتك");
    expect(workflow).not.toContain("اكتب نتيجة محددة، وليس موضوعًا عامًا أو قائمة تعليمات.");
    expect(workflow).toContain("newTaskFlightRef");
    expect(workflow).toContain("newTaskCommandIdRef");
    expect(workflow).toContain("pendingNewTaskIdRef");
    expect(workflow).toContain("requestedTaskId");
    expect(workflow).toContain("submissionLockRef");
    expect(workflow).toContain("locked to one Task");
    expect(workflow).toContain('method: "PUT"');
    expect(workflow).toContain("resolved.intentResolution.confirmedAt");
    expect(workflow).toContain('["COMPLETED", "EVIDENCE_REQUIRED"].includes(candidate.discoveryRun.status)');
    expect(workflow).toContain('started.status !== "READY_TO_COMPLETE"');
    expect(workflow).toContain('data-guided-control="work-type"');
    expect(workflow).toContain('data-owner-action="clarify-objective"');
    expect(workflow).toContain('data-disclosure="success-conditions"');
    expect(schemas).toContain("requestedTaskId");
    expect(schemas).not.toContain("Source implementation requires at least one explicit Owner-defined mandatory outcome.");
    expect(lifecycle).toContain("normalizeDraftForPersistence");
    expect(lifecycle).toContain("from intentchord.task_draft_revisions");
    expect(lifecycle).toContain("existingDraftSha256 !== normalizedDraftSha256");
    expect(lifecycle).toContain("canonical(existingDraft) !== canonical(normalizedDraft)");
    expect(lifecycle).toContain("on conflict(id) do nothing");
    expect(lifecycle).toContain("TASK_CREATE_IDEMPOTENCY_MISMATCH");
  });
});
