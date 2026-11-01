import { executionContractSchema, type ExecutionContract } from "@/core/contracts/execution-contract";
import { resolveExecutionContract } from "@/core/contracts/resolver";
import { executorReportEnvelopeSchema, type ExecutorReportEnvelope } from "@/core/reports/executor-report";
import type { Verdict } from "@/core/verdicts/engine";
import { validatePreflight } from "@/core/policies/preflight";
import {
  createBlankContractInput,
  createBlankTaskDraft,
  generatedTaskTitle,
  synchronizeLegacyWorkspaceProjection,
  type ContractInput,
  type TaskContext,
  type TaskDraftInput,
  type WorkspaceReference,
} from "@/core/tasks/task-input";
import {
  defaultModelForProvider,
  defaultRuntimeProfileForProvider,
  modelRegistry,
  providerRegistry,
  type ExecutionChannelId,
  type ModelId,
  type ProviderId,
  type ReasoningProfile,
  type RuntimeProfileId,
} from "@/core/providers/registry";
import type { Locale } from "@/i18n/types";
import type { IntentResolution } from "@/core/intelligence/intent-schema";
import {
  discoveryRunProjectionSchema,
  type DiscoveryRunProjection,
} from "@/core/discovery/discovery-schema";
import { reportBindingMarker } from "@/core/prompts/governance";

export type Decision = "NONE" | "ACKNOWLEDGED" | "ACCEPTED" | "ACCEPTED_WITH_OVERRIDE" | "CORRECTION_REQUESTED" | "REJECTED";
export type WorkflowStep = "task" | "contract" | "execution" | "review" | "decision";
export type ContractTab = "summary" | "scope" | "authorization" | "policy" | "checks" | "prompt";
export type ReviewTab = "summary" | "contract" | "evidence" | "decision";
export type RunSource = "SYNTHETIC_FIXTURE" | "IMPORTED_REPORT" | "CORRECTION_REPORT";
export type RunStatus = "AWAITING_REPORT" | "REPORT_RECEIVED" | "REVIEW_READY" | "DECIDED" | "SUPERSEDED";
export type ExecutionType = "INITIAL" | "CORRECTION" | "FIXTURE";

export type RunRecord = {
  id: string;
  round: number;
  createdAt: string;
  updatedAt: string;
  contractId: string;
  source: RunSource;
  executionType: ExecutionType;
  status: RunStatus;
  parentRunId?: string;
  bindingMarker: string;
  actionId?: string;
  executor: string;
  agentProfileId: ExecutionChannelId;
  providerId: ProviderId;
  modelId: ModelId;
  reasoningProfile: ReasoningProfile;
  runtimeProfileId: RuntimeProfileId;
  scenario?: string;
  executionCompleted: boolean;
  report?: ExecutorReportEnvelope;
  verdict?: Verdict;
  decision: Decision;
  decisionAt?: string;
  correctionNotes: string;
  correctionStarted: boolean;
  supersededAt?: string;
  /** Backend-owned optimistic concurrency revision. */
  stateRevision?: number;
  /** Exact persisted artifact metadata returned by the Backend. */
  compiledArtifact?: {
    id: string;
    text: string;
    sha256: string;
    compilerVersion: string;
    compiledAt: string;
    deliveryState: "COMPILED" | "DELIVERED";
    deliveryMethod?: string;
  };
};

export type IntentResolutionRecord = {
  id: string;
  revision: number;
  status: "PROPOSED" | "CONFIRMED" | "REJECTED";
  taskDraftRevisionId: string;
  resolverAdapterId: string;
  resolverProviderId?: string;
  resolverModelId?: string;
  resolverExecutionChannelId?: string;
  requestedProviderId: string;
  requestedModelId: string;
  requestedExecutionChannelId: string;
  promptVersion: string;
  schemaVersion: string;
  authorityFingerprint: string;
  inputSha256: string;
  outputSha256: string;
  confirmedBy?: string;
  confirmedAt?: string;
  createdAt: string;
  resolution: IntentResolution;
};

export type TaskRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  draft: TaskDraftInput;
  intentResolution?: IntentResolutionRecord;
  discoveryRun?: DiscoveryRunProjection;
  contract?: ExecutionContract;
  runs: RunRecord[];
  activeRunId?: string;
  promptLocale?: Locale;
  promptLocaleExplicit: boolean;
  contractTab: ContractTab;
  reviewTab: ReviewTab;
  /** Backend identity for the immutable current Contract revision. */
  contractRevisionId?: string;
  /** Backend-owned mutable approval state revision. */
  contractStateRevision?: number;
  /** SHA256 of the immutable Contract content. */
  contractContentSha256?: string;
  /** Owner-facing Backend projection; internal provenance remains outside the setup UI. */
  ownerView?: {
    taskSetup: {
      title: string;
      taskMode: ExecutionContract["taskMode"];
      workspaces: Array<{
        id: string;
        displayName: string;
        role: string;
        discoveryScopeMode: "FULL_WORKSPACE" | "SELECTED_PATHS" | "NONE";
        effectiveReadBoundary: "WORKSPACE_ROOT" | "SELECTED_PATHS" | "NONE";
        selectedPathCount: number;
        excludedPathCount: number;
        requiresOwnerAction: boolean;
      }>;
      readableWorkspaceCount: number;
      selectedPathCount: number;
      supportingEvidenceCount: number;
    };
  };
};

export type Workspace = {
  version: 4;
  tasks: TaskRecord[];
  activeTaskId?: string;
  interfaceLocale?: Locale;
};

export const workspaceKey = "intentchord-workspace-v3";
export const legacyWorkspaceKey = "intentchord-workspace-v2";
export const oldestWorkspaceKey = "intentchord-workspace-v1";

export const emptyWorkspace = (): Workspace => ({ version: 4, tasks: [] });

const contractTabs: ContractTab[] = ["summary", "scope", "authorization", "policy", "checks", "prompt"];
const reviewTabs: ReviewTab[] = ["summary", "contract", "evidence", "decision"];
const decisions: Decision[] = ["NONE", "ACKNOWLEDGED", "ACCEPTED", "ACCEPTED_WITH_OVERRIDE", "CORRECTION_REQUESTED", "REJECTED"];
const runSources: RunSource[] = ["SYNTHETIC_FIXTURE", "IMPORTED_REPORT", "CORRECTION_REPORT"];
const executionTypes: ExecutionType[] = ["INITIAL", "CORRECTION", "FIXTURE"];
const runStatuses: RunStatus[] = ["AWAITING_REPORT", "REPORT_RECEIVED", "REVIEW_READY", "DECIDED", "SUPERSEDED"];

export function makeLocalId(prefix: string, now = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${now.toString(36)}-${random}`;
}

export function createTaskRecord(
  draft: TaskDraftInput,
  options: { id?: string; now?: string } = {},
): TaskRecord {
  const now = options.now ?? new Date().toISOString();
  return {
    id: options.id ?? crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    draft: synchronizeLegacyWorkspaceProjection({ ...draft, title: generatedTaskTitle(draft.objective), titleManuallyEdited: false }),
    runs: [],
    promptLocaleExplicit: false,
    contractTab: "summary",
    reviewTab: "summary",
  };
}

export function activeTask(workspace: Workspace): TaskRecord | undefined {
  return workspace.tasks.find(task => task.id === workspace.activeTaskId);
}

export function activeRun(task: TaskRecord | undefined): RunRecord | undefined {
  return task?.runs.find(run => run.id === task.activeRunId);
}

export function parentRun(task: TaskRecord | undefined, run: RunRecord | undefined): RunRecord | undefined {
  return run?.parentRunId ? task?.runs.find(item => item.id === run.parentRunId) : undefined;
}

export function upsertTask(workspace: Workspace, task: TaskRecord, select = true): Workspace {
  const exists = workspace.tasks.some(item => item.id === task.id);
  const tasks = exists
    ? workspace.tasks.map(item => item.id === task.id ? task : item)
    : [task, ...workspace.tasks];
  return { ...workspace, version: 4, tasks, activeTaskId: select ? task.id : workspace.activeTaskId };
}

export function selectTask(workspace: Workspace, taskId: string): Workspace {
  return workspace.tasks.some(task => task.id === taskId)
    ? { ...workspace, activeTaskId: taskId }
    : workspace;
}

export function updateTaskDraft(task: TaskRecord, draft: TaskDraftInput, now = new Date().toISOString()): TaskRecord {
  const hasDownstream = Boolean(task.contract || task.activeRunId || task.runs.some(run => !run.supersededAt));
  const runs = hasDownstream
    ? task.runs.map(run => run.supersededAt ? run : { ...run, supersededAt: now, updatedAt: now })
    : task.runs;
  return {
    ...task,
    draft: synchronizeLegacyWorkspaceProjection({ ...draft, title: generatedTaskTitle(draft.objective), titleManuallyEdited: false }),
    intentResolution: undefined,
    discoveryRun: undefined,
    updatedAt: now,
    contract: hasDownstream ? undefined : task.contract,
    activeRunId: hasDownstream ? undefined : task.activeRunId,
    runs,
    contractTab: "summary",
    reviewTab: "summary",
  };
}

export function setTaskContract(task: TaskRecord, contract: ExecutionContract, now = new Date().toISOString()): TaskRecord {
  return {
    ...task,
    contract,
    revision: task.revision + 1,
    updatedAt: now,
    activeRunId: undefined,
    contractTab: "summary",
    reviewTab: "summary",
  };
}

export function setTaskPromptLocale(task: TaskRecord, locale: Locale, explicit = true): TaskRecord {
  return { ...task, promptLocale: locale, promptLocaleExplicit: explicit, updatedAt: new Date().toISOString() };
}

export function syncTaskPromptLocale(task: TaskRecord, locale: Locale): TaskRecord {
  return task.promptLocaleExplicit ? task : { ...task, promptLocale: locale };
}

export function appendRun(task: TaskRecord, run: RunRecord): TaskRecord {
  return {
    ...task,
    runs: [...task.runs, run],
    activeRunId: run.id,
    updatedAt: run.updatedAt,
    reviewTab: "summary",
  };
}

export function createRunRecord(input: {
  contract: ExecutionContract;
  source: RunSource;
  executionType?: ExecutionType;
  round: number;
  parentRunId?: string;
  bindingMarker?: string;
  actionId?: string;
  scenario?: string;
  report?: ExecutorReportEnvelope;
  verdict?: Verdict;
  id?: string;
  now?: string;
}): RunRecord {
  const now = input.now ?? new Date().toISOString();
  const completed = Boolean(input.verdict && input.report);
  const id = input.id ?? makeLocalId("run");
  const bindingMarker = input.bindingMarker ?? reportBindingMarker(input.contract.contractId, id, input.round);
  return {
    id,
    round: input.round,
    createdAt: now,
    updatedAt: now,
    contractId: input.contract.contractId,
    source: input.source,
    executionType: input.executionType ?? (
      input.source === "SYNTHETIC_FIXTURE"
        ? "FIXTURE"
        : input.source === "CORRECTION_REPORT"
          ? "CORRECTION"
          : "INITIAL"
    ),
    status: completed ? "REVIEW_READY" : "AWAITING_REPORT",
    parentRunId: input.parentRunId,
    bindingMarker,
    actionId: input.actionId,
    executor: input.contract.agentResolution.executionChannelName,
    agentProfileId: input.contract.agentResolution.profileId,
    providerId: input.contract.selectedConfiguration.providerId,
    modelId: input.contract.selectedConfiguration.modelId,
    reasoningProfile: input.contract.selectedConfiguration.reasoningProfile,
    runtimeProfileId: input.contract.selectedConfiguration.runtimeProfileId,
    scenario: input.scenario,
    executionCompleted: completed,
    report: input.report,
    verdict: input.verdict,
    decision: "NONE",
    correctionNotes: "",
    correctionStarted: false,
  };
}

export function nextRound(task: TaskRecord): number {
  return Math.max(0, ...task.runs.map(item => item.round)) + 1;
}

export function startPendingRun(
  task: TaskRecord,
  input: { executionType: ExecutionType; source: RunSource; parentRunId?: string; actionId?: string; now?: string },
): TaskRecord {
  if (!task.contract) return task;
  const existing = task.runs.find(run =>
    !run.supersededAt
    && run.executionType === input.executionType
    && run.parentRunId === input.parentRunId
    && (input.actionId ? run.actionId === input.actionId : run.status === "AWAITING_REPORT")
  );
  if (existing) {
    return { ...task, activeRunId: existing.id, updatedAt: existing.updatedAt };
  }
  return appendRun(task, createRunRecord({
    contract: task.contract,
    source: input.source,
    executionType: input.executionType,
    parentRunId: input.parentRunId,
    actionId: input.actionId,
    round: nextRound(task),
    now: input.now,
  }));
}

export function completeActiveRun(
  task: TaskRecord,
  report: ExecutorReportEnvelope,
  verdict: Verdict,
  now = new Date().toISOString(),
): TaskRecord {
  return updateActiveRun(task, run => ({
    ...run,
    report,
    verdict,
    executionCompleted: true,
    status: "REVIEW_READY",
    updatedAt: now,
  }));
}

export function updateActiveRun(task: TaskRecord, updater: (run: RunRecord) => RunRecord): TaskRecord {
  if (!task.activeRunId) return task;
  const runs = task.runs.map(run => run.id === task.activeRunId ? updater(run) : run);
  const updated = runs.find(run => run.id === task.activeRunId);
  return { ...task, runs, updatedAt: updated?.updatedAt ?? task.updatedAt };
}

export function canRecordOwnerDecision(
  run: RunRecord | undefined,
  decision: Exclude<Decision, "NONE">,
): boolean {
  if (!run?.verdict) return false;
  if (decision === "ACCEPTED") return run.verdict.classification === "PASS";
  if (decision === "ACCEPTED_WITH_OVERRIDE") {
    return run.verdict.classification !== "PASS" && run.correctionNotes.trim().length >= 12;
  }
  return true;
}

export function recordOwnerDecision(
  task: TaskRecord,
  decision: Exclude<Decision, "NONE">,
  now = new Date().toISOString(),
): TaskRecord {
  const run = activeRun(task);
  if (!canRecordOwnerDecision(run, decision)) return task;
  return {
    ...updateActiveRun(task, current => ({
      ...current,
      decision,
      decisionAt: now,
      updatedAt: now,
      correctionStarted: false,
    })),
    reviewTab: "decision",
  };
}

export function updateCorrectionNotes(task: TaskRecord, notes: string, now = new Date().toISOString()): TaskRecord {
  return updateActiveRun(task, run => ({ ...run, correctionNotes: notes, updatedAt: now }));
}

export function markCorrectionStarted(task: TaskRecord, now = new Date().toISOString()): TaskRecord {
  return updateActiveRun(task, run => ({ ...run, correctionStarted: true, updatedAt: now }));
}

export function taskStatus(task: TaskRecord): "DRAFT" | "AWAITING_APPROVAL" | "APPROVED" | "IN_EXECUTION" | "AWAITING_DECISION" | "CORRECTION_REQUESTED" | "CLOSED" | "REJECTED" {
  if (!task.contract) return "DRAFT";
  if (task.contract.ownerApproval.state !== "APPROVED") return "AWAITING_APPROVAL";
  const run = activeRun(task);
  if (!run) return "APPROVED";
  if (run.status === "AWAITING_REPORT" || !run.executionCompleted || !run.verdict) return "IN_EXECUTION";
  if (run.decision === "CORRECTION_REQUESTED") return "CORRECTION_REQUESTED";
  if (run.decision === "ACCEPTED" || run.decision === "ACCEPTED_WITH_OVERRIDE") return "CLOSED";
  if (run.decision === "REJECTED") return "REJECTED";
  return "AWAITING_DECISION";
}

export function isApprovedAndClear(task: TaskRecord | undefined): boolean {
  return Boolean(
    task?.contract
    && task.contract.ownerApproval.state === "APPROVED"
    && validatePreflight(task.contract).length === 0
  );
}

export function canAccessWorkflowStep(task: TaskRecord | undefined, step: WorkflowStep): boolean {
  if (step === "task") return Boolean(task);
  if (step === "contract") return Boolean(task?.contract);
  if (step === "execution") return isApprovedAndClear(task);
  const run = activeRun(task);
  if (step === "review") {
    return isApprovedAndClear(task) && Boolean(run?.status === "REVIEW_READY" && run.executionCompleted && run.verdict);
  }
  return isApprovedAndClear(task) && Boolean(run?.status === "REVIEW_READY" && run.executionCompleted && run.verdict);
}

const workflowOrder: WorkflowStep[] = ["task", "contract", "execution", "review", "decision"];

export function workflowStepState(
  task: TaskRecord | undefined,
  current: WorkflowStep,
  step: WorkflowStep,
): "complete" | "current" | "future" {
  if (step === "decision" && activeRun(task)?.decision && !["NONE", "ACKNOWLEDGED"].includes(activeRun(task)!.decision)) return "complete";
  if (step === current) return "current";
  const target = workflowOrder.indexOf(step);
  const active = workflowOrder.indexOf(current);
  if (target < active && canAccessWorkflowStep(task, step)) return "complete";
  return "future";
}

export function workflowRoute(step: WorkflowStep): string {
  if (step === "task") return "/tasks/current";
  if (step === "contract") return "/contracts/current";
  if (step === "execution") return "/runs/current/execute";
  if (step === "decision") return "/runs/current/review#decision";
  return "/runs/current/review";
}

function validVerdict(value: unknown): value is Verdict {
  if (!value || typeof value !== "object") return false;
  return ["PASS", "BLOCKER", "VIOLATION", "EVIDENCE_REQUIRED"].includes((value as Verdict).classification);
}

function upgradeContract(value: unknown, draft: TaskDraftInput): { contract?: ExecutionContract; schemaChanged: boolean } {
  const parsed = executionContractSchema.safeParse(value);
  if (parsed.success) return { contract: parsed.data, schemaChanged: false };
  if (!value || typeof value !== "object") return { schemaChanged: false };
  const raw = value as Record<string, unknown>;
  if (typeof raw.contractId !== "string" || !raw.contractId.trim()) return { schemaChanged: true };

  const providerId = draft.providerId ?? "OPENAI";
  const modelId = draft.modelId ?? defaultModelForProvider(providerId);

  const rebuilt = resolveExecutionContract({
    contractId: raw.contractId,
    objective: draft.objective,
    taskMode: draft.taskMode,
    workspaces: draft.workspaces,
    allowedPaths: draft.allowedPaths,
    excludedPaths: draft.excludedPaths,
    evidenceFiles: draft.evidenceFiles,
    identity: draft.identity,
    authorization: {
      readFiles: draft.readFiles,
      modifySource: draft.modifySource,
      runStaticValidation: draft.runStaticValidation,
      runTests: draft.runTests,
      build: draft.build,
      deploy: draft.deploy,
      restartServices: draft.restartServices,
      writeDatabase: draft.writeDatabase,
      changeEnvironment: draft.changeEnvironment,
      useNetwork: draft.useNetwork,
    },
    providerId,
    modelId,
    executionChannelId: draft.executionChannelId ?? providerRegistry[providerId].executionChannelId,
    reasoningProfile: draft.reasoningProfile ?? modelRegistry[modelId].defaultReasoningProfile,
    runtimeProfileId: draft.runtimeProfileId ?? defaultRuntimeProfileForProvider(providerId),
    ownerOverrideAccepted: Boolean(draft.modelOverrideAccepted),
  });

  return {
    contract: {
      ...rebuilt,
      ownerApproval: { required: true, state: "AWAITING_OWNER_APPROVAL" },
    },
    schemaChanged: true,
  };
}

function arrayFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  if (typeof value === "string") return value.split("\n").map(item => item.trim()).filter(Boolean);
  return [];
}

function inferProvider(executor: unknown): ProviderId {
  const normalized = typeof executor === "string" ? executor.toLowerCase() : "";
  if (normalized.includes("claude")) return "ANTHROPIC";
  if (normalized.includes("gemini")) return "GOOGLE";
  return "OPENAI";
}

function migrateTaskContext(value: unknown): TaskContext {
  if (!value || typeof value !== "object") return { kind: "INDEPENDENT" };
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "PROJECT_BOUND") return { kind: "INDEPENDENT" };
  if (
    typeof raw.projectContextId !== "string"
    || typeof raw.projectContextDisplayName !== "string"
    || typeof raw.projectContextRevision !== "number"
  ) return { kind: "INDEPENDENT" };
  return {
    kind: "PROJECT_BOUND",
    projectContextId: raw.projectContextId,
    projectContextDisplayName: raw.projectContextDisplayName,
    projectContextRevision: raw.projectContextRevision,
  };
}

function migrateDraft(value: unknown): TaskDraftInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const providerId = (["OPENAI", "ANTHROPIC", "GOOGLE"] as const).includes(raw.providerId as ProviderId)
    ? raw.providerId as ProviderId
    : inferProvider(raw.executor);
  const candidateModel = typeof raw.modelId === "string" && raw.modelId in modelRegistry
    ? raw.modelId as ModelId
    : defaultModelForProvider(providerId);
  const base = createBlankContractInput(
    raw.taskMode === "SOURCE_IMPLEMENTATION" || raw.taskMode === "REPORT_REVIEW"
      ? raw.taskMode
      : "CONTROLLED_AUDIT",
  );
  const workspaceRef = typeof raw.workspaceRef === "string"
    ? raw.workspaceRef
    : typeof raw.projectRef === "string"
      ? raw.projectRef
      : "";
  const rawWorkspaces = Array.isArray(raw.workspaces) ? raw.workspaces : [];
  const workspaces: WorkspaceReference[] = rawWorkspaces.flatMap((value, ordering): WorkspaceReference[] => {
    if (!value || typeof value !== "object") return [];
    const workspace = value as Record<string, unknown>;
    if (typeof workspace.reference !== "string" || !workspace.reference.trim()) return [];
    return [{
      id: typeof workspace.id === "string" && workspace.id.trim() ? workspace.id : `migrated-workspace-${ordering + 1}`,
      displayName: typeof workspace.displayName === "string" && workspace.displayName.trim() ? workspace.displayName : workspace.reference,
      role: typeof workspace.role === "string" && workspace.role.trim() ? workspace.role : "primary",
      referenceType: workspace.referenceType === "REMOTE_REFERENCE" ? "REMOTE_REFERENCE" as const : "LOCAL_PATH" as const,
      reference: workspace.reference,
      repositoryIdentity: typeof workspace.repositoryIdentity === "string" ? workspace.repositoryIdentity : undefined,
      branch: typeof workspace.branch === "string" ? workspace.branch : undefined,
      commitSha: typeof workspace.commitSha === "string" ? workspace.commitSha : undefined,
      fingerprint: typeof workspace.fingerprint === "string" && workspace.fingerprint.trim() ? workspace.fingerprint : `migrated-workspace-${ordering + 1}`,
      provenance: typeof workspace.provenance === "string" ? workspace.provenance : undefined,
      discoveryScopeMode:
        workspace.discoveryScopeMode === "FULL_WORKSPACE"
        || workspace.discoveryScopeMode === "SELECTED_PATHS"
        || workspace.discoveryScopeMode === "NONE"
          ? workspace.discoveryScopeMode
          : arrayFromUnknown(workspace.allowedPaths).length
            ? "SELECTED_PATHS"
            : base.taskMode === "CONTROLLED_AUDIT"
              ? "FULL_WORKSPACE"
              : "NONE",
      allowedPaths: arrayFromUnknown(workspace.allowedPaths),
      excludedPaths: arrayFromUnknown(workspace.excludedPaths),
      authorizationContext: typeof workspace.authorizationContext === "string" && workspace.authorizationContext.trim() ? workspace.authorizationContext : "migrated owner authority",
      ordering,
    }];
  });
  const migratedWorkspaces: WorkspaceReference[] = workspaces.length || !workspaceRef ? workspaces : [{
    id: "migrated-workspace-1", displayName: workspaceRef, role: "primary", referenceType: "LOCAL_PATH" as const, reference: workspaceRef,
    fingerprint: typeof raw.workspaceFingerprint === "string" && raw.workspaceFingerprint.trim() ? raw.workspaceFingerprint : "migrated-workspace-1",
    discoveryScopeMode: arrayFromUnknown(raw.allowedPaths).length ? "SELECTED_PATHS" : base.taskMode === "CONTROLLED_AUDIT" ? "FULL_WORKSPACE" : "NONE",
    allowedPaths: arrayFromUnknown(raw.allowedPaths), excludedPaths: arrayFromUnknown(raw.excludedPaths), authorizationContext: "migrated owner authority", ordering: 0,
  }];
  return {
    ...base,
    objective: typeof raw.objective === "string" ? raw.objective : "",
    taskContext: migrateTaskContext(raw.taskContext),
    taskMode: raw.taskMode === "SOURCE_IMPLEMENTATION" || raw.taskMode === "REPORT_REVIEW"
      ? raw.taskMode
      : "CONTROLLED_AUDIT",
    providerId,
    modelId: candidateModel,
    executionChannelId: providerRegistry[providerId].executionChannelId,
    reasoningProfile: modelRegistry[candidateModel].allowedReasoningProfiles.includes(raw.reasoningProfile as ReasoningProfile)
      ? raw.reasoningProfile as ReasoningProfile
      : modelRegistry[candidateModel].defaultReasoningProfile,
    runtimeProfileId: raw.runtimeProfileId === "CODEX_ULTRA" || raw.runtimeProfileId === "CLAUDE_ULTRACODE"
      ? raw.runtimeProfileId
      : defaultRuntimeProfileForProvider(providerId),
    modelOverrideAccepted: raw.modelOverrideAccepted === true,
    workspaces: migratedWorkspaces,
    workspaceRef,
    workspaceSource: "MANUAL_UNVERIFIED",
    workspaceFingerprint: typeof raw.workspaceFingerprint === "string" ? raw.workspaceFingerprint : "",
    allowedPaths: arrayFromUnknown(raw.allowedPaths),
    excludedPaths: arrayFromUnknown(raw.excludedPaths),
    evidenceFiles: arrayFromUnknown(raw.evidenceFiles),
    identity: typeof raw.identity === "string" ? raw.identity : "",
    readFiles: typeof raw.readFiles === "boolean" ? raw.readFiles : base.readFiles,
    modifySource: typeof raw.modifySource === "boolean" ? raw.modifySource : base.modifySource,
    runStaticValidation: typeof raw.runStaticValidation === "boolean" ? raw.runStaticValidation : base.runStaticValidation,
    runTests: typeof raw.runTests === "boolean" ? raw.runTests : base.runTests,
    build: typeof raw.build === "boolean" ? raw.build : base.build,
    deploy: typeof raw.deploy === "boolean" ? raw.deploy : false,
    restartServices: typeof raw.restartServices === "boolean" ? raw.restartServices : false,
    writeDatabase: typeof raw.writeDatabase === "boolean" ? raw.writeDatabase : false,
    changeEnvironment: typeof raw.changeEnvironment === "boolean" ? raw.changeEnvironment : false,
    useNetwork: typeof raw.useNetwork === "boolean" ? raw.useNetwork : false,
  };
}

function restoreRun(value: unknown, contract?: ExecutionContract): RunRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") return undefined;
  const report = raw.report && executorReportEnvelopeSchema.safeParse(raw.report).success
    ? raw.report as ExecutorReportEnvelope
    : undefined;
  const verdict = validVerdict(raw.verdict) ? raw.verdict : undefined;
  const source = runSources.includes(raw.source as RunSource) ? raw.source as RunSource : "IMPORTED_REPORT";
  const completed = raw.executionCompleted === true || Boolean(report && verdict);
  const selected = contract?.selectedConfiguration;
  const providerId = selected?.providerId ?? "OPENAI";
  const modelId = selected?.modelId ?? defaultModelForProvider(providerId);
  const channelId = selected?.executionChannelId ?? providerRegistry[providerId].executionChannelId;
  return {
    id: raw.id,
    round: typeof raw.round === "number" ? raw.round : 1,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    contractId: typeof raw.contractId === "string"
      ? raw.contractId
      : typeof raw.contractRunId === "string"
        ? raw.contractRunId
        : contract?.contractId ?? "legacy-contract",
    source,
    executionType: executionTypes.includes(raw.executionType as ExecutionType)
      ? raw.executionType as ExecutionType
      : source === "SYNTHETIC_FIXTURE"
        ? "FIXTURE"
        : source === "CORRECTION_REPORT"
          ? "CORRECTION"
          : "INITIAL",
    status: runStatuses.includes(raw.status as RunStatus)
      ? raw.status as RunStatus
      : completed
        ? "REVIEW_READY"
        : "AWAITING_REPORT",
    parentRunId: typeof raw.parentRunId === "string" ? raw.parentRunId : undefined,
    bindingMarker: typeof raw.bindingMarker === "string" && raw.bindingMarker.trim()
      ? raw.bindingMarker
      : reportBindingMarker(
          typeof raw.contractId === "string" ? raw.contractId : contract?.contractId ?? "legacy-contract",
          raw.id,
          typeof raw.round === "number" ? raw.round : 1,
        ),
    actionId: typeof raw.actionId === "string" ? raw.actionId : undefined,
    executor: typeof raw.executor === "string" ? raw.executor : providerRegistry[providerId].executionChannelName,
    agentProfileId: channelId,
    providerId,
    modelId,
    reasoningProfile: selected?.reasoningProfile ?? modelRegistry[modelId].defaultReasoningProfile,
    runtimeProfileId: selected?.runtimeProfileId ?? defaultRuntimeProfileForProvider(providerId),
    scenario: typeof raw.scenario === "string" ? raw.scenario : undefined,
    executionCompleted: completed,
    report,
    verdict,
    decision: decisions.includes(raw.decision as Decision) ? raw.decision as Decision : "NONE",
    decisionAt: typeof raw.decisionAt === "string" ? raw.decisionAt : undefined,
    correctionNotes: typeof raw.correctionNotes === "string" ? raw.correctionNotes : "",
    correctionStarted: raw.correctionStarted === true,
    supersededAt: typeof raw.supersededAt === "string" ? raw.supersededAt : undefined,
  };
}

function restoreTask(value: unknown): TaskRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") return undefined;
  const draft = migrateDraft(raw.draft);
  if (!draft) return undefined;
  const upgraded = upgradeContract(raw.contract, draft);
  const contract = upgraded.contract;
  const discoveryRun = discoveryRunProjectionSchema.safeParse(raw.discoveryRun).success
    ? raw.discoveryRun as DiscoveryRunProjection
    : undefined;
  const now = new Date().toISOString();
  const restoredRuns = Array.isArray(raw.runs)
    ? raw.runs.map(item => restoreRun(item, contract)).filter((run): run is RunRecord => Boolean(run))
    : [];
  const runs = restoredRuns.map(run => {
    if (run.executionType !== "CORRECTION" || !run.parentRunId) return run;
    const parent = restoredRuns.find(item => item.id === run.parentRunId);
    return parent ? { ...run, bindingMarker: parent.bindingMarker } : run;
  });
  const schemaChanged = upgraded.schemaChanged;
  const migratedRuns = schemaChanged
    ? runs.map(run => run.supersededAt ? run : { ...run, supersededAt: now })
    : runs;
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    revision: typeof raw.revision === "number" ? raw.revision : 0,
    draft,
    discoveryRun,
    contract,
    runs: migratedRuns,
    activeRunId: !schemaChanged && contract && migratedRuns.some(run => run.id === raw.activeRunId) ? raw.activeRunId as string : undefined,
    promptLocale: raw.promptLocale === "ar" ? "ar" : raw.promptLocale === "en" ? "en" : undefined,
    promptLocaleExplicit: raw.promptLocaleExplicit === true,
    contractTab: contractTabs.includes(raw.contractTab as ContractTab) ? raw.contractTab as ContractTab : "summary",
    reviewTab: reviewTabs.includes(raw.reviewTab as ReviewTab) ? raw.reviewTab as ReviewTab : "summary",
  };
}

function parseWorkspace(raw: string | null): Workspace | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!Array.isArray(value.tasks)) return undefined;
  const tasks = value.tasks.map(restoreTask).filter((task): task is TaskRecord => Boolean(task));
  const activeTaskId = tasks.some(task => task.id === value.activeTaskId) ? value.activeTaskId as string : undefined;
  return {
    version: 4,
    tasks,
    activeTaskId,
    interfaceLocale: value.interfaceLocale === "ar" ? "ar" : value.interfaceLocale === "en" ? "en" : undefined,
  };
}

export function restoreWorkspace(
  raw: string | null,
  legacyRaw: string | null = null,
  oldestRaw: string | null = null,
): Workspace {
  try {
    return parseWorkspace(raw) ?? parseWorkspace(legacyRaw) ?? parseWorkspace(oldestRaw) ?? emptyWorkspace();
  } catch {
    return emptyWorkspace();
  }
}
