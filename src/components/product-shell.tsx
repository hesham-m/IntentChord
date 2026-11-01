"use client";

import Image from "next/image";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { translations } from "@/i18n/translations";
import type { Locale } from "@/i18n/types";
import type { TaskRecord } from "@/lib/workspace";
import { taskStatus } from "@/lib/workspace";
import { effectiveTaskContext } from "@/core/tasks/task-input";
import type { TaskExperienceProjectionState } from "@/components/task-experience-projection-client";
import styles from "./product-shell.module.css";

export type ShellStage =
  | "home"
  | "tasks"
  | "runs"
  | "task-new"
  | "task-current"
  | "contract"
  | "execute"
  | "review"
  | "bridge"
  | "environment"
  | "workspace-analysis";

export type CustomOpenItem = {
  id: string;
  title: string;
  statusLabel?: string;
  contextLabel?: string;
  active?: boolean;
  children: Array<{
    id: string;
    label: string;
    href?: string;
    active?: boolean;
    attention?: boolean;
    complete?: boolean;
  }>;
};


export type ProductShellInteractionState = {
  railCollapsed: boolean;
  auditDrawerOpen: boolean;
};

export type ProductShellInteractionEvent =
  | { type: "TOGGLE_RAIL" }
  | { type: "INITIALIZE_RAIL"; railCollapsed: boolean }
  | { type: "OPEN_AUDIT" }
  | { type: "CLOSE_AUDIT" };

export function productShellInteractionReducer(
  state: ProductShellInteractionState,
  event: ProductShellInteractionEvent,
): ProductShellInteractionState {
  if (event.type === "TOGGLE_RAIL") return { ...state, railCollapsed: !state.railCollapsed };
  if (event.type === "INITIALIZE_RAIL") return { ...state, railCollapsed: event.railCollapsed };
  if (event.type === "OPEN_AUDIT") return { ...state, auditDrawerOpen: true };
  return { ...state, auditDrawerOpen: false };
}


export function governedRailCollapsedForViewport(width: number): boolean {
  return width > 980 && width < 1440;
}

const governedPhases = ["UNDERSTAND", "GOVERN", "EXECUTE", "DECIDE"] as const;

function governedPhaseLabel(locale: Locale, phase: (typeof governedPhases)[number]): string {
  const labels = {
    UNDERSTAND: { en: "Understand", ar: "الفهم" },
    GOVERN: { en: "Govern", ar: "الحوكمة" },
    EXECUTE: { en: "Execute", ar: "التنفيذ" },
    DECIDE: { en: "Decide", ar: "القرار" },
  } as const;
  return labels[phase][locale];
}

function governedStateLabel(locale: Locale, status: string): string {
  const labels: Record<string, { en: string; ar: string }> = {
    AWAITING_OBJECTIVE: { en: "Awaiting objective", ar: "بانتظار تحديد الهدف" },
    WORKSPACE_VERIFYING: { en: "Workspace verification", ar: "التحقق من مساحة العمل" },
    ANALYSIS_READY_TO_START: { en: "Analysis ready to start", ar: "التحليل جاهز للبدء" },
    INDEXING_AND_MAPPING: { en: "Indexing and context mapping", ar: "الفهرسة وربط السياق" },
    CONTEXT_MAPPING_RETRYABLE: { en: "Context mapping retry available", ar: "إعادة محاولة تحليل السياق متاحة" },
    CONTEXT_EVIDENCE_REQUIRED: { en: "Required context evidence unresolved", ar: "أدلة سياق مطلوبة لم تُحسم" },
    CONTEXT_SOURCE_TRUTH_CONFLICT: { en: "Source truth conflict requires correction", ar: "تعارض حقيقة السورس يحتاج تصحيحًا" },
    COMPONENTS_READY_FOR_WORK_SELECTION: { en: "Components ready for Work Selection", ar: "المكونات جاهزة لاختيار العمل" },
    STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED: { en: "Current Context advanced · Work re-selection required", ar: "تقدم السياق الحالي · يلزم إعادة اختيار العمل" },
    SOURCE_DRIFT_REBASE_REQUIRED: { en: "Source drift · Context rebase required", ar: "تغيّر مصدر الحقيقة · يلزم Rebase للسياق" },
    SCOPE_DERIVED_AWAITING_CONFIRMATION: { en: "Governed scope awaiting confirmation", ar: "النطاق المحكوم بانتظار التأكيد" },
    SCOPE_CONFIRMED_AWAITING_PLATFORM: { en: "Scope confirmed · execution platform required", ar: "تم تأكيد النطاق · مطلوب اختيار منصة التنفيذ" },
    PLATFORM_SELECTED_CONFIGURATION_RESOLVED_AWAITING_CONTRACT: { en: "Execution configuration resolved · contract review", ar: "تم حل إعداد التنفيذ · مراجعة العقد" },
    CONTRACT_APPROVED_READY_FOR_RUN: { en: "Approved contract ready for run", ar: "العقد المعتمد جاهز للتشغيل" },
    RUN_ACTIVE_EXECUTING: { en: "Governed run active", ar: "التشغيل المحكوم نشط" },
    REPORT_INGESTED_AWAITING_EVALUATION: { en: "Report received · evaluation required", ar: "تم استلام التقرير · التقييم مطلوب" },
    VERDICT_READY_AWAITING_OWNER_DECISION: { en: "Verdict ready · Owner decision required", ar: "الحكم جاهز · قرار المالك مطلوب" },
    CORRECTION_REQUESTED: { en: "Correction requested", ar: "تم طلب تصحيح" },
    TASK_CLOSED: { en: "Task closed", ar: "المهمة مغلقة" },
  };
  return labels[status]?.[locale] ?? status.replaceAll("_", " ");
}

function actionAvailabilityLabel(locale: Locale, availability: string): string {
  const labels: Record<string, { en: string; ar: string }> = {
    ENABLED: { en: "Available", ar: "متاح" },
    DISABLED: { en: "Unavailable", ar: "غير متاح" },
    BUSY: { en: "In progress", ar: "قيد التنفيذ" },
    COMPLETED: { en: "Completed", ar: "مكتمل" },
  };
  return labels[availability]?.[locale] ?? availability;
}

type ProductShellProps = {
  locale: Locale;
  stage: ShellStage;
  theme: "system" | "light" | "dark";
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: "system" | "light" | "dark") => void;
  tasks?: TaskRecord[];
  activeTaskId?: string;
  onSelectTask?: (taskId: string) => void;
  customOpenItems?: CustomOpenItem[];
  workflowProgress?: ReactNode;
  projectionState?: TaskExperienceProjectionState;
  children: ReactNode;
};

function stageLabel(locale: Locale, key: string) {
  const ar: Record<string, string> = {
    task: "الهدف والنطاق",
    contract: "العقد الحاكم",
    execution: "التنفيذ",
    evidence: "التقرير والأدلة",
    decision: "الحكم وقرار المالك",
  };
  const en: Record<string, string> = {
    task: "Objective and scope",
    contract: "Governed contract",
    execution: "Execution",
    evidence: "Report and evidence",
    decision: "Verdict and Owner decision",
  };
  return (locale === "ar" ? ar : en)[key] ?? key;
}

function taskStageItems(task: TaskRecord, stage: ShellStage, activeTaskId?: string) {
  const active = task.id === activeTaskId;
  const run = task.runs.find(item => item.id === task.activeRunId);
  const items = [
    { id: "task", labelKey: "task", href: "/tasks/current", available: true, active: active && ["task-current"].includes(stage), complete: Boolean(task.contract) },
    { id: "contract", labelKey: "contract", href: "/contracts/current", available: Boolean(task.contract), active: active && stage === "contract", complete: task.contract?.ownerApproval.state === "APPROVED" },
    { id: "execution", labelKey: "execution", href: "/runs/current/execute", available: Boolean(task.contract?.ownerApproval.state === "APPROVED" || run), active: active && stage === "execute", complete: Boolean(run && run.status !== "AWAITING_REPORT") },
    { id: "evidence", labelKey: "evidence", href: run?.status === "AWAITING_REPORT" ? "/bridge" : "/runs/current/review", available: Boolean(run), active: active && (stage === "bridge" || (stage === "review" && task.reviewTab !== "decision")), complete: Boolean(run?.verdict) },
    { id: "decision", labelKey: "decision", href: "/runs/current/review", available: Boolean(run?.verdict), active: active && stage === "review" && task.reviewTab === "decision", attention: Boolean(run?.verdict && run.decision === "NONE"), complete: Boolean(run?.decision && run.decision !== "NONE") },
  ];
  return items.filter(item => item.available);
}

function statusLabel(locale: Locale, task: TaskRecord) {
  const status = taskStatus(task);
  const labels: Record<string, { en: string; ar: string }> = {
    DRAFT: { en: "Draft", ar: "مسودة" },
    AWAITING_APPROVAL: { en: "Owner approval", ar: "اعتماد المالك" },
    APPROVED: { en: "Approved", ar: "معتمد" },
    IN_EXECUTION: { en: "In execution", ar: "قيد التنفيذ" },
    AWAITING_DECISION: { en: "Decision required", ar: "قرار مطلوب" },
    CORRECTION_REQUESTED: { en: "Correction", ar: "تصحيح مطلوب" },
    CLOSED: { en: "Closed", ar: "مغلق" },
    REJECTED: { en: "Rejected", ar: "مرفوض" },
  };
  return labels[status]?.[locale] ?? status;
}

export function ProductShell({
  locale,
  stage,
  theme,
  onLocaleChange,
  onThemeChange,
  tasks = [],
  activeTaskId,
  onSelectTask,
  customOpenItems,
  workflowProgress,
  projectionState,
  children,
}: ProductShellProps) {
  const governedMode = projectionState !== undefined;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [interaction, dispatchInteraction] = useReducer(productShellInteractionReducer, { railCollapsed: governedMode, auditDrawerOpen: false });
  const responsiveRailInitialized = useRef(false);
  useEffect(() => {
    const syncNarrowViewport = () => setNarrowViewport(window.innerWidth <= 980);
    syncNarrowViewport();
    window.addEventListener("resize", syncNarrowViewport);
    if (governedMode && !responsiveRailInitialized.current) {
      responsiveRailInitialized.current = true;
      dispatchInteraction({ type: "INITIALIZE_RAIL", railCollapsed: governedRailCollapsedForViewport(window.innerWidth) });
    }
    return () => window.removeEventListener("resize", syncNarrowViewport);
  }, [governedMode]);
  const sidebarCollapsed = interaction.railCollapsed;
  const drawerOpen = interaction.auditDrawerOpen;
  const [collapsedItems, setCollapsedItems] = useState<Set<string>>(new Set());
  const [hiddenOpenItems, setHiddenOpenItems] = useState<Set<string>>(new Set());
  const [workSearch, setWorkSearch] = useState("");
  const openTasks = useMemo(
    () => tasks.filter(task => !["CLOSED", "REJECTED"].includes(taskStatus(task))),
    [tasks],
  );
  const activeTask = tasks.find(task => task.id === activeTaskId);
  const activeTaskContext = activeTask ? effectiveTaskContext(activeTask.draft) : undefined;
  const attentionCount = tasks.filter(task => {
    const run = task.runs.find(item => item.id === task.activeRunId);
    return Boolean(run?.verdict && run.decision === "NONE");
  }).length;

  const projectionTaskId = projectionState && "taskId" in projectionState ? projectionState.taskId : undefined;
  const governedProjectionState: TaskExperienceProjectionState | undefined = projectionTaskId && projectionTaskId !== activeTaskId
    ? activeTaskId
      ? { status: "LOADING", taskId: activeTaskId }
      : { status: "IDLE" }
    : projectionState;
  const governedProjection = governedProjectionState?.status === "READY" ? governedProjectionState.projection : undefined;

  const governedOpenItems: CustomOpenItem[] = governedProjection ? [{
    id: governedProjection.taskSummary.id,
    title: governedProjection.taskSummary.title || governedProjection.taskSummary.objective,
    statusLabel: `${governedPhaseLabel(locale, governedProjection.visiblePhase)} · ${governedStateLabel(locale, governedProjection.phaseStatus)}`,
    contextLabel: governedProjection.taskSummary.taskContext.kind === "PROJECT_BOUND"
      ? `${locale === "ar" ? "المشروع" : "Project"}: ${governedProjection.taskSummary.taskContext.projectDisplayName ?? governedProjection.taskSummary.taskContext.projectId ?? "—"}`
      : locale === "ar" ? "مهمة مستقلة" : "Independent task",
    active: true,
    children: governedPhases.map(phase => ({
      id: `${governedProjection.taskSummary.id}-${phase.toLowerCase()}`,
      label: governedPhaseLabel(locale, phase),
      active: governedProjection.visiblePhase === phase,
    })),
  }] : [];

  const openItems: CustomOpenItem[] = governedMode
    ? governedOpenItems
    : customOpenItems ?? openTasks.map(task => {
        const context = effectiveTaskContext(task.draft);
        return {
          id: task.id,
          title: task.draft.title || task.draft.objective,
          statusLabel: statusLabel(locale, task),
          contextLabel: context.kind === "PROJECT_BOUND"
            ? `${locale === "ar" ? "المشروع" : "Project"}: ${context.projectContextDisplayName}`
            : locale === "ar" ? "مهمة مستقلة" : "Independent task",
          active: task.id === activeTaskId,
          children: taskStageItems(task, stage, activeTaskId).map(item => ({
            id: `${task.id}-${item.id}`,
            label: stageLabel(locale, item.labelKey),
            href: item.href,
            active: item.active,
            attention: item.attention,
            complete: item.complete,
          })),
        };
      });

  const visibleOpenItems = governedMode ? openItems : openItems.filter(item => {
    if (hiddenOpenItems.has(item.id)) return false;
    const query = workSearch.trim().toLocaleLowerCase(locale === "ar" ? "ar" : "en");
    if (!query) return true;
    return [item.title, item.statusLabel, item.contextLabel, ...item.children.map(child => child.label)]
      .filter(Boolean)
      .some(value => String(value).toLocaleLowerCase(locale === "ar" ? "ar" : "en").includes(query));
  });

  const toggleCollapsed = (id: string) => {
    setCollapsedItems(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hideOpenItem = (id: string) => {
    setHiddenOpenItems(current => new Set(current).add(id));
  };

  const focusCurrentWork = () => {
    const target = document.getElementById("governed-current-work");
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  };



  return (
    <div className={styles.shell} data-theme={theme} dir={locale === "ar" ? "rtl" : "ltr"}>
      <header className={`${styles.topbar} ${governedMode ? styles.topbarGoverned : ""}`}>
        <div className={styles.globalArea}>
          <button
            className={styles.sidebarToggle}
            type="button"
            onClick={() => {
              if (narrowViewport) setSidebarOpen(value => !value);
              else dispatchInteraction({ type: "TOGGLE_RAIL" });
            }}
            aria-label={narrowViewport
              ? locale === "ar" ? (sidebarOpen ? "إغلاق الأعمال المفتوحة" : "فتح الأعمال المفتوحة") : (sidebarOpen ? "Close open work" : "Open work")
              : locale === "ar" ? (sidebarCollapsed ? "توسيع شريط الأعمال" : "طي شريط الأعمال") : (sidebarCollapsed ? "Expand work sidebar" : "Collapse work sidebar")}
            aria-expanded={narrowViewport ? sidebarOpen : !sidebarCollapsed}
            title={narrowViewport
              ? locale === "ar" ? (sidebarOpen ? "إغلاق الأعمال المفتوحة" : "فتح الأعمال المفتوحة") : (sidebarOpen ? "Close open work" : "Open work")
              : locale === "ar" ? (sidebarCollapsed ? "توسيع شريط الأعمال" : "طي شريط الأعمال") : (sidebarCollapsed ? "Expand work sidebar" : "Collapse work sidebar")}
          >☰</button>
          <Link className={styles.brand} href="/" aria-label="IntentChord">
            <Image src="/intentchord-assets/intentchord-horizontal-color.webp" width={348} height={86} alt="IntentChord" priority unoptimized />
          </Link>
        </div>

        {governedProjection ? (
          <div className={styles.topbarTaskContext} data-topbar-context-source="projection">
            <div className={styles.taskBreadcrumb}>
              <span>{locale === "ar" ? "المهمة" : "Task"}</span>
              <strong title={governedProjection.taskSummary.title || governedProjection.taskSummary.objective}>{governedProjection.taskSummary.title || governedProjection.taskSummary.objective}</strong>
            </div>
            <div className={styles.projectContextIndicator} data-task-context={governedProjection.taskSummary.taskContext.kind} data-project-context-role="reference-only">
              {governedProjection.taskSummary.taskContext.kind === "PROJECT_BOUND"
                ? <><span>{locale === "ar" ? "المشروع" : "Project"}</span><strong>{governedProjection.taskSummary.taskContext.projectDisplayName ?? governedProjection.taskSummary.taskContext.projectId ?? "—"}</strong></>
                : <strong>{locale === "ar" ? "مهمة مستقلة" : "Independent task"}</strong>}
            </div>
          </div>
        ) : !governedMode ? (
          <div className={`${styles.globalArea} ${styles.environmentArea}`}>
            <Link className={styles.topLink} href="/project-contexts"><span className={styles.topLinkText}>{locale === "ar" ? "المشاريع" : "Projects"}</span></Link>
          </div>
        ) : <div className={styles.topbarTaskContext} aria-live="polite"><span className={styles.topbarContextPending}>{locale === "ar" ? "جارٍ تحميل سياق المهمة…" : "Loading task context…"}</span></div>}

        {!governedMode && <label className={styles.workSearch}>
          <span className={styles.srOnly}>{locale === "ar" ? "بحث في العمل المفتوح" : "Search open work"}</span>
          <span aria-hidden="true">⌕</span>
          <input value={workSearch} onChange={event => setWorkSearch(event.target.value)} placeholder={locale === "ar" ? "بحث في العمل المفتوح" : "Search open work"} />
        </label>}

        <nav className={styles.globalActions} aria-label={locale === "ar" ? "التنقل الرئيسي" : "Primary navigation"}>
          <Link className={styles.topAction} href="/tasks/new">＋ <span>{locale === "ar" ? "مهمة جديدة" : "New task"}</span></Link>
          {governedMode ? (
            <>
              <Link className={styles.topLink} href="/project-contexts">{locale === "ar" ? "المشاريع" : "Projects"}</Link>
              <Link className={styles.topLink} href="/tasks">{locale === "ar" ? "الأعمال" : "Work"}</Link>
            </>
          ) : (
            <>
              <Link className={styles.topLink} href="/tasks">{locale === "ar" ? "الأعمال" : "Work"}</Link>
              <Link className={styles.topLink} href="/runs">{translations[locale].runs}{attentionCount > 0 && <span className={styles.attention}>{attentionCount}</span>}</Link>
            </>
          )}
          <Link className={styles.topLink} href="/admin">{locale === "ar" ? "الإدارة" : "Admin"}</Link>
          <div className={styles.iconActions}>
            <button className={styles.iconButton} type="button" onClick={() => onLocaleChange(locale === "ar" ? "en" : "ar")} aria-label={locale === "ar" ? "Switch to English" : "التبديل إلى العربية"} title={locale === "ar" ? "Switch to English" : "التبديل إلى العربية"}>{locale === "ar" ? "EN" : "ع"}</button>
            <button className={styles.iconButton} type="button" onClick={() => onThemeChange(theme === "system" ? "light" : theme === "light" ? "dark" : "system")} aria-label={locale === "ar" ? "تغيير المظهر" : "Change appearance"} title={locale === "ar" ? "تغيير المظهر" : "Change appearance"}>{theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}</button>
            <button className={styles.iconButton} type="button" onClick={() => dispatchInteraction({ type: "OPEN_AUDIT" })} aria-label={locale === "ar" ? "فتح السياق والتدقيق" : "Open context and audit"} title={locale === "ar" ? "فتح السياق والتدقيق" : "Open context and audit"}>ⓘ</button>
          </div>
        </nav>
      </header>

      <div className={`${styles.body} ${sidebarCollapsed ? styles.bodyCollapsed : ""}`}>
        {sidebarOpen && <button className={`${styles.mobileBackdrop} ${styles.mobileOnly}`} type="button" aria-label={locale === "ar" ? "إغلاق الأعمال" : "Close open work"} onClick={() => setSidebarOpen(false)} />}
        <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""} ${sidebarCollapsed ? styles.sidebarCollapsed : ""}`} aria-label={locale === "ar" ? "الأعمال المفتوحة" : "Open work"} data-open-work-source={governedMode ? "current-task-projection" : "legacy-workspace"}>
          <div className={styles.sidebarHeader}>
            <h2>{locale === "ar" ? "الأعمال المفتوحة" : "Open work"}</h2>
            <span>{visibleOpenItems.length}</span>
          </div>
          {!governedMode && hiddenOpenItems.size > 0 && <button type="button" className={styles.restoreOpenItems} onClick={() => setHiddenOpenItems(new Set())}>{locale === "ar" ? `إظهار ${hiddenOpenItems.size} عمل مغلق من المساحة` : `Restore ${hiddenOpenItems.size} hidden item(s)`}</button>}
          <div className={styles.openList}>
            {!visibleOpenItems.length && <div className={styles.emptyOpen}><p>{governedMode
              ? governedProjectionState?.status === "LOADING"
                ? (locale === "ar" ? "جارٍ تحميل حالة العمل المحكومة…" : "Loading governed work state…")
                : governedProjectionState?.status === "ERROR"
                  ? (locale === "ar" ? "تعذر تحميل حالة العمل الحالية." : "Current governed work state is unavailable.")
                  : (locale === "ar" ? "لا توجد مهمة حالية محددة." : "No current task is selected.")
              : workSearch.trim() ? (locale === "ar" ? "لا توجد نتيجة في العمل المفتوح." : "No matching open work.") : (locale === "ar" ? "لا يوجد عمل مفتوح. ابدأ عملًا محكومًا أو افتح عملًا سابقًا." : "No open work. Start governed work or open a previous item.")}</p><Link href="/tasks">{locale === "ar" ? "فتح سجل الأعمال" : "Open work history"}</Link></div>}
            {visibleOpenItems.map(item => {
              const collapsed = collapsedItems.has(item.id);
              return <section key={item.id} className={`${styles.workGroup} ${item.active ? styles.workGroupActive : ""}`}>
                <div className={styles.workSummary}>
                  <button type="button" className={styles.workTitleButton} onClick={() => onSelectTask?.(item.id)}>
                    <strong title={item.title}>{item.title}</strong>
                    <small>{item.statusLabel}{item.contextLabel ? ` · ${item.contextLabel}` : ""}</small>
                  </button>
                  <div className={styles.workControls}>
                    <button type="button" className={styles.workControl} onClick={() => toggleCollapsed(item.id)} aria-expanded={!collapsed} aria-label={collapsed ? (locale === "ar" ? "فتح المراحل" : "Expand stages") : (locale === "ar" ? "طي المراحل" : "Collapse stages")}>{collapsed ? "⌄" : "⌃"}</button>
                    {!governedMode && <button type="button" className={styles.workControl} onClick={() => hideOpenItem(item.id)} aria-label={locale === "ar" ? "إغلاق من مساحة العمل دون حذف" : "Close from workspace without deleting"}>×</button>}
                  </div>
                </div>
                {!collapsed && <nav className={styles.stageList}>
                  {item.children.map(child => (
                    child.href ? <Link key={child.id} href={child.href} className={`${styles.stageLink} ${child.active ? styles.stageActive : ""}`} aria-current={child.active ? "page" : undefined} title={sidebarCollapsed ? child.label : undefined} onClick={() => { onSelectTask?.(item.id); setSidebarOpen(false); }}>
                      <span className={`${styles.stageDot} ${child.active ? styles.stageDotActive : child.attention ? styles.stageDotAttention : child.complete ? styles.stageDotComplete : ""}`} />
                      <span>{child.label}</span>
                    </Link> : <div key={child.id} className={`${styles.stageLink} ${styles.stagePresentationOnly} ${child.active ? styles.stageActive : ""}`} aria-current={child.active ? "step" : undefined} title={sidebarCollapsed ? child.label : undefined}>
                      <span className={`${styles.stageDot} ${child.active ? styles.stageDotActive : ""}`} />
                      <span>{child.label}</span>
                    </div>
                  ))}
                </nav>}
              </section>;
            })}
          </div>
        </aside>

        <main className={`${styles.canvas} ${governedMode ? styles.canvasGoverned : ""}`} data-governed-product-canvas={governedMode ? "true" : undefined}>
          {governedMode ? <div className={styles.governedViewport}>
            <section className={styles.governedState} id="governed-state" aria-label={locale === "ar" ? "حالة العمل المحكومة" : "Governed work state"}>
              {governedProjectionState?.status === "READY" ? <>
                <div className={styles.governedOrientation}>
                  <p className={styles.eyebrow}>{locale === "ar" ? "IntentChord · سطح العمل المحكوم" : "IntentChord · Governed Work Surface"}</p>
                  <div className={styles.titleRow}>
                    <div>
                      <h1>{governedProjectionState.projection.taskSummary.title}</h1>
                      <p>{governedProjectionState.projection.taskSummary.objective}</p>
                    </div>
                    <span className={styles.modeBadge}>{governedProjectionState.projection.taskSummary.taskMode.replaceAll("_", " ")}</span>
                  </div>
                  <div className={styles.phaseTrack} role="list" aria-label={locale === "ar" ? "مراحل المنتج" : "Product phases"}>
                    {governedPhases.map(phase => <div key={phase} role="listitem" className={`${styles.phaseItem} ${governedProjectionState.projection.visiblePhase === phase ? styles.phaseItemCurrent : ""}`} aria-current={governedProjectionState.projection.visiblePhase === phase ? "step" : undefined}>
                      <span>{governedPhaseLabel(locale, phase)}</span>
                    </div>)}
                  </div>
                  <div className={styles.currentStateLine}>
                    <span>{locale === "ar" ? "الحالة الحالية" : "Current state"}</span>
                    <strong>{governedStateLabel(locale, governedProjectionState.projection.phaseStatus)}</strong>
                  </div>
                </div>
                <aside className={styles.primaryActionPanel} aria-label={locale === "ar" ? "إجراء المالك الحالي" : "Current Owner action"}>
                  <div>
                    <span>{locale === "ar" ? "الإجراء الحاكم التالي" : "Next authoritative action"}</span>
                    <strong>{locale === "ar" ? governedProjectionState.projection.primaryAction.labelAr : governedProjectionState.projection.primaryAction.labelEn}</strong>
                    <small>{actionAvailabilityLabel(locale, governedProjectionState.projection.primaryAction.availability)}</small>
                    {governedProjectionState.projection.primaryAction.availability === "DISABLED" && (locale === "ar" ? governedProjectionState.projection.primaryAction.disabledReasonAr : governedProjectionState.projection.primaryAction.disabledReasonEn) && <p>{locale === "ar" ? governedProjectionState.projection.primaryAction.disabledReasonAr : governedProjectionState.projection.primaryAction.disabledReasonEn}</p>}
                  </div>
                  <button
                    className={styles.primaryActionControl}
                    type="button"
                    disabled={governedProjectionState.projection.primaryAction.availability !== "ENABLED"}
                    onClick={governedProjectionState.projection.primaryAction.availability === "ENABLED" ? focusCurrentWork : undefined}
                    data-primary-action-source="projection"
                    data-authority-transition="none"
                  >{locale === "ar" ? governedProjectionState.projection.primaryAction.labelAr : governedProjectionState.projection.primaryAction.labelEn}</button>
                  <small className={styles.authorityNote}>{locale === "ar" ? "هذا التحكم ينقلك إلى سطح العمل الحالي فقط؛ أي انتقال في السلطة يظل Backend-governed." : "This control only focuses the current work surface; authority transitions remain backend-governed."}</small>
                </aside>
              </> : governedProjectionState?.status === "LOADING" ? <div className={styles.governedBoundedState} role="status"><strong>{locale === "ar" ? "جارٍ تحميل الحالة الحاكمة…" : "Loading authoritative task state…"}</strong><p>{locale === "ar" ? "لا يتم افتراض مرحلة أو إجراء أثناء التحميل." : "No phase or action is inferred while loading."}</p></div>
                : governedProjectionState?.status === "ERROR" ? <div className={`${styles.governedBoundedState} ${styles.governedError}`} role="alert"><strong>{locale === "ar" ? "تعذر تحميل الحالة الحاكمة" : "Authoritative task state unavailable"}</strong><p>{governedProjectionState.message}</p></div>
                  : <div className={styles.governedBoundedState}><strong>{locale === "ar" ? "لا توجد مهمة حالية" : "No current task selected"}</strong><p>{locale === "ar" ? "اختر مهمة من سجل الأعمال؛ لن يعرض IntentChord حالة مصطنعة." : "Choose a task from Work; IntentChord will not fabricate task state."}</p><Link href="/tasks">{locale === "ar" ? "فتح الأعمال" : "Open Work"}</Link></div>}
            </section>
            <div className={styles.governedContentViewport} id="governed-current-work" tabIndex={-1}>
              <div className={styles.canvasInner}>{children}</div>
            </div>
          </div> : <div className={styles.canvasScroll}>
            <div className={styles.canvasInner}>
              {workflowProgress && <div className={styles.workflowProgress}>{workflowProgress}</div>}
              {children}
            </div>
          </div>}
        </main>
      </div>

      {drawerOpen && <>
        <button className={styles.drawerBackdrop} type="button" aria-label={locale === "ar" ? "إغلاق اللوحة" : "Close drawer"} onClick={() => dispatchInteraction({ type: "CLOSE_AUDIT" })} />
        <aside className={styles.drawer} aria-label={locale === "ar" ? "السياق والتدقيق المتقدم" : "Context and advanced audit"}>
          <div className={styles.drawerHeader}>
            <h2>{locale === "ar" ? "السياق والتدقيق" : "Context and audit"}</h2>
            <button className={styles.iconButton} type="button" onClick={() => dispatchInteraction({ type: "CLOSE_AUDIT" })} aria-label={locale === "ar" ? "إغلاق" : "Close"}>×</button>
          </div>
          {governedMode ? <>
            <section className={styles.drawerSection}>
              <h3>{locale === "ar" ? "سياق المهمة الحالية" : "Current task context"}</h3>
              {governedProjection ? <>
                <p><strong>{governedProjection.taskSummary.taskContext.kind === "PROJECT_BOUND"
                  ? `${locale === "ar" ? "المشروع" : "Project"}: ${governedProjection.taskSummary.taskContext.projectDisplayName ?? governedProjection.taskSummary.taskContext.projectId ?? "—"}`
                  : locale === "ar" ? "مهمة مستقلة" : "Independent task"}</strong></p>
                <p>{governedProjection.taskSummary.objective}</p>
              </> : <p>{locale === "ar" ? "لا توجد حقيقة Task محمّلة للتدقيق." : "No authoritative Task projection is loaded for audit."}</p>}
            </section>
            <section className={styles.drawerSection} data-audit-drawer="projection">
              <h3>{locale === "ar" ? "التفاصيل الحاكمة" : "Governance details"}</h3>
              {governedProjection ? <dl className={styles.auditGrid}>
                {([
                  ["Task ID", governedProjection.auditDetails.taskId],
                  ["Workspace Index Snapshot", governedProjection.auditDetails.workspaceIndexSnapshotId],
                  ["Workspace Observation", governedProjection.auditDetails.b1WorkspaceObservationId],
                  ["Workspace Revision", governedProjection.auditDetails.workspaceRevisionId],
                  ["Canonical Index Artifact", governedProjection.auditDetails.canonicalIndexArtifactId],
                  ["Mapping Run", governedProjection.auditDetails.mappingRunId],
                  ["Mapping Proposal", governedProjection.auditDetails.mappingProposalId],
                  ["Contract SHA256", governedProjection.auditDetails.contractSha256],
                  ["Report Submission", governedProjection.auditDetails.reportSubmissionId],
                  ["Verdict SHA256", governedProjection.auditDetails.verdictSha256],
                ] as const).filter(([, value]) => Boolean(value)).map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}
              </dl> : <p>{locale === "ar" ? "لا توجد تفاصيل حاكمة متاحة." : "No authoritative audit details are available."}</p>}
            </section>
          </> : <>
            <section className={styles.drawerSection}>
              <h3>{locale === "ar" ? "سياق المهمة الحالية" : "Current task context"}</h3>
              {activeTaskContext ? (
                activeTaskContext.kind === "PROJECT_BOUND" ? <>
                  <p><strong>{locale === "ar" ? `المشروع: ${activeTaskContext.projectContextDisplayName}` : `Project: ${activeTaskContext.projectContextDisplayName}`}</strong></p>
                  <p>{locale === "ar" ? "ارتباط المشروع لا يمنح المهمة أي صلاحية تلقائيًا." : "Project membership grants no Task authority automatically."}</p>
                </> : <p><strong>{locale === "ar" ? "مهمة مستقلة" : "Independent task"}</strong></p>
              ) : <p>{locale === "ar" ? "لا توجد مهمة مفتوحة." : "No task is open."}</p>}
              <Link className={styles.topAction} href="/project-contexts">{locale === "ar" ? "إدارة المشاريع" : "Manage projects"}</Link>
            </section>
            <section className={styles.drawerSection}>
              <h3>{locale === "ar" ? "Advanced Audit" : "Advanced Audit"}</h3>
              <dl className={styles.auditGrid}>
                <dt>{locale === "ar" ? "Task context" : "Task context"}</dt><dd>{activeTaskContext?.kind ?? "—"}</dd>
                <dt>{locale === "ar" ? "Project ID" : "Project ID"}</dt><dd>{activeTaskContext?.kind === "PROJECT_BOUND" ? activeTaskContext.projectContextId : "—"}</dd>
                <dt>{locale === "ar" ? "Project revision" : "Project revision"}</dt><dd>{activeTaskContext?.kind === "PROJECT_BOUND" ? activeTaskContext.projectContextRevision : "—"}</dd>
                <dt>{locale === "ar" ? "Active Task ID" : "Active Task ID"}</dt><dd>{activeTaskId ?? "—"}</dd>
              </dl>
            </section>
          </>}
          <section className={styles.drawerSection}>
            <p>{locale === "ar" ? "المعرّفات والتفاصيل الفنية معروضة هنا للنسخ والتدقيق فقط، ولا تمنح أي سلطة تنفيذ." : "Identifiers and technical details are shown here for copying and audit only. They grant no execution authority."}</p>
          </section>
        </aside>
      </>}
    </div>
  );
}
