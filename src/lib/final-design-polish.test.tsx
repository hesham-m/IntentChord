import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductShell } from "@/components/product-shell";
import { WorkflowApp } from "@/components/workflow-app";
import { translations } from "@/i18n/translations";

describe("IntentChord Phase 1 governed-workbench design contract", () => {
  it("provides the governance explanation in both languages", () => {
    expect(translations.en.flowTitle).toContain("governs");
    expect(translations.en.flowScopeText).toContain("boundary");
    expect(translations.en.flowRunText).toContain("Run");
    expect(translations.en.flowReviewText).toContain("human owner");
    expect(translations.ar.flowTitle).toContain("IntentChord");
    expect(translations.ar.flowScopeText).toContain("حدود");
    expect(translations.ar.flowRunText).toContain("معرف التنفيذ");
    expect(translations.ar.flowReviewText).toContain("للمالك");
  });

  it("uses the Topbar with a persistent open-work sidebar and task stages", () => {
    const html = renderToStaticMarkup(
      <ProductShell
        locale="en"
        stage="review"
        theme="light"
        onLocaleChange={() => undefined}
        onThemeChange={() => undefined}
        activeTaskId="work-1"
        customOpenItems={[{
          id: "work-1",
          title: "Review Update Channel",
          statusLabel: "Decision required",
          active: true,
          children: [{ id: "decision", label: "Owner decision", href: "/runs/current/review", active: true, attention: true }],
        }]}
      >
        <p>Current work</p>
      </ProductShell>,
    );
    expect(html).toContain('aria-label="Open work"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("New task");
    expect(html).toContain("Run History");
    expect(html).toContain('aria-label="Change appearance"');
    expect(html).toContain('aria-label="Open context and audit"');
    expect(html).toContain("Open work");
  });

  it("lets the Main Canvas use the full home width and supports a compact task rail", () => {
    const css = readFileSync("src/components/product-shell.module.css", "utf8");
    expect(css).toMatch(/\.canvasInner\s*\{[\s\S]*width:\s*100%;[\s\S]*max-width:\s*none;/);
    expect(css).toMatch(/\.body\s*\{[\s\S]*grid-template-columns:\s*324px minmax\(0, 1fr\);/);
    expect(css).toContain(".openList");
    expect(css).toContain(".workSearch");
    expect(css).toContain(".bodyCollapsed");
    expect(css).toContain(".sidebarCollapsed");
  });

  it("keeps Workspace selection human-facing and advanced fallbacks collapsed", () => {
    const page = renderToStaticMarkup(<WorkflowApp stage="task-new" initialNewTaskStep={2} />);
    expect(page).toContain("Registered Workspace");
    expect(page).toContain("Select by name and path");
    expect(page).toContain("Add to this Task");
    expect(page).toContain('class="wizard-card scope-authority-step"');
    expect(page).toContain('class="advanced-options register-workspace-fallback"');
    expect(page).not.toContain('class="advanced-options register-workspace-fallback" open=""');
    expect(page).not.toContain("workspaceRegistrationId");
  });

  it("uses a compact information hierarchy without removing governed capabilities", () => {
    const page = renderToStaticMarkup(<WorkflowApp stage="task-new" />);
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(page).toContain('data-product-journey="objective-first"');
    expect(page).toContain('data-primary-action="objective-input"');
    expect(page).toContain('data-guided-control="work-type"');
    expect(page).toContain('data-disclosure="success-conditions"');
    expect(page).toContain('data-disclosure="requested-authorization"');
    expect(page).toContain("authorization-primary-list");
    expect(page).toContain("Unavailable under this policy");
    expect(css).toContain(".workspace-card-summary");
    expect(css).toContain(".picker-feedback");
    expect(css).toContain(".scope-mode-selector.compact");
  });

  it("provides useful empty-state guidance instead of zero-only cards", () => {
    expect(translations.en.noOpenTasks).toContain("Create a bounded task");
    expect(translations.en.noRunsDetail).toContain("execution identity");
    expect(translations.en.emptyClosedMetric).toContain("Owner-decided");
    expect(translations.ar.noOpenTasks).toContain("أنشئ مهمة");
    expect(translations.ar.noRunsDetail).toContain("Run");
    expect(translations.ar.emptyClosedMetric).toContain("قرار مالكها");
  });
});
