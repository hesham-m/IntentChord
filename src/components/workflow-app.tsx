"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  approvalState,
  authorizationPolicyPreview,
  buildDraftContract,
  compiledPromptForLocale,
  configurationPreview,
  type AuthorizationCapability,
  type ContractInput,
  type TaskDraftInput,
} from "@/lib/ui-flow";
import {
  activeRun,
  activeTask,
  canAccessWorkflowStep,
  emptyWorkspace,
  parentRun,
  selectTask,
  setTaskPromptLocale,
  taskStatus,
  upsertTask,
  workflowRoute,
  workflowStepState,
  type ContractTab,
  type Decision,
  type ReviewTab,
  type RunRecord,
  type TaskRecord,
  type WorkflowStep,
  type Workspace,
} from "@/lib/workspace";
import {
  authorizationCapabilities,
  createBlankContractInput,
  defaultDiscoveryScopeMode,
  effectiveDiscoveryScopeMode,
  effectiveTaskContext,
  extractExecutionSetup,
  generatedTaskTitle,
  independentTaskContext,
  parseOwnerRequirementLines,
  synchronizeLegacyWorkspaceProjection,
  transitionModel,
  transitionProvider,
  transitionReasoning,
  transitionRuntimeProfile,
  transitionTaskMode,
  workspaceDisplayNameFromReference,
  type DiscoveryScopeMode,
  type TaskContext,
  type WorkspaceReference,
  type WorkspaceSource,
} from "@/core/tasks/task-input";
import {
  localizeDecision,
  localizePolicyReason,
  localizePreflightIssue,
  localizeRunSource,
  localizeRecommendationText,
  localizeTaskSemanticReason,
  localizeTaskStatus,
  localizeVerdictText,
  translations,
  type TranslationCopy,
} from "@/i18n/translations";
import {
  defaultModelForProvider,
  defaultRuntimeProfileForProvider,
  modelRegistry,
  modelsForProvider,
  providerRegistry,
  providerIds,
  runtimeProfileForProvider,
  runtimeProfilesForProvider,
  type ExecutionChannelId,
  type ModelId,
  type ReasoningProfile,
  type RuntimeProfileId,
} from "@/core/providers/registry";
import type { Locale } from "@/i18n/types";
import type { Verdict } from "@/core/verdicts/engine";
import type { ExecutionContract } from "@/core/contracts/execution-contract";
import {
  compileMarkdownReportTemplate,
  compileOptionalJsonTemplate,
  localizedAgentGoal,
} from "@/core/prompts/compiler";
import { agentBehaviorProfile } from "@/core/agents/profiles";
import {
  localizeContractText,
  localizeContractTexts,
} from "@/i18n/contract-text";
import type { ExecutorReportEnvelope } from "@/core/reports/executor-report";
import { normalizeScopeSelections } from "@/core/policies/path-authority";
import { ProductShell } from "@/components/product-shell";
import {
  requestTaskExperienceProjection,
  type TaskExperienceProjectionState,
} from "@/components/task-experience-projection-client";
import { useProductPreferences } from "@/components/product-preferences-provider";
import { ownerErrorMessage } from "@/lib/owner-errors";

export type Stage =
  | "home"
  | "tasks"
  | "runs"
  | "task-new"
  | "task-current"
  | "contract"
  | "execute"
  | "review"
  | "bridge"
;

type NewTaskOperationPhase =
  | "PREPARING"
  | "CREATING_TASK"
  | "RESUMING_TASK"
  | "UNDERSTANDING_INTENT"
  | "DISCOVERING_CONTEXT"
  | "BUILDING_CONTRACT"
  | "SAVING_DRAFT";

type BridgeResult =
  | { kind: "idle" }
  | { kind: "syntax"; detail: string }
  | { kind: "schema"; issues: string[] }
  | {
      kind: "mapping";
      mappedFields: string[];
      missingFields: string[];
      detail: string;
    }
  | {
      kind: "report-received";
      report: ExecutorReportEnvelope;
      format?: "JSON" | "MARKDOWN";
      authoritativeTask: TaskRecord;
    }
  | {
      kind: "verdict";
      verdict: Verdict;
      report: ExecutorReportEnvelope;
      format?: "JSON" | "MARKDOWN";
      boundFields?: string[];
      mappedFields?: string[];
      authoritativeTask: TaskRecord;
    };

type BackendErrorPayload = {
  error?: string;
  code?: string;
};

async function ownerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response = await fetch(input, init);
  if (response.status !== 401 && response.status !== 403) return response;

  const failure = await response.clone().json().catch(() => ({})) as BackendErrorPayload;
  if (!['OWNER_SESSION_REQUIRED', 'OWNER_SESSION_INVALID'].includes(failure.code ?? '')) {
    return response;
  }

  if (typeof window !== "undefined") {
    window.location.href = "/login";
  }
  return response;
}

const authCopyKey: Record<AuthorizationCapability, keyof TranslationCopy> = {
  readFiles: "readFiles",
  modifySource: "modifySource",
  runStaticValidation: "runStaticValidation",
  runTests: "runTests",
  build: "runBuild",
  deploy: "deploy",
  restartServices: "restartServices",
  writeDatabase: "writeDatabase",
  changeEnvironment: "changeEnvironment",
  useNetwork: "useNetwork",
};

const contractTabOrder: ContractTab[] = [
  "summary",
  "scope",
  "authorization",
  "policy",
  "checks",
  "prompt",
];
const reviewTabOrder: ReviewTab[] = [
  "summary",
  "contract",
  "evidence",
  "decision",
];
const stepOrder: WorkflowStep[] = [
  "task",
  "contract",
  "execution",
  "review",
  "decision",
];
const stepCopyKey: Record<WorkflowStep, keyof TranslationCopy> = {
  task: "workflowTask",
  contract: "workflowContract",
  execution: "workflowExecution",
  review: "workflowReview",
  decision: "workflowDecision",
};

const technical = (value: React.ReactNode) => (
  <span className="technical-inline" dir="ltr">
    {value}
  </span>
);
export const formatTechnicalDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  const hour24 = date.getHours();
  const hour12 = hour24 % 12 || 12;
  const dayPeriod = hour24 >= 12 ? "PM" : "AM";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour12)}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${dayPeriod}`;
};

function runSourceDisplay(locale: Locale, run: RunRecord): string {
  if (run.status === "AWAITING_REPORT")
    return locale === "ar" ? "لم يُستورد تقرير بعد" : "No report imported yet";
  return localizeRunSource(locale, run.source);
}

function provenanceTraceLabel(locale: Locale, label: string): string {
  if (locale !== "ar") return label;
  const labels: Record<string, string> = {
    "Owner Objective": "هدف المالك",
    "Approved Scope": "النطاق المعتمد",
    "Approved Evidence": "الأدلة المعتمدة",
    "Report Binding": "ربط التقرير",
    "Report Content": "محتوى التقرير",
  };
  return labels[label] ?? label;
}

const provenanceDisplay = (locale: Locale, status: string) =>
  status === "FIXTURE"
    ? locale === "ar"
      ? "بيانات اختبار تاريخية · FIXTURE"
      : "HISTORICAL TEST DATA · FIXTURE"
    : status;

function currentStep(stage: Stage, reviewTab: ReviewTab): WorkflowStep {
  if (stage === "task-new" || stage === "task-current") return "task";
  if (stage === "contract") return "contract";
  if (stage === "execute") return "execution";
  if (stage === "review" && reviewTab === "decision") return "decision";
  return "review";
}

function taskResumeHref(task: TaskRecord): string {
  const status = taskStatus(task);
  if (status === "DRAFT") return "/tasks/current";
  if (status === "AWAITING_APPROVAL" || status === "APPROVED")
    return "/contracts/current";
  if (status === "IN_EXECUTION") return "/runs/current/execute";
  return "/runs/current/review";
}

function reviewNextAction(
  copy: TranslationCopy,
  locale: Locale,
  run: RunRecord,
): string {
  if (run.decision === "CORRECTION_REQUESTED")
    return copy.exactActionCorrection;
  if (run.decision === "ACCEPTED") return copy.exactActionAccepted;
  if (run.decision === "ACCEPTED_WITH_OVERRIDE")
    return locale === "ar"
      ? "أغلق المالك المهمة باستثناء صريح موثق رغم أن الحكم لم يكن PASS."
      : "The owner closed the task with a documented explicit override despite a non-PASS verdict.";
  if (run.decision === "ACKNOWLEDGED") return copy.acknowledgedNotice;
  if (run.decision === "REJECTED") return copy.exactActionRejected;
  return run.verdict
    ? localizeVerdictText(locale, run.verdict.nextAction)
    : copy.noItems;
}

function promptContextForRun(task: TaskRecord, run: RunRecord) {
  const parent = parentRun(task, run);
  const correctionGaps = parent?.verdict
    ? [
        ...parent.verdict.detectedViolations,
        ...parent.verdict.evidenceGaps,
        ...parent.verdict.unsupportedClaims,
      ]
    : [];
  return {
    activeRunId: run.id,
    round: run.round,
    executionType: run.executionType,
    parentRunId: run.parentRunId,
    bindingMarker: run.bindingMarker,
    correctionGaps,
    completedFacts: parent?.verdict?.acceptedFacts ?? [],
    inheritedCheckIds: parent?.verdict?.trustedSatisfiedCheckIds ?? [],
  } as const;
}

function submissionDraftSignature(input: TaskDraftInput): string {
  return JSON.stringify(synchronizeLegacyWorkspaceProjection({
    ...input,
    title: generatedTaskTitle(input.objective),
    titleManuallyEdited: false,
  }));
}

export function WorkflowApp({
  stage,
  initialNewTaskStep = 1,
}: {
  stage: Stage;
  initialNewTaskStep?: number;
}) {
  const { locale, setLocale, theme, setTheme } = useProductPreferences();
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [taskExperienceProjectionState, setTaskExperienceProjectionState] = useState<TaskExperienceProjectionState | undefined>(
    () => stage === "task-new" ? undefined : { status: "IDLE" },
  );
  const [newInput, setNewInput] = useState<TaskDraftInput>(() =>
    createBlankContractInput(),
  );
  const [json, setJson] = useState("");
  const [bridgeResult, setBridgeResult] = useState<BridgeResult>({
    kind: "idle",
  });
  const [notice, setNotice] = useState("");
  const [intentClarification, setIntentClarification] = useState<string>();
  const [newTaskOperationPhase, setNewTaskOperationPhase] = useState<NewTaskOperationPhase>();
  const [hydrated, setHydrated] = useState(false);
  const localeRef = useRef(locale);
  const newTaskFlightRef = useRef<Promise<boolean> | null>(null);
  const newTaskCommandIdRef = useRef<string | undefined>(undefined);
  const pendingNewTaskIdRef = useRef<string | undefined>(undefined);
  const pendingNewTaskDraftSignatureRef = useRef<string | undefined>(undefined);

  const copy = translations[locale];
  const task = activeTask(workspace);
  const run = activeRun(task);
  const promptLocale = task?.promptLocale ?? locale;

  useEffect(() => {
    localeRef.current = locale;
    setWorkspace((current) => current.interfaceLocale === locale
      ? current
      : { ...current, interfaceLocale: locale });
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/tasks", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as BackendErrorPayload;
          throw new Error(ownerErrorMessage(body, localeRef.current));
        }
        return response.json();
      })
      .then((rows: TaskRecord[]) => {
        if (cancelled) return;
        const tasks = rows.filter(Boolean);
        setWorkspace((current) => {
          const activeTaskId = current.activeTaskId && tasks.some((item) => item.id === current.activeTaskId)
            ? current.activeTaskId
            : tasks[0]?.id;
          return {
            version: 4,
            tasks,
            activeTaskId,
            interfaceLocale: localeRef.current,
          };
        });
        setNotice("");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setNotice(error instanceof Error ? error.message : "Server persistence is unavailable; no task data was loaded.");
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (stage === "task-new") {
      setTaskExperienceProjectionState(undefined);
      return;
    }
    if (!hydrated) return;

    const taskId = workspace.activeTaskId;
    if (!taskId) {
      setTaskExperienceProjectionState(notice
        ? { status: "ERROR", message: notice }
        : { status: "IDLE" });
      return;
    }

    let cancelled = false;
    setTaskExperienceProjectionState({ status: "LOADING", taskId });
    void requestTaskExperienceProjection(taskId, locale, ownerFetch)
      .then((projection) => {
        if (!cancelled) setTaskExperienceProjectionState({ status: "READY", taskId, projection });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTaskExperienceProjectionState({
          status: "ERROR",
          taskId,
          message: error instanceof Error ? error.message : "Authoritative task projection is unavailable.",
        });
      });

    return () => { cancelled = true; };
  }, [hydrated, locale, notice, stage, task?.revision, workspace.activeTaskId]);


  const save = (next: Workspace) => {
    setWorkspace(next);
  };

  const replaceAuthoritativeTask = (nextTask: TaskRecord) => {
    setWorkspace((current) => upsertTask(current, nextTask));
    return nextTask;
  };

  const reloadAuthoritativeTask = async (taskId: string) => {
    const response = await ownerFetch(`/api/tasks/${taskId}`, { cache: "no-store" });
    if (!response.ok) return undefined;
    return replaceAuthoritativeTask((await response.json()) as TaskRecord);
  };

  const taskCommand = async (
    url: string,
    init: RequestInit,
    taskIdForConflict?: string,
  ): Promise<TaskRecord | undefined> => {
    const response = await ownerFetch(url, init);
    const body = await response.json().catch(() => ({})) as {
      error?: string;
      code?: string;
    } & Partial<TaskRecord>;
    if (!response.ok) {
      if (response.status === 409 && taskIdForConflict) {
        await reloadAuthoritativeTask(taskIdForConflict);
        setNotice(locale === "ar"
          ? "تغيّرت الحالة الحاكمة. أعاد IntentChord تحميل أحدث مراجعة من Backend."
          : "The authoritative state changed. IntentChord reloaded the latest Backend revision.");
      } else {
        setNotice(ownerErrorMessage(body, locale));
      }
      return undefined;
    }
    setNotice("");
    return replaceAuthoritativeTask(body as TaskRecord);
  };

  const materializeWorkspaceRegistrations = async (input: TaskDraftInput) => {
    const workspaces: WorkspaceReference[] = [];
    for (const workspace of input.workspaces) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspace.id)) {
        workspaces.push(workspace);
        continue;
      }
      const response = await ownerFetch("/api/workspaces/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: workspace.displayName,
          role: workspace.role,
          referenceType: workspace.referenceType,
          reference: workspace.reference,
          authorizationContext: workspace.authorizationContext,
        }),
      });
      let registration = await response.json() as {
        id?: string;
        reference?: string;
        normalizedReference?: string;
        fingerprint?: string;
        repositoryIdentity?: string;
        branch?: string;
        commitSha?: string;
        revision?: number;
        source?: WorkspaceReference["source"];
        verificationStatus?: string;
        verificationMethod?: string;
        error?: string;
        code?: string;
        details?: unknown;
      };
      if (!response.ok || !registration.id || !registration.fingerprint) {
        setNotice(ownerErrorMessage(registration, locale, locale === "ar" ? "تعذر تسجيل مساحة العمل يدويًا. راجع المسار ثم حاول مرة أخرى." : "The advanced manual Workspace fallback was rejected. Review the path and try again."));
        return undefined;
      }
      const fallbackRegistrationId = registration.id;
      const fallbackFingerprint = registration.fingerprint;
      if (workspace.referenceType === "LOCAL_PATH") {
        const verificationResponse = await ownerFetch(`/api/workspaces/${registration.id}/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: registration.revision ?? 0 }),
        });
        if (verificationResponse.ok) {
          registration = await verificationResponse.json() as typeof registration;
        }
      }
      workspaces.push({
        ...workspace,
        id: registration.id ?? fallbackRegistrationId,
        reference: registration.normalizedReference ?? registration.reference ?? workspace.reference,
        fingerprint: registration.fingerprint ?? fallbackFingerprint,
        source: registration.source ?? "MANUAL_UNVERIFIED",
        repositoryIdentity: registration.repositoryIdentity,
        branch: registration.branch,
        commitSha: registration.commitSha,
        provenance: JSON.stringify({
          verificationStatus: registration.verificationStatus ?? "UNVERIFIED",
          verificationMethod: registration.verificationMethod ?? "ADVANCED_UNVERIFIED_FALLBACK",
        }),
      });
    }
    return synchronizeLegacyWorkspaceProjection({ ...input, workspaces });
  };

  const changeLocale = (next: Locale) => {
    setLocale(next);
    setWorkspace((current) => current.interfaceLocale === next
      ? current
      : { ...current, interfaceLocale: next });
  };

  const resolveAndConfirmIntent = async (candidate: TaskRecord): Promise<TaskRecord | undefined> => {
    const setup = extractExecutionSetup(candidate.draft);
    const resolved = candidate.intentResolution
      ? candidate
      : await taskCommand(`/api/tasks/${candidate.id}/resolve-intent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: candidate.revision,
            locale,
            plannerAdapterId: "DETERMINISTIC_INTENT_BASELINE",
            plannerProviderId: setup?.providerId ?? candidate.draft.providerId,
            plannerModelId: setup?.modelId ?? candidate.draft.modelId,
            plannerExecutionChannelId: setup?.executionChannelId ?? candidate.draft.executionChannelId,
          }),
        }, candidate.id);
    if (!resolved?.intentResolution) return undefined;
    if (resolved.intentResolution.confirmedAt) {
      setIntentClarification(undefined);
      return resolved;
    }
    if (resolved.intentResolution.resolution.needsClarification) {
      setNotice("");
      setIntentClarification(
        resolved.intentResolution.resolution.clarificationQuestion
          ?? (locale === "ar" ? "يحتاج IntentChord إلى توضيح واحد قبل إنشاء العقد." : "IntentChord needs one clarification before creating the Contract."),
      );
      return undefined;
    }
    setIntentClarification(undefined);
    return taskCommand(`/api/tasks/${resolved.id}/confirm-intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: resolved.revision,
        expectedResolutionId: resolved.intentResolution.id,
        expectedOutputSha256: resolved.intentResolution.outputSha256,
      }),
    }, resolved.id);
  };

  const runAndCompleteBoundedDiscovery = async (candidate: TaskRecord): Promise<TaskRecord | undefined> => {
    if (candidate.discoveryRun && ["COMPLETED", "EVIDENCE_REQUIRED"].includes(candidate.discoveryRun.status)) {
      return candidate;
    }

    let started = candidate.discoveryRun;
    if (!started) {
      const setup = extractExecutionSetup(candidate.draft);
      const startResponse = await ownerFetch(`/api/tasks/${candidate.id}/discovery-runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: candidate.revision,
          locale,
          discoveryAdapterId: "DETERMINISTIC_BOUNDED_DISCOVERY",
          discoveryProviderId: setup?.providerId ?? candidate.draft.providerId,
          discoveryModelId: setup?.modelId ?? candidate.draft.modelId,
          discoveryExecutionChannelId: setup?.executionChannelId ?? candidate.draft.executionChannelId,
        }),
      });
      const startBody = await startResponse.json().catch(() => ({})) as NonNullable<TaskRecord["discoveryRun"]> & { error?: string; code?: string; details?: unknown };
      if (!startResponse.ok || !startBody.id) {
        if (startResponse.status === 409) await reloadAuthoritativeTask(candidate.id);
        setNotice(ownerErrorMessage(startBody, locale, locale === "ar" ? "تعذر بدء الاكتشاف المقيّد. راجع الحالة الحاكمة ثم حاول مرة أخرى." : "Bounded discovery could not start. Review the governed state and try again."));
        return undefined;
      }
      started = startBody;
    }

    if (started.status === "FAILED") {
      setNotice(locale === "ar" ? "فشل الاكتشاف المقيّد قبل بناء العقد." : "Bounded discovery failed before Contract generation.");
      await reloadAuthoritativeTask(candidate.id);
      return undefined;
    }
    if (started.status !== "READY_TO_COMPLETE") {
      setNotice(locale === "ar" ? `حالة الاكتشاف الحالية لا تسمح بالإغلاق: ${started.status}` : `Discovery cannot be completed from state ${started.status}.`);
      await reloadAuthoritativeTask(candidate.id);
      return undefined;
    }
    const completeResponse = await ownerFetch(`/api/discovery-runs/${started.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedStateRevision: started.stateRevision }),
    });
    const completed = await completeResponse.json().catch(() => ({})) as NonNullable<TaskRecord["discoveryRun"]> & { error?: string };
    if (!completeResponse.ok || !["COMPLETED", "EVIDENCE_REQUIRED"].includes(completed.status)) {
      setNotice(ownerErrorMessage(completed, locale, locale === "ar" ? "تعذر إغلاق الاكتشاف المقيّد. راجع الأدلة المطلوبة ثم حاول مرة أخرى." : "Bounded discovery could not be completed. Review the required evidence and try again."));
      await reloadAuthoritativeTask(candidate.id);
      return undefined;
    }
    return reloadAuthoritativeTask(candidate.id);
  };

  const createNewTask = async (buildContract: boolean): Promise<boolean> => {
    if (newTaskFlightRef.current) return newTaskFlightRef.current;

    let operationCompleted = false;
    setNewTaskOperationPhase(buildContract ? "PREPARING" : "SAVING_DRAFT");
    const operation = (async (): Promise<boolean> => {
      const draft = await materializeWorkspaceRegistrations(newInput);
      if (!draft) return false;
      setNewInput(draft);
      const draftSignature = submissionDraftSignature(draft);

      let candidate: TaskRecord | undefined;
      const pendingTaskId = pendingNewTaskIdRef.current;
      if (pendingTaskId) {
        setNewTaskOperationPhase("RESUMING_TASK");
        const latest = await reloadAuthoritativeTask(pendingTaskId);
        if (latest) {
          const changedSinceCreate = pendingNewTaskDraftSignatureRef.current !== draftSignature;
          if (latest.contract && changedSinceCreate) {
            setNotice(locale === "ar"
              ? "أُنشئ عقد بالفعل للمدخل السابق. افتح المهمة الحالية وعدّلها بدل إنشاء مهمة مكررة."
              : "A Contract already exists for the previous input. Open the current Task and revise it instead of creating a duplicate.");
            return false;
          }
          if (changedSinceCreate && !latest.contract) {
            candidate = await taskCommand(`/api/tasks/${latest.id}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ expectedRevision: latest.revision, draft }),
            }, latest.id);
            if (!candidate) return false;
            pendingNewTaskDraftSignatureRef.current = draftSignature;
          } else {
            candidate = latest;
          }
        }
      }

      if (!candidate) {
        setNewTaskOperationPhase(buildContract ? "CREATING_TASK" : "SAVING_DRAFT");
        const requestedTaskId = newTaskCommandIdRef.current ?? crypto.randomUUID();
        newTaskCommandIdRef.current = requestedTaskId;
        const response = await ownerFetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ draft, requestedTaskId }),
        });
        const body = await response.json().catch(() => ({})) as BackendErrorPayload & Partial<TaskRecord>;
        if (!response.ok) {
          if (response.status === 409 && body.code === "TASK_CREATE_IDEMPOTENCY_MISMATCH") {
            newTaskCommandIdRef.current = undefined;
            pendingNewTaskIdRef.current = undefined;
            pendingNewTaskDraftSignatureRef.current = undefined;
            setNotice(locale === "ar"
              ? "تعذر إعادة استخدام هوية الطلب بأمان. لم تُنشأ مهمة أخرى؛ حاول مرة جديدة."
              : "The request identity could not be reused safely. No second Task was created; start the operation again.");
            return false;
          }
          setNotice(ownerErrorMessage(body, locale));
          return false;
        }
        candidate = replaceAuthoritativeTask(body as TaskRecord);
        pendingNewTaskIdRef.current = candidate.id;
        pendingNewTaskDraftSignatureRef.current = draftSignature;
      }

      if (!buildContract) {
        pendingNewTaskIdRef.current = undefined;
        newTaskCommandIdRef.current = undefined;
        pendingNewTaskDraftSignatureRef.current = undefined;
        operationCompleted = true;
        return true;
      }

      if (candidate.contract) {
        pendingNewTaskIdRef.current = undefined;
        newTaskCommandIdRef.current = undefined;
        pendingNewTaskDraftSignatureRef.current = undefined;
        operationCompleted = true;
        return true;
      }

      setNewTaskOperationPhase("UNDERSTANDING_INTENT");
      const confirmed = await resolveAndConfirmIntent(candidate);
      if (!confirmed) return false;
      setNewTaskOperationPhase("DISCOVERING_CONTEXT");
      const discovered = await runAndCompleteBoundedDiscovery(confirmed);
      if (!discovered) return false;
      setNewTaskOperationPhase("BUILDING_CONTRACT");
      const built = Boolean(await taskCommand(`/api/tasks/${discovered.id}/contract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: discovered.revision, locale }),
      }, discovered.id));
      if (built) {
        pendingNewTaskIdRef.current = undefined;
        newTaskCommandIdRef.current = undefined;
        pendingNewTaskDraftSignatureRef.current = undefined;
        operationCompleted = true;
      }
      return built;
    })().catch((error: unknown) => {
      setNotice(error instanceof Error
        ? error.message
        : locale === "ar"
          ? "تعذر إكمال إنشاء المهمة. سيستكمل IntentChord نفس المهمة عند إعادة المحاولة."
          : "Task creation could not complete. IntentChord will resume the same Task on retry.");
      return false;
    }).finally(() => {
      newTaskFlightRef.current = null;
      if (!operationCompleted) setNewTaskOperationPhase(undefined);
    });

    newTaskFlightRef.current = operation;
    return operation;
  };

  const updateCurrentTask = (input: TaskDraftInput) => {
    if (!task) return;
    const normalized = {
      ...input,
      title: generatedTaskTitle(input.objective),
      titleManuallyEdited: false,
    };
    save(upsertTask(workspace, { ...task, draft: normalized }));
  };

  const persistCurrentDraft = async () => {
    if (!task) return undefined;
    setNewTaskOperationPhase("SAVING_DRAFT");
    const draft = await materializeWorkspaceRegistrations(task.draft);
    if (!draft) {
      setNewTaskOperationPhase(undefined);
      return undefined;
    }
    const saved = await taskCommand(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: task.revision, draft }),
    }, task.id);
    if (!saved) setNewTaskOperationPhase(undefined);
    return saved;
  };

  const buildCurrentContract = async (): Promise<boolean> => {
    setNewTaskOperationPhase("PREPARING");
    const revised = await persistCurrentDraft();
    if (!revised) return false;
    setNewTaskOperationPhase("UNDERSTANDING_INTENT");
    const confirmed = await resolveAndConfirmIntent(revised);
    if (!confirmed) {
      setNewTaskOperationPhase(undefined);
      return false;
    }
    setNewTaskOperationPhase("DISCOVERING_CONTEXT");
    const discovered = await runAndCompleteBoundedDiscovery(confirmed);
    if (!discovered) {
      setNewTaskOperationPhase(undefined);
      return false;
    }
    setNewTaskOperationPhase("BUILDING_CONTRACT");
    const built = Boolean(await taskCommand(`/api/tasks/${discovered.id}/contract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: discovered.revision, locale }),
    }, discovered.id));
    if (!built) setNewTaskOperationPhase(undefined);
    return built;
  };

  const approve = async () => {
    if (!task?.contractRevisionId || task.contractStateRevision === undefined || !task.contractContentSha256) return;
    await taskCommand(`/api/contracts/${task.contractRevisionId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: task.contractStateRevision,
        expectedContentSha256: task.contractContentSha256,
        approvalChannel: "LOCAL_UI",
      }),
    }, task.id);
  };

  const setContractTab = (tab: ContractTab) =>
    task && save(upsertTask(workspace, { ...task, contractTab: tab }));
  const setReviewTab = (tab: ReviewTab) =>
    task && save(upsertTask(workspace, { ...task, reviewTab: tab }));
  const setAgentPromptLocale = (next: Locale) =>
    task && save(upsertTask(workspace, setTaskPromptLocale(task, next, true)));

  const prepareInitialExecution = async () => {
    if (!task?.contract) return false;
    const current = activeRun(task);
    if (current?.status === "AWAITING_REPORT") return true;
    return Boolean(await taskCommand(`/api/tasks/${task.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: task.revision,
        locale: task.promptLocale ?? locale,
        executionType: "INITIAL",
        source: "IMPORTED_REPORT",
      }),
    }, task.id));
  };

  const validateBridge = async () => {
    if (!task?.contract || !run || run.status !== "AWAITING_REPORT") return;
    const submitted = await taskCommand(`/api/runs/${run.id}/reports`, {
      method: "POST",
      headers: {
        "content-type": json.trim().startsWith("{") ? "application/json" : "text/markdown; charset=utf-8",
        "if-match": String(run.stateRevision ?? 0),
      },
      body: json,
    }, task.id);
    const received = activeRun(submitted);
    if (!submitted || !received?.report) {
      setBridgeResult({ kind: "schema", issues: ["The Backend rejected the report. Raw bytes were preserved when parsing was attempted."] });
      return;
    }
    setBridgeResult({
      kind: "report-received",
      report: received.report,
      authoritativeTask: submitted,
      format: json.trim().startsWith("{") ? "JSON" : "MARKDOWN",
    });
  };

  const finalizeOwnerRuntimeEvidence = async (
    validationRows: Array<{ checkId: string; status: "PASS" | "FAIL" | "EVIDENCE_REQUIRED"; details: string }>,
    commands: string[],
  ) => {
    if (!task?.contract || !run || run.status !== "REPORT_RECEIVED" || !run.report) return;
    let authoritativeTask: TaskRecord | undefined = task;
    let authoritativeRun: RunRecord | undefined = run;
    const validationBatchId = crypto.randomUUID();
    for (const [sequence, row] of validationRows.entries()) {
      authoritativeTask = await taskCommand(`/api/runs/${run.id}/validations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-intentchord-producer-type": "OWNER_RUNTIME",
        },
        body: JSON.stringify({
          expectedRevision: authoritativeRun.stateRevision ?? 0,
          checkId: row.checkId,
          status: row.status,
          details: row.details,
          batchId: validationBatchId,
          sequence,
          sequenceTotal: validationRows.length,
          isTerminal: sequence === validationRows.length - 1,
        }),
      }, task.id);
      authoritativeRun = activeRun(authoritativeTask);
      if (!authoritativeTask || !authoritativeRun) return;
    }

    const traceCommands = commands.length ? commands : ["INTENTCHORD:NO_COMMANDS_EXECUTED"];
    authoritativeTask = await taskCommand(`/api/runs/${run.id}/tool-trace/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-intentchord-producer-type": "OWNER_RUNTIME",
      },
      body: JSON.stringify({
        expectedRevision: authoritativeRun.stateRevision ?? 0,
        batchId: crypto.randomUUID(),
        events: traceCommands.map(command => ({
          command,
          authorizationResult: "AUTHORIZED",
          occurredAt: new Date().toISOString(),
        })),
      }),
    }, task.id);
    authoritativeRun = activeRun(authoritativeTask);
    if (!authoritativeTask || !authoritativeRun) return;

    const evaluated = await taskCommand(`/api/runs/${run.id}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: authoritativeRun.stateRevision ?? 0 }),
    }, task.id);
    const reviewed = activeRun(evaluated);
    if (!evaluated || !reviewed?.report || !reviewed.verdict) return;
    setBridgeResult({
      kind: "verdict",
      report: reviewed.report,
      verdict: reviewed.verdict,
      authoritativeTask: evaluated,
      format: json.trim().startsWith("{") ? "JSON" : "MARKDOWN",
      boundFields: [],
      mappedFields: Object.keys(reviewed.report),
    });
  };

  const saveImportedRun = () => {
    if (bridgeResult.kind === "verdict") replaceAuthoritativeTask(bridgeResult.authoritativeTask);
  };

  const backToParentReview = () => {
    if (!task || !run?.parentRunId) return;
    save(upsertTask(workspace, { ...task, activeRunId: run.parentRunId, reviewTab: "summary" }));
  };

  const recordDecision = async (
    currentRun: RunRecord,
    decision: Exclude<Decision, "NONE">,
    reason?: string,
  ) => {
    if (!task) return;
    await taskCommand(`/api/runs/${currentRun.id}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: currentRun.stateRevision ?? 0,
        decisionType: decision,
        ...(reason?.trim() ? { reason } : {}),
      }),
    }, task.id);
  };

  const updateDecisionNotes = (currentRun: RunRecord, notes: string) => {
    if (!task) return;
    save(upsertTask(workspace, {
      ...task,
      runs: task.runs.map(item => item.id === currentRun.id ? { ...item, correctionNotes: notes } : item),
    }));
  };

  const startCorrection = async (currentRun: RunRecord) => {
    if (!task) return false;
    return Boolean(await taskCommand(`/api/runs/${currentRun.id}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: currentRun.stateRevision ?? 0,
        locale: task.promptLocale ?? locale,
      }),
    }, task.id));
  };

  const requiredAvailable = (() => {
    if (
      [
        "home",
        "tasks",
        "runs",
        "task-new",
      ].includes(stage)
    )
      return true;
    if (stage === "task-current") return Boolean(task);
    if (stage === "contract") return Boolean(task?.contract);
    if (stage === "execute") return canAccessWorkflowStep(task, "execution");
    if (stage === "bridge")
      return (
        canAccessWorkflowStep(task, "execution") &&
        run?.status === "AWAITING_REPORT"
      );
    if (stage === "review") return canAccessWorkflowStep(task, "review");
    return true;
  })();

  const activeWorkflowStep = currentStep(stage, task?.reviewTab ?? "summary");

  const progress = ["task-current", "contract", "execute", "review"].includes(stage) && requiredAvailable ? (
    <WorkflowStepper
      task={task}
      current={activeWorkflowStep}
      copy={copy}
      setReviewTab={setReviewTab}
    />
  ) : undefined;

  return (
    <ProductShell
      locale={locale}
      stage={stage}
      theme={theme}
      onLocaleChange={changeLocale}
      onThemeChange={setTheme}
      tasks={workspace.tasks}
      activeTaskId={workspace.activeTaskId}
      onSelectTask={(taskId) => save(selectTask(workspace, taskId))}
      workflowProgress={progress}
      projectionState={stage === "task-new" ? undefined : taskExperienceProjectionState}
    >
      {!hydrated && !["home", "task-new"].includes(stage) ? null : !requiredAvailable ? (
        <Recovery
          copy={copy}
          clear={() => {
            setWorkspace(emptyWorkspace());
          }}
        />
      ) : (
        <>
          {stage === "home" && (
            <Dashboard
              workspace={workspace}
              copy={copy}
              locale={locale}
              select={(id) => save(selectTask(workspace, id))}
            />
          )}
          {stage === "tasks" && (
            <TaskRegistry
              workspace={workspace}
              copy={copy}
              locale={locale}
              select={(id) => save(selectTask(workspace, id))}
            />
          )}
          {stage === "runs" && (
            <RunRegistry
              workspace={workspace}
              copy={copy}
              locale={locale}
              select={(taskId, runId) => {
                const selected = workspace.tasks.find(
                  (item) => item.id === taskId,
                );
                if (!selected) return;
                save(
                  upsertTask(selectTask(workspace, taskId), {
                    ...selected,
                    activeRunId: runId,
                    reviewTab: "summary",
                  }),
                );
              }}
            />
          )}
          {stage === "task-new" && (
            <NewTask
              input={newInput}
              copy={copy}
              locale={locale}
              title={copy.newTask}
              hasDownstreamState={false}
              notice={notice}
              clarificationQuestion={intentClarification}
              operationPhase={newTaskOperationPhase}
              onObjectiveEdited={() => setIntentClarification(undefined)}
              update={(value) =>
                setNewInput({
                  ...value,
                  title: generatedTaskTitle(value.objective),
                  titleManuallyEdited: false,
                })
              }
              build={createNewTask}
              initialStep={initialNewTaskStep}
            />
          )}
          {stage === "task-current" && task && (
            <NewTask
              input={task.draft}
              copy={copy}
              locale={locale}
              title={copy.editTaskTitle}
              hasDownstreamState={Boolean(
                task.contract || task.runs.some((item) => !item.supersededAt),
              )}
              notice={notice}
              clarificationQuestion={intentClarification}
              operationPhase={newTaskOperationPhase}
              onObjectiveEdited={() => setIntentClarification(undefined)}
              update={updateCurrentTask}
              build={(flag) => flag ? buildCurrentContract() : persistCurrentDraft().then(Boolean)}
            />
          )}
          {stage === "contract" && task?.contract && (
            <ContractWorkbench
              contract={task.contract}
              activeRun={run}
              copy={copy}
              locale={locale}
              tab={task.contractTab}
              setTab={setContractTab}
              approve={approve}
              prepareExecution={prepareInitialExecution}
              promptLocale={promptLocale}
              setPromptLocale={setAgentPromptLocale}
              notice={notice}
              continueHref="/runs/current/execute"
            />
          )}
          {stage === "execute" && task?.contract && (
            <ExecutionPanel
              task={task}
              run={run}
              copy={copy}
              locale={locale}
              prepareBridge={prepareInitialExecution}
            />
          )}
          {stage === "review" && task?.contract && run?.verdict && (
            <RunReview
              task={task}
              contract={task.contract}
              run={run}
              copy={copy}
              locale={locale}
              tab={task.reviewTab}
              setTab={setReviewTab}
              recordDecision={recordDecision}
              updateNotes={updateDecisionNotes}
              startCorrection={startCorrection}
            />
          )}
          {stage === "bridge" && task?.contract && (
            <BridgeWorkbench
              task={task}
              run={run}
              copy={copy}
              locale={locale}
              json={json}
              setJson={setJson}
              result={bridgeResult}
              validate={validateBridge}
              finalizeOwnerRuntimeEvidence={finalizeOwnerRuntimeEvidence}
              saveImportedRun={saveImportedRun}
              backToParentReview={backToParentReview}
            />
          )}
        </>
      )}
    </ProductShell>
  );
}

function WorkflowStepper({
  task,
  current,
  copy,
  setReviewTab,
}: {
  task?: TaskRecord;
  current: WorkflowStep;
  copy: TranslationCopy;
  setReviewTab: (tab: ReviewTab) => void;
}) {
  return (
    <ol className="stepper" aria-label="Workflow progress">
      {stepOrder.map((step, index) => {
        const state = workflowStepState(task, current, step);
        const accessible = canAccessWorkflowStep(task, step);
        const content = (
          <>
            {index + 1}. {copy[stepCopyKey[step]]}
          </>
        );
        return (
          <li key={step} className={state}>
            {state === "current" ? (
              <span aria-current="step">{content}</span>
            ) : accessible ? (
              <Link
                href={workflowRoute(step)}
                onClick={() =>
                  setReviewTab(step === "decision" ? "decision" : "summary")
                }
              >
                {content}
              </Link>
            ) : (
              <span aria-disabled="true">{content}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Dashboard({
  workspace,
  copy,
  locale,
  select,
}: {
  workspace: Workspace;
  copy: TranslationCopy;
  locale: Locale;
  select: (id: string) => void;
}) {
  const open = workspace.tasks
    .filter(task => !["CLOSED", "REJECTED"].includes(taskStatus(task)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const closed = workspace.tasks.filter(task => ["CLOSED", "REJECTED"].includes(taskStatus(task)));
  const activeRuns = workspace.tasks
    .flatMap(task => task.runs.filter(run => !run.supersededAt))
    .length;
  const attention = open.filter(task => {
    const run = activeRun(task);
    return Boolean(
      !task.contract
      || task.contract.ownerApproval.state !== "APPROVED"
      || run?.status === "AWAITING_REPORT"
      || (run?.verdict && run.decision === "NONE")
      || run?.decision === "CORRECTION_REQUESTED",
    );
  });
  const attentionIds = new Set(attention.map(task => task.id));
  const recent = open.filter(task => !attentionIds.has(task.id)).slice(0, 3);
  const text = (en: string, ar: string) => locale === "ar" ? ar : en;

  return (
    <section className="welcome-home" data-product-view="home">
      <section className="home-start-panel" aria-labelledby="welcome-title">
        <div className="home-start-copy">
          <span className="eyebrow">{text("Start here", "ابدأ من هنا")}</span>
          <h1 id="welcome-title">{text(
            "What do you want IntentChord to help you accomplish?",
            "ماذا تريد من IntentChord أن يساعدك فيه؟",
          )}</h1>
          <p>{text(
            "Write the request in your own words. IntentChord organizes it, asks only for what is missing, and keeps the work governed from start to decision.",
            "اكتب طلبك بطريقتك. ينظمه IntentChord، ويسألك فقط عما ينقص، ويحافظ على حوكمة العمل من البداية حتى القرار.",
          )}</p>
          <div className="welcome-actions">
            <Link className="primary-link welcome-primary" href="/tasks/new">{text("Start a new task", "ابدأ مهمة جديدة")}</Link>
          </div>
          <p className="home-assurance">
            <span aria-hidden="true" />
            {text("No conclusion without evidence. Your objective remains the authority.", "لا نتيجة بلا دليل، وهدفك يظل هو المرجع.")}
          </p>
        </div>

        <ol className="home-journey" aria-label={text("How it works", "كيف تعمل المنصة")}>
          <li data-journey-stage="objective"><span>1</span><div><strong>{text("Tell IntentChord what you need", "اكتب ما تحتاجه")}</strong><p>{text("Use a result, a problem, or a short request in your own words.", "اكتب نتيجة أو مشكلة أو طلبًا مختصرًا بطريقتك.")}</p></div></li>
          <li data-journey-stage="boundaries"><span>2</span><div><strong>{text("Review what IntentChord understood", "راجع ما فهمه IntentChord")}</strong><p>{text("Confirm the scope, authority, and proposed requirements before execution.", "أكد النطاق والصلاحيات والمتطلبات المقترحة قبل التنفيذ.")}</p></div></li>
          <li data-journey-stage="evidence-decision"><span>3</span><div><strong>{text("Follow the work to a verified decision", "تابع العمل حتى قرار قابل للتحقق")}</strong><p>{text("IntentChord keeps the next action clear and separates claims from evidence.", "يوضح IntentChord الإجراء التالي ويفصل الادعاءات عن الأدلة.")}</p></div></li>
        </ol>
      </section>

      {attention.length > 0 && <section className="home-section" aria-labelledby="next-action-title">
        <div className="home-section-heading">
          <div>
            <span className="eyebrow">{text("Continue", "استكمل")}</span>
            <h2 id="next-action-title">{text("What needs your attention now", "ما يحتاج انتباهك الآن")}</h2>
            <p>{text("Only the next actions that move work forward are shown.", "تظهر هنا فقط الإجراءات التالية التي تحرّك العمل للأمام.")}</p>
          </div>
          {attention.length > 3 && <Link href="/tasks">{text("View all work", "عرض كل الأعمال")}</Link>}
        </div>
        <div className="calm-work-list">
          {attention.slice(0, 3).map(task => <TaskCard key={task.id} task={task} copy={copy} locale={locale} select={select} attention />)}
        </div>
      </section>}

      {recent.length > 0 && <section className="home-section" aria-labelledby="recent-work-title">
        <div className="home-section-heading">
          <div>
            <h2 id="recent-work-title">{text("Recent work", "أحدث الأعمال")}</h2>
            <p>{text("Open a recent task without exposing technical registry details.", "افتح مهمة حديثة دون إظهار تفاصيل السجل التقني.")}</p>
          </div>
          {open.length > 3 && <Link href="/tasks">{text("View all", "عرض الكل")}</Link>}
        </div>
        <div className="calm-work-list">
          {recent.map(task => <TaskCard key={task.id} task={task} copy={copy} locale={locale} select={select} />)}
        </div>
      </section>}

      <section className="owner-summary-strip" aria-label={text("Workspace summary", "ملخص مساحة العمل")}>
        <Metric label={copy.openTasks} value={String(open.length)} emptyCopy={copy.emptyOpenMetric} />
        <Metric label={copy.runsTitle} value={String(activeRuns)} emptyCopy={copy.emptyRunMetric} />
        <Metric label={copy.closedTasks} value={String(closed.length)} emptyCopy={copy.emptyClosedMetric} />
      </section>
    </section>
  );
}

function ownerNextAction(task: TaskRecord, copy: TranslationCopy, locale: Locale): { label: string; href: string } {
  const run = activeRun(task);
  if (!task.contract) return { label: locale === "ar" ? "استكمال الهدف والنطاق" : "Complete objective and scope", href: "/tasks/current" };
  if (task.contract.ownerApproval.state !== "APPROVED") return { label: locale === "ar" ? "مراجعة العقد واعتماده" : "Review and approve Contract", href: "/contracts/current" };
  if (!run) return { label: locale === "ar" ? "بدء التنفيذ المحكوم" : "Start governed execution", href: "/runs/current/execute" };
  if (run.status === "AWAITING_REPORT") return { label: locale === "ar" ? "استيراد تقرير المنفذ" : "Import executor report", href: "/bridge" };
  if (run.verdict && run.decision === "NONE") return { label: locale === "ar" ? "تسجيل قرار المالك" : "Record Owner decision", href: "/runs/current/review" };
  if (run.decision === "CORRECTION_REQUESTED") return { label: locale === "ar" ? "بدء جولة التصحيح" : "Start correction round", href: "/runs/current/review" };
  return { label: copy.resumeTask, href: taskResumeHref(task) };
}

function TaskCard({
  task,
  copy,
  locale,
  select,
  attention = false,
}: {
  task: TaskRecord;
  copy: TranslationCopy;
  locale: Locale;
  select: (id: string) => void;
  attention?: boolean;
}) {
  const run = activeRun(task);
  const status = taskStatus(task);
  const next = ownerNextAction(task, copy, locale);
  return (
    <article className={`owner-work-row ${attention ? "owner-work-row-attention" : ""}`}>
      <div className="owner-work-identity">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <h3>{task.draft.title || copy.taskDraft}</h3>
          <p>{task.draft.objective}</p>
        </div>
      </div>
      <div className="owner-work-state">
        <span>{localizeTaskStatus(locale, status)}</span>
        {run?.verdict && <strong dir="ltr">{run.verdict.classification}</strong>}
        <time className="technical-date" dir="ltr" dateTime={task.updatedAt}>{formatTechnicalDate(task.updatedAt)}</time>
      </div>
      <Link className="primary-link" href={next.href} onClick={() => select(task.id)}>{next.label}</Link>
    </article>
  );
}

function TaskRegistry({
  workspace,
  copy,
  locale,
  select,
}: {
  workspace: Workspace;
  copy: TranslationCopy;
  locale: Locale;
  select: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const tasks = workspace.tasks.filter((task) => {
    const closed = ["CLOSED", "REJECTED"].includes(taskStatus(task));
    return filter === "all" || (filter === "closed" ? closed : !closed);
  });
  const emptyText =
    filter === "open"
      ? copy.noOpenTasks
      : filter === "closed"
        ? copy.noClosedTasks
        : copy.noAllTasks;
  const emptyTitle =
    filter === "open"
      ? copy.openTasks
      : filter === "closed"
        ? copy.closedTasks
        : copy.allTasks;
  return (
    <section className="workspace page-workspace">
      <div className="page-heading">
        <div>
          <h1>{copy.tasksTitle}</h1>
          <p>{copy.tasksIntro}</p>
        </div>
      </div>
      <div className="segmented">
        <button
          type="button"
          className={filter === "open" ? "active" : ""}
          onClick={() => setFilter("open")}
        >
          {copy.openTasks}
        </button>
        <button
          type="button"
          className={filter === "closed" ? "active" : ""}
          onClick={() => setFilter("closed")}
        >
          {copy.closedTasks}
        </button>
        <button
          type="button"
          className={filter === "all" ? "active" : ""}
          onClick={() => setFilter("all")}
        >
          {copy.allTasks}
        </button>
      </div>
      {tasks.length ? (
        <div className="registry-grid">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              copy={copy}
              locale={locale}
              select={select}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={emptyTitle}
          text={emptyText}
          actionHref={filter === "closed" ? undefined : "/tasks/new"}
          actionLabel={filter === "closed" ? undefined : copy.createTask}
        />
      )}
    </section>
  );
}

function RunRegistry({
  workspace,
  copy,
  locale,
  select,
}: {
  workspace: Workspace;
  copy: TranslationCopy;
  locale: Locale;
  select: (taskId: string, runId: string) => void;
}) {
  const [view, setView] = useState<"grouped" | "flat">("grouped");
  const tasks = workspace.tasks
    .map((task) => ({
      task,
      runs: task.runs
        .filter((run) => !run.supersededAt)
        .sort((a, b) => a.round - b.round),
    }))
    .filter((group) => group.runs.length)
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  const rows = tasks
    .flatMap((group) => group.runs.map((run) => ({ task: group.task, run })))
    .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));

  return (
    <section className="workspace page-workspace run-registry">
      <div className="page-heading">
        <div>
          <h1>{copy.runsTitle}</h1>
          <p>{copy.runsIntro}</p>
        </div>
      </div>
      <div className="segmented">
        <button
          type="button"
          className={view === "grouped" ? "active" : ""}
          onClick={() => setView("grouped")}
        >
          {copy.groupByTask}
        </button>
        <button
          type="button"
          className={view === "flat" ? "active" : ""}
          onClick={() => setView("flat")}
        >
          {copy.flatRunView}
        </button>
      </div>
      {view === "grouped" ? (
        tasks.length ? (
          <div className="task-run-groups">
            {tasks.map(({ task, runs }) => {
              const latest = runs.at(-1)!;
              const active =
                runs.find((item) => item.id === task.activeRunId) ?? latest;
              const latestDecisionRun =
                [...runs].reverse().find((item) => item.decision !== "NONE") ??
                latest;
              return (
                <details className="task-run-group" key={task.id}>
                  <summary>
                    <div className="task-group-identity">
                      <strong>{task.draft.title || copy.taskDraft}</strong>
                    </div>
                    <div className="task-group-metrics">
                      <span className="status-chip">
                        {localizeTaskStatus(locale, taskStatus(task))}
                      </span>
                      <span>
                        {locale === "ar" ? "الجولات" : "Rounds"}:{" "}
                        <b>{runs.length}</b>
                      </span>
                      <span>
                        {locale === "ar" ? "الجولة النشطة" : "Active round"}:{" "}
                        <b>{active.round}</b>
                      </span>
                      <span>
                        {copy.latestVerdict}:{" "}
                        <b className="technical-inline" dir="ltr">
                          {latest.verdict?.classification ??
                            copy.awaitingReport}
                        </b>
                      </span>
                      <span>
                        {copy.latestDecision}:{" "}
                        <b>
                          {localizeDecision(locale, latestDecisionRun.decision)}
                        </b>
                      </span>
                    </div>
                  </summary>
                  <div className="round-timeline">
                    {runs.map((run) => (
                      <RunHistoryItem
                        key={run.id}
                        task={task}
                        run={run}
                        copy={copy}
                        locale={locale}
                        select={select}
                      />
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title={copy.runsTitle}
            text={copy.noRunsDetail}
            actionHref="/tasks/new"
            actionLabel={copy.createTask}
          />
        )
      ) : rows.length ? (
        <div className="run-list">
          {rows.map(({ task, run }) => (
            <RunHistoryItem
              key={run.id}
              task={task}
              run={run}
              copy={copy}
              locale={locale}
              select={select}
              flat
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={copy.runsTitle}
          text={copy.noRunsDetail}
          actionHref="/tasks/new"
          actionLabel={copy.createTask}
        />
      )}
    </section>
  );
}

function RunHistoryItem({
  task,
  run,
  copy,
  locale,
  select,
  flat = false,
}: {
  task: TaskRecord;
  run: RunRecord;
  copy: TranslationCopy;
  locale: Locale;
  select: (taskId: string, runId: string) => void;
  flat?: boolean;
}) {
  const identity =
    task.contract?.evidenceIdentity.sessionId ??
    task.contract?.evidenceIdentity.runId ??
    copy.noItems;
  const provider = providerRegistry[run.providerId];
  const model = modelRegistry[run.modelId];
  const verdict = run.verdict?.classification ?? copy.awaitingReport;
  const action =
    run.status === "REVIEW_READY" ? (
      <Link
        className="primary-link"
        href="/runs/current/review"
        onClick={() => select(task.id, run.id)}
      >
        {copy.openReview}
      </Link>
    ) : (
      <Link
        className="primary-link"
        href="/bridge"
        onClick={() => select(task.id, run.id)}
      >
        {copy.resumeExecution}
      </Link>
    );

  return (
    <article className={`${flat ? "run-row" : "round-row"} compact-run-card`}>
      <header className="run-card-header">
        <div className="round-marker">
          <span>
            {copy.round} {run.round}
          </span>

        </div>
        <div className="run-card-statuses">
          {run.executionType === "CORRECTION" && (
            <span className="status-chip correction-chip">
              {copy.correctionRound}
            </span>
          )}
          <span className="status-chip">
            {run.status === "AWAITING_REPORT"
              ? copy.awaitingReport
              : copy.reviewReady}
          </span>
          <span
            className={`status-chip classification-chip ${String(verdict).toLowerCase().replaceAll("_", "-")}`}
            dir="ltr"
          >
            {verdict}
          </span>
        </div>
      </header>

      <div className="run-card-primary">
        <StateLine
          label={copy.source}
          value={runSourceDisplay(locale, run)}
          technicalValue={false}
        />
        <StateLine
          label={copy.ownerReviewDecision}
          value={localizeDecision(locale, run.decision)}
          technicalValue={false}
        />
        <StateLine
          label={copy.provider}
          value={provider.displayName}
          technicalValue={false}
        />
        <StateLine
          label={copy.model}
          value={model.displayName}
          technicalValue={false}
        />
        <StateLine
          label={copy.executionChannel}
          value={run.executor}
          technicalValue={false}
        />
        <StateLine label={copy.reasoningProfile} value={run.reasoningProfile} />
        <StateLine
          label={copy.runtimeProfile}
          value={
            runtimeProfileForProvider(run.runtimeProfileId, run.providerId)
              .displayName
          }
          technicalValue={false}
        />
      </div>

      <details className="advanced-audit run-card-technical">
        <summary>Advanced Audit</summary>
        <StateLine label={copy.runId} value={run.id} />
        <StateLine label={copy.contractId} value={run.contractId} />
        <StateLine label={copy.evidenceIdentity} value={identity} />
        <StateLine label={copy.bindingMarker} value={run.bindingMarker} />
        {run.parentRunId && <StateLine label={copy.correctsRun} value={run.parentRunId} />}
        <div className="state-line"><span>{copy.created}</span><time className="technical-date" dir="ltr" dateTime={run.createdAt}>{formatTechnicalDate(run.createdAt)}</time></div>
      </details>

      <footer className="run-card-action">
        {run.supersededAt && (
          <span className="status-chip muted">{copy.superseded}</span>
        )}
        {action}
      </footer>
    </article>
  );
}

function NewTask({
  input,
  copy,
  locale,
  title,
  hasDownstreamState,
  notice,
  clarificationQuestion,
  operationPhase,
  onObjectiveEdited,
  update,
  build,
  initialStep = 1,
}: {
  input: TaskDraftInput;
  copy: TranslationCopy;
  locale: Locale;
  title: string;
  hasDownstreamState: boolean;
  notice: string;
  clarificationQuestion?: string;
  operationPhase?: NewTaskOperationPhase;
  onObjectiveEdited: () => void;
  update: (input: TaskDraftInput) => void;
  build: (buildContract: boolean) => boolean | Promise<boolean>;
  initialStep?: number;
}) {
  const [step, setStep] = useState(initialStep);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const pickerLockRef = useRef(false);
  const [pickerOperation, setPickerOperation] = useState<{
    kind: "WORKSPACE" | "FOLDER" | "FILE";
    workspaceId?: string;
    workspaceName?: string;
  }>();
  const [pickerNotice, setPickerNotice] = useState<{
    tone: "success" | "neutral" | "error";
    message: string;
  }>();
  const [registeredWorkspaces, setRegisteredWorkspaces] = useState<Array<{
    id: string;
    displayName: string;
    role: string;
    referenceType: "LOCAL_PATH" | "REMOTE_REFERENCE";
    source: Exclude<WorkspaceSource, "MIXED">;
    normalizedReference: string;
    fingerprint: string;
    repositoryIdentity?: string;
    branch?: string;
    commitSha?: string;
    verificationStatus: string;
    verificationMethod: string;
    authorizationContext: string;
    provenance?: Record<string, unknown>;
  }>>([]);
  const [projectContexts, setProjectContexts] = useState<Array<{
    id: string;
    displayName: string;
    status: "ACTIVE" | "ARCHIVED";
    revision: number;
    workspaces?: Array<{ workspaceRegistrationId: string; validFrom?: string; validUntil?: string }>;
  }>>([]);
  const [selectedRegisteredWorkspaceId, setSelectedRegisteredWorkspaceId] = useState("");
  const initialProjectContextIdRef = useRef<string | undefined>(
    typeof window === "undefined"
      ? undefined
      : new URLSearchParams(window.location.search).get("project") ?? undefined,
  );
  const initialInputRef = useRef(input);
  const initialUpdateRef = useRef(update);
  const submissionLockRef = useRef(false);
  const [submissionMode, setSubmissionMode] = useState<"SAVE" | "BUILD">();

  useEffect(() => {
    if (!clarificationQuestion) return;
    setStep(1);
    const focusTimer = window.setTimeout(() => objectiveRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [clarificationQuestion]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      ownerFetch("/api/project-contexts", { cache: "no-store" }).then(async response => response.ok ? response.json() : []),
      ownerFetch("/api/workspaces", { cache: "no-store" }).then(async response => response.ok ? response.json() : []),
    ]).then(([contextRows, workspaceRows]) => {
      if (cancelled) return;
      const contexts = Array.isArray(contextRows)
        ? contextRows.filter((item): item is { id: string; displayName: string; status: "ACTIVE" | "ARCHIVED"; revision: number; workspaces?: Array<{ workspaceRegistrationId: string; validFrom?: string; validUntil?: string }> } =>
            Boolean(item && typeof item.id === "string" && typeof item.displayName === "string"))
        : [];
      const registrations = Array.isArray(workspaceRows) ? workspaceRows : [];
      setProjectContexts(contexts);
      setRegisteredWorkspaces(registrations.filter((item: { id?: string }) => typeof item.id === "string"));
      setSelectedRegisteredWorkspaceId("");
      const initialProjectContextId = initialProjectContextIdRef.current;
      const initialInput = initialInputRef.current;
      if (initialProjectContextId && effectiveTaskContext(initialInput).kind === "INDEPENDENT") {
        const initialProject = contexts.find(context => context.id === initialProjectContextId && context.status === "ACTIVE");
        if (initialProject) {
          initialUpdateRef.current(synchronizeLegacyWorkspaceProjection({
            ...initialInput,
            taskContext: {
              kind: "PROJECT_BOUND",
              projectContextId: initialProject.id,
              projectContextDisplayName: initialProject.displayName,
              projectContextRevision: initialProject.revision,
            },
            workspaces: [],
          }));
        }
      }
    }).catch(() => {
      if (!cancelled) {
        setProjectContexts([]);
        setRegisteredWorkspaces([]);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const availability = authorizationPolicyPreview(input.taskMode);
  const resolvedContract = buildDraftContract(input);
  const policyTrace = resolvedContract?.policyDecisionTrace ?? [];
  const requestedCapabilities = authorizationCapabilities.filter(
    (capability) => input[capability],
  );
  const effectiveCapabilities = policyTrace
    .filter((item) => item.effective)
    .map((item) => item.capability);
  const reconciledCapabilities = policyTrace.filter(
    (item) => item.requested && !item.effective,
  );
  const configuration = configurationPreview(input);
  // Defect 7 fix: no silent OpenAI/model fallback. Show NOT_SELECTED when execution setup incomplete.
  const executionSetupSelected = configuration.executionStatus === "SELECTED";
  const activeProviderId = input.providerId;
  const activeModelId = input.modelId;
  const provider = activeProviderId ? providerRegistry[activeProviderId] : undefined;
  const selectedModel = activeModelId ? modelRegistry[activeModelId] : undefined;
  const recommendedModel = configuration.recommendation
    ? modelRegistry[configuration.recommendation.recommendedModelId]
    : undefined;
  const providerModels = activeProviderId ? modelsForProvider(activeProviderId) : modelsForProvider("OPENAI");
  const runtimeProfiles = activeProviderId ? runtimeProfilesForProvider(activeProviderId) : runtimeProfilesForProvider("OPENAI");
  const recommendedRuntimeProfile = recommendedModel
    ? runtimeProfileForProvider(
        defaultRuntimeProfileForProvider(recommendedModel.providerId),
        recommendedModel.providerId,
      )
    : runtimeProfileForProvider(
        defaultRuntimeProfileForProvider("OPENAI"),
        "OPENAI",
      );
  const ar = locale === "ar";
  const text = (en: string, arabic: string) => (ar ? arabic : en);
  const taskContext = effectiveTaskContext(input);
  const selectedProject = taskContext.kind === "PROJECT_BOUND"
    ? projectContexts.find(context => context.id === taskContext.projectContextId)
    : undefined;
  const availableRegisteredWorkspaces = taskContext.kind === "PROJECT_BOUND"
    ? (() => {
        const now = Date.now();
        const linkedIds = new Set((selectedProject?.workspaces ?? [])
          .filter(item => {
            const validFrom = item.validFrom ? Date.parse(item.validFrom) : Number.NEGATIVE_INFINITY;
            const validUntil = item.validUntil ? Date.parse(item.validUntil) : Number.POSITIVE_INFINITY;
            return validFrom <= now && now < validUntil;
          })
          .map(item => item.workspaceRegistrationId));
        return registeredWorkspaces.filter(workspace => linkedIds.has(workspace.id));
      })()
    : registeredWorkspaces;
  const operationPhaseMessage: Record<NewTaskOperationPhase, { en: string; ar: string }> = {
    PREPARING: { en: "Preparing the governed Workspace…", ar: "جارٍ تجهيز مساحة العمل الحاكمة…" },
    CREATING_TASK: { en: "Creating one authoritative Task…", ar: "جارٍ إنشاء مهمة حاكمة واحدة…" },
    RESUMING_TASK: { en: "Resuming the same Task from its latest state…", ar: "جارٍ استكمال نفس المهمة من أحدث حالة…" },
    UNDERSTANDING_INTENT: { en: "Understanding the objective…", ar: "جارٍ فهم الهدف…" },
    DISCOVERING_CONTEXT: { en: "Checking the approved Workspace and context…", ar: "جارٍ فحص مساحة العمل والسياق المعتمدين…" },
    BUILDING_CONTRACT: { en: "Creating the governed Contract…", ar: "جارٍ إنشاء العقد الحاكم…" },
    SAVING_DRAFT: { en: "Saving the Task draft…", ar: "جارٍ حفظ مسودة المهمة…" },
  };
  const generatedTitle = generatedTaskTitle(input.objective);
  const taskModeDisplayName = input.taskMode === "SOURCE_IMPLEMENTATION"
    ? copy.sourceImplementation
    : input.taskMode === "REPORT_REVIEW"
      ? copy.reportReview
      : copy.controlledAudit;
  const evidenceRequired =
    input.taskMode === "SOURCE_IMPLEMENTATION" &&
    /(runtime|startup|session|process|release|telemetry|تشغيل|جلسة|عملية|إصدار)/i.test(
      input.objective,
    );
  const reportReviewWithoutEvidence =
    input.taskMode === "REPORT_REVIEW" && input.evidenceFiles.length === 0;
  const discoveryFirstAudit =
    input.taskMode === "CONTROLLED_AUDIT" && input.evidenceFiles.length === 0;
  const stepLabels = [
    text("Objective and context", "الهدف والسياق"),
    text("Workspace and scope", "مساحة العمل والنطاق"),
    text("Authorization", "الصلاحيات"),
    text("Task execution setup", "إعداد تنفيذ المهمة"),
    text("Review", "المراجعة"),
  ];
  const stepDescriptions = [
    text("Write what you need, choose independent or project work, then select the kind of work.", "اكتب ما تحتاجه، وحدد هل هي مهمة مستقلة أم داخل مشروع، ثم اختر نوع العمل."),
    text("Choose the Workspace and the exact read boundary.", "اختر مساحة العمل وحدود القراءة الدقيقة."),
    text("Confirm what the selected policy actually allows.", "تحقق مما تسمح به السياسة المختارة فعليًا."),
    text("Review the provider, model, and execution profile.", "راجع المزوّد والموديل وملف التنفيذ."),
    text("Read the complete governed summary before creation.", "اقرأ الملخص الحاكم كاملًا قبل الإنشاء."),
  ];

  const pickerBusy = Boolean(pickerOperation);
  const beginPicker = (operation: NonNullable<typeof pickerOperation>) => {
    if (pickerLockRef.current) return false;
    pickerLockRef.current = true;
    setPickerOperation(operation);
    setPickerNotice(undefined);
    return true;
  };
  const finishPicker = () => {
    pickerLockRef.current = false;
    setPickerOperation(undefined);
  };
  const pickerFailureMessage = (code?: string) => {
    const messages: Record<string, string> = {
      OWNER_SESSION_REQUIRED: text("Your session has expired. Please sign in again.", "انتهت صلاحية جلستك. يرجى تسجيل الدخول مرة أخرى."),
      OWNER_SESSION_INVALID: text("Your session is no longer valid. Please sign in again.", "جلستك لم تعد صالحة. يرجى تسجيل الدخول مرة أخرى."),
      NATIVE_SELECTOR_BUSY: text("Another picker is already open. Complete or cancel it first.", "توجد نافذة اختيار مفتوحة بالفعل. أكملها أو ألغها أولًا."),
      NATIVE_SELECTOR_UNAVAILABLE: text("The Windows native picker is unavailable on this runtime.", "منتقي Windows المحلي غير متاح في بيئة التشغيل الحالية."),
      NATIVE_SELECTOR_TIMEOUT: text("The picker timed out before a selection was completed.", "انتهت مهلة نافذة الاختيار قبل إكمال التحديد."),
      NATIVE_SELECTOR_FAILED: text("The Windows native picker could not be opened or completed.", "تعذر فتح منتقي Windows المحلي أو إكماله."),
      WORKSPACE_NOT_FOUND: text("The selected Workspace path no longer exists.", "مسار مساحة العمل المحدد لم يعد موجودًا."),
      WORKSPACE_NOT_DIRECTORY: text("The selected path is not a directory.", "المسار المحدد ليس مجلدًا."),
      SCOPE_PATH_OUTSIDE_WORKSPACE: text("The selected path is outside this Workspace.", "المسار المحدد خارج مساحة العمل هذه."),
    };
    const resolvedCode = code || "NATIVE_SELECTOR_FAILED";
    return `${messages[resolvedCode] ?? messages.NATIVE_SELECTOR_FAILED} (${resolvedCode})`;
  };

  const normalizedUpdate = (
    changes: Partial<
      Pick<ContractInput, "allowedPaths" | "excludedPaths" | "evidenceFiles">
    >,
  ) => {
    const normalized = normalizeScopeSelections({
      allowedPaths: changes.allowedPaths ?? input.allowedPaths,
      excludedPaths: changes.excludedPaths ?? input.excludedPaths,
      evidenceFiles: changes.evidenceFiles ?? input.evidenceFiles,
    });
    update({
      ...input,
      allowedPaths: normalized.allowedPaths,
      excludedPaths: normalized.excludedPaths,
      evidenceFiles: normalized.evidenceFiles,
    });
  };

  const addUnique = (
    field: "allowedPaths" | "excludedPaths" | "evidenceFiles",
    values: string[],
  ) => {
    normalizedUpdate({ [field]: [...input[field], ...values] });
  };
  const removeItem = (
    field: "allowedPaths" | "excludedPaths" | "evidenceFiles",
    value: string,
  ) =>
    normalizedUpdate({
      [field]: input[field].filter((item) => item !== value),
    });

  const updateWorkspaces = (workspaces: WorkspaceReference[]) =>
    update(
      synchronizeLegacyWorkspaceProjection({
        ...input,
        workspaces: workspaces.map((workspace, ordering) => ({
          ...workspace,
          ordering,
        })),
        modelOverrideAccepted: false,
      }),
    );
  const changeTaskContext = (nextContext: TaskContext) => {
    setSelectedRegisteredWorkspaceId("");
    setFieldErrors(current => ({ ...current, projectContext: "", workspace: "", scope: "" }));
    update(synchronizeLegacyWorkspaceProjection({
      ...input,
      taskContext: nextContext,
      workspaces: [],
      modelOverrideAccepted: false,
    }));
  };

  const selectProjectContext = (projectContextId: string) => {
    const project = projectContexts.find(context => context.id === projectContextId && context.status === "ACTIVE");
    changeTaskContext(project ? {
      kind: "PROJECT_BOUND",
      projectContextId: project.id,
      projectContextDisplayName: project.displayName,
      projectContextRevision: project.revision,
    } : {
      kind: "PROJECT_BOUND",
      projectContextId: "",
      projectContextDisplayName: "",
      projectContextRevision: 0,
    });
  };
  const addRegisteredWorkspace = () => {
    const registration = availableRegisteredWorkspaces.find(item => item.id === selectedRegisteredWorkspaceId);
    if (!registration || input.workspaces.some(item => item.id === registration.id)) return;
    updateWorkspaces([
      ...input.workspaces,
      {
        id: registration.id,
        displayName: registration.displayName,
        role: registration.role || (input.workspaces.length === 0 ? "primary" : "supporting"),
        referenceType: registration.referenceType,
        source: registration.source,
        reference: registration.normalizedReference,
        repositoryIdentity: registration.repositoryIdentity,
        branch: registration.branch,
        commitSha: registration.commitSha,
        fingerprint: registration.fingerprint,
        provenance: JSON.stringify({
          ...(registration.provenance ?? {}),
          verificationStatus: registration.verificationStatus,
          verificationMethod: registration.verificationMethod,
        }),
        discoveryScopeMode: defaultDiscoveryScopeMode(input.taskMode),
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: registration.authorizationContext,
        ordering: input.workspaces.length,
      },
    ]);
    setSelectedRegisteredWorkspaceId("");
    setFieldErrors(current => ({ ...current, workspace: "" }));
    setPickerNotice({
      tone: "success",
      message: text(`Workspace added: ${registration.displayName}`, `تمت إضافة مساحة العمل: ${registration.displayName}`),
    });
  };
  const addWorkspace = async () => {
    if (!beginPicker({ kind: "WORKSPACE" })) return;
    try {
      const response = await ownerFetch("/api/workspaces/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: `Workspace ${input.workspaces.length + 1}`,
          role: input.workspaces.length === 0 ? "primary" : "supporting",
          authorizationContext: "owner-selected local Workspace",
          taskMode: input.taskMode,
        }),
      });
      const result = await response.json() as {
        workspace?: WorkspaceReference;
        ownerView?: { discoveryScopeMode?: DiscoveryScopeMode };
        error?: string;
        code?: string;
      };
      if (!response.ok || !result.workspace?.id || !result.workspace.fingerprint) {
        if (result.code === "WORKSPACE_SELECTION_CANCELLED") {
          setPickerNotice({
            tone: "neutral",
            message: text("Workspace selection cancelled. No changes were made.", "أُلغي اختيار مساحة العمل ولم يتم إجراء أي تغيير."),
          });
          return;
        }
        const message = pickerFailureMessage(result.code);
        setFieldErrors(current => ({ ...current, workspace: message }));
        setPickerNotice({ tone: "error", message });
        return;
      }
      updateWorkspaces([
        ...input.workspaces,
        {
          ...result.workspace,
          discoveryScopeMode:
            result.ownerView?.discoveryScopeMode
            ?? result.workspace.discoveryScopeMode
            ?? defaultDiscoveryScopeMode(input.taskMode),
          ordering: input.workspaces.length,
        },
      ]);
      setFieldErrors(current => ({ ...current, workspace: "" }));
      setPickerNotice({
        tone: "success",
        message: text(
          `Workspace added: ${result.workspace.displayName}`,
          `تمت إضافة مساحة العمل: ${result.workspace.displayName}`,
        ),
      });
    } catch {
      const message = pickerFailureMessage("NATIVE_SELECTOR_FAILED");
      setFieldErrors(current => ({ ...current, workspace: message }));
      setPickerNotice({ tone: "error", message });
    } finally {
      finishPicker();
    }
  };

  const addManualWorkspace = () =>
    updateWorkspaces([
      ...input.workspaces,
      {
        id: `temporary-${crypto.randomUUID()}`,
        displayName: "",
        role: "",
        referenceType: "LOCAL_PATH",
        source: "MANUAL_UNVERIFIED",
        reference: "",
        fingerprint: "UNVERIFIED",
        provenance: JSON.stringify({
          verificationStatus: "UNVERIFIED",
          verificationMethod: "ADVANCED_UNVERIFIED_FALLBACK",
        }),
        discoveryScopeMode: defaultDiscoveryScopeMode(input.taskMode),
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: "owner",
        ordering: input.workspaces.length,
      },
    ]);
  const updateWorkspace = (id: string, changes: Partial<WorkspaceReference>) =>
    updateWorkspaces(
      input.workspaces.map((workspace) =>
        workspace.id === id
          ? {
              ...workspace,
              ...changes,
              ...(changes.reference === undefined || !workspace.id.startsWith("temporary-")
                ? {}
                : { fingerprint: "UNVERIFIED" }),
            }
          : workspace,
      ),
    );

  const selectScopePath = async (
    workspace: WorkspaceReference,
    selectionType: "FOLDER" | "FILE",
  ) => {
    if (!beginPicker({
      kind: selectionType,
      workspaceId: workspace.id,
      workspaceName: workspace.displayName,
    })) return;
    try {
      const response = await ownerFetch(`/api/workspaces/${workspace.id}/scope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectionType }),
      });
      const result = await response.json() as {
        path?: string;
        impliedDiscoveryScopeMode?: DiscoveryScopeMode;
        code?: string;
      };
      if (!response.ok || !result.path) {
        if (result.code === "SCOPE_SELECTION_CANCELLED") {
          setPickerNotice({
            tone: "neutral",
            message: text("Path selection cancelled. No changes were made.", "أُلغي اختيار المسار ولم يتم إجراء أي تغيير."),
          });
          return;
        }
        const message = pickerFailureMessage(result.code);
        setFieldErrors(current => ({ ...current, scope: message }));
        setPickerNotice({ tone: "error", message });
        return;
      }
      if (result.impliedDiscoveryScopeMode === "FULL_WORKSPACE") {
        updateWorkspace(workspace.id, {
          discoveryScopeMode: "FULL_WORKSPACE",
          allowedPaths: [],
        });
      } else {
        updateWorkspace(workspace.id, {
          discoveryScopeMode: "SELECTED_PATHS",
          allowedPaths: workspace.allowedPaths.includes(result.path)
            ? workspace.allowedPaths
            : [...workspace.allowedPaths, result.path],
        });
      }
      setFieldErrors(current => ({ ...current, scope: "" }));
      setPickerNotice({
        tone: "success",
        message: text(`Path added: ${result.path}`, `تمت إضافة المسار: ${result.path}`),
      });
    } catch {
      const message = pickerFailureMessage("NATIVE_SELECTOR_FAILED");
      setFieldErrors(current => ({ ...current, scope: message }));
      setPickerNotice({ tone: "error", message });
    } finally {
      finishPicker();
    }
  };
  const removeWorkspace = (id: string) =>
    updateWorkspaces(
      input.workspaces
        .filter((workspace) => workspace.id !== id)
        .map((workspace, ordering) => ({ ...workspace, ordering })),
    );
  const moveWorkspace = (id: string, direction: -1 | 1) => {
    const currentIndex = input.workspaces.findIndex(
      (workspace) => workspace.id === id,
    );
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= input.workspaces.length)
      return;
    const ordered = [...input.workspaces];
    [ordered[currentIndex], ordered[targetIndex]] = [
      ordered[targetIndex],
      ordered[currentIndex],
    ];
    updateWorkspaces(ordered);
  };

  const attachEvidence = (files: FileList | null) => {
    if (!files?.length) return;
    addUnique(
      "evidenceFiles",
      Array.from(files).map((file) => `upload:${file.name}`),
    );
  };


  const recommendationClass = (configuration.recommendation?.status ?? "NOT_SELECTED")
    .toLowerCase()
    .replaceAll("_", "-");
  const overrideRequired = [
    "SUPPORTED_WITH_WARNING",
    "OWNER_DECISION_REQUIRED",
  ].includes(configuration.recommendation?.status ?? "");
  const workspaceEvidence = input.evidenceFiles.filter(
    (path) => !path.startsWith("upload:"),
  );
  const uploadedEvidence = input.evidenceFiles.filter((path) =>
    path.startsWith("upload:"),
  );

  const stepSummary = [
    input.objective
      ? taskContext.kind === "PROJECT_BOUND" && taskContext.projectContextDisplayName
        ? text(`Project: ${taskContext.projectContextDisplayName}`, `المشروع: ${taskContext.projectContextDisplayName}`)
        : text("Independent request captured", "تم تسجيل مهمة مستقلة")
      : text("Start here", "ابدأ هنا"),
    input.workspaces.length
      ? `${input.workspaces.length} ${text("Workspace selected", "مساحة عمل محددة")}`
      : text("Workspace not selected", "لم تُحدد مساحة عمل"),
    `${effectiveCapabilities.length} ${text("effective capabilities", "صلاحيات فعالة")}`,
    `${provider?.displayName ?? text("Not selected", "لم يُحدد")} · ${selectedModel?.displayName ?? text("Not selected", "لم يُحدد")}`,
    text("Final check before creation", "الفحص النهائي قبل الإنشاء"),
  ];

  const validateStep = (stepToValidate: number): boolean => {
    const errors: Record<string, string> = {};
    if (stepToValidate === 1) {
      const objective = input.objective.trim();
      if (!objective)
        errors.objective = text(
          "Write the objective in your own words. IntentChord will organize it and ask for clarification only when needed.",
          "اكتب الهدف بطريقتك. سيقوم IntentChord بتنظيمه ولن يطلب توضيحًا إلا عند الحاجة.",
        );
      else if (objective.length < 3)
        errors.objective = text(
          "Add a little more detail so IntentChord can understand the request.",
          "أضف تفصيلًا بسيطًا حتى يتمكن IntentChord من فهم الطلب.",
        );
      if (taskContext.kind === "PROJECT_BOUND" && !taskContext.projectContextId)
        errors.projectContext = text(
          "Choose the Project this Task belongs to.",
          "اختر المشروع الذي تتبعه هذه المهمة.",
        );
    }
    if (stepToValidate === 2) {
      if (
        input.workspaces.length === 0 ||
        input.workspaces.some(
          (workspace) =>
            !workspace.displayName.trim() ||
            !workspace.role.trim() ||
            !workspace.reference.trim() ||
            !workspace.fingerprint.trim(),
        )
      )
        errors.workspace = text(
          "Select a verified workspace folder.",
          "اختر مجلد مساحة عمل موثّقًا.",
        );
      if (input.workspaces.every((workspace) => effectiveDiscoveryScopeMode(workspace, input.taskMode) === "NONE"))
        errors.scope = text(
          "Authorize discovery/read access for at least one Workspace.",
          "اسمح بالاكتشاف والقراءة لمساحة عمل واحدة على الأقل.",
        );
      if (input.workspaces.some((workspace) =>
        effectiveDiscoveryScopeMode(workspace, input.taskMode) === "SELECTED_PATHS"
        && workspace.allowedPaths.length === 0
      ))
        errors.scope = text(
          "Choose at least one file or folder for every Workspace using selected-path mode.",
          "اختر ملفًا أو مجلدًا واحدًا على الأقل لكل مساحة عمل تستخدم وضع المسارات المحددة.",
        );
      if (evidenceRequired && input.evidenceFiles.length === 0)
        errors.evidence = text(
          "This task mode requires at least one evidence source.",
          "نمط المهمة يتطلب مصدر دليل واحدًا على الأقل.",
        );
    }
    if (
      stepToValidate === 4 &&
      overrideRequired &&
      (!input.modelOverrideAccepted || (input.modelOverrideReason?.trim().length ?? 0) < 12)
    ) {
      errors.configuration = text(
        "Use the recommended configuration or explicitly accept the warning.",
        "استخدم الإعداد الموصى به أو وافق صراحةً على التحذير.",
      );
    }
    setFieldErrors(errors);
    if (errors.objective) objectiveRef.current?.focus();
    return Object.keys(errors).length === 0;
  };

  const goNext = () => {
    if (!validateStep(step)) return;
    setStep((value) => Math.min(5, value + 1));
  };

  const goToStep = (target: number) => {
    if (target <= step) {
      setFieldErrors({});
      setStep(target);
      return;
    }
    if (target === step + 1 && validateStep(step)) setStep(target);
  };

  const applyRecommendedConfiguration = () => {
    if (recommendedModel) {
      update(transitionModel(input, recommendedModel.id));
      setFieldErrors((current) => ({ ...current, configuration: "" }));
    }
  };

  const runSubmission = async (mode: "SAVE" | "BUILD") => {
    if (submissionLockRef.current) return;
    submissionLockRef.current = true;
    setSubmissionMode(mode);
    let navigationStarted = false;
    try {
      const success = await Promise.resolve(build(mode === "BUILD"));
      if (!success) return;
      navigationStarted = true;
      window.location.assign(mode === "BUILD" ? "/contracts/current" : "/tasks/current");
    } finally {
      if (!navigationStarted) {
        submissionLockRef.current = false;
        setSubmissionMode(undefined);
      }
    }
  };

  const submissionBusy = Boolean(submissionMode);
  const draftCanPersist = input.objective.trim().length >= 3
    && (taskContext.kind === "INDEPENDENT" || Boolean(taskContext.projectContextId))
    && input.workspaces.length > 0
    && input.workspaces.every(workspace =>
      workspace.displayName.trim()
      && workspace.role.trim()
      && workspace.reference.trim()
      && workspace.fingerprint.trim()
      && (effectiveDiscoveryScopeMode(workspace, input.taskMode) !== "SELECTED_PATHS"
        || workspace.allowedPaths.length > 0)
    )
    && (!input.readFiles || input.workspaces.some(workspace =>
      effectiveDiscoveryScopeMode(workspace, input.taskMode) !== "NONE"
    ));

  return (
    <section className="page-workspace wizard-page new-task-page" data-product-view="new-task" data-product-journey="objective-first" aria-busy={submissionBusy}>
      <div className="page-heading new-task-heading">
        <div>
          <span className="eyebrow">{title}</span>
          <h1>{stepLabels[step - 1]}</h1>
          <p>{stepDescriptions[step - 1]}</p>
        </div>
        <div className="current-step-indicator" aria-label={text(`Step ${step} of 5`, `الخطوة ${step} من 5`)}>
          <strong>{step}</strong>
          <span>{text("of 5", "من 5")}</span>
        </div>
      </div>
      {hasDownstreamState && (
        <p className="notice warning">{copy.editInvalidationNotice}</p>
      )}
      {notice && <p className="notice error">{notice}</p>}
      <div className="wizard-shell">
        <nav
          className="wizard-sidebar creation-progress"
          aria-label={text("Task creation progress", "تقدم إنشاء المهمة")}
        >
          {stepLabels.map((label, index) => {
            const target = index + 1;
            return (
              <button
                type="button"
                key={label}
                disabled={submissionBusy || target > step + 1}
                className={
                  step === target ? "active" : step > target ? "complete" : ""
                }
                onClick={() => goToStep(target)}
              >
                <span>{target}</span>
                <div>
                  <strong>{label}</strong>
                  <small>{step > target || step === target ? stepSummary[index] : stepDescriptions[index]}</small>
                </div>
              </button>
            );
          })}
        </nav>
        <div className="wizard-main">
          {step === 1 && (
            <section className="wizard-card task-definition-step" data-journey-stage="objective">
              <div className="step-introduction objective-step-introduction">
                <div>
                  <span className="eyebrow">{text("Start here", "ابدأ من هنا")}</span>
                  <h2>{text("Tell IntentChord what you need", "اكتب ما تحتاجه")}</h2>
                  <p>{text(
                    "Describe what you need in your own words. IntentChord will organize the intent, ask for clarification when needed, then move to scope and authority.",
                    "اكتب ما تحتاجه بطريقتك. سينظم IntentChord الهدف، ويطلب التوضيح عند الحاجة، ثم ينتقل إلى النطاق والصلاحيات.",
                  )}</p>
                </div>
              </div>

              <div className="objective-first-layout">
                <label className="wide task-objective-field" data-primary-action="objective-input">
                  <span>{text("What do you need?", "ماذا تحتاج؟")}</span>
                  <textarea
                    ref={objectiveRef}
                    autoFocus
                    aria-invalid={Boolean(fieldErrors.objective)}
                    value={input.objective}
                    placeholder={text(
                      "Example: The update channel creates duplicate tasks and then stops before the Contract is ready.",
                      "مثال: مسار التحديث ينشئ مهام مكررة ثم يتوقف قبل أن يصبح العقد جاهزًا.",
                    )}
                    onChange={(event) => {
                      onObjectiveEdited();
                      update({
                        ...input,
                        objective: event.target.value,
                        title: generatedTaskTitle(event.target.value),
                        titleManuallyEdited: false,
                        modelOverrideAccepted: false,
                      });
                      setFieldErrors((current) => ({ ...current, objective: "" }));
                    }}
                  />
                  <small>{text(
                    "Write the objective in your own words. It can be a result, a problem, or a short request; IntentChord will organize it before the Contract is created.",
                    "اكتب الهدف بطريقتك؛ يمكن أن يكون نتيجة أو مشكلة أو طلبًا مختصرًا، وسيقوم IntentChord بتنظيمه قبل إنشاء العقد.",
                  )}</small>
                  {fieldErrors.objective && <small className="field-error">{fieldErrors.objective}</small>}
                </label>

                {clarificationQuestion && (
                  <section className="intent-clarification" role="status" aria-live="polite" data-owner-action="clarify-objective">
                    <span className="intent-clarification-marker" aria-hidden="true">?</span>
                    <div>
                      <strong>{text("One detail is needed", "مطلوب توضيح واحد")}</strong>
                      <p>{clarificationQuestion}</p>
                      <small>{text(
                        "Add the missing detail to the request above, then continue. IntentChord will update the same Task instead of creating another one.",
                        "أضف التفصيل الناقص إلى الطلب بالأعلى ثم أكمل. سيحدّث IntentChord نفس المهمة بدل إنشاء مهمة أخرى.",
                      )}</small>
                    </div>
                  </section>
                )}

                <div className="generated-title-preview" data-task-title-source="objective" aria-live="polite">
                  <span>{text("Task title", "عنوان المهمة")}</span>
                  <strong>{input.objective.trim() ? generatedTitle : text("Generated after the objective", "يُنشأ بعد كتابة الهدف")}</strong>
                </div>

                <fieldset className="task-mode-guidance task-context-guidance" data-guided-control="task-context">
                  <legend>{text("Where does this work belong?", "هذا العمل تابع لإيه؟")}</legend>
                  <p>{text(
                    "Choose whether this is a standalone Task or work inside a saved Project. The choice is stored with this Task, not as a global application setting.",
                    "اختر هل هذه مهمة مستقلة أم عمل داخل مشروع محفوظ. الاختيار يُحفظ مع المهمة نفسها، وليس كإعداد عام للبرنامج.",
                  )}</p>
                  <div className="task-mode-options task-context-options">
                    <label className={`task-mode-option ${taskContext.kind === "INDEPENDENT" ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="task-context"
                        value="INDEPENDENT"
                        checked={taskContext.kind === "INDEPENDENT"}
                        onChange={() => changeTaskContext(independentTaskContext())}
                      />
                      <span>
                        <strong>{text("Independent task", "مهمة مستقلة")}</strong>
                        <small>{text("Separate work that does not inherit saved Project context.", "عمل منفصل لا يعتمد على سياق مشروع محفوظ.")}</small>
                      </span>
                    </label>
                    <label className={`task-mode-option ${taskContext.kind === "PROJECT_BOUND" ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="task-context"
                        value="PROJECT_BOUND"
                        checked={taskContext.kind === "PROJECT_BOUND"}
                        onChange={() => selectProjectContext("")}
                      />
                      <span>
                        <strong>{text("Inside a project", "داخل مشروع")}</strong>
                        <small>{text("Use the Project identity and its linked Workspace choices. Task authority remains explicit.", "استخدم هوية المشروع ومساحات العمل المرتبطة به، مع بقاء صلاحيات المهمة صريحة.")}</small>
                      </span>
                    </label>
                  </div>
                  {taskContext.kind === "PROJECT_BOUND" && (
                    <div className="project-context-selection">
                      <label className="wide">
                        <span>{text("Project", "المشروع")}</span>
                        <select
                          value={taskContext.projectContextId}
                          aria-invalid={Boolean(fieldErrors.projectContext)}
                          onChange={event => selectProjectContext(event.target.value)}
                        >
                          <option value="">{text("Choose a project", "اختر مشروعًا")}</option>
                          {projectContexts.filter(project => project.status === "ACTIVE").map(project => (
                            <option key={project.id} value={project.id}>{project.displayName}</option>
                          ))}
                        </select>
                      </label>
                      {!projectContexts.some(project => project.status === "ACTIVE") && (
                        <p className="notice info">
                          {text("No project exists yet.", "لا يوجد مشروع محفوظ حتى الآن.")} {" "}
                          <Link href="/project-contexts">{text("Create a project", "إنشاء مشروع")}</Link>
                        </p>
                      )}
                      {fieldErrors.projectContext && <small className="field-error">{fieldErrors.projectContext}</small>}
                    </div>
                  )}
                </fieldset>

                <fieldset className="task-mode-guidance" data-guided-control="work-type">
                  <legend>{text("What should IntentChord do?", "ماذا تريد من IntentChord أن يفعل؟")}</legend>
                  <p>{text(
                    "Choose the kind of work in plain language. This controls the authority that can be requested later.",
                    "اختر نوع العمل بلغة بسيطة. هذا الاختيار يحدد الصلاحيات التي يمكن طلبها لاحقًا.",
                  )}</p>
                  <div className="task-mode-options">
                    {([
                      {
                        value: "CONTROLLED_AUDIT" as const,
                        title: text("Investigate and explain", "يفحص ويشرح"),
                        detail: text("Read-only investigation. No source changes.", "فحص للقراءة فقط دون تعديل المصدر."),
                        technical: copy.controlledAudit,
                      },
                      {
                        value: "SOURCE_IMPLEMENTATION" as const,
                        title: text("Implement or fix", "ينفذ أو يصلح"),
                        detail: text("May request bounded source changes and validation.", "يمكنه طلب تعديلات محددة على المصدر والتحقق منها."),
                        technical: copy.sourceImplementation,
                      },
                      {
                        value: "REPORT_REVIEW" as const,
                        title: text("Review a report", "يراجع تقريرًا"),
                        detail: text("Checks an existing report against governed evidence.", "يفحص تقريرًا موجودًا مقابل الأدلة الحاكمة."),
                        technical: copy.reportReview,
                      },
                    ]).map(option => (
                      <label key={option.value} className={`task-mode-option ${input.taskMode === option.value ? "selected" : ""}`}>
                        <input
                          type="radio"
                          name="task-mode"
                          value={option.value}
                          checked={input.taskMode === option.value}
                          onChange={() => {
                            onObjectiveEdited();
                            update(transitionTaskMode(input, option.value));
                            setFieldErrors({});
                          }}
                        />
                        <span>
                          <strong>{option.title}</strong>
                          <small>{option.detail}</small>
                          <em dir="ltr">{option.technical}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <details className="progressive-disclosure success-conditions-disclosure" data-disclosure="success-conditions">
                  <summary>
                    <span>
                      <strong>{text("Success conditions (optional)", "شروط النجاح (اختيارية)")}</strong>
                      <small>{text(
                        "Add them only when you already know them. IntentChord will propose reviewable requirements from the objective.",
                        "أضفها فقط إذا كانت واضحة لديك. سيقترح IntentChord متطلبات قابلة للمراجعة من الهدف.",
                      )}</small>
                    </span>
                    <span className="disclosure-value">{input.ownerRequirements.length
                      ? text(`${input.ownerRequirements.length} added`, `تمت إضافة ${input.ownerRequirements.length}`)
                      : text("Optional", "اختياري")}</span>
                  </summary>
                  <label className="task-outcomes-field progressive-disclosure-body">
                    <span>{text("What would make this work successful?", "ما الذي يجعل هذا العمل ناجحًا؟")}</span>
                    <textarea
                      value={input.ownerRequirements.map(requirement => `${requirement.id} :: ${requirement.outcome}`).join("\n")}
                      onChange={(event) => {
                        update({
                          ...input,
                          ownerRequirements: parseOwnerRequirementLines(event.target.value, input.taskMode),
                          modelOverrideAccepted: false,
                        });
                      }}
                      placeholder={text(
                        "Optional: one condition per line.",
                        "اختياري: شرط واحد في كل سطر.",
                      )}
                    />
                    <small>{text(
                      "You can leave this empty and review the requirements proposed during intent understanding.",
                      "يمكنك تركه فارغًا ومراجعة المتطلبات التي يقترحها النظام أثناء فهم الهدف.",
                    )}</small>
                  </label>
                </details>

                <details className="progressive-disclosure requested-authorization authorization-workbench" data-disclosure="requested-authorization">
                  <summary>
                    <span>
                      <strong>{text("Requested authorization", "التفويض المطلوب من المالك")}</strong>
                      <small>{text(
                        "Review or change the capabilities requested by this Task. The effective policy is confirmed in step 3.",
                        "راجع أو غيّر الصلاحيات المطلوبة لهذه المهمة. تُحسم السياسة الفعالة في الخطوة الثالثة.",
                      )}</small>
                    </span>
                    <span className="count-chip">{requestedCapabilities.length} {text("requested", "مطلوبة")}</span>
                  </summary>
                  <div className="progressive-disclosure-body">
                    <div className="authorization-primary-list">
                      {authorizationCapabilities.filter(capability => availability.find(item => item.capability === capability)?.effective).map((capability) => {
                        const policy = availability.find(item => item.capability === capability)!;
                        return (
                          <label className="authorization-choice" key={capability}>
                            <input
                              type="checkbox"
                              checked={Boolean(input[capability])}
                              onChange={(event) => update({
                                ...input,
                                [capability]: event.target.checked,
                                modelOverrideAccepted: false,
                              })}
                            />
                            <span>
                              <strong>{copy[authCopyKey[capability]]}</strong>
                              <small>{localizePolicyReason(locale, policy.reason)}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>

                    <details className="advanced-options denied-capabilities">
                      <summary>
                        {text("Unavailable under this policy", "غير متاح وفق هذه السياسة")} ({authorizationCapabilities.filter(capability => !availability.find(item => item.capability === capability)?.effective).length})
                      </summary>
                      <div className="authorization-denied-list">
                        {authorizationCapabilities.filter(capability => !availability.find(item => item.capability === capability)?.effective).map((capability) => {
                          const policy = availability.find(item => item.capability === capability)!;
                          return (
                            <div className="authorization-denied-row" key={capability}>
                              <strong>{copy[authCopyKey[capability]]}</strong>
                              <small>{localizePolicyReason(locale, policy.reason)}</small>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  </div>
                </details>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="wizard-card scope-authority-step" aria-busy={pickerBusy}>
              <div className="scope-step-heading">
                <div>
                  <h2>{stepLabels[1]}</h2>
                  <p>{text(
                    taskContext.kind === "PROJECT_BOUND"
                      ? "Choose from the Workspaces linked to this Project, then grant this Task an explicit read boundary. Project membership alone grants no Task authority."
                      : "Choose or register the Workspace for this independent Task, then grant an explicit read boundary.",
                    taskContext.kind === "PROJECT_BOUND"
                      ? "اختر من مساحات العمل المرتبطة بهذا المشروع، ثم امنح المهمة حدود قراءة صريحة. الارتباط بالمشروع وحده لا يمنح المهمة أي صلاحية."
                      : "اختر أو سجّل مساحة العمل لهذه المهمة المستقلة، ثم امنحها حدود قراءة صريحة.",
                  )}</p>
                  <p className="governed-environment-note task-context-note">
                    <strong>{taskContext.kind === "PROJECT_BOUND" ? text("Project", "المشروع") : text("Task context", "سياق المهمة")}:</strong>{" "}
                    {taskContext.kind === "PROJECT_BOUND"
                      ? taskContext.projectContextDisplayName
                      : text("Independent task", "مهمة مستقلة")}
                  </p>
                </div>
                <div className="registered-workspace-picker">
                  <label>
                    <span>{text("Registered Workspace", "مساحة عمل مسجلة")}</span>
                    <select value={selectedRegisteredWorkspaceId} onChange={event => setSelectedRegisteredWorkspaceId(event.target.value)}>
                      <option value="">{text("Select by name and path", "اختر بالاسم والمسار")}</option>
                      {availableRegisteredWorkspaces.filter(option => !input.workspaces.some(item => item.id === option.id)).map(option => (
                        <option key={option.id} value={option.id}>{option.displayName} · {option.normalizedReference}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="primary-action" disabled={!selectedRegisteredWorkspaceId || pickerBusy} onClick={addRegisteredWorkspace}>
                    {text("Add to this Task", "إضافة للمهمة")}
                  </button>
                </div>
              </div>
              {!availableRegisteredWorkspaces.length && (
                <p className="notice info">
                  {taskContext.kind === "PROJECT_BOUND"
                    ? text("No Workspace is linked to this Project. Link one in Project management before authorizing it for this Task.", "لا توجد مساحة عمل مرتبطة بهذا المشروع. اربط مساحة عمل من إدارة المشاريع قبل منحها صلاحية لهذه المهمة.")
                    : text("No registered Workspace is available yet. Register one below for this independent Task.", "لا توجد مساحة عمل مسجلة حتى الآن. سجّل واحدة بالأسفل لهذه المهمة المستقلة.")} {" "}
                  {taskContext.kind === "PROJECT_BOUND" && <Link href="/project-contexts">{text("Open project management", "فتح إدارة المشاريع")}</Link>}
                </p>
              )}
              <details className="advanced-options register-workspace-fallback">
                <summary>{text("Register a new Workspace or use an advanced fallback", "تسجيل مساحة عمل جديدة أو استخدام إدخال متقدم")}</summary>
                <div className="optional-setup-actions">
                  <button type="button" disabled={pickerBusy} onClick={() => void addWorkspace()}>
                    {pickerOperation?.kind === "WORKSPACE"
                      ? text("Opening Windows selector…", "جارٍ فتح منتقي Windows…")
                      : text("Register with Windows selector", "تسجيل عبر منتقي Windows")}
                  </button>
                  <button type="button" disabled={pickerBusy} onClick={addManualWorkspace}>{text("Enter an unverified path", "إدخال مسار غير موثّق")}</button>
                </div>
              </details>

              {(pickerOperation || pickerNotice) && (
                <div
                  className={`picker-feedback ${pickerOperation ? "pending" : pickerNotice?.tone ?? "neutral"}`}
                  role="status"
                  aria-live="polite"
                >
                  {pickerOperation ? (
                    <>
                      <span className="picker-spinner" aria-hidden="true" />
                      <strong>
                        {pickerOperation.kind === "WORKSPACE"
                          ? text("Opening the Workspace picker. Complete or cancel it before continuing.", "جارٍ فتح نافذة اختيار مساحة العمل. أكملها أو ألغها قبل المتابعة.")
                          : text(
                              `Opening the ${pickerOperation.kind === "FOLDER" ? "folder" : "file"} picker for ${pickerOperation.workspaceName}.`,
                              `جارٍ فتح نافذة اختيار ${pickerOperation.kind === "FOLDER" ? "المجلد" : "الملف"} لمساحة العمل ${pickerOperation.workspaceName}.`,
                            )}
                      </strong>
                    </>
                  ) : <span>{pickerNotice?.message}</span>}
                </div>
              )}

              <div className="workspace-scope-list">
                {input.workspaces.map((workspace, workspaceIndex) => {
                  const discoveryScopeMode = effectiveDiscoveryScopeMode(workspace, input.taskMode);
                  const workspacePickerBusy = pickerOperation?.workspaceId === workspace.id;
                  return (
                    <article className="workspace-scope-card" key={workspace.id}>
                      <header className="workspace-card-summary">
                        <span className="workspace-order">{workspaceIndex + 1}</span>
                        <div className="workspace-identity-fields">
                          <label>
                            <span>{text("Workspace name", "اسم مساحة العمل")}</span>
                            <input value={workspace.displayName} onChange={(event) => updateWorkspace(workspace.id, { displayName: event.target.value })} />
                          </label>
                          <label className="workspace-role-field">
                            <span>{text("Role", "الدور")}</span>
                            <input value={workspace.role} onChange={(event) => updateWorkspace(workspace.id, { role: event.target.value })} />
                          </label>
                        </div>
                        <span className={`scope-summary-chip ${discoveryScopeMode.toLowerCase().replace("_", "-")}`}>
                          {discoveryScopeMode === "FULL_WORKSPACE"
                            ? text("Entire Workspace", "مساحة العمل كاملة")
                            : discoveryScopeMode === "SELECTED_PATHS"
                              ? text(`${workspace.allowedPaths.length} selected`, `${workspace.allowedPaths.length} محدد`)
                              : text("No read access", "بدون قراءة")}
                        </span>
                      </header>

                      <div className="workspace-reference-line">
                        <span>
                          {workspace.id.startsWith("temporary-")
                            ? text("Enter local path", "أدخل المسار المحلي")
                            : text("Selected path", "المسار المحدد")}
                        </span>
                        {workspace.id.startsWith("temporary-") ? (
                          <input
                            className="technical"
                            dir="ltr"
                            value={workspace.reference}
                            placeholder="E:\\project\\source"
                            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                              const reference = event.target.value;
                              const previousAutomaticName = workspaceDisplayNameFromReference(workspace.reference);
                              updateWorkspace(workspace.id, {
                                reference,
                                displayName:
                                  !workspace.displayName.trim() || workspace.displayName === previousAutomaticName
                                    ? workspaceDisplayNameFromReference(reference)
                                    : workspace.displayName,
                              });
                            }}
                          />
                        ) : (
                          <code dir="ltr">{workspace.reference}</code>
                        )}
                      </div>

                      <fieldset className="scope-mode-selector compact">
                        <legend>{text("Discovery / read boundary", "حدود الاكتشاف والقراءة")}</legend>
                        <label>
                          <input type="radio" name={`scope-mode-${workspace.id}`} checked={discoveryScopeMode === "FULL_WORKSPACE"} onChange={() => updateWorkspace(workspace.id, { discoveryScopeMode: "FULL_WORKSPACE", allowedPaths: [] })} />
                          <span><strong>{text("Entire Workspace", "مساحة العمل كاملة")}</strong><small>{text("Read-only discovery from the root.", "اكتشاف للقراءة فقط من الجذر.")}</small></span>
                        </label>
                        <label>
                          <input type="radio" name={`scope-mode-${workspace.id}`} checked={discoveryScopeMode === "SELECTED_PATHS"} onChange={() => updateWorkspace(workspace.id, { discoveryScopeMode: "SELECTED_PATHS" })} />
                          <span><strong>{text("Selected paths", "مسارات محددة")}</strong><small>{text("Choose exact files or folders.", "اختر ملفات أو مجلدات بعينها.")}</small></span>
                        </label>
                        <label>
                          <input type="radio" name={`scope-mode-${workspace.id}`} checked={discoveryScopeMode === "NONE"} onChange={() => updateWorkspace(workspace.id, { discoveryScopeMode: "NONE", allowedPaths: [] })} />
                          <span><strong>{text("No read access", "بدون صلاحية قراءة")}</strong><small>{text("Register without inspection authority.", "تسجيل دون صلاحية فحص.")}</small></span>
                        </label>
                      </fieldset>

                      {discoveryScopeMode === "SELECTED_PATHS" && (
                        <section className="selected-scope-controls">
                          <div className="scope-picker-toolbar">
                            <div>
                              <strong>{text("Selected discovery paths", "مسارات الاكتشاف المحددة")}</strong>
                              <small>{text("One native picker can be open at a time.", "يمكن فتح نافذة اختيار محلية واحدة فقط في كل مرة.")}</small>
                            </div>
                            <div className="scope-picker-actions">
                              <button type="button" disabled={pickerBusy} onClick={() => void selectScopePath(workspace, "FOLDER")}>
                                {workspacePickerBusy && pickerOperation?.kind === "FOLDER" ? text("Opening folder…", "جارٍ فتح المجلد…") : text("Choose folder", "اختيار مجلد")}
                              </button>
                              <button type="button" disabled={pickerBusy} onClick={() => void selectScopePath(workspace, "FILE")}>
                                {workspacePickerBusy && pickerOperation?.kind === "FILE" ? text("Opening file…", "جارٍ فتح الملف…") : text("Choose file", "اختيار ملف")}
                              </button>
                            </div>
                          </div>
                          <PathSelection
                            title={text("Current selection", "التحديد الحالي")}
                            items={workspace.allowedPaths}
                            empty={text("No paths selected yet.", "لم يتم تحديد مسارات بعد.")}
                            remove={(value) => updateWorkspace(workspace.id, { allowedPaths: workspace.allowedPaths.filter(item => item !== value) })}
                            removeLabel={copy.remove}
                          />
                          <details className="advanced-options compact-advanced">
                            <summary>{text("Advanced: enter a relative path", "متقدم: إدخال مسار نسبي")}</summary>
                            <ScopedPathEditor workspace={workspace} kind="allowedPaths" update={updateWorkspace} locale={locale} />
                          </details>
                        </section>
                      )}

                      <details className="advanced-options workspace-details">
                        <summary>{text("Exclusions and Workspace controls", "الاستبعادات والتحكم في مساحة العمل")}</summary>
                        <ScopedPathEditor workspace={workspace} kind="excludedPaths" update={updateWorkspace} locale={locale} />
                        <div className="workspace-card-actions">
                          <button type="button" disabled={workspace.ordering === 0 || pickerBusy} onClick={() => moveWorkspace(workspace.id, -1)}>{text("Move up", "نقل لأعلى")}</button>
                          <button type="button" disabled={workspace.ordering === input.workspaces.length - 1 || pickerBusy} onClick={() => moveWorkspace(workspace.id, 1)}>{text("Move down", "نقل لأسفل")}</button>
                          <button type="button" disabled={pickerBusy} onClick={() => removeWorkspace(workspace.id)}>{copy.remove}</button>
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>

              {input.workspaces.length === 0 && (
                <div className="owner-empty-state">
                  <strong>{text("No Workspace selected", "لم يتم اختيار مساحة عمل")}</strong>
                  <p>{text("Add the project roots the agent may inspect.", "أضف جذور المشروعات التي يحق للوكيل فحصها.")}</p>
                </div>
              )}

              <details className="advanced-options setup-optional">
                <summary>{text("Optional evidence and advanced fallback", "أدلة اختيارية وإدخال متقدم")}</summary>
                <div className="optional-setup-actions">
                  <label className="file-picker-button secondary-picker">
                    {copy.attachEvidence}
                    <input type="file" multiple disabled={pickerBusy} accept=".json,.md,.txt,.log,.csv" onChange={(event) => attachEvidence(event.target.files)} />
                  </label>
                </div>
                <PathSelection
                  title={text("Preselected supporting evidence", "الأدلة الداعمة المحددة مسبقًا")}
                  items={input.evidenceFiles}
                  empty={text("No supporting evidence preselected.", "لم يتم تحديد أدلة داعمة مسبقًا.")}
                  remove={(value) => removeItem("evidenceFiles", value)}
                  removeLabel={copy.remove}
                />
              </details>

              {fieldErrors.workspace && pickerNotice?.tone !== "error" && <p className="field-error block-error">{fieldErrors.workspace}</p>}
              {fieldErrors.scope && pickerNotice?.tone !== "error" && <p className="field-error block-error">{fieldErrors.scope}</p>}
            </section>
          )}

          {step === 3 && (
            <section className="wizard-card">
              <h2>{stepLabels[2]}</h2>
              <div className="authorization-resolution-grid">
                <DetailBlock
                  title={text("Requested by owner", "المطلوب من المالك")}
                >
                  <SimpleList
                    items={requestedCapabilities.map(
                      (capability) => copy[authCopyKey[capability]],
                    )}
                    empty={copy.noItems}
                  />
                </DetailBlock>
                <DetailBlock
                  title={text("Effective under policy", "الفعّال وفق السياسة")}
                >
                  <SimpleList
                    items={effectiveCapabilities.map(
                      (capability) => copy[authCopyKey[capability]],
                    )}
                    empty={copy.noItems}
                  />
                </DetailBlock>
              </div>
              {reconciledCapabilities.length > 0 ? (
                <div className="reconciliation-list">
                  <h3>{text("Policy reconciliation", "تسوية السياسة")}</h3>
                  {reconciledCapabilities.map((decision) => (
                    <article
                      className="reconciliation-card"
                      key={decision.capability}
                    >
                      <div>
                        <strong>
                          {copy[authCopyKey[decision.capability]]}
                        </strong>
                        <span className="source-badge policy">
                          {decision.source}
                        </span>
                      </div>
                      <p>{localizePolicyReason(locale, decision.reason)}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="notice success">
                  <strong>
                    {text("Authorization resolved", "تم حل الصلاحيات")}
                  </strong>
                  <p>
                    {text(
                      "The requested set already matches the effective policy set.",
                      "المجموعة المطلوبة مطابقة بالفعل للمجموعة الفعالة وفق السياسة.",
                    )}
                  </p>
                </div>
              )}
              <div className="policy-review-list">
                {policyTrace
                  .filter(
                    (decision) => decision.requested || decision.effective,
                  )
                  .map((decision) => (
                    <article
                      className={`authorization-result ${decision.effective ? "permitted" : "denied"}`}
                      key={decision.capability}
                    >
                      <div>
                        <strong>
                          {copy[authCopyKey[decision.capability]]}
                        </strong>
                        <span className="technical-inline" dir="ltr">
                          {decision.capability}
                        </span>
                      </div>
                      <dl>
                        <dt>{copy.requested}</dt>
                        <dd>{decision.requested ? copy.yes : copy.no}</dd>
                        <dt>{copy.effective}</dt>
                        <dd>{decision.effective ? copy.yes : copy.no}</dd>
                        <dt>{copy.authority}</dt>
                        <dd className="technical-inline" dir="ltr">
                          {decision.source}
                        </dd>
                      </dl>
                      <p>{localizePolicyReason(locale, decision.reason)}</p>
                    </article>
                  ))}
              </div>
            </section>
          )}

          {step === 4 && (
            <section className="wizard-card">
              <h2>{stepLabels[3]}</h2>
              <p className="task-execution-setup-note">{text("This setup belongs to task execution method, not workspace analysis.", "هذا الإعداد يخص طريقة تنفيذ المهمة، وليس تحليل مساحة العمل.")}</p>
              <div className="provider-choice-grid">
                {providerIds.map((id) => (
                  <button
                    type="button"
                    key={id}
                    className={input.providerId === id ? "selected" : ""}
                    onClick={() => update(transitionProvider(input, id))}
                  >
                    <strong>{providerRegistry[id].displayName}</strong>
                    <span>{providerRegistry[id].executionChannelName}</span>
                  </button>
                ))}
              </div>
              {provider && selectedModel ? (
                <>
                  <div className="form-grid provider-grid">
                    <label>
                      {copy.model}
                      <select
                        value={input.modelId}
                        onChange={(event) =>
                          update(
                            transitionModel(input, event.target.value as ModelId),
                          )
                        }
                      >
                        {providerModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName} · {model.lifecycle}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {copy.executionChannel}
                      <input value={provider.executionChannelName} readOnly />
                    </label>
                    <label>
                      {copy.reasoningProfile}
                      <select
                        value={input.reasoningProfile}
                        onChange={(event) =>
                          update(
                            transitionReasoning(
                              input,
                              event.target.value as ReasoningProfile,
                            ),
                          )
                        }
                      >
                        {selectedModel.allowedReasoningProfiles.map((value: ReasoningProfile) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {copy.runtimeProfile}
                      <select
                        value={input.runtimeProfileId}
                        onChange={(event) =>
                          update(
                            transitionRuntimeProfile(
                              input,
                              event.target.value as RuntimeProfileId,
                            ),
                          )
                        }
                      >
                        {runtimeProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {configuration.recommendation && recommendedModel && recommendedRuntimeProfile && (
                    <article className={`recommendation-card ${recommendationClass}`}>
                      <div className="recommendation-head">
                        <div>
                          <span>{copy.modelRecommendation}</span>
                          <span className="source-badge policy">NON_AUTHORITATIVE_PREVIEW</span>
                          <strong dir="ltr">
                            {configuration.recommendation.assessmentStatus} · {configuration.recommendation.status}
                          </strong>
                        </div>
                        <span>
                          {copy.recommendedModel}: {recommendedModel.displayName} ·{" "}
                          {recommendedModel.defaultReasoningProfile} ·{" "}
                          {recommendedRuntimeProfile.displayName}
                        </span>
                      </div>
                      <details className="advanced-options recommendation-details">
                        <summary>{text("Recommendation evidence and technical metrics", "أدلة التوصية والمقاييس الفنية")}</summary>
                        <div className="recommendation-columns" style={{ marginTop: "0.75rem" }}>
                          <div>
                            <h3>{copy.recommendationWhy}</h3>
                            <SimpleList
                              items={configuration.recommendation.reasons.map((item) =>
                                localizeRecommendationText(locale, item),
                              )}
                              empty={copy.noItems}
                            />
                          </div>
                          <div>
                            <h3>{copy.recommendationActions}</h3>
                            <SimpleList
                              items={configuration.recommendation.recommendedActions.map(
                                (item) => localizeRecommendationText(locale, item),
                              )}
                              empty={copy.noItems}
                            />
                          </div>
                        </div>
                        <div className="semantic-grid" style={{ marginTop: "0.75rem" }}>
                          <StateCard
                            label={copy.taskComplexity}
                            value={configuration.task.complexity}
                            technicalValue
                          />
                          <StateCard
                            label={copy.crossFileDependency}
                            value={configuration.task.crossFileDependency}
                            technicalValue
                          />
                          <StateCard
                            label={copy.validationDepth}
                            value={configuration.task.validationDepth}
                            technicalValue
                          />
                          <StateCard
                            label={copy.sourceModificationRequired}
                            value={
                              configuration.task.sourceModificationRequired
                                ? copy.yes
                                : copy.no
                            }
                          />
                        </div>
                        <SimpleList
                          items={configuration.task.reasons.map((item) =>
                            localizeTaskSemanticReason(locale, item),
                          )}
                          empty={copy.noItems}
                        />
                      </details>
                      {recommendedModel.id !== selectedModel.id && (
                        <button type="button" onClick={applyRecommendedConfiguration}>
                          {text(
                            `Use ${recommendedModel.displayName} · ${recommendedModel.defaultReasoningProfile} · ${recommendedRuntimeProfile.displayName}`,
                            `استخدام ${recommendedModel.displayName} · ${recommendedModel.defaultReasoningProfile} · ${recommendedRuntimeProfile.displayName}`,
                          )}
                        </button>
                      )}
                      {overrideRequired && (
                        <label className="override-acceptance">
                          <input
                            type="checkbox"
                            checked={input.modelOverrideAccepted}
                            onChange={(event) => {
                              update({
                                ...input,
                                modelOverrideAccepted: event.target.checked,
                                modelOverrideReason: event.target.checked
                                  ? input.modelOverrideReason ?? ""
                                  : "",
                              });
                              setFieldErrors((current) => ({
                                ...current,
                                configuration: "",
                              }));
                            }}
                          />
                          {copy.acceptModelWarning}
                          {input.modelOverrideAccepted && (
                            <textarea
                              value={input.modelOverrideReason ?? ""}
                              onChange={(event) => update({
                                ...input,
                                modelOverrideReason: event.target.value,
                              })}
                              placeholder={
                                ar
                                  ? "سبب قبول تجاوز توصية Backend (12 حرفًا على الأقل)"
                                  : "Reason for overriding the Backend recommendation (minimum 12 characters)"
                              }
                            />
                          )}
                        </label>
                      )}
                      {fieldErrors.configuration && (
                        <small className="field-error">
                          {fieldErrors.configuration}
                        </small>
                      )}
                    </article>
                  )}
                </>
              ) : (
                <div className="empty-state" style={{ marginTop: "1rem" }}>
                  <p>{text("Select an AI provider above to configure execution setup.", "حدد مزود الذكاء الاصطناعي أعلاه لتهيئة إعدادات التنفيذ.")}</p>
                </div>
              )}
            </section>
          )}

          {step === 5 && (
            <section className="wizard-card review-card">
              <h2>{stepLabels[4]}</h2>
              <div className="review-summary-grid">
                <DetailBlock title={copy.objective}>
                  <p>{input.objective || copy.noItems}</p>
                </DetailBlock>
                <DetailBlock title={copy.authorization}>
                  <p>
                    {requestedCapabilities.length} {text("requested", "مطلوبة")}{" "}
                    · {effectiveCapabilities.length}{" "}
                    {text("effective", "فعالة")}
                  </p>
                </DetailBlock>
                <DetailBlock title={copy.workspaceSelected}>
                  {input.workspaces.length ? (
                    <ul className="compact-list">
                      {input.workspaces.map((workspace) => (
                        <li key={workspace.id}>
                          <strong>{workspace.displayName}</strong>
                          <span>
                            {workspace.role} · {effectiveDiscoveryScopeMode(workspace, input.taskMode)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{copy.noItems}</p>
                  )}
                </DetailBlock>
                <DetailBlock title={copy.scopeAndEvidence}>
                  <p>
                    {input.allowedPaths.length}{" "}
                    {text(
                      "authorized discovery/read paths",
                      "مسارات اكتشاف/قراءة مصرح بها",
                    )}{" "}
                    · {input.excludedPaths.length} {copy.selectedExcluded} ·{" "}
                    {workspaceEvidence.length}{" "}
                    {text(
                      "preselected supporting evidence",
                      "أدلة داعمة محددة مسبقًا",
                    )}{" "}
                    · {uploadedEvidence.length} {text("uploads", "مرفقات")}
                  </p>
                </DetailBlock>
                <DetailBlock title={copy.aiConfiguration}>
                  {provider && selectedModel ? (
                    <>
                      <p>
                        {provider.displayName} · {selectedModel.displayName} ·{" "}
                        {input.reasoningProfile ?? selectedModel.defaultReasoningProfile} ·{" "}
                        {
                          runtimeProfileForProvider(
                            input.runtimeProfileId ?? defaultRuntimeProfileForProvider(provider.id),
                            provider.id,
                          ).displayName
                        }
                      </p>
                      {configuration.recommendation && <p dir="ltr">{configuration.recommendation.status}</p>}
                    </>
                  ) : (
                    <p>{text("Execution model: NOT_SELECTED / INCOMPLETE", "نموذج التنفيذ: لم يُحدد بعد")}</p>
                  )}
                </DetailBlock>
              </div>
              <RecommendationSummary
                contract={resolvedContract}
                copy={copy}
                locale={locale}
              />
            </section>
          )}

          {submissionBusy && (
            <div className="submission-progress" role="status" aria-live="polite">
              <span className="submission-spinner" aria-hidden="true" />
              <div>
                <strong>{operationPhase
                  ? text(operationPhaseMessage[operationPhase].en, operationPhaseMessage[operationPhase].ar)
                  : submissionMode === "BUILD"
                    ? text("Preparing the governed operation…", "جارٍ تجهيز العملية الحاكمة…")
                    : text("Saving the Task draft…", "جارٍ حفظ مسودة المهمة…")}</strong>
                <small>{text("Keep this page open. The action is locked to one Task; retry resumes that same Task from its last authoritative state.", "اترك الصفحة مفتوحة. العملية مرتبطة بمهمة واحدة، وإعادة المحاولة تستكمل نفس المهمة من آخر حالة حاكمة.")}</small>
              </div>
            </div>
          )}
          <footer className="wizard-footer">
            <button
              type="button"
              disabled={submissionBusy || step === 1}
              onClick={() => {
                setFieldErrors({});
                setStep((value) => Math.max(1, value - 1));
              }}
            >
              {text("Previous", "السابق")}
            </button>
            <button
              type="button"
              disabled={submissionBusy || !draftCanPersist}
              title={!draftCanPersist ? text("Complete the verified Workspace and read scope before saving the Task.", "أكمل مساحة العمل الموثقة ونطاق القراءة قبل حفظ المهمة.") : undefined}
              onClick={() => void runSubmission("SAVE")}
            >
              {submissionMode === "SAVE" ? text("Saving…", "جارٍ الحفظ…") : copy.saveDraft}
            </button>
            {step < 5 ? (
              <button type="button" className="primary" disabled={submissionBusy} onClick={goNext}>
                {text("Next", "التالي")}
              </button>
            ) : (
              <button type="button" className="primary" disabled={submissionBusy} onClick={() => void runSubmission("BUILD")}>
                {submissionMode === "BUILD"
                  ? text("Creating Contract…", "جارٍ إنشاء العقد…")
                  : copy.buildContract}
              </button>
            )}
          </footer>
        </div>
      </div>
    </section>
  );
}

function CompactSection({
  title,
  count,
  open,
  toggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  toggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="compact-section">
      <button
        type="button"
        className="compact-section-summary"
        aria-expanded={open}
        onClick={toggle}
      >
        <strong>{title}</strong>
        <span>{count}</span>
      </button>
      {open && <div className="compact-section-editor">{children}</div>}
    </section>
  );
}

function ScopedPathEditor({
  workspace,
  kind,
  update,
  locale,
}: {
  workspace: WorkspaceReference;
  kind: "allowedPaths" | "excludedPaths";
  update: (id: string, changes: Partial<WorkspaceReference>) => void;
  locale: Locale;
}) {
  const [value, setValue] = useState("");
  const label =
    kind === "allowedPaths"
      ? locale === "ar"
        ? "نطاق مسموح"
        : "Allowed scope"
      : locale === "ar"
        ? "نطاق مستبعد"
        : "Excluded scope";
  const add = () => {
    const path = value.trim();
    if (path && !workspace[kind].includes(path))
      update(workspace.id, { [kind]: [...workspace[kind], path] });
    setValue("");
  };
  return (
    <section className="scoped-path-editor">
      <h3>
        {workspace.displayName || workspace.id} · {label}
      </h3>
      <div>
        <input
          className="technical"
          dir="ltr"
          value={value}
          placeholder={locale === "ar" ? "مثال: src أو Cargo.toml" : "Example: src or Cargo.toml"}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" onClick={add} disabled={!value.trim()}>
          {locale === "ar" ? "إضافة" : "Add"}
        </button>
      </div>
      {workspace[kind].length ? (
        <ul className="technical-list" dir="ltr">
          {workspace[kind].map((path) => (
            <li key={path}>
              <span>{path}</span>
              <button
                type="button"
                aria-label={locale === "ar" ? `إزالة: ${path}` : `Remove: ${path}`}
                onClick={() =>
                  update(workspace.id, {
                    [kind]: workspace[kind].filter((item) => item !== path),
                  })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>{locale === "ar" ? "لا توجد عناصر" : "No entries"}</p>
      )}
    </section>
  );
}

function PathSelection({
  title,
  items,
  empty,
  remove,
  removeLabel,
}: {
  title: string;
  items: string[];
  empty: string;
  remove: (value: string) => void;
  removeLabel: string;
}) {
  return (
    <section className="path-selection">
      <h3>{title}</h3>
      {items.length ? (
        <ul dir="ltr">
          {items.map((item) => (
            <li key={item}>
              <span>{item}</span>
              <button
                type="button"
                aria-label={`${removeLabel}: ${item}`}
                onClick={() => remove(item)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

export function ContractWorkbench({
  contract,
  activeRun: executionRun,
  copy,
  locale,
  tab,
  setTab,
  approve,
  prepareExecution,
  promptLocale,
  setPromptLocale,
  notice,
  continueHref,
}: {
  contract: ExecutionContract;
  activeRun?: RunRecord;
  copy: TranslationCopy;
  locale: Locale;
  tab: ContractTab;
  setTab: (tab: ContractTab) => void;
  approve: () => void;
  prepareExecution: () => void | boolean | Promise<boolean>;
  promptLocale: Locale;
  setPromptLocale: (locale: Locale) => void;
  notice: string;
  continueHref: string;
}) {
  const preflight = approvalState(contract);
  const prompt = executionRun?.compiledArtifact?.text ?? compiledPromptForLocale(
    contract,
    promptLocale,
    executionRun
      ? {
          activeRunId: executionRun.id,
          round: executionRun.round,
          executionType: executionRun.executionType,
          parentRunId: executionRun.parentRunId,
          bindingMarker: executionRun.bindingMarker,
        }
      : undefined,
  );
  const tabLabels: Record<ContractTab, string> = {
    summary: copy.summaryTab,
    scope: copy.scopeTab,
    authorization: copy.authorizationTab,
    policy: copy.policyDecisionsTab,
    checks: copy.checksClosureTab,
    prompt: copy.agentPromptTab,
  };
  const nextAction = preflight.canApprove
    ? copy.approveThisContract
    : preflight.canExecute
      ? copy.continueExecutionSentence
      : contract.ownerApproval.state === "APPROVED"
        ? copy.approvedNoAction
        : copy.resolveIssues;
  const promptStateText =
    contract.ownerApproval.state !== "APPROVED"
      ? copy.previewNotExecutable
      : executionRun
        ? `${copy.runId}: ${executionRun.id}`
        : locale === "ar"
          ? "تمت موافقة المالك. المعاينة غير قابلة للتنفيذ حتى إنشاء Active Run."
          : "Owner approval is recorded. This preview is not executable until an Active Run is created.";

  return (
    <section className="two-column workbench-layout">
      <div className="workspace page-workspace">
        <div className="page-heading">
          <div>
            <h1>{copy.contractReview}</h1>
            <p>{technical(contract.contractId)}</p>
          </div>
        </div>
        <TabBar
          items={contractTabOrder}
          active={tab}
          labels={tabLabels}
          setActive={setTab}
        />
        {tab === "summary" && (
          <section className="workbench-section">
            <div className="state-grid">
              <StateCard
                label={copy.contractApproval}
                value={contract.ownerApproval.state}
                technicalValue
              />
              <StateCard
                label={copy.provider}
                value={
                  providerRegistry[contract.selectedConfiguration.providerId]
                    .displayName
                }
              />
              <StateCard
                label={copy.model}
                value={contract.agentResolution.modelDisplayName}
              />
              <StateCard
                label={copy.executionChannel}
                value={contract.agentResolution.executionChannelName}
              />
              <StateCard
                label={copy.reasoningProfile}
                value={contract.selectedConfiguration.reasoningProfile}
                technicalValue
              />
              <StateCard
                label={copy.runtimeProfile}
                value={contract.agentResolution.runtimeProfileName}
              />
              <StateCard
                label={copy.modelRecommendation}
                value={contract.configurationRecommendation.status}
                technicalValue
              />
              <StateCard
                label={copy.taskModeLabel}
                value={contract.taskMode}
                technicalValue
              />
              <StateCard
                label={copy.preflightReadiness}
                value={
                  preflight.issues.length
                    ? `${preflight.issues.length} ${copy.preflightIssues}`
                    : copy.ready
                }
              />
            </div>
            {contract.intentResolution && (
              <section className="intent-understanding-card">
                <div>
                  <span className="eyebrow">
                    {locale === "ar" ? "فهم IntentChord المعتمد" : "Confirmed IntentChord understanding"}
                  </span>
                  <h2>{contract.intentResolution.normalizedTopic}</h2>
                  <p>{contract.intentResolution.ownerSummary}</p>
                </div>
                <div className="intent-understanding-meta">
                  <span>
                    {locale === "ar" ? "متطلبات التحقيق" : "Investigation requirements"}: {contract.executionPackage.mandatoryRequirements.length}
                  </span>
                  <span>
                    {locale === "ar" ? "حالة هوية الأدلة" : "Evidence identity"}: {contract.evidenceIdentityState === "NOT_ESTABLISHED"
                      ? (locale === "ar" ? "لم تُنشأ بعد" : "Not established yet")
                      : contract.evidenceIdentityState}
                  </span>
                </div>
              </section>
            )}
            {contract.discoveryResolution && (
              <section className="intent-understanding-card">
                <div>
                  <span className="eyebrow">
                    {locale === "ar" ? "خريطة الاكتشاف المقيّد" : "Bounded Discovery Map"}
                  </span>
                  <h2>
                    {locale === "ar" ? "تم تقييم نطاق التحقيق" : "Investigation scope assessed"}
                  </h2>
                  <p>
                    {locale === "ar"
                      ? `تم فحص ${contract.discoveryResolution.assessment.inspectedFileCount} ملفًا مرشحًا داخل ${contract.discoveryResolution.assessment.workspaceCount} مساحة عمل دون تعديل السورس.`
                      : `${contract.discoveryResolution.assessment.inspectedFileCount} candidate files were inspected across ${contract.discoveryResolution.assessment.workspaceCount} workspaces without source modification.`}
                  </p>
                </div>
                <div className="intent-understanding-meta">
                  <span>
                    {locale === "ar" ? "التعقيد" : "Complexity"}: {contract.discoveryResolution.assessment.complexity}
                  </span>
                  <span>
                    {locale === "ar" ? "ترابط مساحات العمل" : "Cross-workspace dependency"}: {contract.discoveryResolution.assessment.crossWorkspaceDependency}
                  </span>
                  <span>
                    {locale === "ar" ? "فجوات الأدلة" : "Evidence gaps"}: {contract.discoveryResolution.evidenceGaps.length}
                  </span>
                </div>
              </section>
            )}
            <RecommendationSummary
              contract={contract}
              copy={copy}
              locale={locale}
            />
            <div className="next-action">
              <strong>{copy.exactNextOwnerAction}</strong>
              <p>{nextAction}</p>
            </div>
            {notice && <p className="notice error">{notice}</p>}
            <h2>{copy.preflightIssues}</h2>
            {preflight.issues.length === 0 ? (
              <p>{copy.noPreflightIssues}</p>
            ) : (
              <div className="issue-list">
                {preflight.issues.map((raw) => {
                  const issue = localizePreflightIssue(locale, raw);
                  return (
                    <article
                      className="issue-card"
                      key={`${issue.code}-${issue.field}`}
                    >
                      <div>
                        <strong className="technical-inline" dir="ltr">
                          {issue.code}
                        </strong>
                        <span
                          className={`severity ${issue.severity.toLowerCase()}`}
                        >
                          {issue.severity}
                        </span>
                      </div>
                      <p>{issue.message}</p>
                      <dl>
                        <dt>{copy.issueField}</dt>
                        <dd className="technical-inline" dir="ltr">
                          {issue.field}
                        </dd>
                        <dt>{copy.recommendedCorrection}</dt>
                        <dd>{issue.recommendedCorrection}</dd>
                      </dl>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}
        {tab === "scope" && (
          <ScopeSection contract={contract} copy={copy} locale={locale} />
        )}
        {tab === "authorization" && (
          <AuthorizationSection
            contract={contract}
            copy={copy}
            locale={locale}
          />
        )}
        {tab === "policy" && (
          <PolicyDecisionTrace
            decisions={contract.policyDecisionTrace}
            copy={copy}
            locale={locale}
          />
        )}
        {tab === "checks" && (
          <ChecksSection contract={contract} copy={copy} locale={locale} />
        )}
        {tab === "prompt" && (
          <section className="workbench-section prompt-workbench">
            <div className="section-heading-row">
              <div>
                <h2>{copy.compiledAgentPrompt}</h2>
                <p>
                  {executionRun ? "AUTHORITATIVE_STORED_ARTIFACT" : "NON_AUTHORITATIVE_PREVIEW"} · {promptStateText}
                </p>
              </div>
              <label className="prompt-locale-label">
                {copy.agentPromptLanguage}
                <select
                  value={promptLocale}
                  onChange={(event) =>
                    setPromptLocale(event.target.value as Locale)
                  }
                >
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                </select>
              </label>
            </div>
            <AgentResolutionPreview contract={contract} locale={promptLocale} />
            <pre
              className="prompt-preview"
              dir={promptLocale === "ar" ? "rtl" : "ltr"}
            >
              {prompt}
            </pre>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(prompt)}
            >
              {copy.copyAgentPrompt}
            </button>
          </section>
        )}
        <div className="action-bar sticky-actions">
          {contract.ownerApproval.state !== "APPROVED" && (
            <button
              type="button"
              className="primary"
              disabled={!preflight.canApprove}
              onClick={approve}
            >
              {copy.approve}
            </button>
          )}
          {preflight.canExecute && (
            <Link
              className="primary-link"
              href={continueHref}
              onClick={(event) => {
                event.preventDefault();
                void Promise.resolve(prepareExecution()).then((ready) => {
                  if (ready !== false) window.location.assign(continueHref);
                });
              }}
            >
              {copy.continueExecution}
            </Link>
          )}
        </div>
      </div>
      <ContractStateSummary
        contract={contract}
        preflightIssues={preflight.issues.length}
        copy={copy}
      />
    </section>
  );
}

function ExecutionPanel({
  task,
  run,
  copy,
  locale,
  prepareBridge,
}: {
  task: TaskRecord;
  run?: RunRecord;
  copy: TranslationCopy;
  locale: Locale;
  prepareBridge: () => void | boolean | Promise<boolean>;
}) {
  const contract = task.contract!;
  const effective = contract.policyDecisionTrace
    .filter((item) => item.effective)
    .map((item) => copy[authCopyKey[item.capability]]);
  const executablePrompt = run?.compiledArtifact?.text;
  const bindingMarker = run?.bindingMarker;
  const evidenceIdentityDisplay = contract.evidenceIdentityState === "NOT_ESTABLISHED"
    ? (locale === "ar" ? "لم تُنشأ بعد — تُربط عند وصول الدليل" : "Not established yet — bound when evidence arrives")
    : contract.evidenceIdentity.sessionId
      ?? contract.evidenceIdentity.runId
      ?? contract.evidenceIdentityState;
  const ownerDiscoveryScope = contract.scope.workspaces
    .filter(workspace => workspace.effectiveReadBoundary !== "NONE")
    .map(workspace => {
      const boundary = workspace.effectiveReadBoundary === "WORKSPACE_ROOT"
        ? (locale === "ar" ? "مساحة العمل كاملة" : "Full workspace")
        : (locale === "ar" ? `${workspace.allowedPaths.length} مسار محدد` : `${workspace.allowedPaths.length} selected path(s)`);
      return `${workspace.displayName} — ${workspace.role} — ${boundary}`;
    });
  return (
    <section className="workspace page-workspace">
      <div className="page-heading">
        <div>
          <h1>{copy.execution}</h1>
          <p>{copy.executionContext}</p>
        </div>
      </div>
      <div className="state-grid execution-state-grid">
        <StateCard
          label={copy.round}
          value={run ? String(run.round) : copy.notAssigned}
        />
        <StateCard
          label={copy.provider}
          value={
            providerRegistry[contract.selectedConfiguration.providerId]
              .displayName
          }
        />
        <StateCard
          label={copy.model}
          value={contract.agentResolution.modelDisplayName}
        />
        <StateCard
          label={copy.executionChannel}
          value={contract.agentResolution.executionChannelName}
        />
        <StateCard
          label={copy.reasoningProfile}
          value={contract.selectedConfiguration.reasoningProfile}
          technicalValue
        />
        <StateCard
          label={copy.runtimeProfile}
          value={contract.agentResolution.runtimeProfileName}
        />

        <StateCard
          label={copy.taskMode}
          value={contract.taskMode}
          technicalValue
        />
      </div>
      <details className="advanced-audit execution-audit">
        <summary>Advanced Audit</summary>
        <dl>
          <dt>{copy.taskId}</dt><dd dir="ltr">{task.id}</dd>
          <dt>{copy.contractId}</dt><dd dir="ltr">{contract.contractId}</dd>
          <dt>{copy.runId}</dt><dd dir="ltr">{run?.id ?? copy.notStarted}</dd>
          <dt>{copy.evidenceIdentity}</dt><dd dir="ltr">{evidenceIdentityDisplay}</dd>
          {bindingMarker && <><dt>{copy.bindingMarker}</dt><dd dir="ltr">{bindingMarker}</dd></>}
        </dl>
      </details>
      <section className="execution-context-grid">
        <DetailBlock
          title={
            locale === "ar"
              ? "نطاق الاكتشاف والقراءة المصرح"
              : "Authorized discovery / read scope"
          }
        >
          <SimpleList
            items={ownerDiscoveryScope}
            empty={copy.noItems}
          />
        </DetailBlock>
        <DetailBlock
          title={
            locale === "ar"
              ? "نطاق التعديل المصرح"
              : "Authorized modification scope"
          }
        >
          <TechnicalList
            items={
              contract.policyDecisionTrace.some(
                (item) => item.capability === "modifySource" && item.effective,
              )
                ? ownerDiscoveryScope
                : []
            }
            empty={copy.noItems}
          />
        </DetailBlock>
        <DetailBlock title={copy.effectiveAuthorizations}>
          <SimpleList items={effective} empty={copy.noItems} />
        </DetailBlock>
      </section>
      <p className="notice info scope-authority-notice">
        <strong>
          {locale === "ar"
            ? "هذه المسارات حدود تفويض وليست إثباتًا للكفاية أو الصلة."
            : "These paths are an authority boundary, not proof of relevance or completeness."}
        </strong>
        <span>
          {locale === "ar"
            ? "أي مسار إضافي يتطلب توقفًا بتصنيف EVIDENCE_REQUIRED وطلب توسيع محدد قبل الفحص أو التعديل."
            : "Any additional path requires an EVIDENCE_REQUIRED stop and an exact scope-expansion request before inspection or modification."}
        </span>
      </p>
      {executablePrompt && (
        <details className="execution-prompt" open>
          <summary>
            <strong>{copy.executableContract}</strong>
            <span>
              {copy.reportRunIdInstruction.replace("{runId}", run!.id)}
            </span>
          </summary>
          <pre
            className="prompt-preview"
            dir={(task.promptLocale ?? locale) === "ar" ? "rtl" : "ltr"}
          >
            {executablePrompt}
          </pre>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(executablePrompt)}
          >
            {copy.copyAgentPrompt}
          </button>
        </details>
      )}
      <div className="execution-choice-grid">
        <section className="execution-choice">
          <h2>{copy.openBridge}</h2>
          <p>{copy.bridgeHelp}</p>
          <Link
            className="primary-link"
            href="/bridge"
            onClick={(event) => {
              event.preventDefault();
              void Promise.resolve(prepareBridge()).then((ready) => {
                if (ready !== false) window.location.assign("/bridge");
              });
            }}
          >
            {copy.openBridge}
          </Link>
        </section>
      </div>
    </section>
  );
}

function RunReview({
  task,
  contract,
  run,
  copy,
  locale,
  tab,
  setTab,
  recordDecision,
  updateNotes,
  startCorrection,
}: {
  task: TaskRecord;
  contract: ExecutionContract;
  run: RunRecord;
  copy: TranslationCopy;
  locale: Locale;
  tab: ReviewTab;
  setTab: (tab: ReviewTab) => void;
  recordDecision: (run: RunRecord, decision: Exclude<Decision, "NONE">, reason?: string) => void;
  updateNotes: (run: RunRecord, notes: string) => void;
  startCorrection: (run: RunRecord) => void | boolean | Promise<boolean>;
}) {
  return (
    <ReviewWorkbench
      task={task}
      contract={contract}
      run={run}
      copy={copy}
      locale={locale}
      tab={tab}
      setTab={setTab}
      recordDecision={(decision) => recordDecision(run, decision, run.correctionNotes)}
      updateNotes={(notes) => updateNotes(run, notes)}
      startCorrectionHref="/bridge"
      startCorrection={() => startCorrection(run)}
    />
  );
}

function ReviewWorkbench({
  task,
  contract,
  run,
  copy,
  locale,
  tab,
  setTab,
  recordDecision,
  updateNotes,
  startCorrectionHref,
  startCorrection,
}: {
  task?: TaskRecord;
  contract: ExecutionContract;
  run: RunRecord;
  copy: TranslationCopy;
  locale: Locale;
  tab: ReviewTab;
  setTab: (tab: ReviewTab) => void;
  recordDecision: (decision: Exclude<Decision, "NONE">) => void;
  updateNotes: (notes: string) => void;
  startCorrectionHref?: string;
  startCorrection?: () => void | boolean | Promise<boolean>;
}) {
  const verdict = run.verdict!;
  const tabLabels: Record<ReviewTab, string> = {
    summary: copy.summaryTab,
    contract: copy.workflowContract,
    evidence: copy.evidenceTab,
    decision: copy.decisionTab,
  };
  const causes = [
    ...verdict.detectedViolations,
    ...verdict.evidenceGaps,
    ...verdict.unsupportedClaims,
  ];
  const correctionPreview = task
    ? buildCorrectionPreview(locale, task, contract, run, verdict)
    : "";
  const exactAction = reviewNextAction(copy, locale, run);
  const decisionOpen =
    run.decision === "NONE" || run.decision === "ACKNOWLEDGED";
  const nonPass = verdict.classification !== "PASS";
  const overrideReady = run.correctionNotes.trim().length >= 12;

  return (
    <section className="two-column workbench-layout">
      <div className="workspace page-workspace">
        <div className="page-heading">
          <div>
            <h1>{copy.review}</h1>
            <p>{copy.round} {run.round}</p>
          </div>
        </div>
        <TabBar
          items={reviewTabOrder}
          active={tab}
          labels={tabLabels}
          setActive={setTab}
        />
        {tab === "summary" && (
          <section className="workbench-section">
            <div className="state-grid">
              <StateCard
                label={copy.contractApproval}
                value={contract.ownerApproval.state}
                technicalValue
              />
              <StateCard
                label={copy.deterministicVerdict}
                value={verdict.classification}
                technicalValue
              />
              <StateCard
                label={copy.ownerReviewDecision}
                value={localizeDecision(locale, run.decision)}
              />
              <StateCard
                label={copy.provider}
                value={
                  providerRegistry[contract.selectedConfiguration.providerId]
                    .displayName
                }
              />
              <StateCard
                label={copy.model}
                value={contract.agentResolution.modelDisplayName}
              />

              <StateCard
                label={copy.reportProvenance}
                value={
                  verdict.reportProvenance
                    ? provenanceDisplay(locale, verdict.reportProvenance.status)
                    : copy.noItems
                }
                technicalValue
              />
            </div>
            <div className="verdict-summary">
              <h2>{copy.reviewSummary}</h2>
              <p>
                {localizeVerdictText(locale, verdict.contractComplianceSummary)}
              </p>
            </div>
            <div className="cause-panel">
              <h2>{copy.directReviewCauses}</h2>
              {causes.length ? (
                <ul>
                  {causes.map((item) => (
                    <li key={item}>{localizeVerdictText(locale, item)}</li>
                  ))}
                </ul>
              ) : (
                <p>{copy.noDirectCauses}</p>
              )}
            </div>
            <div className="next-action">
              <strong>{copy.nextAction}</strong>
              <p>{exactAction}</p>
            </div>
          </section>
        )}
        {tab === "contract" && (
          <ScopeSection contract={contract} copy={copy} locale={locale} />
        )}
        {tab === "evidence" && (
          <EvidenceSection verdict={verdict} copy={copy} locale={locale} />
        )}
        {tab === "decision" && (
          <section className="workbench-section">
            <h2>{copy.ownerReviewDecision}</h2>
            {run.decision === "ACKNOWLEDGED" && (
              <p className="notice info">{copy.acknowledgedNotice}</p>
            )}
            {decisionOpen ? (
              <>
                {nonPass && (
                  <p className="notice warning override-warning">
                    <strong>
                      {locale === "ar"
                        ? "هذا الحكم ليس PASS قائمًا على الأدلة."
                        : "This is not an evidence-based PASS."}
                    </strong>
                    <span>
                      {locale === "ar"
                        ? "الإغلاق يتطلب استثناءً صريحًا وسببًا موثقًا من المالك، ويُحفظ القرار في سجل التنفيذ."
                        : "Closing requires an explicit owner override and documented reason, preserved in the run history."}
                    </span>
                  </p>
                )}
                {nonPass && (
                  <label className="override-reason">
                    {copy.optionalOwnerNotes}
                    <textarea
                      value={run.correctionNotes}
                      onChange={(event) => updateNotes(event.target.value)}
                      placeholder={copy.overrideReasonRequired}
                    />
                    <small>{copy.overrideReasonRequired}</small>
                  </label>
                )}
                <div className="review-actions">
                  {verdict.classification === "PASS" ? (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => recordDecision("ACCEPTED")}
                    >
                      {copy.acceptAndClose}
                    </button>
                  ) : run.decision === "NONE" ? (
                    <button
                      type="button"
                      onClick={() => recordDecision("ACKNOWLEDGED")}
                    >
                      {copy.acknowledgeVerdict}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => recordDecision("CORRECTION_REQUESTED")}
                  >
                    {copy.requestCorrection}
                  </button>
                  {nonPass && (
                    <button
                      type="button"
                      className="override-action"
                      disabled={!overrideReady}
                      onClick={() => recordDecision("ACCEPTED_WITH_OVERRIDE")}
                    >
                      {copy.closeWithOverride}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => recordDecision("REJECTED")}
                  >
                    {copy.rejectRun}
                  </button>
                </div>
              </>
            ) : (
              <div className="decision-record">
                <strong>
                  {copy.decisionRecorded}:{" "}
                  {localizeDecision(locale, run.decision)}
                </strong>
                <p>{copy.decisionLocked}</p>
              </div>
            )}
            {run.decision === "CORRECTION_REQUESTED" && (
              <section className="correction">
                <h2>{copy.correctionRequestedTitle}</h2>
                <p>{copy.runReturnedForCorrection}</p>
                <p>
                  <strong>{copy.originalRun}:</strong> {technical(run.id)}
                </p>
                <p>
                  <strong>{copy.originalVerdict}:</strong>{" "}
                  {technical(verdict.classification)}
                </p>
                <h3>{locale === "ar" ? "الفجوات المطلوب إغلاقها فقط" : "Only the gaps that must be closed"}</h3>
                <SimpleList
                  items={causes.map((item) =>
                    localizeVerdictText(locale, item),
                  )}
                  empty={copy.noItems}
                />
                <label>
                  {copy.optionalOwnerNotes}
                  <textarea
                    value={run.correctionNotes}
                    onChange={(event) => updateNotes(event.target.value)}
                  />
                </label>
                <div className="notice warning">
                  <strong>{copy.correctionPreview}</strong>
                  <p>{copy.correctionPreviewHelp}</p>
                </div>
                <pre
                  className="prompt-preview"
                  dir={locale === "ar" ? "rtl" : "ltr"}
                >
                  {correctionPreview}
                </pre>
                <div className="action-bar">
                  {startCorrectionHref && (
                    <Link
                      className="primary-link"
                      href={startCorrectionHref}
                      onClick={(event) => {
                        event.preventDefault();
                        if (!startCorrection) return;
                        void Promise.resolve(startCorrection()).then((ready) => {
                          if (ready !== false) window.location.assign(startCorrectionHref);
                        });
                      }}
                    >
                      {copy.startCorrectionRound}
                    </Link>
                  )}
                </div>
              </section>
            )}
            <div className="next-action">
              <strong>{copy.nextAction}</strong>
              <p>{exactAction}</p>
            </div>
          </section>
        )}
      </div>
      <aside className="summary state-summary">
        <h2>{copy.reviewSummary}</h2>
        <details className="advanced-audit">
          <summary>Advanced Audit</summary>
          <StateLine label={copy.runId} value={run.id} />
          <StateLine label={copy.contractId} value={contract.contractId} />
          <StateLine label={copy.bindingMarker} value={run.bindingMarker} />
        </details>
        <StateLine
          label={copy.deterministicVerdict}
          value={verdict.classification}
        />
        <StateLine
          label={copy.reportProvenance}
          value={
            verdict.reportProvenance
              ? provenanceDisplay(locale, verdict.reportProvenance.status)
              : copy.noItems
          }
        />
        <StateLine
          label={copy.contractApproval}
          value={contract.ownerApproval.state}
        />
        <StateLine
          label={copy.ownerReviewDecision}
          value={localizeDecision(locale, run.decision)}
        />
        <div className="next-action compact-next">
          <strong>{copy.nextAction}</strong>
          <p>{exactAction}</p>
        </div>
      </aside>
    </section>
  );
}

function BridgeWorkbench({
  task,
  run,
  copy,
  locale,
  json,
  setJson,
  result,
  validate,
  finalizeOwnerRuntimeEvidence,
  saveImportedRun,
  backToParentReview,
}: {
  task: TaskRecord;
  run?: RunRecord;
  copy: TranslationCopy;
  locale: Locale;
  json: string;
  setJson: (value: string) => void;
  result: BridgeResult;
  validate: () => void;
  finalizeOwnerRuntimeEvidence: (
    validationRows: Array<{ checkId: string; status: "PASS" | "FAIL" | "EVIDENCE_REQUIRED"; details: string }>,
    commands: string[],
  ) => void | Promise<void>;
  saveImportedRun: () => void;
  backToParentReview: () => void;
}) {
  const [format, setFormat] = useState<"JSON" | "MARKDOWN">("MARKDOWN");
  const correction = run?.executionType === "CORRECTION";
  const original = parentRun(task, run);
  const contract = task.contract;
  const ar = locale === "ar";
  const executablePrompt = run?.compiledArtifact?.text ?? "";
  const bindingMarker = run?.bindingMarker ?? "";
  const jsonTemplate =
    contract && run
      ? compileOptionalJsonTemplate(contract, promptContextForRun(task, run))
      : "";
  const markdownTemplate = contract && run
    ? compileMarkdownReportTemplate(contract, locale, promptContextForRun(task, run))
    : "";
  const [validationRows, setValidationRows] = useState<Array<{
    checkId: string;
    status: "PASS" | "FAIL" | "EVIDENCE_REQUIRED";
    details: string;
  }>>([]);
  const [noCommandsExecuted, setNoCommandsExecuted] = useState(true);
  const [ownerCommands, setOwnerCommands] = useState("");
  useEffect(() => {
    if (!contract || !run || run.status !== "REPORT_RECEIVED") return;
    setValidationRows(contract.requiredChecks.filter(check => check.required).map(check => ({
      checkId: check.id,
      status: "EVIDENCE_REQUIRED",
      details: "",
    })));
    const claimedCommands = run.report?.commands.map(item => item.command) ?? [];
    setNoCommandsExecuted(claimedCommands.length === 0);
    setOwnerCommands(claimedCommands.join("\n"));
  }, [contract, run]);
  const evidenceReady = validationRows.length > 0
    && validationRows.every(row => row.details.trim().length >= 8)
    && (noCommandsExecuted || ownerCommands.split(/\r?\n/).some(command => command.trim()));
  const validateWithFormatDetection = () => {
    const trimmed = json.trim();
    if (
      format === "JSON" &&
      trimmed &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("[")
    )
      setFormat("MARKDOWN");
    validate();
  };
  const loadReportFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setJson(ar ? "الملف أكبر من 2MB." : "The file exceeds 2MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setJson(String(reader.result ?? ""));
      setFormat(
        file.name.toLowerCase().endsWith(".json") ? "JSON" : "MARKDOWN",
      );
    };
    reader.readAsText(file);
  };
  return (
    <section className="workspace page-workspace bridge-workbench">
      <div className="page-heading">
        <div>
          <h1>
            {correction
              ? copy.bridgeCorrection
              : ar
                ? "استيراد تقرير المنفذ"
                : "Executor Report Import"}
          </h1>
          <p>
            {ar
              ? "استورد التقرير المنظم أو حوّل تقرير Markdown مع مراجعة الحقول قبل الحكم."
              : "Import structured JSON or map a Markdown report before deterministic validation."}
          </p>
        </div>
      </div>
      <div className="state-grid compact-context bridge-context">
        <StateCard
          label={copy.round}
          value={run ? String(run.round) : copy.notAssigned}
        />
        <StateCard
          label={copy.executionType}
          value={
            run
              ? copy[
                  run.executionType === "CORRECTION"
                    ? "correctionRound"
                    : run.executionType === "FIXTURE"
                      ? "fixtureExecution"
                      : "initialExecution"
                ]
              : copy.noItems
          }
        />
        <StateCard
          label={copy.provider}
          value={
            contract
              ? providerRegistry[contract.selectedConfiguration.providerId]
                  .displayName
              : copy.noItems
          }
        />
        <StateCard
          label={copy.model}
          value={contract?.agentResolution.modelDisplayName ?? copy.noItems}
        />
        <StateCard
          label={copy.executionChannel}
          value={contract?.agentResolution.executionChannelName ?? copy.noItems}
        />
        <StateCard
          label={copy.reasoningProfile}
          value={
            contract?.selectedConfiguration.reasoningProfile ?? copy.noItems
          }
          technicalValue
        />
      </div>
      <details className="advanced-audit bridge-audit">
        <summary>Advanced Audit</summary>
        <dl>
          <dt>{copy.taskId}</dt><dd dir="ltr">{task.id}</dd>
          <dt>{copy.activeContract}</dt><dd dir="ltr">{contract?.contractId ?? copy.noItems}</dd>
          <dt>{copy.runId}</dt><dd dir="ltr">{run?.id ?? copy.noItems}</dd>
          <dt>{copy.evidenceIdentity}</dt><dd dir="ltr">{contract?.evidenceIdentity.sessionId ?? contract?.evidenceIdentity.runId ?? copy.noItems}</dd>
          {bindingMarker && <><dt>{copy.bindingMarker}</dt><dd dir="ltr">{bindingMarker}</dd></>}
          {correction && <><dt>{copy.originalRun}</dt><dd dir="ltr">{original?.id ?? run?.parentRunId ?? copy.noItems}</dd></>}
        </dl>
      </details>
      <p className="notice info">
        {copy.reportRunIdInstruction.replace(
          "{runId}",
          run?.id ?? copy.noItems,
        )}
      </p>
      {executablePrompt && (
        <details className="execution-prompt">
          <summary>
            <strong>{copy.executableContract}</strong>
            <span>
              {ar ? "عرض ونسخ عند الحاجة" : "Open and copy when needed"}
            </span>
          </summary>
          <pre
            className="prompt-preview"
            dir={(task.promptLocale ?? locale) === "ar" ? "rtl" : "ltr"}
          >
            {executablePrompt}
          </pre>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(executablePrompt)}
          >
            {copy.copyAgentPrompt}
          </button>
        </details>
      )}
      <div className="report-format-tabs">
        <button
          type="button"
          className={format === "MARKDOWN" ? "active" : ""}
          onClick={() => setFormat("MARKDOWN")}
        >
          {ar ? "تقرير منظم / Markdown" : "Structured report / Markdown"}
        </button>
        <button
          type="button"
          className={format === "JSON" ? "active" : ""}
          onClick={() => setFormat("JSON")}
        >
          {ar ? "JSON متقدم" : "Advanced JSON"}
        </button>
        {format === "MARKDOWN" && markdownTemplate && (
          <button type="button" onClick={() => setJson(markdownTemplate)}>
            {ar ? "تحميل قالب تقرير مطابق" : "Load run-bound report template"}
          </button>
        )}
        {format === "JSON" && jsonTemplate && (
          <button type="button" onClick={() => setJson(jsonTemplate)}>
            {ar ? "تحميل قالب الأتمتة" : "Load automation template"}
          </button>
        )}
        <label>
          {ar ? "رفع ملف تقرير" : "Upload report file"}
          <input
            type="file"
            accept=".json,.md,.txt"
            onChange={(event) => loadReportFile(event.target.files)}
          />
        </label>
      </div>
      {run?.status === "REPORT_RECEIVED" && !run.verdict && (
        <section className="panel owner-runtime-evidence">
          <div className="section-heading-row">
            <div>
              <h2>{ar ? "دليل Owner Runtime الموثوق" : "Trusted Owner Runtime evidence"}</h2>
              <p>{ar
                ? "تقرير المنفذ محفوظ كادعاء فقط. سجّل نتيجة مستقلة لكل check، ثم أثبت سجل الأوامر الكامل قبل إصدار Verdict."
                : "The executor report is preserved as a claim only. Record one independent result per check and the complete command trace before Verdict issuance."}</p>
            </div>
          </div>
          <div className="owner-evidence-grid">
            {validationRows.map((row, index) => (
              <div className="owner-evidence-row" key={row.checkId}>
                <code dir="ltr">{row.checkId}</code>
                <select
                  value={row.status}
                  onChange={(event) => setValidationRows(current => current.map((item, itemIndex) => itemIndex === index
                    ? { ...item, status: event.target.value as typeof row.status }
                    : item))}
                >
                  <option value="EVIDENCE_REQUIRED">EVIDENCE_REQUIRED</option>
                  <option value="PASS">PASS</option>
                  <option value="FAIL">FAIL</option>
                </select>
                <textarea
                  dir="ltr"
                  value={row.details}
                  placeholder={ar ? "الدليل المستقل المحدد لهذه النتيجة" : "Exact independent evidence for this result"}
                  onChange={(event) => setValidationRows(current => current.map((item, itemIndex) => itemIndex === index
                    ? { ...item, details: event.target.value }
                    : item))}
                />
              </div>
            ))}
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={noCommandsExecuted}
              onChange={(event) => setNoCommandsExecuted(event.target.checked)}
            />
            <span>{ar ? "لم تُنفذ أي أوامر على الإطلاق في هذا التشغيل" : "No commands were executed at all in this Run"}</span>
          </label>
          {!noCommandsExecuted && (
            <label>
              {ar ? "سجل الأوامر الكامل — أمر واحد في كل سطر" : "Complete command trace — one exact command per line"}
              <textarea
                dir="ltr"
                className="code-input compact-code-input"
                value={ownerCommands}
                onChange={(event) => setOwnerCommands(event.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            className="primary"
            disabled={!evidenceReady}
            onClick={() => void finalizeOwnerRuntimeEvidence(
              validationRows,
              noCommandsExecuted ? [] : ownerCommands.split(/\r?\n/).map(command => command.trim()).filter(Boolean),
            )}
          >
            {ar ? "حفظ الدليل الموثوق وإصدار Verdict" : "Record trusted evidence and issue Verdict"}
          </button>
        </section>
      )}
      <div className="bridge-grid">
        <div className="bridge-input">
          <label>
            {format === "JSON"
              ? copy.reportJson
              : ar
                ? "تقرير المنفذ النصي"
                : "Executor text report"}
            <textarea
              dir="ltr"
              className="code-input"
              value={json}
              placeholder={
                format === "JSON"
                  ? "{ ... }"
                  : ar
                    ? "# ملخص التنفيذ\n\n## المصادر المفحوصة\n- ...\n\n## النتائج\n- ..."
                    : "# Execution summary\n\n## Inspected sources\n- ...\n\n## Findings\n- ..."
              }
              onChange={(event) => setJson(event.target.value)}
            />
          </label>
          <p className="field-help">
            {format === "JSON"
              ? ar
                ? "سيتم التحقق مباشرة من المخطط والربط والأدلة."
                : "Schema, binding, and evidence will be validated directly."
              : ar
                ? "سيعرض IntentChord الحقول المستخرجة والناقصة. لا يمنح النص الحر PASS تلقائيًا."
                : "IntentChord shows mapped and missing fields. Free text never receives PASS automatically."}
          </p>
          <div className="action-bar">
            <button
              type="button"
              className="primary"
              onClick={validateWithFormatDetection}
            >
              {copy.validate}
            </button>
            {correction && original ? (
              <Link href="/runs/current/review" onClick={backToParentReview}>
                {copy.backToReview}
              </Link>
            ) : (
              <Link href="/runs/current/execute">{copy.backToExecution}</Link>
            )}
            <Link href="/contracts/current">{copy.backToContract}</Link>
          </div>
        </div>
        <BridgeResultPanel
          result={result}
          copy={copy}
          locale={locale}
          correction={Boolean(correction)}
          saveImportedRun={saveImportedRun}
        />
      </div>
    </section>
  );
}

function BridgeResultPanel({
  result,
  copy,
  locale,
  correction,
  saveImportedRun,
}: {
  result: BridgeResult;
  copy: TranslationCopy;
  locale: Locale;
  correction: boolean;
  saveImportedRun: () => void;
}) {
  const ar = locale === "ar";
  const m =
    result.kind === "verdict" ? result.verdict.evidenceSufficiency : undefined;
  return (
    <aside className={`bridge-result ${result.kind}`} aria-live="polite">
      <h2>{copy.validationResult}</h2>
      {result.kind === "idle" && (
        <p>
          {ar
            ? "ألصق أو ارفع تقرير المنفذ، ثم ابدأ التحقق."
            : "Paste or upload the executor report, then validate it."}
        </p>
      )}
      {result.kind === "syntax" && (
        <>
          <strong>{copy.jsonSyntaxError}</strong>
          <p className="technical-block" dir="ltr">
            {result.detail}
          </p>
          <p className="notice info">
            {ar
              ? "إذا كان المحتوى تقريرًا نصيًا، استخدم وضع Markdown بدل JSON."
              : "If this is a readable report, switch to Markdown instead of JSON."}
          </p>
        </>
      )}
      {result.kind === "mapping" && (
        <>
          <strong>
            {ar ? "مراجعة تحويل التقرير" : "Report mapping review"}
          </strong>
          <p>{result.detail}</p>
          <p>
            <b>{ar ? "الحقول المستخرجة" : "Mapped fields"}:</b>{" "}
            {result.mappedFields.join(", ") || copy.noItems}
          </p>
          <p>
            <b>{ar ? "الحقول الناقصة" : "Missing fields"}:</b>{" "}
            {result.missingFields.join(", ") || copy.noItems}
          </p>
          <p className="notice warning">
            {ar
              ? "أكمل محتوى التقرير المطلوب. بيانات التنفيذ الحاكمة يجب أن تكون موجودة حرفيًا في التقرير؛ لا يتم حقنها من الواجهة، ولا يمنح النص الحر PASS."
              : "Complete the report content. Governed Run metadata must be present exactly in the report; the UI never injects it, and free text never receives PASS."}
          </p>
        </>
      )}
      {result.kind === "schema" && (
        <>
          <strong>{copy.reportSchemaError}</strong>
          <p>{copy.schemaIssues}</p>
          <ul className="schema-issue-list" dir="ltr">
            {result.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </>
      )}
      {result.kind === "report-received" && (
        <>
          <strong>{ar ? "تم حفظ التقرير وربطه بالتنفيذ" : "Report received and bound"}</strong>
          <p>{ar
            ? "لم يصدر Verdict بعد. تقرير المنفذ ليس Independent Evidence؛ أكمل لوحة Owner Runtime الموثوقة أولًا."
            : "No Verdict has been issued. The executor report is not independent evidence; complete the trusted Owner Runtime panel first."}</p>
          <p className="classification-value" dir="ltr">REPORT_RECEIVED</p>
        </>
      )}
      {result.kind === "verdict" && (
        <>
          <strong>{copy.deterministicResult}</strong>
          {result.format === "MARKDOWN" && (
            <div className="mapping-summary">
              <p>
                <b>
                  {ar ? "مرتبط من التنفيذ النشط" : "Bound from active run"}:
                </b>{" "}
                {(result.boundFields ?? []).join(", ") || copy.noItems}
              </p>
              <p>
                <b>{ar ? "مُستخرج من التقرير" : "Extracted from report"}:</b>{" "}
                {(result.mappedFields ?? [])
                  .filter(
                    (field) => !(result.boundFields ?? []).includes(field),
                  )
                  .join(", ") || copy.noItems}
              </p>
            </div>
          )}
          <p className="classification-value" dir="ltr">
            {result.verdict.classification}
          </p>
          <p>
            {localizeVerdictText(
              locale,
              result.verdict.contractComplianceSummary,
            )}
          </p>
          {result.verdict.reportProvenance && (
            <ProvenanceTrace
              verdict={result.verdict}
              copy={copy}
              locale={locale}
              compact
            />
          )}
          {m && (
            <div className="evidence-metrics">
              <Metric
                label={ar ? "مدخلات نطاق التفويض" : "Authorized scope entries"}
                value={String(m.authorizedScopePathCount)}
              />
              <Metric
                label={
                  ar ? "المسارات المذكور فحصها" : "Reported inspected paths"
                }
                value={String(m.inspectedPathCount)}
              />
              <Metric
                label={
                  ar
                    ? "المسارات المفحوصة داخل النطاق"
                    : "In-scope inspected paths"
                }
                value={String(m.approvedInspectedPathCount)}
              />
              <Metric
                label={
                  ar
                    ? "أدلة داعمة محددة مسبقًا تم فحصها"
                    : "Preselected evidence paths inspected"
                }
                value={String(m.evidencePathCount)}
              />
              <Metric
                label={
                  ar ? "هويات الأدلة المتطابقة" : "Matched evidence identities"
                }
                value={String(m.matchedEvidenceIdentityCount)}
              />
              <Metric
                label={ar ? "الفحوص المكتملة" : "Required checks"}
                value={`${m.requiredChecksPassed}/${m.requiredChecksTotal}`}
              />
              <Metric
                label={
                  ar ? "الحقائق المثبتة بمراجع" : "Referenced proven findings"
                }
                value={`${m.referencedProvenFindingCount}/${m.provenFindingCount}`}
              />
            </div>
          )}
          <div className="next-action compact-next">
            <strong>{copy.nextAction}</strong>
            <p>{localizeVerdictText(locale, result.verdict.nextAction)}</p>
          </div>
          <Link
            className="primary-link bridge-save"
            href="/runs/current/review"
            onClick={saveImportedRun}
          >
            {correction ? copy.saveCorrectedRound : copy.saveImportedRun}
          </Link>
        </>
      )}
    </aside>
  );
}

function ScopeSection({
  contract,
  copy,
  locale,
}: {
  contract: ExecutionContract;
  copy: TranslationCopy;
  locale: Locale;
}) {
  const workspaceEvidence = contract.scope.evidenceFiles.filter(
    (path) => !path.startsWith("upload:"),
  );
  const uploadedEvidence = contract.scope.evidenceFiles
    .filter((path) => path.startsWith("upload:"))
    .map((path) => path.replace(/^upload:/, ""));
  return (
    <section className="workbench-section detail-grid">
      <DetailBlock title={copy.objective}>
        <p>{contract.objective}</p>
      </DetailBlock>
      <DetailBlock
        title={
          locale === "ar"
            ? `مساحات العمل (${contract.scope.workspaces.length})`
            : `Workspaces (${contract.scope.workspaces.length})`
        }
      >
        <div>
          {contract.scope.workspaces.map((workspace) => (
            <article key={workspace.id}>
              <strong>
                {workspace.displayName} · {workspace.role}
              </strong>
              <p dir="ltr">{workspace.reference}</p>
              <p dir="ltr">{workspace.fingerprint}</p>
              <TechnicalList
                items={workspace.allowedPaths.map(
                  (path) => `${workspace.id}: ${path}`,
                )}
                empty={copy.noItems}
              />
              <TechnicalList
                items={workspace.excludedPaths.map(
                  (path) => `${workspace.id}: ${path}`,
                )}
                empty={copy.noItems}
              />
            </article>
          ))}
        </div>
      </DetailBlock>
      <DetailBlock title={copy.provider}>
        <p>
          {
            providerRegistry[contract.selectedConfiguration.providerId]
              .displayName
          }
        </p>
      </DetailBlock>
      <DetailBlock title={copy.model}>
        <p>{contract.agentResolution.modelDisplayName}</p>
        <p>{technical(contract.selectedConfiguration.modelId)}</p>
      </DetailBlock>
      <DetailBlock title={copy.executionChannel}>
        <p>{contract.agentResolution.executionChannelName}</p>
        <p>{technical(contract.selectedConfiguration.executionChannelId)}</p>
      </DetailBlock>
      <DetailBlock title={copy.reasoningProfile}>
        <p>{technical(contract.selectedConfiguration.reasoningProfile)}</p>
      </DetailBlock>
      <DetailBlock title={copy.runtimeProfile}>
        <p>{contract.agentResolution.runtimeProfileName}</p>
        <p>{technical(contract.selectedConfiguration.runtimeProfileId)}</p>
      </DetailBlock>
      <DetailBlock title={copy.modelRecommendation}>
        <p>{technical(`${contract.configurationRecommendation.assessmentStatus} · ${contract.configurationRecommendation.status}`)}</p>
        <p>
          {copy.recommendedModel}:{" "}
          {
            modelRegistry[
              contract.configurationRecommendation.recommendedModelId
            ].displayName
          }
        </p>
      </DetailBlock>
      <DetailBlock title={copy.taskComplexity}>
        <p>{technical(contract.taskSemanticProfile.complexity)}</p>
        <p>{technical(`Cross-file: ${contract.taskSemanticProfile.crossFileDependency}`)}</p>
        <p>{technical(`Cross-workspace: ${contract.taskSemanticProfile.crossWorkspaceDependency}`)}</p>
        <SimpleList
          items={contract.taskSemanticProfile.reasons}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock title={copy.evidenceIdentity}>
        <p>{technical(contract.evidenceIdentityState)}</p>
        {contract.evidenceIdentityState === "NOT_ESTABLISHED" ? (
          <p>{locale === "ar" ? "تُربط هوية الأدلة عند استيراد أول دليل موثوق خاص بالتنفيذ." : "Evidence identity is bound when the first trusted run evidence is imported."}</p>
        ) : (
          <pre className="inline-code">
            {JSON.stringify(contract.evidenceIdentity, null, 2)}
          </pre>
        )}
      </DetailBlock>
      <section className="detail-block scope-authority-explainer">
        <h2>
          {locale === "ar" ? "قاعدة حدود التفويض" : "Authority-boundary rule"}
        </h2>
        <p>
          {locale === "ar"
            ? "المسارات المعتمدة تحدد أقصى صلاحية للوكيل، ولا تثبت أنها كل الملفات المرتبطة أو الكافية لحل المهمة."
            : "Approved paths define the agent's maximum authority; they do not prove that the paths are complete, sufficient, or relevant to the root cause."}
        </p>
        <p>
          {locale === "ar"
            ? "عند الحاجة لمسار خارجها، يتوقف الوكيل بتصنيف EVIDENCE_REQUIRED ويذكر المسار والسبب والتوسيع المطلوب لقرار جديد من المالك."
            : "When an out-of-bound path is required, the agent stops with EVIDENCE_REQUIRED and names the path, reason, and proposed expansion for a new owner decision."}
        </p>
      </section>
      <DetailBlock
        title={
          locale === "ar"
            ? "نطاق الاكتشاف والقراءة المصرح"
            : "Authorized discovery / read scope"
        }
      >
        <TechnicalList
          items={contract.scope.allowedPaths}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock
        title={
          locale === "ar"
            ? "نطاق التعديل المصرح"
            : "Authorized modification scope"
        }
      >
        <TechnicalList
          items={
            contract.policyDecisionTrace.some(
              (item) => item.capability === "modifySource" && item.effective,
            )
              ? contract.scope.allowedPaths
              : []
          }
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock title={copy.excludedPaths}>
        <TechnicalList
          items={contract.scope.excludedPaths}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock
        title={
          locale === "ar"
            ? "أدلة داعمة اختيارية محددة مسبقًا · للقراءة فقط"
            : "Optional preselected supporting evidence · read only"
        }
      >
        <TechnicalList items={workspaceEvidence} empty={copy.noItems} />
      </DetailBlock>
      <section className="detail-block uploaded-evidence">
        <div className="path-selection-heading">
          <h2>
            {locale === "ar"
              ? "مرفقات أدلة خارجية"
              : "Uploaded external evidence"}
          </h2>
          <span className="source-badge uploaded">
            {locale === "ar" ? "مرفوع" : "UPLOADED"}
          </span>
        </div>
        <TechnicalList items={uploadedEvidence} empty={copy.noItems} />
      </section>
      <DetailBlock title="Scope normalization">
        <p>
          {contract.scope.normalization.removedRedundantEntries.length}{" "}
          redundant entries merged
        </p>
        <TechnicalList
          items={contract.scope.normalization.conflicts}
          empty={copy.noItems}
        />
      </DetailBlock>
    </section>
  );
}

function AgentResolutionPreview({
  contract,
  locale,
}: {
  contract: ExecutionContract;
  locale: Locale;
}) {
  const channels: Array<{
    id: ExecutionChannelId;
    name: string;
    reason: string;
  }> = [
    {
      id: "CODEX",
      name: "Codex",
      reason:
        locale === "ar"
          ? "تنفيذ موجّه بهدف /goal مع استمرارية سياق المستودع."
          : "Goal-driven /goal execution with repository-context continuity.",
    },
    {
      id: "CLAUDE_CODE",
      name: "Claude Code",
      reason:
        locale === "ar"
          ? "استقلالية محدودة ومنع التحسينات وإعادة الهيكلة غير المطلوبة."
          : "Bounded autonomy with unsolicited refactoring and enhancements forbidden.",
    },
    {
      id: "GEMINI_CLI",
      name: "Gemini CLI",
      reason:
        locale === "ar"
          ? "خطوات صريحة مرتبة ومنع الافتراض أو استبدال الملفات."
          : "Explicit ordered steps with assumptions and file substitution forbidden.",
    },
  ];
  const selected = channels.find(
    (channel) => channel.id === contract.agentResolution.executionChannelId,
  )!;
  const others = channels.filter((channel) => channel.id !== selected.id);
  const card = (channel: (typeof channels)[number], selectedCard = false) => {
    const profile = agentBehaviorProfile(channel.id);
    return (
      <article
        key={channel.id}
        className={`agent-resolution-card ${selectedCard ? "selected" : ""}`}
      >
        <div className="agent-card-heading">
          <h3>{channel.name}</h3>
          {selectedCard && (
            <span className="status-chip">
              {locale === "ar" ? "الوكيل المنفذ" : "EXECUTING AGENT"}
            </span>
          )}
        </div>
        <p>{channel.reason}</p>
        <ul>
          {localizeContractTexts(
            locale,
            profile.behaviorControls.slice(0, selectedCard ? 4 : 3),
          ).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </article>
    );
  };
  return (
    <section className="agent-resolution-preview">
      <div className="notice info immutable-agent-context">
        <strong>
          {locale === "ar"
            ? "ثوابت الحوكمة المشتركة"
            : "Shared governance invariants"}
        </strong>
        <p>
          {locale === "ar"
            ? "الهدف والنطاق والأدلة والتفويض وهوية التنفيذ وقرار المالك لا تتغير. الاختلاف محصور في استراتيجية التنفيذ وضوابط الوكيل."
            : "Objective, scope, evidence, authority, run identity, and owner decisions never change. Only execution strategy and agent controls adapt."}
        </p>
      </div>
      <div className="selected-agent-panel">
        {card(selected, true)}
        <div className="selected-agent-goal">
          <span>{locale === "ar" ? "الهدف المحلول" : "Resolved goal"}</span>
          <code dir={locale === "ar" ? "rtl" : "ltr"}>
            {localizedAgentGoal(contract, locale)}
          </code>
        </div>
      </div>
      <details className="agent-comparison">
        <summary>
          {locale === "ar"
            ? "مقارنة اختيارية مع الوكلاء الآخرين"
            : "Optional comparison with other agents"}
        </summary>
        <div className="agent-resolution-grid comparison-grid">
          {others.map((channel) => card(channel))}
        </div>
      </details>
    </section>
  );
}

function RecommendationSummary({
  contract,
  copy,
  locale = "en",
}: {
  contract?: ExecutionContract;
  copy: TranslationCopy;
  locale?: Locale;
}) {
  if (!contract) {
    return null;
  }
  const recommendation = contract.configurationRecommendation;
  return (
    <article
      className={`recommendation-card ${recommendation.status.toLowerCase().replaceAll("_", "-")}`}
    >
      <div className="recommendation-head">
        <div>
          <span>{copy.modelRecommendation}</span>
          <strong dir="ltr">{recommendation.assessmentStatus} · {recommendation.status}</strong>
        </div>
        <span>
          {copy.selectedModel}: {contract.agentResolution.modelDisplayName}
        </span>
      </div>
      <div className="recommendation-columns">
        <div>
          <h3>{copy.recommendationWhy}</h3>
          <SimpleList
            items={recommendation.reasons.map((item) =>
              localizeRecommendationText(locale, item),
            )}
            empty={copy.noItems}
          />
        </div>
        <div>
          <h3>{copy.recommendationActions}</h3>
          <SimpleList
            items={recommendation.recommendedActions.map((item) =>
              localizeRecommendationText(locale, item),
            )}
            empty={copy.noItems}
          />
        </div>
      </div>
    </article>
  );
}

function AuthorizationSection({
  contract,
  copy,
  locale,
}: {
  contract: ExecutionContract;
  copy: TranslationCopy;
  locale: Locale;
}) {
  return (
    <section className="workbench-section">
      <h2>{copy.authorization}</h2>
      <div className="authorization-summary">
        {contract.policyDecisionTrace.map((decision) => (
          <article
            className={`authorization-result ${decision.effective ? "permitted" : "denied"}`}
            key={decision.capability}
          >
            <div>
              <strong>{copy[authCopyKey[decision.capability]]}</strong>
              <span className="technical-inline" dir="ltr">
                {decision.capability}
              </span>
            </div>
            <dl>
              <dt>{copy.requested}</dt>
              <dd>{decision.requested ? copy.yes : copy.no}</dd>
              <dt>{copy.effective}</dt>
              <dd>{decision.effective ? copy.yes : copy.no}</dd>
              <dt>{copy.authority}</dt>
              <dd className="technical-inline" dir="ltr">
                {decision.source}
              </dd>
            </dl>
            <p>{localizePolicyReason(locale, decision.reason)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function PolicyDecisionTrace({
  decisions,
  copy,
  locale,
}: {
  decisions: ExecutionContract["policyDecisionTrace"];
  copy: TranslationCopy;
  locale: Locale;
}) {
  return (
    <section className="workbench-section policy-decision-trace">
      <h2>{copy.policyDecisionTrace}</h2>
      <div className="decision-table" role="table">
        <div role="row" className="decision-head">
          <span>{copy.capability}</span>
          <span>{copy.requested}</span>
          <span>{copy.effective}</span>
          <span>{copy.authority}</span>
          <span>{copy.reason}</span>
        </div>
        {decisions.map((decision) => (
          <div
            role="row"
            key={decision.capability}
            data-testid={`policy-decision-${decision.capability}`}
          >
            <span className="technical-inline" dir="ltr">
              {decision.capability}
            </span>
            <span>{decision.requested ? copy.yes : copy.no}</span>
            <span>{decision.effective ? copy.yes : copy.no}</span>
            <span className="technical-inline" dir="ltr">
              {decision.source}
            </span>
            <span>{localizePolicyReason(locale, decision.reason)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChecksSection({
  contract,
  copy,
  locale,
}: {
  contract: ExecutionContract;
  copy: TranslationCopy;
  locale: Locale;
}) {
  return (
    <section className="workbench-section checks-grid">
      <DetailBlock title={copy.allowedActions}>
        <SimpleList
          items={localizeContractTexts(locale, contract.allowedActions)}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock title={copy.forbiddenActions}>
        <SimpleList
          items={localizeContractTexts(locale, contract.forbiddenActions)}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock title={copy.requiredChecks}>
        <SimpleList
          items={contract.requiredChecks.map(
            (item) =>
              `${item.id}: ${localizeContractText(locale, item.description)}`,
          )}
          empty={copy.noItems}
          technicalPrefix
        />
      </DetailBlock>
      <DetailBlock title={copy.stopConditions}>
        <SimpleList
          items={localizeContractTexts(locale, contract.stopConditions)}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock title={copy.closureCriteria}>
        <SimpleList
          items={contract.closureCriteria.map(
            (item) =>
              `${item.id}: ${localizeContractText(locale, item.description)}`,
          )}
          empty={copy.noItems}
          technicalPrefix
        />
      </DetailBlock>
      <DetailBlock title={copy.requiredReportSections}>
        <SimpleList
          items={localizeContractTexts(locale, contract.requiredReportSections)}
          empty={copy.noItems}
        />
      </DetailBlock>
    </section>
  );
}

function ContractStateSummary({
  contract,
  preflightIssues,
  copy,
}: {
  contract: ExecutionContract;
  preflightIssues: number;
  copy: TranslationCopy;
}) {
  return (
    <aside className="summary state-summary">
      <h2>{copy.contractApproval}</h2>
      <StateLine
        label={copy.contractApproval}
        value={contract.ownerApproval.state}
      />
      <details className="advanced-audit">
        <summary>Advanced Audit</summary>
        <StateLine label={copy.contractId} value={contract.contractId} />
        <StateLine label={copy.evidenceIdentity} value={contract.evidenceIdentity.sessionId ?? contract.evidenceIdentity.runId ?? contract.contractId} />
        <StateLine label={copy.policyVersion} value={contract.policyVersion} />
      </details>
      <StateLine
        label={copy.preflightReadiness}
        value={
          preflightIssues
            ? `${preflightIssues} ${copy.preflightIssues}`
            : copy.ready
        }
      />
    </aside>
  );
}

function ProvenanceTrace({
  verdict,
  copy,
  locale,
  compact = false,
}: {
  verdict: Verdict;
  copy: TranslationCopy;
  locale: Locale;
  compact?: boolean;
}) {
  const provenance = verdict.reportProvenance;
  if (!provenance) return null;
  return (
    <section className={`provenance-trace ${compact ? "compact" : ""}`}>
      <div className="path-selection-heading">
        <h2>{copy.reportProvenance}</h2>
        <span
          className={`status-chip provenance-status ${provenance.status.toLowerCase().replaceAll("_", "-")}`}
          dir="ltr"
        >
          {provenanceDisplay(locale, provenance.status)}
        </span>
      </div>
      <div className="binding-pair">
        <span>{copy.bindingMarker}</span>
        <code dir="ltr">
          {provenance.receivedMarker ??
            (locale === "ar" ? "غير موجود" : "Missing")}
        </code>
        <small>
          {locale === "ar" ? "المتوقع" : "Expected"}:{" "}
          <span dir="ltr">{provenance.expectedMarker}</span>
        </small>
      </div>
      <div className="provenance-steps">
        {provenance.trace.map((item) => {
          const icon =
            item.status === "PASS"
              ? "✓"
              : item.status === "FAIL"
                ? "✕"
                : item.status === "NOT_APPLICABLE"
                  ? "—"
                  : "!";
          return (
            <article
              key={`${item.label}-${item.status}`}
              className={`provenance-step ${item.status.toLowerCase().replaceAll("_", "-")}`}
            >
              <span aria-label={item.status}>{icon}</span>
              <div>
                <strong>{provenanceTraceLabel(locale, item.label)}</strong>
                <p>{localizeVerdictText(locale, item.details)}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function EvidenceSection({
  verdict,
  copy,
  locale,
}: {
  verdict: Verdict;
  copy: TranslationCopy;
  locale: Locale;
}) {
  const m = verdict.evidenceSufficiency;
  return (
    <section className="workbench-section evidence-grid">
      {verdict.reportProvenance && (
        <div className="wide-grid-item">
          <ProvenanceTrace verdict={verdict} copy={copy} locale={locale} />
        </div>
      )}
      {m && (
        <div className="evidence-metrics wide-evidence-metrics">
          <Metric
            label={
              locale === "ar"
                ? "مدخلات نطاق التفويض"
                : "Authorized scope entries"
            }
            value={String(m.authorizedScopePathCount)}
          />
          <Metric
            label={
              locale === "ar"
                ? "المسارات المذكور فحصها"
                : "Reported inspected paths"
            }
            value={String(m.inspectedPathCount)}
          />
          <Metric
            label={
              locale === "ar"
                ? "المسارات المفحوصة داخل النطاق"
                : "In-scope inspected paths"
            }
            value={String(m.approvedInspectedPathCount)}
          />
          <Metric
            label={
              locale === "ar"
                ? "أدلة داعمة محددة مسبقًا تم فحصها"
                : "Preselected evidence paths inspected"
            }
            value={String(m.evidencePathCount)}
          />
          <Metric
            label={locale === "ar" ? "الفحوص المطلوبة" : "Required checks"}
            value={`${m.requiredChecksPassed}/${m.requiredChecksTotal}`}
          />
          <Metric
            label={
              locale === "ar"
                ? "حقائق مثبتة بمراجع"
                : "Referenced proven findings"
            }
            value={`${m.referencedProvenFindingCount}/${m.provenFindingCount}`}
          />
        </div>
      )}
      <DetailBlock title={copy.acceptedFacts}>
        <SimpleList
          items={verdict.acceptedFacts.map((item) =>
            localizeVerdictText(locale, item),
          )}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock title={copy.violations}>
        <SimpleList
          items={verdict.detectedViolations.map((item) =>
            localizeVerdictText(locale, item),
          )}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock title={copy.evidenceGaps}>
        <SimpleList
          items={verdict.evidenceGaps.map((item) =>
            localizeVerdictText(locale, item),
          )}
          empty={copy.noItems}
        />
      </DetailBlock>
      <DetailBlock title={copy.unsupportedClaims}>
        <SimpleList
          items={verdict.unsupportedClaims.map((item) =>
            localizeVerdictText(locale, item),
          )}
          empty={copy.noItems}
        />
      </DetailBlock>
    </section>
  );
}

function Recovery({
  copy,
  clear,
}: {
  copy: TranslationCopy;
  clear: () => void;
}) {
  return (
    <section className="recovery">
      <h1>{copy.recoveryTitle}</h1>
      <p>{copy.recoveryText}</p>
      <div className="recovery-actions">
        <Link href="/">{copy.returnHome}</Link>
        <Link className="primary-link" href="/tasks/new">
          {copy.startNewTask}
        </Link>
        <button type="button" onClick={clear}>
          {copy.clearWorkspace}
        </button>
      </div>
    </section>
  );
}

function TabBar<T extends string>({
  items,
  active,
  labels,
  setActive,
}: {
  items: readonly T[];
  active: T;
  labels: Record<T, string>;
  setActive: (item: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          type="button"
          role="tab"
          aria-selected={active === item}
          className={active === item ? "active" : ""}
          key={item}
          onClick={() => setActive(item)}
        >
          {labels[item]}
        </button>
      ))}
    </div>
  );
}

function StateCard({
  label,
  value,
  technicalValue = false,
}: {
  label: string;
  value: string;
  technicalValue?: boolean;
}) {
  return (
    <article className="state-card">
      <span>{label}</span>
      <strong
        className={technicalValue ? "technical-inline" : ""}
        dir={technicalValue ? "ltr" : undefined}
      >
        {value}
      </strong>
    </article>
  );
}

function StateLine({
  label,
  value,
  technicalValue = true,
}: {
  label: string;
  value: string;
  technicalValue?: boolean;
}) {
  return (
    <div className="state-line">
      <span>{label}</span>
      <strong
        className={technicalValue ? "technical-inline" : undefined}
        dir={technicalValue ? "ltr" : undefined}
      >
        {value}
      </strong>
    </div>
  );
}

function Metric({
  label,
  value,
  emptyCopy,
}: {
  label: string;
  value: string;
  emptyCopy?: string;
}) {
  const empty = value === "0";
  return (
    <article className={`metric ${empty ? "empty" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {empty && emptyCopy && <small>{emptyCopy}</small>}
    </article>
  );
}

function EmptyState({
  title,
  text,
  actionHref,
  actionLabel,
}: {
  title: string;
  text: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <section className="empty-state" aria-live="polite">
      <span className="empty-state-mark" aria-hidden="true">
        ○
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {actionHref && actionLabel && (
        <Link className="primary-link" href={actionHref}>
          {actionLabel}
        </Link>
      )}
    </section>
  );
}

function DetailBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="detail-block">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function TechnicalList({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? (
    <ul className="technical-list" dir="ltr">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  ) : (
    <p>{empty}</p>
  );
}

function SimpleList({
  items,
  empty,
  technicalPrefix = false,
}: {
  items: string[];
  empty: string;
  technicalPrefix?: boolean;
}) {
  return items.length ? (
    <ul>
      {items.map((item) => (
        <li key={item} className={technicalPrefix ? "mixed-technical" : ""}>
          {item}
        </li>
      ))}
    </ul>
  ) : (
    <p>{empty}</p>
  );
}

function buildCorrectionPreview(
  locale: Locale,
  task: TaskRecord,
  contract: ExecutionContract,
  run: RunRecord,
  verdict: Verdict,
): string {
  const causes = [
    ...verdict.detectedViolations,
    ...verdict.evidenceGaps,
    ...verdict.unsupportedClaims,
  ].map((item) => localizeVerdictText(locale, item));
  const workspaces = contract.scope.workspaces
    .map(
      (workspace) =>
        `- ${workspace.displayName} (${workspace.role}): ${workspace.reference}\n  allowed: ${workspace.allowedPaths.join(", ") || "none"}\n  excluded: ${workspace.excludedPaths.join(", ") || "none"}`,
    )
    .join("\n");
  if (locale === "ar")
    return `# معاينة طلب التصحيح — غير قابلة للتنفيذ\nمعرف المهمة: ${task.id}\nمساحة العمل: ${contract.scope.workspaceRef}\nمساحات العمل:\n${workspaces}\nمعرف العقد: ${contract.contractId}\nالتنفيذ الأصلي: ${run.id}\nالجولة الأصلية: ${run.round}\nعلامة الربط الحاكمة: ${run.bindingMarker}\nهوية الأدلة: ${contract.evidenceIdentity.sessionId ?? contract.evidenceIdentity.runId ?? "غير محدد"}\nالحكم الأصلي: ${verdict.classification}\nالتصحيح المطلوب: ${localizeVerdictText(locale, verdict.nextAction)}\nالأسباب:\n${causes.map((item) => `- ${item}`).join("\n")}\nملاحظات المالك: ${run.correctionNotes}`;
  return `# Correction Request Preview — NOT EXECUTABLE\nTask ID: ${task.id}\nWorkspaces:\n${workspaces}\nContract: ${contract.contractId}\nOriginal run: ${run.id}\nOriginal round: ${run.round}\nGoverning binding marker: ${run.bindingMarker}\nEvidence identity: ${contract.evidenceIdentity.sessionId ?? contract.evidenceIdentity.runId ?? "Not specified"}\nOriginal verdict: ${verdict.classification}\nRequired correction: ${verdict.nextAction}\nReasons:\n${causes.map((item) => `- ${item}`).join("\n")}\nOwner notes: ${run.correctionNotes}`;
}
