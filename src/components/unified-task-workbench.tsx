"use client";

import { workspaceIndexAttemptIdempotencyKey } from "@/core/tasks/context-analysis-attempt";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProductShell } from "@/components/product-shell";
import { useProductPreferences } from "@/components/product-preferences-provider";
import {
  requestTaskExperienceProjection,
  type TaskExperienceProjectionState,
} from "@/components/task-experience-projection-client";
import {
  createBlankTaskDraft,
  generatedTaskTitle,
  type TaskDraftInput,
  type WorkspaceReference,
} from "@/core/tasks/task-input";
import type { TaskExperienceProjectionV1 } from "@/server/task-experience-projection-service";
import type { TaskRecord } from "@/lib/workspace";
import { ownerErrorMessage, type ErrorPayload } from "@/lib/owner-errors";
import styles from "./unified-task-workbench.module.css";

type WorkspaceRegistrationView = {
  id: string;
  revision: number;
  displayName: string;
  role: string;
  referenceType: "LOCAL_PATH" | "REMOTE_REFERENCE";
  source: "WINDOWS_NATIVE_SELECTOR" | "MANUAL_VERIFIED" | "MANUAL_UNVERIFIED" | "REMOTE_CONNECTOR";
  normalizedReference: string;
  verificationStatus: "VERIFIED" | "UNVERIFIED" | "STALE" | "FAILED";
  fingerprint: string;
  repositoryIdentity?: string;
  branch?: string;
  commitSha?: string;
  authorizationContext: string;
};

type WorkspaceIndexSnapshotView = {
  id: string;
  status: "CREATING" | "READY" | "FAILED";
  failureCode?: string;
};

type ActionState =
  | { kind: "IDLE" }
  | { kind: "WORKING"; message: string }
  | { kind: "SUCCESS"; message: string }
  | { kind: "ERROR"; message: string };

const ACTIVE_TASK_KEY = "intentchord-ui-active-task-id";

async function ownerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response = await fetch(input, init);
  if (response.status !== 401 && response.status !== 403) return response;
  const body = await response.clone().json().catch(() => ({})) as ErrorPayload;
  if (!["OWNER_SESSION_REQUIRED", "OWNER_SESSION_INVALID"].includes(body.code ?? "")) return response;
  if (typeof window !== "undefined") {
    window.location.href = "/login";
  }
  return response;
}

async function readResponse<T>(response: Response, locale: "ar" | "en"): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ErrorPayload;
  if (!response.ok) throw new Error(ownerErrorMessage(body, locale));
  return body;
}

function asTaskWorkspace(registration: WorkspaceRegistrationView, ordering: number): WorkspaceReference {
  return {
    id: registration.id,
    displayName: registration.displayName,
    role: registration.role || (ordering === 0 ? "primary" : "supporting"),
    referenceType: registration.referenceType,
    source: registration.source,
    reference: registration.normalizedReference,
    repositoryIdentity: registration.repositoryIdentity,
    branch: registration.branch,
    commitSha: registration.commitSha,
    fingerprint: registration.fingerprint,
    provenance: `registered-workspace-revision:${registration.revision}`,
    // Understanding authority is Workspace-root read authority. Execution scope is derived later.
    discoveryScopeMode: "FULL_WORKSPACE",
    allowedPaths: [],
    excludedPaths: [],
    authorizationContext: registration.authorizationContext || "owner-selected governed workspace",
    ordering,
  };
}

function currentOpenTask(tasks: TaskRecord[]): TaskRecord | undefined {
  if (typeof window !== "undefined") {
    const preferred = window.localStorage.getItem(ACTIVE_TASK_KEY);
    const match = preferred ? tasks.find(task => task.id === preferred) : undefined;
    if (match) return match;
  }
  return tasks.find(task => {
    const run = task.runs.find(item => item.id === task.activeRunId);
    return !run || !run.decision || run.decision === "NONE" || run.decision === "CORRECTION_REQUESTED";
  }) ?? tasks[0];
}

export function UnifiedTaskWorkbench({ mode }: { mode: "NEW" | "CURRENT" }) {
  const { locale, setLocale, theme, setTheme } = useProductPreferences();
  const text = useCallback((en: string, ar: string) => locale === "ar" ? ar : en, [locale]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [task, setTask] = useState<TaskRecord>();
  const [projectionState, setProjectionState] = useState<TaskExperienceProjectionState>(
    mode === "CURRENT" ? { status: "IDLE" } : { status: "IDLE" },
  );
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceRegistrationView[]>([]);
  const [objective, setObjective] = useState("");
  const [taskMode, setTaskMode] = useState<TaskDraftInput["taskMode"]>("CONTROLLED_AUDIT");
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);
  const [selectedComponentIds, setSelectedComponentIds] = useState<string[]>([]);
  const [sourceChoiceByGap, setSourceChoiceByGap] = useState<Record<string, string>>({});
  const [action, setAction] = useState<ActionState>({ kind: "IDLE" });

  const projection = projectionState.status === "READY" ? projectionState.projection : undefined;

  const refreshProjection = useCallback(async (taskId: string) => {
    setProjectionState({ status: "LOADING", taskId });
    try {
      const next = await requestTaskExperienceProjection(taskId, locale, ownerFetch);
      setProjectionState({ status: "READY", taskId, projection: next });
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProjectionState({ status: "ERROR", taskId, message });
      throw error;
    }
  }, [locale]);

  const refreshBootstrap = useCallback(async () => {
    const [taskRows, workspaceRows] = await Promise.all([
      readResponse<TaskRecord[]>(await ownerFetch("/api/tasks", { cache: "no-store" }), locale),
      readResponse<WorkspaceRegistrationView[]>(await ownerFetch("/api/workspaces", { cache: "no-store" }), locale),
    ]);
    setTasks(taskRows);
    setWorkspaceOptions(workspaceRows);
    if (mode === "CURRENT") {
      const active = currentOpenTask(taskRows);
      setTask(active);
      if (active) {
        window.localStorage.setItem(ACTIVE_TASK_KEY, active.id);
        await refreshProjection(active.id);
      } else {
        setProjectionState({ status: "IDLE" });
      }
    } else if (!selectedWorkspaceIds.length && workspaceRows.length) {
      setSelectedWorkspaceIds([workspaceRows[0].id]);
    }
  }, [locale, mode, refreshProjection, selectedWorkspaceIds.length]);

  useEffect(() => {
    void refreshBootstrap().catch(error => setAction({ kind: "ERROR", message: error instanceof Error ? error.message : String(error) }));
    // Bootstrap is intentionally run once per route mount; projection refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectOpenTask(taskId: string) {
    const selected = tasks.find(item => item.id === taskId);
    if (!selected) return;
    window.localStorage.setItem(ACTIVE_TASK_KEY, selected.id);
    setTask(selected);
    await refreshProjection(selected.id);
    if (mode === "NEW") window.history.replaceState(null, "", "/tasks/current");
  }

  async function runAction(message: string, operation: () => Promise<void>) {
    setAction({ kind: "WORKING", message });
    try {
      await operation();
      setAction({ kind: "SUCCESS", message: text("Governed operation completed.", "اكتملت العملية المحكومة.") });
    } catch (error) {
      setAction({ kind: "ERROR", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function registerWorkspace() {
    await runAction(text("Opening the governed Workspace selector…", "جارٍ فتح اختيار مساحة العمل المحكوم…"), async () => {
      const result = await readResponse<{ workspace: WorkspaceReference }>(await ownerFetch("/api/workspaces/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: `Workspace ${workspaceOptions.length + 1}`,
          role: selectedWorkspaceIds.length ? "supporting" : "primary",
          authorizationContext: "Owner selected this Workspace for governed source understanding.",
          taskMode,
        }),
      }), locale);
      const workspaces = await readResponse<WorkspaceRegistrationView[]>(await ownerFetch("/api/workspaces", { cache: "no-store" }), locale);
      setWorkspaceOptions(workspaces);
      setSelectedWorkspaceIds(ids => Array.from(new Set([...ids, result.workspace.id])));
    });
  }

  async function createTask() {
    if (objective.trim().length < 3) {
      setAction({ kind: "ERROR", message: text("Write a clear Owner objective first.", "اكتب هدف المالك بوضوح أولًا.") });
      return;
    }
    const selected = selectedWorkspaceIds
      .map(id => workspaceOptions.find(workspace => workspace.id === id))
      .filter((workspace): workspace is WorkspaceRegistrationView => Boolean(workspace));
    if (!selected.length) {
      setAction({ kind: "ERROR", message: text("Select at least one governed Workspace.", "اختر مساحة عمل محكومة واحدة على الأقل.") });
      return;
    }
    await runAction(text("Creating the governed Task…", "جارٍ إنشاء المهمة المحكومة…"), async () => {
      const draft = createBlankTaskDraft(taskMode, selected.map(asTaskWorkspace));
      draft.objective = objective.trim();
      draft.title = generatedTaskTitle(draft.objective);
      const created = await readResponse<TaskRecord>(await ownerFetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft }),
      }), locale);
      window.localStorage.setItem(ACTIVE_TASK_KEY, created.id);
      setTask(created);
      setTasks(rows => [created, ...rows.filter(row => row.id !== created.id)]);
      await refreshProjection(created.id);
      window.history.replaceState(null, "", "/tasks/current");
    });
  }

  async function ensureReadySnapshot(workspaceId: string, analysisAttemptId: string): Promise<string> {
    if (!task) throw new Error("TASK_REQUIRED_FOR_WORKSPACE_INDEX");
    const snapshot = await readResponse<WorkspaceIndexSnapshotView>(await ownerFetch("/api/workspace-index-snapshots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: workspaceIndexAttemptIdempotencyKey({ taskId: task.id, analysisAttemptId, workspaceId }),
      }),
    }), locale);
    if (snapshot.status !== "READY") {
      throw new Error(snapshot.failureCode ?? "WORKSPACE_INDEX_NOT_READY");
    }
    return snapshot.id;
  }

  async function waitForContextMappingOutcome(taskId: string): Promise<TaskExperienceProjectionV1> {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 1500));
      const next = await requestTaskExperienceProjection(taskId, locale, ownerFetch);
      setProjectionState({ status: "READY", taskId, projection: next });
      if (next.phaseStatus !== "INDEXING_AND_MAPPING") return next;
    }
    throw new Error("CONTEXT_MAPPING_UI_WAIT_TIMEOUT");
  }

  async function analyzeTaskContext() {
    if (!task || !projection) return;
    const isContextMappingRetry = projection.primaryAction.actionKey === "RETRY_CONTEXT_MAPPING";
    await runAction(
      isContextMappingRetry
        ? text("Retrying governed Context Mapping on the frozen Context authority…", "جارٍ إعادة محاولة تحليل السياق على سلطة السياق المجمدة…")
        : text("Building Source Truth and governed Context Closure…", "جارٍ بناء حقيقة السورس وإغلاق السياق المحكوم…"),
      async () => {
      // A Mapping retry must never create a new Workspace Index or advance Context Assembly authority.
      // It reuses the exact failed frozen Context revision; only a fresh Mapping window/run is allowed.
      if (!isContextMappingRetry) {
        // One explicit Owner Analyze/Rebuild action owns one idempotency identity. All Workspace
        // index requests in this action share it; a later explicit action receives a new identity.
        const analysisAttemptId = crypto.randomUUID();
        for (const workspace of projection.workspaceSummary.workspaces) {
          if (!workspace.rootAuthorityValid) {
            throw new Error(text(
              `Workspace ${workspace.displayName} is not currently verified by backend root authority.`,
              `مساحة العمل ${workspace.displayName} غير متحقق منها حاليًا بواسطة سلطة الجذر في الـBackend.`,
            ));
          }
          await ensureReadySnapshot(workspace.id, analysisAttemptId);
        }
      }
      await readResponse(await ownerFetch(`/api/tasks/${task.id}/context-closure`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: `unified-context-closure:${task.id}:${crypto.randomUUID()}` }),
      }), locale);
      const outcome = await waitForContextMappingOutcome(task.id);
      if (outcome.phaseStatus === "CONTEXT_MAPPING_RETRYABLE") {
        throw new Error(text("Context Mapping failed. The backend preserved the failed run for retry.", "فشل تحليل السياق. احتفظ الـBackend بالمحاولة الفاشلة وأصبحت قابلة لإعادة المحاولة."));
      }
    });
  }

  function toggleComponent(component: TaskExperienceProjectionV1["discoveredWorkSummary"]["components"][number]) {
    setSelectedComponentIds(ids => ids.includes(component.componentId)
      ? ids.filter(id => id !== component.componentId)
      : [...ids, component.componentId]);
  }

  async function commitWorkSelection() {
    if (!task || !projection || !selectedComponentIds.length) return;
    const acceptedCatalogRevisionId = projection.auditDetails.acceptedCatalogRevisionId
      ?? projection.discoveredWorkSummary.components[0]?.acceptedCatalogRevisionId;
    if (!acceptedCatalogRevisionId) {
      setAction({ kind: "ERROR", message: text("A closed accepted Context Catalog is required.", "يلزم Catalog سياق مغلق ومقبول.") });
      return;
    }
    await runAction(text("Committing Owner Work Selection and deriving cross-workspace Candidate Scope…", "جارٍ تثبيت اختيار العمل واشتقاق Candidate Scope عبر مساحات العمل…"), async () => {
      const updated = await readResponse<TaskRecord>(await ownerFetch(`/api/tasks/${task.id}/work-selection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: task.revision,
          acceptedCatalogRevisionId,
          selectedComponentIds,
        }),
      }), locale);
      setTask(updated);
      setTasks(rows => rows.map(row => row.id === updated.id ? updated : row));
      setSelectedComponentIds([]);
      await refreshProjection(task.id);
    });
  }

  async function authorizeContextSource(requestId: string, workspaceRegistrationId: string | undefined, decision: "APPROVE" | "DENY" | "SOURCE_UNAVAILABLE") {
    if (!task || (decision !== "SOURCE_UNAVAILABLE" && !workspaceRegistrationId)) return;
    await runAction(text("Recording governed Source authorization…", "جارٍ تسجيل تفويض السورس المحكوم…"), async () => {
      await readResponse(await ownerFetch(`/api/tasks/${task.id}/context-source-authorization`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedTaskRevision: task.revision,
          missingEvidenceRequestId: requestId,
          ...(workspaceRegistrationId ? { workspaceRegistrationId } : {}),
          decision,
        }),
      }), locale);
      const refreshedTasks = await readResponse<TaskRecord[]>(await ownerFetch("/api/tasks", { cache: "no-store" }), locale);
      const refreshedTask = refreshedTasks.find(row => row.id === task.id);
      if (refreshedTask) setTask(refreshedTask);
      setTasks(refreshedTasks);
      await refreshProjection(task.id);
    });
  }

  async function confirmScope() {
    if (!task || !projection?.candidateScopeSummary.identity) return;
    await runAction(text("Confirming the backend-derived governed Scope…", "جارٍ تأكيد النطاق المحكوم المشتق من الـBackend…"), async () => {
      const updated = await readResponse<TaskRecord>(await ownerFetch(`/api/tasks/${task.id}/scope-confirmation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: task.revision,
          expectedCandidateIdentity: projection.candidateScopeSummary.identity,
          confirmedAllowedPaths: projection.candidateScopeSummary.allowedPaths.map(path => ({ workspaceId: path.workspaceId, path: path.path })),
          confirmedExcludedPaths: [],
        }),
      }), locale);
      setTask(updated);
      setTasks(rows => rows.map(row => row.id === updated.id ? updated : row));
      await refreshProjection(task.id);
    });
  }

  async function selectExecutionPlatform(executionChannelId: "CODEX" | "CLAUDE_CODE" | "GEMINI_CLI") {
    if (!task) return;
    await runAction(text("Resolving governed execution configuration and Contract…", "جارٍ حل إعداد التنفيذ المحكوم وإنشاء العقد…"), async () => {
      const routed = await readResponse<TaskRecord>(await ownerFetch(`/api/tasks/${task.id}/execution-platform`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: task.revision, executionChannelId }),
      }), locale);
      // Freeze and project the backend-resolved execution configuration before Contract creation.
      // If Contract creation later fails closed, the UI remains synchronized to the routed Task revision.
      setTask(routed);
      setTasks(rows => rows.map(row => row.id === routed.id ? routed : row));
      await refreshProjection(routed.id);
      const contracted = await readResponse<TaskRecord>(await ownerFetch(`/api/tasks/${task.id}/contract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: routed.revision, locale }),
      }), locale);
      setTask(contracted);
      setTasks(rows => rows.map(row => row.id === contracted.id ? contracted : row));
      await refreshProjection(task.id);
    });
  }

  const componentGroups = useMemo(() => {
    const groups = new Map<string, TaskExperienceProjectionV1["discoveredWorkSummary"]["components"]>();
    for (const component of projection?.discoveredWorkSummary.components ?? []) {
      const groupId = component.acceptedCatalogRevisionId ?? component.mappingRunId ?? "governed-catalog";
      const group = groups.get(groupId) ?? [];
      group.push(component);
      groups.set(groupId, group);
    }
    return [...groups.entries()];
  }, [projection]);

  const shellProjectionState: TaskExperienceProjectionState = mode === "NEW" && !task
    ? { status: "IDLE" }
    : projectionState;

  return <ProductShell
    locale={locale}
    stage={mode === "NEW" && !task ? "task-new" : "task-current"}
    theme={theme}
    onLocaleChange={setLocale}
    onThemeChange={setTheme}
    tasks={tasks}
    activeTaskId={task?.id}
    onSelectTask={taskId => void selectOpenTask(taskId)}
    projectionState={shellProjectionState}
  >
    <div className={styles.surface} data-unified-governed-task-surface="true">
      {action.kind !== "IDLE" && <div className={`${styles.notice} ${action.kind === "ERROR" ? styles.noticeError : action.kind === "WORKING" ? styles.noticeWorking : styles.noticeSuccess}`} role={action.kind === "ERROR" ? "alert" : "status"}>{action.message}</div>}

      {!task ? <section className={styles.creationGrid} aria-label={text("Create governed Task", "إنشاء مهمة محكومة")}>
        <div className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div><span className={styles.kicker}>UNDERSTAND</span><h2>{text("Owner Objective", "هدف المالك")}</h2></div>
            <span className={styles.authorityBadge}>{text("Owner authority", "سلطة المالك")}</span>
          </div>
          <label className={styles.field}>
            <span>{text("What outcome do you need?", "ما النتيجة التي تريدها؟")}</span>
            <textarea value={objective} onChange={event => setObjective(event.target.value)} rows={5} placeholder={text("Describe the required outcome, problem, or investigation…", "اكتب النتيجة المطلوبة أو المشكلة أو التحقيق…")} />
          </label>
          <label className={styles.field}>
            <span>{text("Task mode", "نوع المهمة")}</span>
            <select value={taskMode} onChange={event => setTaskMode(event.target.value as TaskDraftInput["taskMode"])}>
              <option value="CONTROLLED_AUDIT">CONTROLLED_AUDIT</option>
              <option value="SOURCE_IMPLEMENTATION">SOURCE_IMPLEMENTATION</option>
              <option value="REPORT_REVIEW">REPORT_REVIEW</option>
            </select>
          </label>
        </div>

        <div className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div><span className={styles.kicker}>SOURCE TRUTH</span><h2>{text("Workspace", "مساحة العمل")}</h2></div>
            <button type="button" className={styles.secondaryButton} onClick={() => void registerWorkspace()}>{text("Add Workspace", "إضافة Workspace")}</button>
          </div>
          <p className={styles.muted}>{text("Select the governed source roots IntentChord may index for understanding. Execution scope is derived later and is not implied by this selection.", "اختر جذور السورس المحكومة التي يجوز لـIntentChord فهرستها للفهم. نطاق التنفيذ يُشتق لاحقًا ولا ينتج تلقائيًا من هذا الاختيار.")}</p>
          <div className={styles.workspaceList}>
            {workspaceOptions.length ? workspaceOptions.map(workspace => <label key={workspace.id} className={styles.workspaceChoice}>
              <input type="checkbox" checked={selectedWorkspaceIds.includes(workspace.id)} onChange={event => setSelectedWorkspaceIds(ids => event.target.checked ? [...ids, workspace.id] : ids.filter(id => id !== workspace.id))} />
              <span><strong>{workspace.displayName}</strong><small dir="ltr">{workspace.normalizedReference}</small></span>
              <em data-status={workspace.verificationStatus}>{workspace.verificationStatus}</em>
            </label>) : <div className={styles.emptyState}>{text("No registered Workspace yet.", "لا توجد Workspace مسجلة حتى الآن.")}</div>}
          </div>
        </div>

        <div className={styles.creationAction}>
          <div><strong>{text("Next governed transition", "الانتقال المحكوم التالي")}</strong><span>{text("Create Task and enter Source Understanding", "إنشاء المهمة والدخول إلى فهم السورس")}</span></div>
          <button type="button" className={styles.primaryButton} onClick={() => void createTask()} disabled={action.kind === "WORKING"}>{text("Create Governed Task", "إنشاء المهمة المحكومة")}</button>
        </div>
      </section> : projection ? <>
        <section className={styles.contextStrip}>
          <div><span>{text("Workspace", "Workspace")}</span><strong>{projection.workspaceSummary.workspaces.map(item => item.displayName).join(" · ") || "—"}</strong></div>
          <div><span>{text("Index", "الفهرس")}</span><strong>{projection.analysisSummary.indexStatus}</strong></div>
          <div><span>{text("Context Closure", "إغلاق السياق")}</span><strong>{projection.analysisSummary.contextClosureState}</strong></div>
          <div><span>{text("Selected Work", "العمل المختار")}</span><strong>{projection.ownerSelectionSummary.selectedComponentIds.length || projection.ownerSelectionSummary.selectedContextIds.length}</strong></div>
          <div><span>{text("Scope", "النطاق")}</span><strong>{projection.scopeConfirmationSummary.isConfirmed ? text("Confirmed", "مؤكد") : projection.candidateScopeSummary.isDerived ? text("Candidate", "مرشح") : text("Pending", "بانتظار")}</strong></div>
        </section>

        <section className={styles.workGrid}>
          <article className={`${styles.panel} ${styles.primaryPanel}`}>
            <div className={styles.sectionHeading}>
              <div><span className={styles.kicker}>{projection.visiblePhase}</span><h2>{text("Current governed work", "العمل المحكوم الحالي")}</h2></div>
              <span className={styles.authorityBadge}>{projection.phaseStatus.replaceAll("_", " ")}</span>
            </div>

            {["AWAITING_OBJECTIVE", "WORKSPACE_VERIFYING", "ANALYSIS_READY_TO_START", "INDEXING_AND_MAPPING", "CONTEXT_MAPPING_RETRYABLE"].includes(projection.phaseStatus) && <div className={styles.focusBlock}>
              <h3>{projection.phaseStatus === "CONTEXT_MAPPING_RETRYABLE" ? text("Retry Context Mapping", "إعادة محاولة تحليل السياق") : text("Build Source Truth & Context", "بناء حقيقة السورس والسياق")}</h3>
              <p>{projection.phaseStatus === "CONTEXT_MAPPING_RETRYABLE"
                ? text("The previous Mapping Run ended in a terminal execution/model-result failure. The governed Context Assembly is unchanged and remains eligible for a new Mapping Run; previous failed provenance is preserved.", "انتهت محاولة الـMapping السابقة بفشل تقني أو رفض لنتيجة النموذج. تظل Context Assembly المحكومة كما هي وصالحة لمحاولة Mapping جديدة مع الاحتفاظ الكامل بدليل المحاولة الفاشلة.")
                : text("IntentChord will create/use a Canonical Workspace Index, then run the qualified Internal AI Context Mapper. No external execution model is selected here.", "سيُنشئ IntentChord أو يستخدم Canonical Workspace Index ثم يشغل Internal AI Context Mapper المؤهل. لا يتم اختيار نموذج تنفيذ خارجي هنا.")}</p>
              <div className={styles.workspaceCards}>{projection.workspaceSummary.workspaces.map(workspace => <div key={workspace.id} className={styles.compactCard}>
                <strong>{workspace.displayName}</strong><small dir="ltr">{workspace.referencePath}</small><span>{workspace.rootAuthorityValid ? text("Verified source authority", "سلطة سورس متحقق منها") : text("Source authority not ready", "سلطة السورس غير جاهزة")}</span>
              </div>)}</div>
              <button type="button" className={styles.primaryButton} disabled={projection.primaryAction.availability !== "ENABLED" || action.kind === "WORKING"} onClick={() => void analyzeTaskContext()}>{projection.phaseStatus === "CONTEXT_MAPPING_RETRYABLE" ? text("Retry Mapping", "إعادة محاولة الـMapping") : text("Build / Continue Context", "بناء / استكمال السياق")}</button>
            </div>}

            {projection.phaseStatus === "CONTEXT_EVIDENCE_REQUIRED" && <div className={styles.focusBlock}>
              <h3>{text("Resolve required Context evidence", "استكمال أدلة السياق المطلوبة")}</h3>
              <p>{text(
                "The Internal AI reported an evidence gap; the Backend classified it. No partial Catalog is published and Work Selection stays locked until the governed source gap is resolved.",
                "أبلغ الـInternal AI عن فجوة دليل وقام الـBackend بتصنيفها. لا يتم نشر Catalog جزئي ويظل اختيار العمل مغلقًا حتى حل فجوة السورس المحكومة.",
              )}</p>
              <div className={styles.componentScroll}>
                {projection.contextResolutionSummary.missingEvidenceRequests.map(request => {
                  const defaultWorkspaceId = request.candidateWorkspaceRegistrationId ?? sourceChoiceByGap[request.id] ?? "";
                  const selectable = workspaceOptions.filter(workspace => !projection.workspaceSummary.workspaces.some(bound => bound.id === workspace.id));
                  return <section key={request.id} className={styles.componentGroup}>
                    <div className={styles.groupHeader}><strong>{request.classification}</strong><small dir="ltr">{request.modelGapId}</small></div>
                    <div className={styles.componentCard}>
                      <span><strong>{request.description}</strong><p>{text("Required evidence", "الدليل المطلوب")}: {request.requiredEvidenceKind}</p>{request.sourceHint && <small dir="ltr">Hint: {request.sourceHint}</small>}</span>
                    </div>
                    {request.classification === "BLOCKING_INTERNAL_SOURCE_GAP" && !request.authorizationDecision && <div className={styles.field}>
                      <span>{text("Owner-authorized source", "السورس الذي سيعتمده المالك")}</span>
                      <select value={defaultWorkspaceId} onChange={event => setSourceChoiceByGap(current => ({ ...current, [request.id]: event.target.value }))}>
                        <option value="">{text("Select registered Workspace", "اختر Workspace مسجلة")}</option>
                        {selectable.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.displayName}</option>)}
                      </select>
                      <div className={styles.platformGrid}>
                        <button type="button" className={styles.primaryButton} disabled={!defaultWorkspaceId || action.kind === "WORKING"} onClick={() => void authorizeContextSource(request.id, defaultWorkspaceId, "APPROVE")}>{text("Authorize Source", "اعتماد السورس")}</button>
                        <button type="button" className={styles.secondaryButton} disabled={!defaultWorkspaceId || action.kind === "WORKING"} onClick={() => void authorizeContextSource(request.id, defaultWorkspaceId, "DENY")}>{text("Deny candidate", "رفض السورس المرشح")}</button>
                        <button type="button" className={styles.secondaryButton} disabled={action.kind === "WORKING"} onClick={() => void authorizeContextSource(request.id, undefined, "SOURCE_UNAVAILABLE")}>{text("Required source unavailable", "السورس المطلوب غير متاح")}</button>
                      </div>
                    </div>}
                    {(request.authorizationDecision || request.resolutionState === "SOURCE_UNAVAILABLE") && <p className={styles.muted}>{text("Governed resolution", "الحل المحكوم")}: {request.resolutionState === "SOURCE_UNAVAILABLE" ? "REQUIRED_SOURCE_UNAVAILABLE" : request.authorizationDecision}</p>}
                  </section>;
                })}
              </div>
              <p className={styles.muted}>{text("After an approved Workspace is bound to the Task, continue Context so the Canonical Indexer acquires it and the Internal AI re-analyzes the complete new Assembly Revision.", "بعد ربط Workspace معتمدة بالمهمة، استكمل السياق ليقرأها Canonical Indexer ويعيد الـInternal AI تحليل Assembly Revision الجديدة كاملة.")}</p>
              <button type="button" className={styles.primaryButton} disabled={action.kind === "WORKING"} onClick={() => void analyzeTaskContext()}>{text("Continue governed analysis", "استكمال التحليل المحكوم")}</button>
            </div>}

            {projection.phaseStatus === "CONTEXT_SOURCE_TRUTH_CONFLICT" && <div className={styles.focusBlock}>
              <h3>{text("Resolve Source Truth conflict", "حل تعارض حقيقة السورس")}</h3>
              <p>{text(
                "A validated Mapping Iteration found a material, evidence-grounded contradiction that is not explained by an unresolved evidence gap. IntentChord cannot override contradictory source truth. Correct or expand the governed source externally, create fresh Canonical Index evidence, then run complete Context analysis again.",
                "وجدت Mapping Iteration متحققًا منها تعارضًا جوهريًا ومثبتًا بالأدلة لا تفسره فجوة دليل غير محسومة. لا يستطيع IntentChord تجاوز حقيقة سورس متعارضة. صحح أو وسّع السورس المحكوم خارجيًا، أنشئ دليل Canonical Index جديدًا، ثم أعد تحليل السياق الكامل.",
              )}</p>
              <div className={styles.componentScroll}>
                {projection.contextResolutionSummary.resolutionRequirements.filter(requirement => requirement.type === "SOURCE_TRUTH_CONFLICT").map(requirement => <section key={requirement.id} className={styles.componentGroup}>
                  <div className={styles.groupHeader}><strong>SOURCE_TRUTH_CONFLICT</strong><small dir="ltr">{requirement.id}</small></div>
                  <p className={styles.muted}>{text("Resolution authority remains external source truth; this requirement is immutable provenance.", "سلطة الحل تظل في حقيقة السورس الخارجية؛ وهذا Requirement يظل Provenance غير قابل للمحو.")}</p>
                </section>)}
              </div>
            </div>}

            {projection.phaseStatus === "CURRENT_CONTEXT_REBUILD_REQUIRED" && <div className={styles.focusBlock}>
              <h3>{text("Rebuild Current Governed Context", "إعادة بناء السياق المحكوم الحالي")}</h3>
              <p>{text(
                projection.primaryAction.labelEn.includes("Correction")
                  ? "The Owner correction obligation remains preserved, but its previous Context authority is stale or consumed. Acquire fresh governed Workspace observations, rebuild/close current Context, then continue the correction under a newly confirmed current Scope/Contract."
                  : "The visible Catalog/Requirement is historical provenance because current governed source authority has drifted or is unproven. Acquire fresh Workspace observations and rebuild the current Context before creating new forward authority.",
                projection.primaryAction.labelEn.includes("Correction")
                  ? "يظل التزام التصحيح الذي طلبه المالك محفوظًا، لكن سلطة السياق السابقة أصبحت قديمة أو مستهلكة. احصل على Observations محكومة جديدة، أعد بناء وإغلاق السياق الحالي، ثم استكمل التصحيح تحت Scope/Contract حالية ومؤكدة من جديد."
                  : "الـCatalog/Requirement الظاهرة أصبحت Provenance تاريخية لأن سلطة السورس المحكومة الحالية تغيرت أو لم تعد مثبتة. احصل على Workspace Observations جديدة وأعد بناء السياق الحالي قبل إنشاء أي سلطة أمامية جديدة.",
              )}</p>
              <button type="button" className={styles.primaryButton} disabled={projection.primaryAction.availability !== "ENABLED" || action.kind === "WORKING"} onClick={() => void analyzeTaskContext()}>{projection.primaryAction.labelAr}</button>
            </div>}

            {projection.phaseStatus === "COMPONENTS_READY_FOR_WORK_SELECTION" && <div className={styles.focusBlock}>
              <h3>{text("Choose the actual Work", "اختر العمل الفعلي")}</h3>
              <p>{text("This is the complete evidence-backed Component Catalog published only after deterministic Context Closure. Select one or more logical Components; the backend derives exact cross-workspace Candidate Scope from accepted Catalog provenance.", "هذا هو Component Catalog الكامل المرتبط بالدليل، ولا يُنشر إلا بعد Context Closure حاكم. اختر Component واحدة أو أكثر؛ وسيشتق الـBackend Candidate Scope الدقيق عبر مساحات العمل من Provenance الـCatalog المقبول.")}</p>
              <div className={styles.componentScroll}>
                {componentGroups.map(([catalogId, components]) => <section key={catalogId} className={styles.componentGroup}>
                  <div className={styles.groupHeader}><strong>{text("Closed Component Catalog", "Component Catalog مغلق")}</strong><small dir="ltr">Catalog {catalogId}</small></div>
                  {components.map(component => <label key={`${catalogId}:${component.componentId}`} className={`${styles.componentCard} ${selectedComponentIds.includes(component.componentId) ? styles.componentSelected : ""}`}>
                    <input type="checkbox" checked={selectedComponentIds.includes(component.componentId)} onChange={() => toggleComponent(component)} />
                    <span><strong>{component.name}</strong><p>{component.responsibilitySummary}</p><small>{component.fileCount} {text("relevant files", "ملفات ذات صلة")}</small></span>
                  </label>)}
                </section>)}
              </div>
              <button type="button" className={styles.primaryButton} disabled={!selectedComponentIds.length || action.kind === "WORKING"} onClick={() => void commitWorkSelection()}>{text("Commit Work & Derive Scope", "تثبيت العمل واشتقاق النطاق")}</button>
            </div>}

            {["STALE_WORK_INTENT_CURRENT_CONTEXT_ADVANCED", "SOURCE_DRIFT_REBASE_REQUIRED"].includes(projection.phaseStatus) && <div className={styles.focusBlock}>
              <h3>{text("Current Context authority advanced", "تقدمت سلطة السياق الحالية")}</h3>
              <p>{projection.phaseStatus === "SOURCE_DRIFT_REBASE_REQUIRED"
                ? text("The confirmed Scope remains immutable historical authority, but it cannot create new execution authority because current governed Context/Source truth no longer matches it. Rebuild the current Context, review the current Catalog, then create a new Work Selection, Candidate Scope, and Scope Confirmation.", "يبقى النطاق المؤكد سلطة تاريخية مجمدة وغير قابلة لإعادة الكتابة، لكنه لا يستطيع إنشاء سلطة تنفيذ جديدة لأن حقيقة السياق/السورس الحالية لم تعد تطابقه. أعد بناء السياق الحالي، راجع الـCatalog الحالي، ثم أنشئ Work Selection وCandidate Scope وScope Confirmation جديدة.")
                : text("The previous Work Selection remains historical Owner intent only. The Context Head advanced before Scope Confirmation, so the old Candidate Scope cannot be confirmed. Review the current Catalog and select Work again.", "يبقى اختيار العمل السابق نية مالك تاريخية فقط. تقدم Context Head قبل Scope Confirmation، لذلك لا يمكن تأكيد Candidate Scope القديمة. راجع الـCatalog الحالية واختر العمل من جديد.")}</p>
              <div className={styles.groupHeader}><strong>{text("Frozen authority", "السلطة المجمدة")}</strong><small dir="ltr">{projection.contextAuthoritySummary.frozenContextAssemblyRevisionId ?? "—"}</small></div>
              <div className={styles.groupHeader}><strong>{text("Current Head", "Current Head")}</strong><small dir="ltr">{projection.contextAuthoritySummary.currentHeadRevisionId ?? "—"}</small></div>
              {projection.primaryAction.actionKey === "REBASE_CONTEXT_WORK_SELECTION" && componentGroups.length > 0 ? <>
                <div className={styles.componentScroll}>
                  {componentGroups.map(([catalogId, components]) => <section key={catalogId} className={styles.componentGroup}>
                    <div className={styles.groupHeader}><strong>{text("Current complete Catalog", "الـCatalog الحالية المكتملة")}</strong><small dir="ltr">Catalog {catalogId}</small></div>
                    {components.map(component => <label key={`${catalogId}:${component.componentId}`} className={`${styles.componentCard} ${selectedComponentIds.includes(component.componentId) ? styles.componentSelected : ""}`}>
                      <input type="checkbox" checked={selectedComponentIds.includes(component.componentId)} onChange={() => toggleComponent(component)} />
                      <span><strong>{component.name}</strong><p>{component.responsibilitySummary}</p><small>{component.fileCount} {text("relevant files", "ملفات ذات صلة")}</small></span>
                    </label>)}
                  </section>)}
                </div>
                <button type="button" className={styles.primaryButton} disabled={!selectedComponentIds.length || action.kind === "WORKING"} onClick={() => void commitWorkSelection()}>{text("Rebase Work on Current Context", "إعادة تثبيت العمل على السياق الحالي")}</button>
              </> : <button type="button" className={styles.primaryButton} disabled={action.kind === "WORKING"} onClick={() => void analyzeTaskContext()}>{text("Rebuild Current Context", "إعادة بناء السياق الحالي")}</button>}
            </div>}

            {projection.phaseStatus === "SCOPE_DERIVED_AWAITING_CONFIRMATION" && <div className={styles.focusBlock}>
              <h3>{text("Confirm governed Scope", "تأكيد النطاق المحكوم")}</h3>
              <p>{text("Candidate Scope below is backend-derived from the exact accepted closed Component Catalog provenance. Confirmation cannot expand beyond this candidate boundary.", "Candidate Scope أدناه مشتق من الـBackend من Provenance الـComponent Catalog المغلق والمقبول بدقة. التأكيد لا يمكنه التوسع خارج هذا الحد المرشح.")}</p>
              <div className={styles.pathList}>{projection.candidateScopeSummary.allowedPaths.map(path => <div key={`${path.workspaceId}:${path.path}`}><strong>{path.workspaceDisplayName}</strong><code dir="ltr">{path.path}</code></div>)}</div>
              <div className={styles.authorityGrid}>{projection.effectiveAuthoritySummary.capabilities.map(item => <div key={item.capability} data-effective={item.isEffective}><strong>{item.capability}</strong><span>{item.isEffective ? text("Effective", "فعّالة") : text("Blocked by policy", "محجوبة بالسياسة")}</span><small>{item.governingPolicyReason}</small></div>)}</div>
              <button type="button" className={styles.primaryButton} disabled={!projection.candidateScopeSummary.identity || action.kind === "WORKING"} onClick={() => void confirmScope()}>{text("Confirm Scope", "تأكيد النطاق")}</button>
            </div>}

            {projection.phaseStatus === "SCOPE_CONFIRMED_AWAITING_PLATFORM" && <div className={styles.focusBlock}>
              <h3>{text("Choose execution platform", "اختر منصة التنفيذ")}</h3>
              <p>{text("This is the Owner's late execution choice. IntentChord resolves the exact provider, model, reasoning, and runtime profile on the backend after this selection.", "هذا هو اختيار التنفيذ المتأخر للمالك. بعد اختيار المنصة، يحل IntentChord تلقائيًا في الـBackend المزوّد والموديل ومستوى reasoning وruntime profile بدقة.")}</p>
              <div className={styles.platformGrid}>{projection.executionOptions.availablePlatforms.map(platform => <button key={platform.executionChannelId} type="button" className={styles.platformCard} onClick={() => void selectExecutionPlatform(platform.executionChannelId)} disabled={action.kind === "WORKING"}>
                <strong>{platform.displayName}</strong><span>{text("Execution platform", "منصة التنفيذ")}</span>
              </button>)}</div>
            </div>}

            {projection.phaseStatus === "PLATFORM_SELECTED_CONFIGURATION_RESOLVED_AWAITING_CONTRACT" && <div className={styles.focusBlock}>
              <h3>{text("Execution configuration resolved", "تم حل إعداد التنفيذ")}</h3>
              <p>{text("The backend has frozen the late-resolved execution configuration. Review the governed Contract before granting execution authority.", "ثبت الـBackend إعداد التنفيذ المحلول بعد اكتمال السياق. راجع العقد المحكوم قبل منح سلطة التنفيذ.")}</p>
              <ResolvedExecution setup={projection.executionSetupSummary} />
              <Link className={styles.primaryLink} href="/contracts/current">{text("Open Governed Contract", "فتح العقد المحكوم")}</Link>
            </div>}

            {projection.contractSummary.contractId && !["PLATFORM_SELECTED_CONFIGURATION_RESOLVED_AWAITING_CONTRACT"].includes(projection.phaseStatus) && <div className={styles.focusBlock}>
              <h3>{text("Governed Contract is ready", "العقد المحكوم جاهز")}</h3>
              <ResolvedExecution setup={projection.executionSetupSummary} />
              <p>{text("Execution authority is still controlled by Contract review and Owner approval.", "سلطة التنفيذ ما زالت محكومة بمراجعة العقد واعتماد المالك.")}</p>
              <Link className={styles.primaryLink} href="/contracts/current">{text("Review Contract", "مراجعة العقد")}</Link>
            </div>}
          </article>

          <aside className={styles.panel}>
            <div className={styles.sectionHeading}><div><span className={styles.kicker}>GOVERNANCE</span><h2>{text("Task truth", "حقيقة المهمة")}</h2></div></div>
            <dl className={styles.truthGrid}>
              <dt>Task ID</dt><dd dir="ltr">{projection.taskSummary.id}</dd>
              <dt>{text("Revision", "Revision")}</dt><dd>{projection.taskSummary.revision}</dd>
              <dt>{text("Components", "Components")}</dt><dd>{projection.discoveredWorkSummary.components.length}</dd>
              <dt>{text("Candidate boundaries", "حدود Candidate")}</dt><dd>{projection.candidateScopeSummary.boundaryCount}</dd>
              <dt>{text("Execution setup", "إعداد التنفيذ")}</dt><dd>{projection.executionSetupSummary.isConfigured ? text("Backend resolved", "محلول من الـBackend") : text("Not resolved", "لم يُحل بعد")}</dd>
            </dl>
            {projection.scopeConfirmationSummary.isConfirmed && <div className={styles.miniSection}><strong>{text("Confirmed Scope", "النطاق المؤكد")}</strong><div className={styles.miniScroll}>{projection.scopeConfirmationSummary.confirmedAllowedPaths.map(path => <code key={`${path.workspaceId}:${path.path}`} dir="ltr">{path.path}</code>)}</div></div>}
            <div className={styles.miniSection}><strong>{text("No hidden model choice", "لا يوجد اختيار موديل مخفي")}</strong><p>{text("The normal Owner path selects only the execution platform after Scope. Exact model/reasoning is projected only after backend resolution.", "المسار الطبيعي للمالك يختار منصة التنفيذ فقط بعد النطاق. الموديل وreasoning يظهران فقط بعد حلّهما من الـBackend.")}</p></div>
          </aside>
        </section>
      </> : <div className={styles.emptyState}>{text("Loading authoritative Task projection…", "جارٍ تحميل Projection الحاكمة للمهمة…")}</div>}
    </div>
  </ProductShell>;
}

function ResolvedExecution({ setup }: { setup: TaskExperienceProjectionV1["executionSetupSummary"] }) {
  if (!setup.isConfigured) return null;
  return <dl className={styles.resolvedGrid}>
    <dt>Platform</dt><dd>{setup.executionChannelId}</dd>
    <dt>Provider</dt><dd>{setup.providerId}</dd>
    <dt>Model</dt><dd dir="ltr">{setup.modelId}</dd>
    <dt>Reasoning</dt><dd>{setup.reasoningProfile}</dd>
    <dt>Runtime</dt><dd>{setup.runtimeProfileId}</dd>
  </dl>;
}
