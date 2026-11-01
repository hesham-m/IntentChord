"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectContextView } from "@/core/truth/project-context-schema";
import type { CustomerMappingAttemptView, CustomerMappingRunView } from "@/core/ai-context-mapper/types";
import type { Locale } from "@/i18n/types";
import { ownerErrorMessage, type ErrorPayload } from "@/lib/owner-errors";
import { ProductShell } from "@/components/product-shell";
import { useProductPreferences } from "@/components/product-preferences-provider";
import styles from "./workspace-analysis-workbench.module.css";

type ActionState = { kind: "idle" | "working" | "success" | "error"; message?: string };
type WorkspaceOption = {
  id: string;
  revision: number;
  displayName: string;
  role: string;
  normalizedReference: string;
  verificationStatus: string;
  verificationMethod: string;
  source: string;
  fingerprint: string;
};
type WorkspaceIndexSnapshotView = {
  id: string;
  sourceMode: "REGISTERED_WORKSPACE" | "ADVANCED_DIAGNOSTIC";
  status: "CREATING" | "READY" | "FAILED";
  workspaceRegistrationId?: string;
  projectContextId?: string;
  canonicalContractVersion?: string;
  canonicalSha256?: string;
  workspaceObservationId?: string;
  workspaceRevisionId?: string;
  canonicalIndexArtifactId?: string;
  indexConfigurationSha256?: string;
  observationResult?: "FIRST_INDEXED" | "SOURCE_UNCHANGED" | "SOURCE_CHANGED" | "KNOWN_STATE_RESTORED" | "SOURCE_UNCHANGED_INDEX_REFRESHED" | "SOURCE_PROVEN_INDEX_FAILED";
  deltaArtifactId?: string;
  indexAttemptStatus?: "IN_PROGRESS" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED";
  indexAttemptEvidence?: Record<string, unknown>;
  failureCode?: string;
  startedAt: string;
  completedAt?: string;
  progressPhase?: string;
};
type ContextDecision = "ACCEPT" | "REJECT";

type WorkspaceKnowledgeHistoryView = {
  workspaceRegistrationId: string;
  revisions: Array<{ workspaceRevisionId: string; sourceTreeFingerprint: string; firstObservedAt: string; observationCount: number }>;
  observations: Array<{ id: string; snapshotOperationId: string; workspaceRevisionId: string; canonicalIndexArtifactId?: string; observationResult: NonNullable<WorkspaceIndexSnapshotView["observationResult"]>; indexConfigurationSha256: string; sourceBinding: Record<string, unknown>; observedAt: string; deltaArtifactId?: string }>;
  transitions: Array<{ id: string; observationId: string; fromWorkspaceRevisionId: string; toWorkspaceRevisionId: string; deltaArtifactId?: string; observedAt: string }>;
};

async function ownerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response = await fetch(input, init);
  if (response.status !== 401 && response.status !== 403) return response;
  const failure = await response.clone().json().catch(() => ({})) as ErrorPayload;
  if (!["OWNER_SESSION_REQUIRED", "OWNER_SESSION_INVALID"].includes(failure.code ?? "")) return response;
  if (typeof window !== "undefined") {
    window.location.href = "/login";
  }
  return response;
}

async function readResponse<T>(response: Response, locale: Locale): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ErrorPayload;
  if (!response.ok) throw new Error(ownerErrorMessage(body, locale));
  return body;
}

export function WorkspaceAnalysisWorkbench({ initialStage = 1 }: { initialStage?: 1 | 2 | 3 | 4 } = {}) {
  const { locale, setLocale, theme, setTheme } = useProductPreferences();
  const [stage, setStage] = useState<1 | 2 | 3 | 4>(initialStage);
  const [mode, setMode] = useState<"INDEPENDENT" | "PROJECT_BOUND">("INDEPENDENT");
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceOption[]>([]);
  const [projectOptions, setProjectOptions] = useState<ProjectContextView[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [changeWorkspaceOpen, setChangeWorkspaceOpen] = useState(false);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerNotice, setPickerNotice] = useState<string>();
  const [mappingIndexJson, setMappingIndexJson] = useState("");
  const [indexSnapshot, setIndexSnapshot] = useState<WorkspaceIndexSnapshotView>();
  const [snapshotIdempotencyKey, setSnapshotIdempotencyKey] = useState("");
  const [mappingIdempotencyKey, setMappingIdempotencyKey] = useState("");
  const [mappingRun, setMappingRun] = useState<CustomerMappingRunView>();
  const [mappingAttempts, setMappingAttempts] = useState<CustomerMappingAttemptView[]>([]);
  const [mappingVerdictNote, setMappingVerdictNote] = useState("");
  const [contextDecisions, setContextDecisions] = useState<Record<string, ContextDecision>>({});
  const [inventoryPreflight, setInventoryPreflight] = useState<{ discoveredFiles: number; discoveredBytes: number; excludedTrees: Array<{ relative_path: string; exclusion_reason: string }> }>();
  const [workspaceHistory, setWorkspaceHistory] = useState<WorkspaceKnowledgeHistoryView>();

  const text = useCallback((en: string, ar: string) => locale === "ar" ? ar : en, [locale]);
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find(item => item.id === selectedWorkspaceId),
    [workspaceOptions, selectedWorkspaceId],
  );
  const selectedProject = useMemo(
    () => projectOptions.find(item => item.id === selectedProjectId),
    [projectOptions, selectedProjectId],
  );

  function resetPipeline(): void {
    setIndexSnapshot(undefined);
    setSnapshotIdempotencyKey("");
    setMappingIdempotencyKey("");
    setMappingRun(undefined);
    setMappingAttempts([]);
    setContextDecisions({});
    setMappingVerdictNote("");
    setInventoryPreflight(undefined);
    setWorkspaceHistory(undefined);
  }

  const refreshData = useCallback(async () => {
    setAction({ kind: "working", message: text("Loading workspace options…", "جارٍ تحميل خيارات مساحة العمل…") });
    try {
      const [workspaceRows, projectRows] = await Promise.all([
        readResponse<WorkspaceOption[]>(await ownerFetch("/api/workspaces", { cache: "no-store" }), locale),
        readResponse<ProjectContextView[]>(await ownerFetch("/api/project-contexts", { cache: "no-store" }), locale),
      ]);
      setWorkspaceOptions(workspaceRows);
      setProjectOptions(projectRows);
      if (workspaceRows.length > 0 && !selectedWorkspaceId) setSelectedWorkspaceId(workspaceRows[0].id);
      setAction({ kind: "idle" });
    } catch (error) {
      setAction({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [locale, selectedWorkspaceId, text]);

  useEffect(() => {
    void refreshData();
    if (typeof window !== "undefined") {
      const paramProject = new URLSearchParams(window.location.search).get("project");
      if (paramProject) {
        setSelectedProjectId(paramProject);
        setMode("PROJECT_BOUND");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshWorkspaceHistory = useCallback(async (workspaceRegistrationId: string) => {
    const history = await readResponse<WorkspaceKnowledgeHistoryView>(
      await ownerFetch(`/api/workspace-index-snapshots?workspaceRegistrationId=${encodeURIComponent(workspaceRegistrationId)}`, { cache: "no-store" }),
      locale,
    );
    setWorkspaceHistory(history);
    return history;
  }, [locale]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setWorkspaceHistory(undefined);
      return;
    }
    void refreshWorkspaceHistory(selectedWorkspaceId).catch(() => setWorkspaceHistory(undefined));
  }, [refreshWorkspaceHistory, selectedWorkspaceId]);

  async function refreshMapping(runId: string) {
    const [run, attempts] = await Promise.all([
      readResponse<CustomerMappingRunView>(await ownerFetch(`/api/ai-context-mappings/${runId}`, { cache: "no-store" }), locale),
      readResponse<CustomerMappingAttemptView[]>(await ownerFetch(`/api/ai-context-mappings/${runId}/attempts`, { cache: "no-store" }), locale),
    ]);
    setMappingRun(run);
    setMappingAttempts(attempts);
    if (run.ownerContextDecisions.length) {
      setContextDecisions(Object.fromEntries(run.ownerContextDecisions.map(item => [item.contextId, item.decision])));
    }
    return run;
  }

  async function executeAction(message: string, command: () => Promise<void>) {
    setAction({ kind: "working", message });
    try {
      await command();
      setAction({ kind: "success", message: text("Operation completed successfully.", "اكتملت العملية بنجاح.") });
    } catch (error) {
      setAction({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function triggerNativePicker() {
    setPickerBusy(true);
    setPickerNotice(undefined);
    try {
      const response = await ownerFetch("/api/workspaces/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: `Workspace ${workspaceOptions.length + 1}`,
          role: "primary",
          authorizationContext: "owner-selected workspace",
          taskMode: "SOURCE_IMPLEMENTATION",
        }),
      });
      const result = await response.json() as { workspace?: WorkspaceOption; error?: string };
      if (!response.ok || !result.workspace) {
        setPickerNotice(result.error ?? text("Workspace picker cancelled or failed.", "أُلغي اختيار مساحة العمل أو تعذر إكماله."));
        return;
      }
      await refreshData();
      resetPipeline();
      setSelectedWorkspaceId(result.workspace.id);
      setChangeWorkspaceOpen(false);
      setPickerNotice(text(`Workspace selected: ${result.workspace.displayName}`, `تمت إضافة مساحة العمل: ${result.workspace.displayName}`));
    } catch (error) {
      setPickerNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setPickerBusy(false);
    }
  }


  async function runInventoryPreflight() {
    if (!selectedWorkspaceId) return;
    await executeAction(text("Running bounded inventory preflight…", "جارٍ تشغيل فحص النطاق المحدود…"), async () => {
      const result = await readResponse<{ discoveredFiles: number; discoveredBytes: number; excludedTrees: Array<{ relative_path: string; exclusion_reason: string }> }>(await ownerFetch("/api/workspace-index-snapshots/preflight", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRegistrationId: selectedWorkspaceId }),
      }), locale);
      setInventoryPreflight(result);
    });
  }

  async function createRegisteredSnapshot() {
    if (!selectedWorkspaceId) return;
    await executeAction(text("Generating and persisting the Canonical Workspace Index…", "جارٍ إنشاء وحفظ Canonical Workspace Index…"), async () => {
      const idempotencyKey = snapshotIdempotencyKey || crypto.randomUUID();
      if (!snapshotIdempotencyKey) setSnapshotIdempotencyKey(idempotencyKey);
      const snapshot = await readResponse<WorkspaceIndexSnapshotView>(await ownerFetch("/api/workspace-index-snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceMode: "REGISTERED_WORKSPACE",
          workspaceRegistrationId: selectedWorkspaceId,
          ...(selectedProjectId ? { projectContextId: selectedProjectId } : {}),
          idempotencyKey,
        }),
      }), locale);
      setIndexSnapshot(snapshot);
      await refreshWorkspaceHistory(selectedWorkspaceId);
      setMappingRun(undefined);
      setMappingAttempts([]);
      setMappingIdempotencyKey("");
      setContextDecisions({});
      if (snapshot.status === "FAILED") setSnapshotIdempotencyKey("");
      if (snapshot.status === "READY") setStage(3);
    });
  }

  async function createDiagnosticSnapshot() {
    await executeAction(text("Validating and persisting the diagnostic Canonical Snapshot…", "جارٍ التحقق من الـCanonical Snapshot التشخيصية وحفظها…"), async () => {
      let workspaceIndex: unknown;
      try { workspaceIndex = JSON.parse(mappingIndexJson) as unknown; }
      catch { throw new Error(text("The Canonical Workspace Index JSON is invalid.", "JSON الخاص بـCanonical Workspace Index غير صالح.")); }
      const idempotencyKey = snapshotIdempotencyKey || crypto.randomUUID();
      if (!snapshotIdempotencyKey) setSnapshotIdempotencyKey(idempotencyKey);
      const snapshot = await readResponse<WorkspaceIndexSnapshotView>(await ownerFetch("/api/workspace-index-snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceMode: "ADVANCED_DIAGNOSTIC",
          workspaceIndex,
          ...(selectedProjectId ? { projectContextId: selectedProjectId } : {}),
          idempotencyKey,
        }),
      }), locale);
      setIndexSnapshot(snapshot);
      setMappingRun(undefined);
      setMappingAttempts([]);
      setMappingIdempotencyKey("");
      setContextDecisions({});
      if (snapshot.status === "FAILED") setSnapshotIdempotencyKey("");
      if (snapshot.status === "READY") setStage(3);
    });
  }

  async function startMapping() {
    if (!indexSnapshot || indexSnapshot.status !== "READY") return;
    await executeAction(text("Running governed AI Context mapping…", "جارٍ تشغيل تعيين السياقات المحكوم…"), async () => {
      const idempotencyKey = mappingIdempotencyKey || crypto.randomUUID();
      if (!mappingIdempotencyKey) setMappingIdempotencyKey(idempotencyKey);
      const run = await readResponse<CustomerMappingRunView>(await ownerFetch("/api/ai-context-mappings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceIndexSnapshotId: indexSnapshot.id, idempotencyKey }),
      }), locale);
      const refreshed = await refreshMapping(run.id);
      if (["PRIMARY_FAILED_TECHNICAL", "STANDBY_BLOCKED_GOVERNANCE", "REJECTED_VALIDATION", "FAILED"].includes(refreshed.status)) {
        setMappingIdempotencyKey("");
      }
      if (refreshed.proposal) setStage(4);
    });
  }

  async function submitOwnerReview(verdict: "ACCEPT" | "REJECT", rejectEntireProposal = false) {
    if (!mappingRun?.proposal) return;
    await executeAction(text("Recording the complete Owner review…", "جارٍ تسجيل مراجعة المالك الكاملة…"), async () => {
      let body: {
        verdict: "ACCEPT" | "REJECT";
        contextDecisions?: Array<{ contextId: string; decision: ContextDecision }>;
        rejectEntireProposal?: true;
        note?: string;
      };
      if (rejectEntireProposal) {
        body = {
          verdict: "REJECT",
          rejectEntireProposal: true,
          ...(mappingVerdictNote.trim() ? { note: mappingVerdictNote.trim() } : {}),
        };
      } else {
        const decisions = mappingRun.proposal!.modelProposal.contexts.map(context => ({
          contextId: context.context_id,
          decision: contextDecisions[context.context_id],
        }));
        if (decisions.some(item => !item.decision)) throw new Error(text("Decide ACCEPT or REJECT for every proposed Context.", "حدد قبول أو رفض لكل سياق مقترح."));
        if (verdict === "ACCEPT" && !decisions.some(item => item.decision === "ACCEPT")) {
          throw new Error(text("Accept at least one Context before accepting the reviewed subset.", "اعتمد سياقاً واحداً على الأقل قبل اعتماد المجموعة المختارة."));
        }
        body = {
          verdict,
          contextDecisions: decisions,
          ...(mappingVerdictNote.trim() ? { note: mappingVerdictNote.trim() } : {}),
        };
      }
      const run = await readResponse<CustomerMappingRunView>(await ownerFetch(`/api/ai-context-mappings/${mappingRun.id}/owner-verdict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }), locale);
      setMappingRun(run);
      setMappingVerdictNote("");
      await refreshMapping(run.id);
    });
  }

  async function loadMappingFile(file: File | undefined) {
    if (!file) return;
    resetPipeline();
    setMappingIndexJson(await file.text());
  }

  const hasIndexJson = mappingIndexJson.trim().length > 0;
  const snapshotReady = indexSnapshot?.status === "READY";
  const proposalContexts = mappingRun?.proposal?.modelProposal.contexts ?? [];
  const allContextsDecided = proposalContexts.length > 0 && proposalContexts.every(context => Boolean(contextDecisions[context.context_id]));
  const acceptedContextCount = proposalContexts.filter(context => contextDecisions[context.context_id] === "ACCEPT").length;
  const latestObservation = workspaceHistory?.observations.length
    ? workspaceHistory.observations[workspaceHistory.observations.length - 1]
    : undefined;
  const currentRevisionId = indexSnapshot?.workspaceRevisionId ?? latestObservation?.workspaceRevisionId;
  const currentArtifactId = indexSnapshot?.canonicalIndexArtifactId ?? latestObservation?.canonicalIndexArtifactId;
  const currentObservationResult = indexSnapshot?.observationResult ?? latestObservation?.observationResult;
  const currentIndexConfigurationSha256 = indexSnapshot?.indexConfigurationSha256 ?? latestObservation?.indexConfigurationSha256;
  const lastCheckedAt = indexSnapshot?.completedAt ?? latestObservation?.observedAt;
  const ownerReviewRequired = mappingRun?.status === "AWAITING_OWNER_REVIEW" && Boolean(mappingRun.proposal);
  const stageAvailable: Record<1 | 2 | 3 | 4, boolean> = {
    1: true,
    2: Boolean(selectedWorkspaceId),
    3: snapshotReady,
    4: Boolean(mappingRun?.proposal),
  };

  function observationResultLabel(value: WorkspaceIndexSnapshotView["observationResult"] | undefined): string {
    if (!value) return text("Not checked", "لم يتم الفحص");
    const labels: Record<NonNullable<WorkspaceIndexSnapshotView["observationResult"]>, [string, string]> = {
      FIRST_INDEXED: ["First indexed source state", "أول حالة مصدر مفهرسة"],
      SOURCE_UNCHANGED: ["Source unchanged", "المصدر لم يتغير"],
      SOURCE_CHANGED: ["Source changed", "المصدر تغير"],
      KNOWN_STATE_RESTORED: ["Known source state restored", "تمت استعادة حالة مصدر معروفة"],
      SOURCE_UNCHANGED_INDEX_REFRESHED: ["Source unchanged · index refreshed", "المصدر لم يتغير · تم تحديث الفهرس"],
      SOURCE_PROVEN_INDEX_FAILED: ["Source proven · semantic indexing failed", "تم إثبات المصدر · فشلت الفهرسة الدلالية"],
    };
    return text(...labels[value]);
  }

  return (
    <ProductShell
      locale={locale}
      stage="workspace-analysis"
      theme={theme}
      onLocaleChange={setLocale}
      onThemeChange={setTheme}
    >
      <div className={styles.page}>
        {action.kind !== "idle" && (
          <div className={`${styles.notice} ${action.kind === "error" ? styles.noticeError : action.kind === "success" ? styles.noticeSuccess : ""}`} role="status">
            {action.message}
          </div>
        )}

        <section className={styles.hero} aria-labelledby="workspace-analysis-title">
          <div className={styles.heroIdentity}>
            <p className={styles.eyebrow}>{text("IntentChord · Workspace Analysis", "IntentChord · تحليل مساحة عمل")}</p>
            <h1 id="workspace-analysis-title">{selectedWorkspace?.displayName ?? text("Workspace Analysis", "تحليل مساحة العمل")}</h1>
            <p>{selectedWorkspace
              ? text("Current governed Workspace and Source State. Backend evidence determines every available stage.", "مساحة العمل المحكومة وحالة المصدر الحالية. أدلة الـBackend هي التي تحدد المراحل المتاحة.")
              : text("Select a registered Workspace to establish the governed source state.", "اختر مساحة عمل مسجلة لإثبات حالة المصدر المحكومة.")}</p>
          </div>
          <div className={styles.heroFacts} aria-label={text("Current source state", "حالة المصدر الحالية")}>
            <div><span>{text("Workspace", "مساحة العمل")}</span><strong>{selectedWorkspace?.verificationStatus ?? text("Not selected", "لم تُحدد")}</strong></div>
            <div><span>{text("Source Revision", "نسخة المصدر")}</span><code className={styles.technicalId} dir="ltr">{currentRevisionId ?? "—"}</code></div>
            <div><span>{text("Canonical Artifact", "الأثر المعياري")}</span><code className={styles.technicalId} dir="ltr">{currentArtifactId ?? "—"}</code></div>
            <div><span>{text("Latest Observation", "أحدث ملاحظة")}</span><strong>{observationResultLabel(currentObservationResult)}</strong></div>
          </div>
          {ownerReviewRequired && (
            <div className={styles.ownerAttentionBanner} role="status">
              <strong>{text("Owner action required", "إجراء المالك مطلوب")}</strong>
              <span>{text("A validated proposal is waiting for your governed review.", "اقتراح متحقق ينتظر مراجعتك المحكومة.")}</span>
            </div>
          )}
        </section>

        <nav className={styles.stepper} aria-label={text("Governed analysis stages", "مراحل التحليل المحكومة")}>
          {([
            [1, text("Workspace Selection", "اختيار مساحة العمل"), selectedWorkspaceId ? text("Ready", "جاهزة") : text("Required", "مطلوبة")],
            [2, text("Index Generation", "إنشاء الفهرس"), snapshotReady ? text("Ready", "جاهزة") : text("Pending", "معلقة")],
            [3, text("Context Analysis", "تحليل السياقات"), mappingRun ? text("Available", "متاح") : text("Not started", "لم تبدأ")],
            [4, text("Human Review", "المراجعة البشرية"), mappingRun?.ownerVerdictState === "ACCEPTED" ? text("Accepted", "تم الاعتماد") : mappingRun?.ownerVerdictState === "REJECTED" ? text("Rejected", "مرفوض") : text("Awaiting", "بانتظار المراجعة")],
          ] as const).map(([targetStage, label, status]) => (
            <button
              key={targetStage}
              type="button"
              className={`${styles.stepTab} ${stage === targetStage ? styles.stepTabActive : ""} ${targetStage < stage && stageAvailable[targetStage] ? styles.stepTabComplete : ""}`}
              aria-current={stage === targetStage ? "step" : undefined}
              disabled={!stageAvailable[targetStage]}
              aria-disabled={!stageAvailable[targetStage]}
              onClick={() => stageAvailable[targetStage] && setStage(targetStage)}
            >
              <span className={styles.stepNumber}>{targetStage}</span>
              <span className={styles.stepMeta}><strong>{label}</strong><small>{status}</small></span>
            </button>
          ))}
        </nav>

        {/* STAGE 1: WORKSPACE SELECTION */}
        {stage === 1 && (
          <section className={`${styles.card} ${styles.stageSurface}`}>
            <header className={styles.cardHeader}>
              <div>
                <h2>{text("Stage 1: Workspace Selection", "المرحلة 1: اختيار مساحة العمل")}</h2>
                <p>{text("Choose the registered Workspace to analyze. Project association is explicitly optional.", "اختر مساحة العمل المسجلة للتحليل. الارتباط بمشروع اختياري بالكامل.")}</p>
              </div>
            </header>

            <div className={styles.modeGrid}>
              <label className={`${styles.modeOption} ${mode === "INDEPENDENT" ? styles.modeOptionSelected : ""}`}>
                <input
                  type="radio"
                  name="analysis-mode"
                  value="INDEPENDENT"
                  checked={mode === "INDEPENDENT"}
                  onChange={() => {
                    resetPipeline();
                    setMode("INDEPENDENT");
                    setSelectedProjectId("");
                  }}
                />
                <div className={styles.modeLabel}>
                  <strong>{text("Independent Workspace", "مساحة عمل مستقلة")}</strong>
                  <small>{text("Analyze a Workspace directly without linking to a Project.", "تحليل مساحة العمل مباشرة دون الحاجة لربطها بمشروع.")}</small>
                </div>
              </label>

              <label className={`${styles.modeOption} ${mode === "PROJECT_BOUND" ? styles.modeOptionSelected : ""}`}>
                <input
                  type="radio"
                  name="analysis-mode"
                  value="PROJECT_BOUND"
                  checked={mode === "PROJECT_BOUND"}
                  onChange={() => { resetPipeline(); setMode("PROJECT_BOUND"); }}
                />
                <div className={styles.modeLabel}>
                  <strong>{text("Workspace linked to a Project", "مساحة عمل مرتبطة بمشروع")} <span className={styles.optionalTag}>{text("(Optional)", "(اختياري)")}</span></strong>
                  <small>{text("Optionally associate the analysis with an existing saved Project.", "ربط التحليل اختيارياً بمشروع موجود لربط السياق المعتمد.")}</small>
                </div>
              </label>
            </div>

            {/* Single Compact Workspace Summary when selected */}
            {selectedWorkspace && !changeWorkspaceOpen ? (
              <div className={styles.diagnosticsSection}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong>{selectedWorkspace.displayName}</strong>
                    <span className={`${styles.statusBadge} ${styles.badgeSuccess}`} style={{ marginInlineStart: "0.75rem" }}>
                      {text("Ready", "جاهزة")}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() => setChangeWorkspaceOpen(true)}
                  >
                    {text("Change Workspace", "تغيير مساحة العمل")}
                  </button>
                </div>
                <div style={{ marginTop: "0.5rem" }}>
                  <code className={styles.technicalText}>{selectedWorkspace.normalizedReference}</code>
                </div>

                {/* Collapsed Technical Details using native details without open prop (Rule 2) */}
                <details className={styles.diagnosticsSection} style={{ marginTop: "0.75rem" }}>
                  <summary>{text("Technical Details", "التفاصيل الفنية")}</summary>
                  <dl className={styles.auditGrid} style={{ marginTop: "0.5rem" }}>
                    <dt>Workspace ID</dt><dd>{selectedWorkspace.id}</dd>
                    <dt>Fingerprint</dt><dd>{selectedWorkspace.fingerprint}</dd>
                    <dt>Verification Status</dt><dd>{selectedWorkspace.verificationStatus}</dd>
                    <dt>Verification Method</dt><dd>{selectedWorkspace.verificationMethod}</dd>
                  </dl>
                </details>
              </div>
            ) : (
              <div className={styles.formGrid}>
                <div className={`${styles.field} ${styles.full}`}>
                  <label htmlFor="workspace-select-field">{text("Select Registered Workspace", "اختر مساحة العمل المسجلة")}</label>
                  <select
                    id="workspace-select-field"
                    value={selectedWorkspaceId}
                    onChange={e => {
                      resetPipeline();
                      setSelectedWorkspaceId(e.target.value);
                      setChangeWorkspaceOpen(false);
                    }}
                  >
                    <option value="">{text("-- Select Workspace by name and path --", "-- اختر مساحة العمل بالاسم والمسار --")}</option>
                    {workspaceOptions.map(option => (
                      <option key={option.id} value={option.id}>
                        {option.displayName} · {option.normalizedReference}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={`${styles.field} ${styles.full}`}>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    disabled={pickerBusy}
                    onClick={() => void triggerNativePicker()}
                  >
                    {pickerBusy ? text("Opening Windows selector…", "جارٍ فتح منتقي Windows…") : text("＋ Register new Workspace with Windows selector", "＋ تسجيل مساحة عمل جديدة عبر منتقي Windows")}
                  </button>
                  {pickerNotice && <small className={styles.noticeError}>{pickerNotice}</small>}
                </div>
              </div>
            )}

            {mode === "PROJECT_BOUND" && (
              <div className={`${styles.field} ${styles.full}`}>
                <label htmlFor="project-select-field">
                  {text("Associated Project", "المشروع المرتبط")}
                  <span className={styles.optionalTag}>{text("(Optional)", "(اختياري)")}</span>
                </label>
                <select
                  id="project-select-field"
                  value={selectedProjectId}
                  onChange={e => { resetPipeline(); setSelectedProjectId(e.target.value); }}
                >
                  <option value="">{text("-- No project selected (Optional) --", "-- لا يوجد مشروع محدد (اختياري) --")}</option>
                  {projectOptions.map(project => (
                    <option key={project.id} value={project.id}>
                      {project.displayName} ({project.slug})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={!selectedWorkspaceId}
                onClick={() => setStage(2)}
              >
                {text("Continue to Index Generation ➔", "المتابعة لإنشاء الفهرس ➔")}
              </button>
            </div>
          </section>
        )}

        {/* STAGE 2: INDEX GENERATION */}
        {stage === 2 && (
          <section className={`${styles.card} ${styles.stageSurface}`}>
            <header className={styles.cardHeader}>
              <div>
                <h2>{text("Stage 2: Index Generation", "المرحلة 2: إنشاء الفهرس")}</h2>
                <p>{text("Generate and persist an immutable Canonical Workspace Index Snapshot using the registered Workspace authority.", "أنشئ واحفظ لقطة Canonical Workspace Index غير قابلة للتعديل باستخدام سلطة مساحة العمل المسجلة.")}</p>
              </div>
            </header>

            {!selectedWorkspace ? (
              <>
                <div className={styles.disabledNotice}>
                  <span aria-hidden="true">⚠️</span>
                  <div>
                    <strong>{text("Workspace Required", "مساحة العمل مطلوبة")}</strong>
                    <p>{text("Select a registered Workspace before creating the governed Snapshot.", "اختر مساحة عمل مسجلة قبل إنشاء اللقطة المحكومة.")}</p>
                  </div>
                </div>
                <div className={styles.formGrid}>
                  <div className={`${styles.field} ${styles.full}`}>
                    <button
                      type="button"
                      className={styles.btnPrimary}
                      disabled
                    >
                      {text("Generate Index from Registered Workspace", "إنشاء الفهرس من مساحة العمل المسجلة")}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className={styles.formGrid}>
                <div className={`${styles.field} ${styles.full}`}>
                  <button type="button" className={styles.btnSecondary} disabled={action.kind === "working"} onClick={() => void runInventoryPreflight()}>
                    {text("Run bounded inventory preflight", "تشغيل فحص النطاق المحدود")}
                  </button>
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    disabled={action.kind === "working"}
                    onClick={() => void createRegisteredSnapshot()}
                  >
                    {action.kind === "working" ? text("Generating Snapshot…", "جارٍ إنشاء اللقطة…") : text("Generate Index from Registered Workspace", "إنشاء الفهرس من مساحة العمل المسجلة")}
                  </button>
                </div>
              </div>
            )}

            {inventoryPreflight && (
              <div className={styles.diagnosticsSection}>
                <strong>{text("Inventory preflight", "فحص النطاق")}</strong>
                <dl className={styles.auditGrid}><dt>Discovered files</dt><dd>{inventoryPreflight.discoveredFiles}</dd><dt>Discovered bytes</dt><dd>{inventoryPreflight.discoveredBytes}</dd><dt>Excluded trees</dt><dd>{inventoryPreflight.excludedTrees.length}</dd></dl>
                <details><summary>{text("Excluded boundaries", "حدود الاستبعاد")}</summary><ul>{inventoryPreflight.excludedTrees.map(item => <li key={`${item.relative_path}:${item.exclusion_reason}`}><code>{item.relative_path}</code> — {item.exclusion_reason}</li>)}</ul></details>
              </div>
            )}

            {selectedWorkspace && (
              <section className={styles.sourceStateHero} aria-label={text("Current source state", "حالة المصدر الحالية")}>
                <div className={styles.sourceStateHeading}>
                  <div>
                    <span className={styles.sourceStateKicker}>{text("Current source state", "حالة المصدر الحالية")}</span>
                    <h3>{selectedWorkspace.displayName}</h3>
                    <code className={styles.technicalText}>{selectedWorkspace.normalizedReference}</code>
                  </div>
                  <span className={`${styles.statusBadge} ${currentRevisionId ? styles.badgeSuccess : ""}`}>
                    {currentRevisionId ? text("Indexed", "مفهرسة") : text("Not indexed", "غير مفهرسة")}
                  </span>
                </div>
                <div className={styles.sourceStateGrid}>
                  <div className={styles.sourceStateMetric}>
                    <span>{text("Source Revision", "نسخة المصدر")}</span>
                    <strong className={styles.technicalId} dir="ltr">{currentRevisionId ?? "—"}</strong>
                  </div>
                  <div className={styles.sourceStateMetric}>
                    <span>{text("Canonical Index Artifact", "أثر الفهرس الحاكم")}</span>
                    <strong className={styles.technicalId} dir="ltr">{currentArtifactId ?? "—"}</strong>
                  </div>
                  <div className={styles.sourceStateMetric}>
                    <span>{text("Latest Observation", "آخر ملاحظة")}</span>
                    <strong>{observationResultLabel(currentObservationResult)}</strong>
                  </div>
                  <div className={styles.sourceStateMetric}>
                    <span>{text("Last checked", "آخر فحص")}</span>
                    <strong>{lastCheckedAt ? new Date(lastCheckedAt).toLocaleString(locale === "ar" ? "ar-EG" : "en-US") : "—"}</strong>
                  </div>
                </div>

                {indexSnapshot?.status === "FAILED" && (
                  <div className={styles.disabledNotice}>
                    <strong>{indexSnapshot.observationResult === "SOURCE_PROVEN_INDEX_FAILED"
                      ? text("Source state proven; semantic indexing attempt failed", "تم إثبات حالة المصدر؛ فشلت محاولة الفهرسة الدلالية")
                      : text("Latest operation failed", "فشلت آخر عملية")}</strong>
                    <span className={styles.technicalId} dir="ltr">{indexSnapshot.failureCode ?? "WORKSPACE_INDEX_FAILED"}</span>
                  </div>
                )}

                <details className={styles.compactDetails}>
                  <summary>{text("Technical source and index details", "تفاصيل المصدر والفهرس الفنية")}</summary>
                  <dl className={styles.auditGrid}>
                    <dt>Snapshot ID</dt><dd className={styles.technicalId} dir="ltr">{indexSnapshot?.id ?? latestObservation?.snapshotOperationId ?? "—"}</dd>
                    <dt>Observation ID</dt><dd className={styles.technicalId} dir="ltr">{indexSnapshot?.workspaceObservationId ?? latestObservation?.id ?? "—"}</dd>
                    <dt>Index Configuration</dt><dd className={styles.technicalId} dir="ltr">{currentIndexConfigurationSha256 ?? "—"}</dd>
                    <dt>Canonical SHA256</dt><dd className={styles.technicalId} dir="ltr">{indexSnapshot?.canonicalSha256 ?? "—"}</dd>
                    <dt>Delta Artifact</dt><dd className={styles.technicalId} dir="ltr">{indexSnapshot?.deltaArtifactId ?? latestObservation?.deltaArtifactId ?? "—"}</dd>
                    <dt>Project Association</dt><dd>{selectedProject?.displayName ?? text("None", "لا يوجد")}</dd>
                  </dl>
                </details>
              </section>
            )}

            {workspaceHistory && workspaceHistory.observations.length > 0 && (
              <details className={styles.historyDisclosure}>
                <summary>{text("Source & Observation History", "سجل المصدر والملاحظات")} · {workspaceHistory.revisions.length} / {workspaceHistory.observations.length}</summary>
                <section className={styles.historyShell}>
                <div className={styles.historyColumn}>
                  <div className={styles.historyHeading}>
                    <div>
                      <span className={styles.sourceStateKicker}>{text("Source history", "سجل حالات المصدر")}</span>
                      <h3>{text("Unique immutable revisions", "نسخ مصدر فريدة وغير قابلة للتعديل")}</h3>
                    </div>
                    <span className={styles.countPill}>{workspaceHistory.revisions.length}</span>
                  </div>
                  <div className={styles.historyList}>
                    {workspaceHistory.revisions.map(revision => (
                      <article key={revision.workspaceRevisionId} className={`${styles.historyItem} ${revision.workspaceRevisionId === currentRevisionId ? styles.historyItemCurrent : ""}`}>
                        <code className={styles.technicalId} dir="ltr">{revision.workspaceRevisionId}</code>
                        <span>{text("Observed", "شوهدت")} {revision.observationCount}×</span>
                        <small>{new Date(revision.firstObservedAt).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}</small>
                      </article>
                    ))}
                  </div>
                </div>

                <div className={styles.historyColumn}>
                  <div className={styles.historyHeading}>
                    <div>
                      <span className={styles.sourceStateKicker}>{text("Observation history", "سجل الملاحظات")}</span>
                      <h3>{text("Checks over time", "الفحوصات عبر الزمن")}</h3>
                    </div>
                    <span className={styles.countPill}>{workspaceHistory.observations.length}</span>
                  </div>
                  <div className={styles.historyList}>
                    {[...workspaceHistory.observations].reverse().map(observation => (
                      <article key={observation.id} className={styles.observationItem}>
                        <div>
                          <strong>{observationResultLabel(observation.observationResult)}</strong>
                          <code className={styles.technicalId} dir="ltr">{observation.workspaceRevisionId}</code>
                        </div>
                        <small>{new Date(observation.observedAt).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}</small>
                      </article>
                    ))}
                  </div>
                  {workspaceHistory.transitions.length > 0 && (
                    <details className={styles.compactDetails}>
                      <summary>{text("Source transitions", "انتقالات حالات المصدر")}</summary>
                      <div className={styles.transitionList}>
                        {workspaceHistory.transitions.map(transition => (
                          <div key={transition.id} className={styles.transitionRow}>
                            <code className={styles.technicalId} dir="ltr">{transition.fromWorkspaceRevisionId}</code>
                            <span aria-hidden="true">→</span>
                            <code className={styles.technicalId} dir="ltr">{transition.toWorkspaceRevisionId}</code>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
                </section>
              </details>
            )}

            <div className={styles.actions}>
              <button type="button" className={styles.btnSecondary} onClick={() => setStage(1)}>
                {text("← Back to Workspace Selection", "← العودة لاختيار مساحة العمل")}
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={!snapshotReady}
                onClick={() => setStage(3)}
              >
                {text("Continue to Context Analysis ➔", "المتابعة لتحليل السياقات ➔")}
              </button>
            </div>
          </section>
        )}

        {/* STAGE 3: CONTEXT ANALYSIS */}
        {stage === 3 && (
          <section className={`${styles.card} ${styles.stageSurface}`}>
            <header className={styles.cardHeader}>
              <div>
                <h2>{text("Stage 3: Context Analysis", "المرحلة 3: تحليل السياقات")}</h2>
                <p>{text("IntentChord maps the persisted Canonical Snapshot through the governed AI Context Mapper. No model selector is exposed.", "يحلل IntentChord اللقطة المحفوظة عبر مُعيّن السياقات المحكوم دون إظهار أي اختيار للموديل.")}</p>
              </div>
            </header>

            {!snapshotReady ? (
              <div className={styles.disabledNotice}>
                <span aria-hidden="true">⚠️</span>
                <div>
                  <strong>{text("Persisted Snapshot Required", "اللقطة المحفوظة مطلوبة")}</strong>
                  <p>{text("Complete Stage 2 with a READY persisted Snapshot before starting Mapping.", "أكمل المرحلة الثانية بلقطة محفوظة بحالة READY قبل بدء التعيين.")}</p>
                </div>
              </div>
            ) : (
              <div className={styles.formGrid}>
                <div className={`${styles.field} ${styles.full}`}>
                  <p>{text("The persisted Snapshot is ready. Start the governed Mapping operation from its Snapshot ID.", "اللقطة المحفوظة جاهزة. ابدأ عملية التعيين المحكومة باستخدام معرف اللقطة.")}</p>
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    disabled={action.kind === "working"}
                    onClick={() => void startMapping()}
                  >
                    {action.kind === "working" ? text("Analyzing Contexts…", "جارٍ تحليل السياقات…") : text("Start Governed Mapping", "بدء التعيين المحكوم")}
                  </button>
                </div>
              </div>
            )}

            {mappingRun && (
              <div className={styles.diagnosticsSection}>
                <strong>{text("Mapping Run", "تشغيل التعيين")}</strong>
                <dl className={styles.auditGrid} style={{ marginTop: "0.5rem" }}>
                  <dt>Run ID</dt><dd>{mappingRun.id}</dd>
                  <dt>Snapshot ID</dt><dd>{mappingRun.workspaceIndexSnapshotId ?? "—"}</dd>
                  <dt>Status</dt><dd>{mappingRun.status}</dd>
                  <dt>Validation</dt><dd>{mappingRun.proposal?.validationEvidence.status ?? "NOT_AVAILABLE"}</dd>
                  <dt>Attempts</dt><dd>{mappingAttempts.length}</dd>
                </dl>
              </div>
            )}

            <div className={styles.actions}>
              <button type="button" className={styles.btnSecondary} onClick={() => setStage(2)}>
                {text("← Back to Index Generation", "← العودة لإنشاء الفهرس")}
              </button>
              {mappingRun?.proposal && (
                <button type="button" className={styles.btnPrimary} onClick={() => setStage(4)}>
                  {text("Continue to Human Review ➔", "المتابعة للمراجعة البشرية ➔")}
                </button>
              )}
            </div>
          </section>
        )}

        {/* STAGE 4: HUMAN REVIEW */}
        {stage === 4 && (
          <section className={`${styles.card} ${styles.stageSurface}`}>
            <header className={styles.cardHeader}>
              <div>
                <h2>{text("Stage 4: Human Review", "المرحلة 4: المراجعة البشرية")}</h2>
                <p>{text("Review only the deterministically validated Proposal, decide every Context, then record the run-level Owner verdict.", "راجع الاقتراح الذي اجتاز التحقق الحتمي فقط، وحدد قرار كل سياق، ثم سجّل قرار المالك على مستوى التشغيل.")}</p>
              </div>
            </header>

            {!mappingRun?.proposal ? (
              <div className={styles.emptyState}>
                <span style={{ fontSize: "2rem" }}>⏳</span>
                <strong>{text("Awaiting Validated Server Proposal", "في انتظار اقتراح سيرفر صالح")}</strong>
                <p>{text("Stage 4 never displays mock or invalid catalogs. Complete Stage 3 and wait for deterministic validation PASS.", "لا تعرض المرحلة الرابعة كتالوجات وهمية أو غير صالحة. أكمل المرحلة الثالثة وانتظر اجتياز التحقق الحتمي.")}</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                <div className={styles.diagnosticsSection}>
                  <strong>{text("Validated Proposal Provenance", "مصدر الاقتراح المتحقق")}</strong>
                  <dl className={styles.auditGrid} style={{ marginTop: "0.5rem" }}>
                    <dt>Proposal ID</dt><dd>{mappingRun.proposal.id}</dd>
                    <dt>Proposal SHA256</dt><dd>{mappingRun.proposal.proposalSha256}</dd>
                    <dt>Validation Status</dt><dd>{mappingRun.proposal.validationEvidence.status}</dd>
                    <dt>Attempt ID</dt><dd>{mappingRun.proposal.attemptId}</dd>
                  </dl>
                </div>

                <div className={styles.catalogGrid}>
                  <div className={styles.full}>
                    <strong>{text("Proposed Context Catalog", "كتالوج السياقات المقترح")}</strong>
                    <p>{mappingRun.proposal.modelProposal.catalog_summary}</p>
                  </div>

                  {mappingRun.proposal.modelProposal.contexts.map(ctx => (
                    <article className={styles.contextCard} key={ctx.context_id}>
                      <span className={`${styles.statusBadge} ${styles.badgeSuccess}`}>{ctx.context_kind} · {ctx.confidence}</span>
                      <h3>{ctx.display_name}</h3>
                      <p>{ctx.summary}</p>
                      <p><strong>{text("Responsibilities", "المسؤوليات")}:</strong> {ctx.responsibilities.join(" • ") || "—"}</p>
                      <p><strong>{text("Evidence", "الأدلة")}:</strong> {ctx.evidence_entry_ids.join(" • ") || "—"}</p>
                      <p><strong>{text("Interfaces", "الواجهات")}:</strong> {ctx.interfaces.join(" • ") || "—"}</p>
                      <p><strong>{text("Unknowns", "المجهولات")}:</strong> {ctx.unknowns.join(" • ") || "—"}</p>
                      <p><strong>{text("Rationale", "المبرر")}:</strong> {ctx.rationale}</p>
                      {mappingRun.status === "AWAITING_OWNER_REVIEW" && (
                        <div className={styles.actions}>
                          <button
                            type="button"
                            className={contextDecisions[ctx.context_id] === "ACCEPT" ? styles.btnPrimary : styles.btnSecondary}
                            onClick={() => setContextDecisions(current => ({ ...current, [ctx.context_id]: "ACCEPT" }))}
                          >
                            {text("Accept Context", "اعتماد السياق")}
                          </button>
                          <button
                            type="button"
                            className={contextDecisions[ctx.context_id] === "REJECT" ? styles.btnDanger : styles.btnSecondary}
                            onClick={() => setContextDecisions(current => ({ ...current, [ctx.context_id]: "REJECT" }))}
                          >
                            {text("Reject Context", "رفض السياق")}
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                <details className={styles.diagnosticsSection}>
                  <summary>{text("Relationships, Unknowns, Warnings, and Unmapped Entries", "العلاقات والمجهولات والتحذيرات والعناصر غير المعيّنة")}</summary>
                  <div className={styles.diagnosticsContent}>
                    <strong>{text("Relationships", "العلاقات")}</strong>
                    {mappingRun.proposal.modelProposal.relationships.length ? (
                      <ul>{mappingRun.proposal.modelProposal.relationships.map(item => <li key={item.relationship_id}>{item.from_context_id} → {item.to_context_id} · {item.relationship_type} · {item.confidence}</li>)}</ul>
                    ) : <p>—</p>}
                    <strong>{text("Global Unknowns", "المجهولات العامة")}</strong>
                    <ul>{mappingRun.proposal.modelProposal.global_unknowns.map(item => <li key={item}>{item}</li>)}</ul>
                    <strong>{text("Warnings", "التحذيرات")}</strong>
                    <ul>{mappingRun.proposal.modelProposal.warnings.map(item => <li key={item}>{item}</li>)}</ul>
                    <strong>{text("Unmapped Entries", "العناصر غير المعيّنة")}</strong>
                    <ul>{mappingRun.proposal.modelProposal.unmapped_entries.map(item => <li key={item.entry_id}>{item.entry_id} · {item.reason_code} · {item.explanation}</li>)}</ul>
                  </div>
                </details>

                {mappingRun.status === "AWAITING_OWNER_REVIEW" && (
                  <div className={styles.ownerReviewCallout} role="region" aria-label={text("Owner Review Required", "مراجعة المالك مطلوبة")}>
                    <h3>{text("Owner Review Required", "مراجعة المالك مطلوبة")}</h3>
                    <p>{text(`${Object.keys(contextDecisions).length} of ${proposalContexts.length} Context decisions recorded.`, `تم تسجيل ${Object.keys(contextDecisions).length} من ${proposalContexts.length} قرارات للسياقات.`)}</p>
                    <div className={styles.formGrid}>
                      <div className={`${styles.field} ${styles.full}`}>
                        <label htmlFor="owner-verdict-note">{text("Owner Note (optional)", "ملاحظة المالك (اختياري)")}</label>
                        <textarea id="owner-verdict-note" value={mappingVerdictNote} onChange={e => setMappingVerdictNote(e.target.value)} />
                      </div>
                      <div className={`${styles.actions} ${styles.full}`}>
                        <button
                          type="button"
                          className={styles.btnPrimary}
                          disabled={!allContextsDecided || acceptedContextCount < 1}
                          onClick={() => void submitOwnerReview("ACCEPT")}
                        >
                          {text("Accept Reviewed Subset", "اعتماد المجموعة المختارة")}
                        </button>
                        <button type="button" className={styles.btnDanger} onClick={() => void submitOwnerReview("REJECT", true)}>
                          {text("Reject Entire Proposal", "رفض الاقتراح بالكامل")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {mappingRun.ownerVerdictState !== "PENDING" && (
                  <div className={styles.diagnosticsSection}>
                    <strong>{text("Owner Review Recorded", "تم تسجيل مراجعة المالك")}</strong>
                    <dl className={styles.auditGrid} style={{ marginTop: "0.5rem" }}>
                      <dt>Run Verdict</dt><dd>{mappingRun.ownerVerdictState}</dd>
                      <dt>Accepted Contexts</dt><dd>{mappingRun.ownerContextDecisions.filter(item => item.decision === "ACCEPT").length}</dd>
                      <dt>Rejected Contexts</dt><dd>{mappingRun.ownerContextDecisions.filter(item => item.decision === "REJECT").length}</dd>
                    </dl>
                  </div>
                )}
              </div>
            )}

            <div className={styles.actions}>
              <button type="button" className={styles.btnSecondary} onClick={() => setStage(3)}>
                {text("← Back to Context Analysis", "← العودة لتحليل السياقات")}
              </button>
            </div>
          </section>
        )}

        {/* Native details element without open prop (Rule 2) */}
        <details className={styles.diagnosticsSection}>
          <summary>{text("Advanced Diagnostics & Raw Canonical Index JSON", "تشخيص متقدم وحمولة Canonical Index JSON الخام")}</summary>
          <div className={styles.diagnosticsContent}>
            <div className={styles.field}>
              <label htmlFor="diagnostic-json-file">{text("Load JSON File", "تحميل ملف JSON")}</label>
              <input
                id="diagnostic-json-file"
                type="file"
                accept="application/json,.json"
                onChange={e => void loadMappingFile(e.target.files?.[0])}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="diagnostic-json-textarea">{text("Exact Canonical Contract JSON", "JSON الدقيق للعقد الحاكم")}</label>
              <textarea
                id="diagnostic-json-textarea"
                className={styles.technicalText}
                rows={8}
                value={mappingIndexJson}
                onChange={e => { resetPipeline(); setMappingIndexJson(e.target.value); }}
                placeholder={text("Paste Canonical Workspace Index JSON here…", "الصق Canonical Workspace Index JSON هنا…")}
              />
            </div>

            <div className={styles.field}>
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={!hasIndexJson || action.kind === "working"}
                onClick={() => void createDiagnosticSnapshot()}
              >
                {text("Validate and Persist Diagnostic Snapshot", "التحقق من اللقطة التشخيصية وحفظها")}
              </button>
            </div>

            {indexSnapshot?.sourceMode === "ADVANCED_DIAGNOSTIC" && (
              <div className={styles.technicalBlock}>
                <strong>{text("Diagnostic Snapshot", "اللقطة التشخيصية")}</strong>
                <dl className={styles.auditGrid} style={{ marginTop: "0.5rem" }}>
                  <dt>Snapshot ID</dt><dd>{indexSnapshot.id}</dd>
                  <dt>Status</dt><dd>{indexSnapshot.status}</dd>
                  <dt>Canonical SHA256</dt><dd>{indexSnapshot.canonicalSha256 ?? "—"}</dd>
                </dl>
              </div>
            )}

            {mappingRun && (
              <div className={styles.technicalBlock}>
                <strong>Run Diagnostics:</strong>
                <dl className={styles.auditGrid} style={{ marginTop: "0.5rem" }}>
                  <dt>Run ID</dt><dd>{mappingRun.id}</dd>
                  <dt>Input SHA256</dt><dd>{mappingRun.mappingInputSha256}</dd>
                  <dt>Workspace Index SHA256</dt><dd>{mappingRun.workspaceIndexSha256}</dd>
                  <dt>Status</dt><dd>{mappingRun.status}</dd>
                  <dt>Owner Verdict</dt><dd>{mappingRun.ownerVerdictState}</dd>
                </dl>
              </div>
            )}
          </div>
        </details>
      </div>
    </ProductShell>
  );
}
