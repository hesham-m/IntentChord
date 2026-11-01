import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProductShell,
  governedRailCollapsedForViewport,
  productShellInteractionReducer,
} from "@/components/product-shell";
import { createBlankContractInput } from "@/core/tasks/task-input";
import { createTaskRecord } from "@/lib/workspace";
import type { TaskExperienceProjectionV1 } from "@/server/task-experience-projection-service";

const independentTask = createTaskRecord({
  ...createBlankContractInput(),
  objective: "Review an independent change",
}, { id: "00000000-0000-4000-8000-000000000101" });

const projectTask = createTaskRecord({
  ...createBlankContractInput(),
  objective: "Review the project release",
  taskContext: {
    kind: "PROJECT_BOUND",
    projectContextId: "00000000-0000-4000-8000-000000000201",
    projectContextDisplayName: "IntentChord",
    projectContextRevision: 4,
  },
}, { id: "00000000-0000-4000-8000-000000000102" });

function projection(overrides: Partial<TaskExperienceProjectionV1> = {}): TaskExperienceProjectionV1 {
  return {
    taskSummary: {
      id: "550e8400-e29b-41d4-a716-446655440000",
      revision: 7,
      title: "Governed release review",
      objective: "Review the current governed release evidence.",
      taskMode: "SOURCE_IMPLEMENTATION",
      taskContext: { kind: "INDEPENDENT" },
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T01:00:00.000Z",
    },
    visiblePhase: "GOVERN",
    phaseStatus: "SCOPE_DERIVED_AWAITING_CONFIRMATION",
    workspaceSummary: { workspaces: [] },
    analysisSummary: { indexStatus: "READY", mappingStatus: "COMPLETED", mappingAttemptCount: 1, discoveryCount: 2, analysisReady: true, contextClosureState: "PASS", missingEvidenceCount: 0 },
    contextResolutionSummary: { closureState: "PASS", missingEvidenceRequests: [], resolutionRequirements: [] },
    contextAuthoritySummary: { status: "CURRENT_WORK_INTENT_AWAITING_SCOPE_CONFIRMATION", headStatus: "CURRENT", sourceAuthorityStatus: "CURRENT" },
    discoveredWorkSummary: { components: [], totalRelevantFiles: 0, excludedPathPatterns: [] },
    ownerSelectionSummary: { selectedContextIds: [], selectedComponentIds: [], selectionCommitted: true },
    candidateScopeSummary: { isDerived: true, allowedPaths: [], excludedPaths: [], boundaryCount: 0 },
    effectiveAuthoritySummary: { capabilities: [] },
    scopeConfirmationSummary: { isConfirmed: false, confirmedAllowedPaths: [], confirmedExcludedPaths: [] },
    executionSetupSummary: { isConfigured: false, authoritySource: "NONE", providerId: null, modelId: null, executionChannelId: null, reasoningProfile: null, runtimeProfileId: null, modelOverrideAccepted: false },
    executionOptions: { authorityMeaning: "OWNER_SELECTS_PLATFORM_BACKEND_RESOLVES_CONFIGURATION", availablePlatforms: [{ executionChannelId: "CODEX", displayName: "Codex" }] },
    governedExecutionInstructionsSummary: { isGenerated: false, authoritySource: "NONE", instructionsPreview: "", byteLength: 0, locale: "en" },
    contractSummary: { ownerApprovalState: "DRAFT", mandatoryRequirementsCount: 0, requiredChecksCount: 0 },
    runSummary: { status: "IDLE", toolTracesCount: 0, reportSubmitted: false, evidenceReferencesCount: 0, validationEvidenceCount: 0, inheritedValidationEvidenceCount: 0, sourceEvidenceCount: 0, artifactEvidenceCount: 0 },
    verdictSummary: { isEvaluated: false, satisfiedChecksCount: 0, totalChecksCount: 0, checkLedger: [], detectedViolations: [], ownerDecision: "NONE" },
    primaryAction: { actionKey: "CONFIRM_SCOPE", labelEn: "Confirm exact governed scope", labelAr: "تأكيد النطاق المحكوم", availability: "ENABLED" },
    availableOwnerActions: [],
    auditDetails: { taskId: "550e8400-e29b-41d4-a716-446655440000", policyDecisionTraceCount: 0 },
    ...overrides,
  };
}

const shellBase = {
  locale: "en" as const,
  stage: "home" as const,
  theme: "dark" as const,
  onLocaleChange: () => undefined,
  onThemeChange: () => undefined,
};

describe("ProductShell", () => {
  it("preserves the existing project/work navigation outside governed projection mode", () => {
    const html = renderToStaticMarkup(
      <ProductShell
        locale="ar"
        stage="home"
        theme="light"
        onLocaleChange={() => undefined}
        onThemeChange={() => undefined}
        tasks={[independentTask, projectTask]}
        activeTaskId={projectTask.id}
      >
        <p>المحتوى الحالي</p>
      </ProductShell>,
    );

    expect(html).toContain('href="/project-contexts"');
    expect(html).not.toContain('href="/workspace-analysis"');
    expect(html).not.toContain("تحليل مساحة عمل");
    expect(html).toContain("المشاريع");
    expect(html).toContain("مهمة مستقلة");
    expect(html).toContain("المشروع: IntentChord");
  });

  it("keeps the existing Open Work rail and global work navigation outside governed projection mode", () => {
    const html = renderToStaticMarkup(
      <ProductShell
        locale="en"
        stage="tasks"
        theme="dark"
        onLocaleChange={() => undefined}
        onThemeChange={() => undefined}
        tasks={[independentTask, projectTask]}
        activeTaskId={independentTask.id}
      >
        <h1>Work</h1>
      </ProductShell>,
    );

    expect(html).toContain("Open work");
    expect(html).toContain("Review an independent change");
    expect(html).toContain("Review the project release");
    expect(html).toContain("Run History");
    expect(html).toContain("New task");
    expect(html).toContain(">Work<");
    expect(html).toContain(">Projects<");
  });

  it("renders the governed work surface from TaskExperienceProjectionV1 truth", () => {
    const html = renderToStaticMarkup(
      <ProductShell {...shellBase} activeTaskId={projection().taskSummary.id} projectionState={{ status: "READY", taskId: projection().taskSummary.id, projection: projection() }}>
        <p>Existing capability remains below the governed state.</p>
      </ProductShell>,
    );

    expect(html).toContain('data-governed-product-canvas="true"');
    expect(html).toContain("Governed release review");
    expect(html).toContain("Govern");
    expect(html).toContain("Governed scope awaiting confirmation");
    expect(html).toContain("Confirm exact governed scope");
    expect(html).toContain('data-primary-action-source="projection"');
    expect(html).toContain('data-authority-transition="none"');
    expect(html).toContain("Existing capability remains below the governed state.");
  });

  it("renders the canonical governed Top Bar from projection-backed Task and Project context", () => {
    const base = projection();
    const projectBound = projection({
      taskSummary: {
        ...base.taskSummary,
        title: "Projection-backed task",
        taskContext: {
          kind: "PROJECT_BOUND",
          projectId: "project-authority-17",
          projectDisplayName: "Project Authority Alpha",
          projectRevision: 9,
        },
      },
    });
    const html = renderToStaticMarkup(
      <ProductShell
        {...shellBase}
        tasks={[projectTask]}
        activeTaskId={projectBound.taskSummary.id}
        projectionState={{ status: "READY", taskId: projectBound.taskSummary.id, projection: projectBound }}
      >
        <div />
      </ProductShell>,
    );

    expect(html).toContain('data-topbar-context-source="projection"');
    expect(html).toContain("Projection-backed task");
    expect(html).toContain("Project Authority Alpha");
    expect(html).toContain('data-project-context-role="reference-only"');
    expect(html).toContain('href="/tasks/new"');
    expect(html).toContain('href="/project-contexts"');
    expect(html).toContain('aria-label="Open context and audit"');
    expect(html).not.toContain("Review the project release");
  });

  it("renders independent Task context truthfully without fabricating a Project or project authority switcher", () => {
    const ready = projection();
    const html = renderToStaticMarkup(
      <ProductShell {...shellBase} activeTaskId={ready.taskSummary.id} projectionState={{ status: "READY", taskId: ready.taskSummary.id, projection: ready }}>
        <div />
      </ProductShell>,
    );
    const source = readFileSync("src/components/product-shell.tsx", "utf8");
    expect(html).toContain("Independent task");
    expect(html).toContain('data-task-context="INDEPENDENT"');
    expect(source).not.toContain("projectSwitcher");
    expect(source).not.toContain("PROJECT_SWITCH");
    expect(source).not.toContain('data-project-authority-switcher');
  });

  it("keeps governed Open Work bounded to the current projection when no multi-Task projection feed exists", () => {
    const ready = projection();
    const html = renderToStaticMarkup(
      <ProductShell
        {...shellBase}
        tasks={[independentTask, projectTask]}
        activeTaskId={ready.taskSummary.id}
        projectionState={{ status: "READY", taskId: ready.taskSummary.id, projection: ready }}
      >
        <div />
      </ProductShell>,
    );
    expect(html).toContain('data-open-work-source="current-task-projection"');
    expect(html).toContain("Governed release review");
    expect(html).not.toContain("Review an independent change");
    expect(html).not.toContain("Review the project release");
  });

  it("uses backend visiblePhase and primaryAction data without a frontend lifecycle decision table", () => {
    const execute = projection({
      visiblePhase: "EXECUTE",
      phaseStatus: "RUN_ACTIVE_EXECUTING",
      primaryAction: {
        actionKey: "SUBMIT_REPORT",
        labelEn: "Backend exact action label",
        labelAr: "إجراء Backend المحدد",
        availability: "BUSY",
      },
    });
    const html = renderToStaticMarkup(
      <ProductShell {...shellBase} activeTaskId={execute.taskSummary.id} projectionState={{ status: "READY", taskId: execute.taskSummary.id, projection: execute }}>
        <div />
      </ProductShell>,
    );

    expect(html).toContain("Execute");
    expect(html).toContain("Governed run active");
    expect(html).toContain("Backend exact action label");
    expect(html).toContain("In progress");

    const source = readFileSync("src/components/product-shell.tsx", "utf8");
    expect(source).not.toContain("primaryAction.actionKey ===");
    expect(source).not.toMatch(/switch\s*\([^)]*phaseStatus/);
  });

  it("fails closed instead of rendering a stale projection after the current Task changes", () => {
    const ready = projection();
    const html = renderToStaticMarkup(
      <ProductShell
        {...shellBase}
        activeTaskId="660e8400-e29b-41d4-a716-446655440000"
        projectionState={{ status: "READY", taskId: ready.taskSummary.id, projection: ready }}
      >
        <div />
      </ProductShell>,
    );

    expect(html).toContain("Loading authoritative task state");
    expect(html).not.toContain("Governed release review");
    expect(html).not.toContain("Confirm exact governed scope");
  });

  it("keeps a projected disabled action non-actionable", () => {
    const disabled = projection({
      primaryAction: {
        actionKey: "SELECT_EXECUTION_PLATFORM",
        labelEn: "Select Execution Platform",
        labelAr: "اختيار منصة التنفيذ",
        availability: "DISABLED",
        disabledReasonEn: "No governed execution platform is supported by this product build",
        disabledReasonAr: "لا توجد منصة تنفيذ محكومة مدعومة في نسخة المنتج الحالية",
      },
    });
    const html = renderToStaticMarkup(
      <ProductShell {...shellBase} activeTaskId={disabled.taskSummary.id} projectionState={{ status: "READY", taskId: disabled.taskSummary.id, projection: disabled }}>
        <div />
      </ProductShell>,
    );

    expect(html).toContain("Select Execution Platform");
    expect(html).toContain("No governed execution platform is supported by this product build");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-primary-action-source="projection"|<button[^>]*data-primary-action-source="projection"[^>]*disabled=""/);
    expect(html).toContain('data-authority-transition="none"');
  });

  it("keeps Audit/Details collapsed by default and models explicit open/close behavior", () => {
    const ready = projection();
    const html = renderToStaticMarkup(
      <ProductShell {...shellBase} activeTaskId={ready.taskSummary.id} projectionState={{ status: "READY", taskId: ready.taskSummary.id, projection: ready }}>
        <div />
      </ProductShell>,
    );

    expect(html).not.toContain('data-audit-drawer="projection"');
    expect(html).toContain('aria-label="Open context and audit"');
    const opened = productShellInteractionReducer({ railCollapsed: false, auditDrawerOpen: false }, { type: "OPEN_AUDIT" });
    expect(opened.auditDrawerOpen).toBe(true);
    expect(productShellInteractionReducer(opened, { type: "CLOSE_AUDIT" }).auditDrawerOpen).toBe(false);
  });

  it("uses deterministic responsive initialization and preserves explicit rail control afterward", () => {
    expect(governedRailCollapsedForViewport(1440)).toBe(false);
    expect(governedRailCollapsedForViewport(1366)).toBe(true);
    expect(governedRailCollapsedForViewport(981)).toBe(true);
    expect(governedRailCollapsedForViewport(980)).toBe(false);

    const ready = projection();
    const initialHtml = renderToStaticMarkup(
      <ProductShell {...shellBase} activeTaskId={ready.taskSummary.id} projectionState={{ status: "READY", taskId: ready.taskSummary.id, projection: ready }}>
        <div />
      </ProductShell>,
    );
    expect(initialHtml).toContain('aria-expanded="false"');

    const initialized1366 = productShellInteractionReducer(
      { railCollapsed: false, auditDrawerOpen: false },
      { type: "INITIALIZE_RAIL", railCollapsed: governedRailCollapsedForViewport(1366) },
    );
    expect(initialized1366.railCollapsed).toBe(true);
    const ownerExpanded = productShellInteractionReducer(initialized1366, { type: "TOGGLE_RAIL" });
    expect(ownerExpanded.railCollapsed).toBe(false);
    expect(productShellInteractionReducer(ownerExpanded, { type: "TOGGLE_RAIL" }).railCollapsed).toBe(true);
  });

  it("keeps narrow/mobile work navigation as a bounded slide-over contract", () => {
    const source = readFileSync("src/components/product-shell.tsx", "utf8");
    const css = readFileSync("src/components/product-shell.module.css", "utf8");
    expect(source).toContain("window.innerWidth <= 980");
    expect(source).toContain("narrowViewport ? sidebarOpen : !sidebarCollapsed");
    expect(css).toContain("@media (max-width: 980px)");
    expect(css).toContain("transform: translateX(-115%)");
    expect(css).toContain(".sidebarOpen { transform: translateX(0) !important; }");
    expect(css).toContain(".topbarGoverned .iconActions { display: flex; }");
  });

  it("renders bounded empty/loading/error states without fabricating task phase or action truth", () => {
    const empty = renderToStaticMarkup(<ProductShell {...shellBase} projectionState={{ status: "IDLE" }}><div /></ProductShell>);
    expect(empty).toContain("No current task selected");
    expect(empty).not.toContain("Next authoritative action");
    expect(empty).not.toContain("Governed scope awaiting confirmation");

    const loading = renderToStaticMarkup(<ProductShell {...shellBase} activeTaskId="task-1" projectionState={{ status: "LOADING", taskId: "task-1" }}><div /></ProductShell>);
    expect(loading).toContain("Loading authoritative task state");
    expect(loading).toContain("No phase or action is inferred while loading.");

    const error = renderToStaticMarkup(<ProductShell {...shellBase} activeTaskId="task-1" projectionState={{ status: "ERROR", taskId: "task-1", message: "Projection unavailable" }}><div /></ProductShell>);
    expect(error).toContain('role="alert"');
    expect(error).toContain("Projection unavailable");
  });

  it("does not render a permanent right rail in the governed surface", () => {
    const ready = projection();
    const html = renderToStaticMarkup(
      <ProductShell {...shellBase} activeTaskId={ready.taskSummary.id} projectionState={{ status: "READY", taskId: ready.taskSummary.id, projection: ready }}>
        <div />
      </ProductShell>,
    );
    expect(html).not.toContain("permanent-right-rail");
    expect(html).not.toContain('data-audit-drawer="projection"');
  });

  it("keeps the 1366x768 shell as a full-width application surface with local content scrolling", () => {
    const css = readFileSync("src/components/product-shell.module.css", "utf8");
    expect(css).toContain("height: calc(100dvh - 68px)");
    expect(css).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(css).toContain("grid-template-columns: 268px minmax(0, 1fr)");
    expect(css).toContain(".bodyCollapsed { grid-template-columns: 64px minmax(0, 1fr); }");
    expect(css).toContain("overflow: auto");
    expect(css).toContain("max-width: none");
    const ready = projection();
    const html = renderToStaticMarkup(<ProductShell {...shellBase} activeTaskId={ready.taskSummary.id} projectionState={{ status: "READY", taskId: ready.taskSummary.id, projection: ready }}><div /></ProductShell>);
    expect(html).toContain('data-governed-product-canvas="true"');
    expect(html).toContain('id="governed-current-work"');
  });
  it("labels retryable Context Mapping explicitly without treating it as evidence or closure state", () => {
    const source = readFileSync("src/components/product-shell.tsx", "utf8");
    expect(source).toContain("CONTEXT_MAPPING_RETRYABLE");
    expect(source).toContain("Context mapping retry available");
  });

});
