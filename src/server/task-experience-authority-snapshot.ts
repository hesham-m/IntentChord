import type { TaskRecord } from "@/lib/workspace";
import type {
  TaskCandidateScope,
  TaskContextAnalysisBinding,
  TaskExecutionSetup,
  TaskScopeConfirmation,
  WorkspaceReference,
} from "@/core/tasks/task-input";
import { candidateScopeIdentityFromScope, candidateScopeIdentityMatches, extractExecutionSetup } from "@/core/tasks/task-input";
import type { PolicyDecision } from "@/core/policies/policy";
import { resolveAuthorization } from "@/core/policies/policy";
import type { ProviderId, ModelId } from "@/core/providers/registry";
import { modelRegistry } from "@/core/providers/registry";
import {
  executionChannelIdSchema,
  modelIdSchema,
  providerIdSchema,
  reasoningProfileSchema,
  runtimeProfileIdSchema,
} from "@/core/contracts/execution-contract";
import type {
  MappingAttemptView,
  MappingInputEntry,
  MappingRunView,
  OwnerContextDecisionView,
} from "@/core/ai-context-mapper/types";
import {
  buildMappingInputSnapshot,
  buildMappingInputSnapshotFromCanonicalArtifact,
} from "@/core/ai-context-mapper/input-builder";
import type { WorkspaceAuthorityRegistration } from "@/server/workspace-connector";
import { readWorkspaceAuthorityRegistration } from "@/server/workspace-connector";
import type { WorkspaceIndexSnapshotRecord } from "@/server/workspace-index-snapshot-repository";
import {
  readPersistedWorkspaceIndexMappingAuthority,
  readPersistedWorkspaceIndexSnapshot,
} from "@/server/workspace-index-snapshot-service";
import { PostgresAiContextMappingRepository } from "@/server/ai-context-mapping-repository";
import { readTaskLifecycle } from "@/server/lifecycle";
import { databaseQuery } from "@/server/db";
import { HttpCommandError } from "@/server/errors";
import type { ContextClosureView } from "@/server/context-closure-service";
import { readCurrentContextHead, readFrozenContextForwardAuthorityStatus } from "@/server/context-head-authority";

export type RequestedAuthorization = {
  readFiles: boolean;
  modifySource: boolean;
  runStaticValidation: boolean;
  runTests: boolean;
  build: boolean;
  deploy: boolean;
  restartServices: boolean;
  writeDatabase: boolean;
  changeEnvironment: boolean;
  useNetwork: boolean;
};

export type InstallationExecutionConfiguration = {
  configuredProviders: ProviderId[];
  configuredModels: ModelId[];
  providerConfigurationSource: "TEST_OVERRIDE" | "NONE";
  modelConfigurationSource: "TEST_OVERRIDE" | "NONE";
};

type ValidationEvidenceAuthority = {
  id: string;
  checkId: string;
  status: "PASS" | "FAIL" | "EVIDENCE_REQUIRED";
  producerType: string;
  producerId?: string;
  trustBasis?: string;
  details: string;
  integritySha256?: string;
  capturedAt: string;
};

export type TaskExperienceRunAuthority = {
  frozenExecutionSetup: TaskExecutionSetup;
  reportSubmission?: {
    id: string;
    reportFormat: "JSON" | "MARKDOWN" | "UNKNOWN";
    contentSha256: string;
    receivedAt: string;
  };
  evidenceReferences: Array<{
    workspaceId?: string;
    path?: string;
    sourceReference: string;
    observation: string;
    referenceKind?: string;
    evidenceType: string;
  }>;
  validationEvidence: ValidationEvidenceAuthority[];
  inheritedValidationEvidence: Array<{
    checkId: string;
    parentRunId: string;
    sourceValidationEvidenceId: string;
    inheritedAt: string;
    source: ValidationEvidenceAuthority;
  }>;
  sourceEvidence: Array<{
    requirementId: string;
    workspaceId: string;
    path: string;
    contentSha256: string;
    observation: string;
    producerType: string;
  }>;
  artifactEvidence: Array<{
    requirementId: string;
    artifactId: string;
    artifactSha256: string;
    producerType: string;
  }>;
  toolTraceEvents: Array<{
    sequence: number;
    command: string;
    authorizationResult: "AUTHORIZED" | "UNAUTHORIZED" | "UNKNOWN";
    occurredAt: string;
  }>;
  verdictIdentity?: {
    id: string;
    engineVersion: string;
    createdAt: string;
  };
  ownerDecisionIdentity?: {
    id: string;
    createdAt: string;
  };
};

export type TaskExperienceWorkspaceAuthority = {
  taskWorkspace: WorkspaceReference;
  registration?: WorkspaceAuthorityRegistration;
  latestIndex?: WorkspaceIndexSnapshotRecord;
};

export type TaskExperienceAnalysisAuthority = {
  workspaceId: string;
  workspaceIndex: WorkspaceIndexSnapshotRecord;
  mappingInputEntries: MappingInputEntry[];
  mappingRun?: MappingRunView;
  mappingAttempts: MappingAttemptView[];
};

export type TaskExperienceBoundAnalysisAuthority = TaskExperienceAnalysisAuthority & {
  binding: TaskContextAnalysisBinding;
  mappingRun: MappingRunView;
};

export type TaskExperienceExecutionAuthority = {
  source: "NONE" | "DRAFT" | "CONTRACT" | "RUN";
  setup?: TaskExecutionSetup;
  frozenCompiledArtifact?: TaskRecord["runs"][number]["compiledArtifact"];
};

export type TaskExperienceContextForwardAuthority = {
  frozenContextAssemblyRevisionId?: string;
  currentHeadRevisionId?: string;
  currentHeadRevision?: number;
  headStatus: "CURRENT" | "SUPERSEDED" | "NONE";
  sourceAuthorityStatus: "CURRENT" | "DRIFT" | "UNPROVEN" | "NOT_APPLICABLE";
};

export interface TaskExperienceAuthoritySnapshot {
  task: TaskRecord;
  workspaces: TaskExperienceWorkspaceAuthority[];
  currentAnalyses: TaskExperienceAnalysisAuthority[];
  boundAnalysis?: TaskExperienceBoundAnalysisAuthority;
  ownerContextDecisions: OwnerContextDecisionView[];
  candidateScope?: TaskCandidateScope;
  scopeConfirmation?: TaskScopeConfirmation;
  requestedAuthorization: RequestedAuthorization;
  effectivePolicyTrace: PolicyDecision[];
  execution: TaskExperienceExecutionAuthority;
  activeRun?: TaskRecord["runs"][number];
  runAuthority?: TaskExperienceRunAuthority;
  contractRevision?: number;
  installationConfiguration: InstallationExecutionConfiguration;
  contextClosure?: ContextClosureView;
  contextForwardAuthority: TaskExperienceContextForwardAuthority;
  currentContextForwardAuthority: TaskExperienceContextForwardAuthority;
}

export type TaskExperienceAuthorityDependencies = {
  readTaskLifecycle: typeof readTaskLifecycle;
  readWorkspaceAuthorityRegistration: (workspaceId: string) => Promise<WorkspaceAuthorityRegistration>;
  readLatestWorkspaceIndexSnapshot: (registration: WorkspaceAuthorityRegistration) => Promise<WorkspaceIndexSnapshotRecord | undefined>;
  readWorkspaceIndexAuthority: typeof readPersistedWorkspaceIndexMappingAuthority;
  readLatestMappingRunForWorkspaceIndexSnapshot: (snapshotId: string) => Promise<MappingRunView | undefined>;
  readMappingRun: (runId: string) => Promise<MappingRunView>;
  readMappingInputEntries: (authority: Awaited<ReturnType<typeof readPersistedWorkspaceIndexMappingAuthority>>) => MappingInputEntry[];
  listMappingAttempts: (runId: string) => Promise<MappingAttemptView[]>;
  readRunAuthority: (runId: string) => Promise<TaskExperienceRunAuthority>;
  readContractRevision: (contractRevisionId: string) => Promise<number | undefined>;
  readInstallationConfiguration: () => InstallationExecutionConfiguration;
  readContextClosure: (taskId: string) => Promise<ContextClosureView | undefined>;
  readContextForwardAuthority: (taskId: string, frozenContextAssemblyRevisionId?: string) => Promise<TaskExperienceContextForwardAuthority>;
};

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function requestedAuthorizationFromTask(task: TaskRecord): RequestedAuthorization {
  if (task.contract) return { ...task.contract.authorization };
  const draft = task.draft;
  return {
    readFiles: Boolean(draft.readFiles),
    modifySource: Boolean(draft.modifySource),
    runStaticValidation: Boolean(draft.runStaticValidation),
    runTests: Boolean(draft.runTests),
    build: Boolean(draft.build),
    deploy: Boolean(draft.deploy),
    restartServices: Boolean(draft.restartServices),
    writeDatabase: Boolean(draft.writeDatabase),
    changeEnvironment: Boolean(draft.changeEnvironment),
    useNetwork: Boolean(draft.useNetwork),
  };
}

function executionSetupFromContract(task: TaskRecord): TaskExecutionSetup | undefined {
  const selected = task.contract?.selectedConfiguration;
  if (!selected) return undefined;
  return {
    providerId: selected.providerId,
    modelId: selected.modelId,
    executionChannelId: selected.executionChannelId,
    reasoningProfile: selected.reasoningProfile,
    runtimeProfileId: selected.runtimeProfileId,
    modelOverrideAccepted: selected.ownerOverrideAccepted,
    ...(selected.ownerOverrideReason ? { modelOverrideReason: selected.ownerOverrideReason } : {}),
  };
}

function readInstallationExecutionConfiguration(): InstallationExecutionConfiguration {
  // CURRENT source has no authoritative installation configuration authority for execution
  // providers or models. Credential presence and static registry membership are not configuration.
  return {
    configuredProviders: [],
    configuredModels: [],
    providerConfigurationSource: "NONE",
    modelConfigurationSource: "NONE",
  };
}

function workspaceIndexMatchesCurrentRegistration(
  snapshot: WorkspaceIndexSnapshotRecord,
  registration: WorkspaceAuthorityRegistration,
): boolean {
  return snapshot.sourceMode === "REGISTERED_WORKSPACE"
    && snapshot.workspaceRegistrationId === registration.id
    && snapshot.workspaceRegistrationRevision === registration.revision
    && snapshot.workspaceRegistrationFingerprint === registration.fingerprint;
}

async function readLatestWorkspaceIndexSnapshot(registration: WorkspaceAuthorityRegistration): Promise<WorkspaceIndexSnapshotRecord | undefined> {
  const result = await databaseQuery<{ id: string }>(
    `select s.id from intentchord.workspace_index_snapshots s
     join intentchord.workspaces w on w.id=s.workspace_registration_id
     where s.workspace_registration_id=$1
       and s.source_mode='REGISTERED_WORKSPACE'
       and s.workspace_registration_revision=w.revision
       and s.workspace_registration_fingerprint=w.fingerprint
     order by s.created_at desc,s.id desc limit 1`,
    [registration.id],
  );
  if (!result.rowCount) return undefined;
  const snapshot = await readPersistedWorkspaceIndexSnapshot(result.rows[0].id);
  return workspaceIndexMatchesCurrentRegistration(snapshot, registration) ? snapshot : undefined;
}

async function readLatestMappingRunForWorkspaceIndexSnapshot(snapshotId: string): Promise<MappingRunView | undefined> {
  const result = await databaseQuery<{ id: string }>(
    `select id from intentchord.context_mapping_runs
     where workspace_index_snapshot_id=$1
     order by created_at desc,id desc limit 1`,
    [snapshotId],
  );
  if (!result.rowCount) return undefined;
  return new PostgresAiContextMappingRepository().readRun(result.rows[0].id);
}

async function readRunAuthority(runId: string): Promise<TaskExperienceRunAuthority> {
  const run = await databaseQuery<{ profile_snapshot: unknown }>(
    "select profile_snapshot from intentchord.runs where id=$1",
    [runId],
  );
  if (!run.rowCount) {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_ACTIVE_RUN_NOT_FOUND", `Active Run ${runId} does not exist.`);
  }
  const profile = run.rows[0].profile_snapshot as Record<string, unknown>;
  const providerId = providerIdSchema.safeParse(profile.providerId);
  const modelId = modelIdSchema.safeParse(profile.modelId);
  const executionChannelId = executionChannelIdSchema.safeParse(profile.agentProfileId);
  const reasoningProfile = reasoningProfileSchema.safeParse(profile.reasoningProfile);
  const runtimeProfileId = runtimeProfileIdSchema.safeParse(profile.runtimeProfileId);
  if (!providerId.success || !modelId.success || !executionChannelId.success || !reasoningProfile.success || !runtimeProfileId.success
      || typeof profile.ownerOverrideAccepted !== "boolean") {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_RUN_PROFILE_INVALID", `Run ${runId} has an invalid frozen profile snapshot.`);
  }
  if (!configuredModelBelongsToProvider(modelId.data, providerId.data)) {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_RUN_PROFILE_MODEL_PROVIDER_MISMATCH", `Run ${runId} frozen model does not belong to its frozen provider.`);
  }
  const overrideReason = typeof profile.ownerOverrideReason === "string" && profile.ownerOverrideReason.trim()
    ? profile.ownerOverrideReason.trim()
    : undefined;
  if (profile.ownerOverrideAccepted && !overrideReason) {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_RUN_PROFILE_OVERRIDE_REASON_REQUIRED", `Run ${runId} accepted a frozen model override without a frozen Owner reason.`);
  }
  const frozenExecutionSetup: TaskExecutionSetup = {
    providerId: providerId.data,
    modelId: modelId.data,
    executionChannelId: executionChannelId.data,
    reasoningProfile: reasoningProfile.data,
    runtimeProfileId: runtimeProfileId.data,
    modelOverrideAccepted: profile.ownerOverrideAccepted,
    ...(overrideReason ? { modelOverrideReason: overrideReason } : {}),
  };

  const report = await databaseQuery<{
    id: string;
    report_format: "JSON" | "MARKDOWN" | "UNKNOWN";
    content_sha256: string;
    received_at: string | Date;
  }>(
    `select id,report_format,content_sha256,received_at
     from intentchord.report_submissions
     where run_id=$1 and parse_status='PARSED'
     order by received_at desc,id desc limit 1`,
    [runId],
  );
  const reportSubmission = report.rows[0]
    ? {
      id: report.rows[0].id,
      reportFormat: report.rows[0].report_format,
      contentSha256: report.rows[0].content_sha256,
      receivedAt: asIso(report.rows[0].received_at),
    }
    : undefined;

  type EvidenceRow = {
    workspace_registration_id: string | null;
    relative_path: string | null;
    source_reference: string;
    observation: string;
    reference_kind: string | null;
    evidence_type: string;
  };
  const evidence: { rows: EvidenceRow[] } = reportSubmission
    ? await databaseQuery<EvidenceRow>(
      `select workspace_registration_id,relative_path,source_reference,observation,reference_kind,evidence_type
       from intentchord.report_evidence_references
       where report_submission_id=$1 order by created_at,id`,
      [reportSubmission.id],
    )
    : { rows: [] };

  type ValidationRow = {
    id: string;
    check_id: string;
    status: "PASS" | "FAIL" | "EVIDENCE_REQUIRED";
    producer_type: string;
    producer_id: string | null;
    trust_basis: string | null;
    details: string;
    integrity_sha256: string | null;
    captured_at: string | Date;
  };
  const validation = await databaseQuery<ValidationRow>(
    `select id,check_id,status,producer_type,producer_id,trust_basis,details,integrity_sha256,captured_at
     from intentchord.validation_evidence
     where run_id=$1 order by captured_at,id`,
    [runId],
  );

  type InheritedRow = {
    check_id: string;
    parent_run_id: string;
    source_validation_evidence_id: string;
    inherited_at: string | Date;
    source_id: string;
    source_check_id: string;
    source_status: "PASS" | "FAIL" | "EVIDENCE_REQUIRED";
    source_producer_type: string;
    source_producer_id: string | null;
    source_trust_basis: string | null;
    source_details: string;
    source_integrity_sha256: string | null;
    source_captured_at: string | Date;
  };
  const inherited = await databaseQuery<InheritedRow>(
    `select ive.check_id,ive.parent_run_id,ive.source_validation_evidence_id,ive.inherited_at,
       ve.id as source_id,ve.check_id as source_check_id,ve.status as source_status,
       ve.producer_type as source_producer_type,ve.producer_id as source_producer_id,
       ve.trust_basis as source_trust_basis,ve.details as source_details,
       ve.integrity_sha256 as source_integrity_sha256,ve.captured_at as source_captured_at
     from intentchord.inherited_validation_evidence ive
     join intentchord.validation_evidence ve on ve.id=ive.source_validation_evidence_id
     where ive.run_id=$1 order by ive.check_id`,
    [runId],
  );

  const sourceEvidence = await databaseQuery<{
    requirement_id: string;
    workspace_registration_id: string;
    relative_path: string;
    content_sha256: string;
    observation: string;
    producer_type: string;
  }>(
    `select requirement_id,workspace_registration_id,relative_path,content_sha256,observation,producer_type
     from intentchord.source_evidence where run_id=$1 order by created_at,id`,
    [runId],
  );

  const artifactEvidence = await databaseQuery<{
    requirement_id: string;
    artifact_id: string;
    artifact_sha256: string;
    producer_type: string;
  }>(
    `select requirement_id,artifact_id,artifact_sha256,producer_type
     from intentchord.artifact_evidence where run_id=$1 order by created_at,id`,
    [runId],
  );

  type TraceRow = {
    sequence: string | number;
    command: string;
    authorization_result: "AUTHORIZED" | "UNAUTHORIZED" | "UNKNOWN";
    occurred_at: string | Date;
  };
  const traces = await databaseQuery<TraceRow>(
    `select sequence,command,authorization_result,occurred_at
     from intentchord.tool_trace_events
     where run_id=$1 order by sequence,id`,
    [runId],
  );

  const verdict = await databaseQuery<{ id: string; engine_version: string; created_at: string | Date }>(
    "select id,engine_version,created_at from intentchord.verdicts where run_id=$1",
    [runId],
  );
  const decision = await databaseQuery<{ id: string; created_at: string | Date }>(
    `select id,created_at from intentchord.owner_decisions
     where run_id=$1 order by created_at desc,id desc limit 1`,
    [runId],
  );

  const mapValidation = (row: ValidationRow): ValidationEvidenceAuthority => ({
    id: row.id,
    checkId: row.check_id,
    status: row.status,
    producerType: row.producer_type,
    ...(row.producer_id ? { producerId: row.producer_id } : {}),
    ...(row.trust_basis ? { trustBasis: row.trust_basis } : {}),
    details: row.details,
    ...(row.integrity_sha256 ? { integritySha256: row.integrity_sha256 } : {}),
    capturedAt: asIso(row.captured_at),
  });

  return {
    frozenExecutionSetup,
    reportSubmission,
    evidenceReferences: evidence.rows.map(row => ({
      ...(row.workspace_registration_id ? { workspaceId: row.workspace_registration_id } : {}),
      ...(row.relative_path ? { path: row.relative_path } : {}),
      sourceReference: row.source_reference,
      observation: row.observation,
      ...(row.reference_kind ? { referenceKind: row.reference_kind } : {}),
      evidenceType: row.evidence_type,
    })),
    validationEvidence: validation.rows.map(mapValidation),
    inheritedValidationEvidence: inherited.rows.map((row: InheritedRow) => ({
      checkId: row.check_id,
      parentRunId: row.parent_run_id,
      sourceValidationEvidenceId: row.source_validation_evidence_id,
      inheritedAt: asIso(row.inherited_at),
      source: mapValidation({
        id: row.source_id,
        check_id: row.source_check_id,
        status: row.source_status,
        producer_type: row.source_producer_type,
        producer_id: row.source_producer_id,
        trust_basis: row.source_trust_basis,
        details: row.source_details,
        integrity_sha256: row.source_integrity_sha256,
        captured_at: row.source_captured_at,
      }),
    })),
    sourceEvidence: sourceEvidence.rows.map((row: { requirement_id: string; workspace_registration_id: string; relative_path: string; content_sha256: string; observation: string; producer_type: string }) => ({
      requirementId: row.requirement_id,
      workspaceId: row.workspace_registration_id,
      path: row.relative_path,
      contentSha256: row.content_sha256,
      observation: row.observation,
      producerType: row.producer_type,
    })),
    artifactEvidence: artifactEvidence.rows.map((row: { requirement_id: string; artifact_id: string; artifact_sha256: string; producer_type: string }) => ({
      requirementId: row.requirement_id,
      artifactId: row.artifact_id,
      artifactSha256: row.artifact_sha256,
      producerType: row.producer_type,
    })),
    toolTraceEvents: traces.rows.map((row: TraceRow) => ({
      sequence: Number(row.sequence),
      command: row.command,
      authorizationResult: row.authorization_result,
      occurredAt: asIso(row.occurred_at),
    })),
    ...(verdict.rows[0] ? {
      verdictIdentity: {
        id: verdict.rows[0].id,
        engineVersion: verdict.rows[0].engine_version,
        createdAt: asIso(verdict.rows[0].created_at),
      },
    } : {}),
    ...(decision.rows[0] ? {
      ownerDecisionIdentity: {
        id: decision.rows[0].id,
        createdAt: asIso(decision.rows[0].created_at),
      },
    } : {}),
  };
}

async function readContractRevision(contractRevisionId: string): Promise<number | undefined> {
  const result = await databaseQuery<{ revision: string | number }>(
    "select revision from intentchord.contract_revisions where id=$1",
    [contractRevisionId],
  );
  return result.rows[0] ? Number(result.rows[0].revision) : undefined;
}

function buildMappingEntries(authority: Awaited<ReturnType<typeof readPersistedWorkspaceIndexMappingAuthority>>): MappingInputEntry[] {
  if (authority.snapshot.sourceMode === "REGISTERED_WORKSPACE" && authority.artifact) {
    if (authority.snapshot.canonicalIndexArtifactId) {
      return buildMappingInputSnapshotFromCanonicalArtifact({
        canonicalIndexArtifactId: authority.artifact.id,
        artifactSemanticSha256: authority.artifact.semanticSha256,
        semanticState: authority.artifact.semanticState as import("@/core/workspace-index/artifact-identity").CanonicalIndexArtifactSemanticState,
      }).entries;
    }
    if (authority.snapshot.acceptedWorkspaceEvidenceArtifactId) {
      return [];
    }
  }
  if (authority.snapshot.canonicalIndex) return buildMappingInputSnapshot(authority.snapshot.canonicalIndex).entries;
  return [];
}

const productionDependencies: TaskExperienceAuthorityDependencies = {
  readTaskLifecycle,
  readWorkspaceAuthorityRegistration,
  readLatestWorkspaceIndexSnapshot,
  readWorkspaceIndexAuthority: readPersistedWorkspaceIndexMappingAuthority,
  readLatestMappingRunForWorkspaceIndexSnapshot,
  readMappingRun: async runId => new PostgresAiContextMappingRepository().readRun(runId),
  readMappingInputEntries: buildMappingEntries,
  listMappingAttempts: async runId => new PostgresAiContextMappingRepository().listAttempts(runId),
  readRunAuthority,
  readContractRevision,
  readInstallationConfiguration: readInstallationExecutionConfiguration,
  readContextClosure: async taskId => {
    const { readTaskContextClosure } = await import("@/server/context-closure-service");
    try {
      return await readTaskContextClosure(taskId);
    } catch (error) {
      if (error instanceof HttpCommandError && error.status === 404) return undefined;
      throw error;
    }
  },
  readContextForwardAuthority: async (taskId, frozenContextAssemblyRevisionId) => {
    if (!frozenContextAssemblyRevisionId) {
      const head = await readCurrentContextHead(taskId);
      return {
        ...(head ? { currentHeadRevisionId: head.contextAssemblyRevisionId, currentHeadRevision: head.revision } : {}),
        headStatus: "NONE" as const,
        sourceAuthorityStatus: "NOT_APPLICABLE" as const,
      };
    }
    const status = await readFrozenContextForwardAuthorityStatus(taskId, frozenContextAssemblyRevisionId);
    return {
      frozenContextAssemblyRevisionId,
      ...(status.head ? { currentHeadRevisionId: status.head.contextAssemblyRevisionId, currentHeadRevision: status.head.revision } : {}),
      headStatus: status.isHead ? "CURRENT" as const : "SUPERSEDED" as const,
      sourceAuthorityStatus: status.source.status,
    };
  },
};

function assertMappingRunMatchesWorkspaceIndex(index: WorkspaceIndexSnapshotRecord, run: MappingRunView): void {
  if (run.workspaceIndexSnapshotId !== index.id) {
    throw new HttpCommandError(
      409,
      "TASK_EXPERIENCE_MAPPING_INDEX_MISMATCH",
      `Mapping Run ${run.id} does not belong to Workspace Index Snapshot ${index.id}.`,
    );
  }
}

function assertOwnerDecisionBinding(binding: TaskContextAnalysisBinding, run: MappingRunView): void {
  const decisionsById = new Map(run.ownerContextDecisions.map(decision => [decision.id, decision]));
  const contextsById = new Set(run.proposal?.modelProposal.contexts.map(context => context.context_id) ?? []);
  for (const decisionId of binding.acceptedContextDecisionIds) {
    const decision = decisionsById.get(decisionId);
    if (!decision) {
      throw new HttpCommandError(409, "TASK_EXPERIENCE_ACCEPTED_DECISION_NOT_FOUND", `Accepted Owner Context Decision ${decisionId} was not found in the bound Mapping Run.`);
    }
    if (decision.runId !== binding.mappingRunId || decision.proposalId !== binding.proposalId) {
      throw new HttpCommandError(409, "TASK_EXPERIENCE_OWNER_DECISION_BINDING_MISMATCH", `Owner Context Decision ${decisionId} does not belong to the bound Mapping Run and Proposal.`);
    }
    if (decision.decision !== "ACCEPT") {
      throw new HttpCommandError(409, "TASK_EXPERIENCE_NON_ACCEPTED_DECISION_IN_BINDING", `Owner Context Decision ${decisionId} is ${decision.decision}; only ACCEPT decisions may be projected as selected work.`);
    }
    if (!contextsById.has(decision.contextId)) {
      throw new HttpCommandError(409, "TASK_EXPERIENCE_DECISION_CONTEXT_NOT_IN_PROPOSAL", `Owner Context Decision ${decisionId} references context ${decision.contextId}, which is absent from the bound Proposal.`);
    }
  }
}

function assertBoundAnalysisIdentity(binding: TaskContextAnalysisBinding, index: WorkspaceIndexSnapshotRecord, run: MappingRunView): void {
  if (index.id !== binding.workspaceIndexSnapshotId) {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_INDEX_BINDING_MISMATCH", "Task Experience authority snapshot resolved the wrong Workspace Index Snapshot.");
  }
  if (run.id !== binding.mappingRunId) {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_MAPPING_RUN_BINDING_MISMATCH", "Task Experience authority snapshot resolved the wrong Mapping Run.");
  }
  assertMappingRunMatchesWorkspaceIndex(index, run);
  if (!run.proposal) {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_VALIDATED_PROPOSAL_REQUIRED", "The bound Mapping Run has no validated Proposal.");
  }
  if (run.proposal.id !== binding.proposalId || run.proposal.proposalSha256 !== binding.proposalSha256) {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_PROPOSAL_BINDING_MISMATCH", "The bound Mapping Proposal identity does not match the Task context-analysis binding.");
  }
}

function assertTaskAuthorityLevelConsistency(task: TaskRecord): void {
  const legacyBinding = task.draft.contextAnalysisBinding;
  const assemblyBinding = task.draft.contextAssemblyBinding;
  const candidate = task.draft.candidateScope;
  const confirmation = task.draft.scopeConfirmation;

  if (candidate) {
    if (candidate.authorityVersion === "CONTEXT_ASSEMBLY_V2") {
      if (!assemblyBinding) {
        throw new HttpCommandError(409, "TASK_EXPERIENCE_CANDIDATE_WITHOUT_BINDING", "V2 Candidate Scope exists without the closed Context Assembly binding that authorizes its derivation.");
      }
      const sameAssembly = candidate.contextAssemblyId === assemblyBinding.contextAssemblyId
        && candidate.contextAssemblyRevisionId === assemblyBinding.contextAssemblyRevisionId
        && candidate.mappingIterationId === assemblyBinding.mappingIterationId
        && candidate.closureEvaluationId === assemblyBinding.closureEvaluationId
        && candidate.acceptedCatalogRevisionId === assemblyBinding.acceptedCatalogRevisionId
        && candidate.acceptedCatalogSha256 === assemblyBinding.acceptedCatalogSha256;
      if (!sameAssembly) {
        throw new HttpCommandError(409, "TASK_EXPERIENCE_CANDIDATE_BINDING_MISMATCH", "V2 Candidate Scope identity does not match the accepted closed Context Assembly authority.");
      }
    } else {
      if (!legacyBinding) {
        throw new HttpCommandError(409, "TASK_EXPERIENCE_CANDIDATE_WITHOUT_BINDING", "Legacy Candidate Scope exists without the Context Analysis Binding that authorizes its derivation.");
      }
      const sameLegacy = candidate.workspaceIndexSnapshotId === legacyBinding.workspaceIndexSnapshotId
        && candidate.mappingRunId === legacyBinding.mappingRunId
        && candidate.proposalId === legacyBinding.proposalId
        && candidate.proposalSha256 === legacyBinding.proposalSha256;
      if (!sameLegacy) {
        throw new HttpCommandError(409, "TASK_EXPERIENCE_CANDIDATE_BINDING_MISMATCH", "Legacy Candidate Scope identity does not match the bound Workspace Index / Mapping Proposal authority.");
      }
    }
  }

  if (confirmation && !candidate) {
    throw new HttpCommandError(409, "TASK_EXPERIENCE_CONFIRMATION_WITHOUT_CANDIDATE", "Scope Confirmation exists without its Candidate Scope authority.");
  }
  if (confirmation && candidate) {
    const currentIdentity = candidateScopeIdentityFromScope(candidate);
    if (!candidateScopeIdentityMatches(confirmation.candidateIdentity, currentIdentity)) {
      throw new HttpCommandError(409, "TASK_EXPERIENCE_CONFIRMATION_CANDIDATE_MISMATCH", "Scope Confirmation does not identify the current Candidate Scope authority.");
    }
  }
}


async function composeCurrentAnalysis(
  workspaceId: string,
  index: WorkspaceIndexSnapshotRecord,
  dependencies: TaskExperienceAuthorityDependencies,
): Promise<TaskExperienceAnalysisAuthority> {
  const indexAuthority = await dependencies.readWorkspaceIndexAuthority(index.id);
  const mappingRun = await dependencies.readLatestMappingRunForWorkspaceIndexSnapshot(index.id);
  if (!mappingRun) {
    return {
      workspaceId,
      workspaceIndex: indexAuthority.snapshot,
      mappingInputEntries: [],
      mappingAttempts: [],
    };
  }
  assertMappingRunMatchesWorkspaceIndex(indexAuthority.snapshot, mappingRun);
  return {
    workspaceId,
    workspaceIndex: indexAuthority.snapshot,
    mappingInputEntries: dependencies.readMappingInputEntries(indexAuthority),
    mappingRun,
    mappingAttempts: await dependencies.listMappingAttempts(mappingRun.id),
  };
}

export async function composeTaskExperienceAuthoritySnapshot(
  taskId: string,
  dependencies: TaskExperienceAuthorityDependencies = productionDependencies,
): Promise<TaskExperienceAuthoritySnapshot | undefined> {
  const task = await dependencies.readTaskLifecycle(taskId);
  if (!task) return undefined;
  assertTaskAuthorityLevelConsistency(task);

  const workspaces: TaskExperienceWorkspaceAuthority[] = [];
  const currentAnalyses: TaskExperienceAnalysisAuthority[] = [];
  for (const taskWorkspace of task.draft.workspaces) {
    let registration: WorkspaceAuthorityRegistration | undefined;
    try {
      registration = await dependencies.readWorkspaceAuthorityRegistration(taskWorkspace.id);
    } catch (error) {
      if (!(error instanceof HttpCommandError) || error.status !== 404) throw error;
    }
    const persistedLatestIndex = registration
      ? await dependencies.readLatestWorkspaceIndexSnapshot(registration)
      : undefined;
    const latestIndex = registration && persistedLatestIndex
      && workspaceIndexMatchesCurrentRegistration(persistedLatestIndex, registration)
      ? persistedLatestIndex
      : undefined;
    workspaces.push({ taskWorkspace, registration, latestIndex });
    if (latestIndex?.status === "READY") currentAnalyses.push(await composeCurrentAnalysis(taskWorkspace.id, latestIndex, dependencies));
  }

  let boundAnalysis: TaskExperienceBoundAnalysisAuthority | undefined;
  let ownerContextDecisions: OwnerContextDecisionView[] = [];
  const binding = task.draft.contextAnalysisBinding;
  if (binding) {
    const indexAuthority = await dependencies.readWorkspaceIndexAuthority(binding.workspaceIndexSnapshotId);
    const mappingRun = await dependencies.readMappingRun(binding.mappingRunId);
    assertBoundAnalysisIdentity(binding, indexAuthority.snapshot, mappingRun);
    assertOwnerDecisionBinding(binding, mappingRun);
    const workspaceId = indexAuthority.snapshot.workspaceRegistrationId;
    if (!workspaceId || !task.draft.workspaces.some(item => item.id === workspaceId)) {
      throw new HttpCommandError(409, "TASK_EXPERIENCE_BOUND_WORKSPACE_NOT_IN_TASK", "The bound analysis belongs to a Workspace that is not part of the Task.");
    }
    ownerContextDecisions = mappingRun.ownerContextDecisions;
    boundAnalysis = {
      binding,
      workspaceId,
      workspaceIndex: indexAuthority.snapshot,
      mappingInputEntries: dependencies.readMappingInputEntries(indexAuthority),
      mappingRun,
      mappingAttempts: await dependencies.listMappingAttempts(binding.mappingRunId),
    };
  }

  let activeRun: TaskRecord["runs"][number] | undefined;
  if (task.activeRunId) {
    activeRun = task.runs.find(run => run.id === task.activeRunId);
    if (!activeRun) {
      throw new HttpCommandError(409, "TASK_EXPERIENCE_ACTIVE_RUN_ID_MISMATCH", `Task activeRunId ${task.activeRunId} does not resolve to a persisted Run.`);
    }
    if (activeRun.supersededAt || activeRun.status === "SUPERSEDED") {
      throw new HttpCommandError(409, "TASK_EXPERIENCE_ACTIVE_RUN_SUPERSEDED", `Task activeRunId ${task.activeRunId} resolves to a superseded Run.`);
    }
  }
  const runAuthority = activeRun ? await dependencies.readRunAuthority(activeRun.id) : undefined;

  let execution: TaskExperienceExecutionAuthority = { source: "NONE" };
  if (activeRun && runAuthority) {
    execution = {
      source: "RUN",
      setup: runAuthority.frozenExecutionSetup,
      frozenCompiledArtifact: activeRun.compiledArtifact,
    };
  } else if (task.contract) {
    const contractSetup = executionSetupFromContract(task);
    execution = contractSetup ? { source: "CONTRACT", setup: contractSetup } : { source: "NONE" };
  } else {
    const draftSetup = extractExecutionSetup(task.draft);
    execution = draftSetup ? { source: "DRAFT", setup: draftSetup } : { source: "NONE" };
  }

  const contextClosure = await dependencies.readContextClosure(taskId);
  const frozenContextAssemblyRevisionId = task.draft.scopeConfirmation?.candidateIdentity.authorityVersion === "CONTEXT_ASSEMBLY_V2"
    ? task.draft.scopeConfirmation.candidateIdentity.contextAssemblyRevisionId
    : task.draft.candidateScope?.authorityVersion === "CONTEXT_ASSEMBLY_V2"
      ? task.draft.candidateScope.contextAssemblyRevisionId
      : task.draft.contextAssemblyBinding?.contextAssemblyRevisionId;
  // One Gate, two authority questions: the frozen Candidate/Scope revision controls whether old
  // execution authority may move forward, while the current Context Closure revision controls
  // whether the Owner may rebuild/re-select Work on newly closed current truth. Both use the exact
  // same CURRENT EFFECTIVE CONTEXT authority resolver.
  const contextForwardAuthority = await dependencies.readContextForwardAuthority(
    taskId,
    frozenContextAssemblyRevisionId ?? contextClosure?.revisionId,
  );
  const currentContextForwardAuthority = contextClosure?.revisionId
    ? await dependencies.readContextForwardAuthority(taskId, contextClosure.revisionId)
    : await dependencies.readContextForwardAuthority(taskId, undefined);

  const requestedAuthorization = requestedAuthorizationFromTask(task);
  const effectivePolicyTrace = task.contract
    ? task.contract.policyDecisionTrace
    : resolveAuthorization(task.draft.taskMode, requestedAuthorization).trace;

  return {
    task,
    workspaces,
    currentAnalyses,
    boundAnalysis,
    ownerContextDecisions,
    candidateScope: task.draft.candidateScope,
    scopeConfirmation: task.draft.scopeConfirmation,
    requestedAuthorization,
    effectivePolicyTrace,
    execution,
    activeRun,
    runAuthority,
    contractRevision: task.contractRevisionId
      ? await dependencies.readContractRevision(task.contractRevisionId)
      : undefined,
    installationConfiguration: dependencies.readInstallationConfiguration(),
    contextClosure,
    contextForwardAuthority,
    currentContextForwardAuthority,
  };
}

export function configuredModelBelongsToProvider(modelId: ModelId, providerId: ProviderId): boolean {
  return modelRegistry[modelId]?.providerId === providerId;
}
