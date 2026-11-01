import { z } from "zod/v3";
import { hostname, platform } from "node:os";
import { sha256Canonical, stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import { canonicalWorkspaceIndexHash } from "@/core/workspace-index/canonical";
import { workspaceIndexConfigurationDescriptor, workspaceIndexConfigurationSha256 } from "@/core/workspace-index/artifact-identity";
import { indexWorkspace, WorkspaceIndexingError } from "@/core/workspace-index/indexer";
import { parseWorkspaceIndexEngine } from "@/core/workspace-index/engine-router";
import { indexWorkspaceV2 } from "@/core/workspace-index/ingestion/engine-v2-adapter";
import type { V2Outcome, V2ExecutionResult } from "@/core/workspace-index/ingestion/v2-result";
import { buildAttestationDigestMaterial, computeAttestationSha256 } from "@/core/workspace-index/ingestion/v2-result";
import { DEFAULT_WORKSPACE_INDEX_BUDGETS, inventoryWorkspaceFiles, WorkspaceIndexBoundedError, WORKSPACE_TRAVERSAL_POLICY_ID, type WorkspaceProgressEvidence } from "@/core/workspace-index/adapters/filesystem";
import {
  DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
  deriveWorkspaceProcessingDurationBudget,
  workspaceAbsoluteOperationDeadlineAt,
  workspaceDurationConfigurationIdentity,
  workspacePhaseDeadlineAt,
  type WorkspaceDurationPhaseAuthority,
} from "@/core/workspace-index/duration-governance";
import { sameLocalAbsolutePath } from "@/core/workspace-index/local-path-semantics";
import { canonicalWorkspaceIndexContractSchema } from "@/core/workspace-index/schema";
import {
  boundedFailureDiagnostic,
  reportBoundedSecondaryDiagnostic,
} from "@/core/workspace-index/failure-diagnostics";
import {
  CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
  PARSER_REGISTRY_VERSION,
  RELATION_REGISTRY_VERSION,
  WORKSPACE_INDEXER_NAME,
  WORKSPACE_INDEXER_VERSION,
  type CanonicalWorkspaceIndexContract,
} from "@/core/workspace-index/types";
import { validateCanonicalWorkspaceIndexContract } from "@/core/workspace-index/validator";
import { DatabaseExecutionGovernanceError, type DatabaseExecutionGovernance } from "@/server/db";
import { HttpCommandError } from "@/server/errors";
import {
  PostgresWorkspaceIndexSnapshotRepository,
  type WorkspaceIndexSnapshotRepository,
  type WorkspaceIndexSnapshotView,
} from "@/server/workspace-index-snapshot-repository";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import {
  assertRegisteredWorkspaceSourceAuthority,
  readWorkspaceRegistration,
  type AuthorizedWorkspaceSource,
  type WorkspaceRegistration,
} from "@/server/workspace-connector";

const uuidSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const createSnapshotCommandSchema = z.discriminatedUnion("sourceMode", [
  z.object({
    sourceMode: z.literal("REGISTERED_WORKSPACE"),
    workspaceRegistrationId: uuidSchema,
    projectContextId: uuidSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  z.object({
    sourceMode: z.literal("ADVANCED_DIAGNOSTIC"),
    workspaceIndex: canonicalWorkspaceIndexContractSchema,
    workspaceRegistrationId: uuidSchema.optional(),
    projectContextId: uuidSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
]);

export type CreateWorkspaceIndexSnapshotCommand = z.infer<typeof createSnapshotCommandSchema>;
export type WorkspaceIndexSnapshotCreateOperation = {
  snapshot: WorkspaceIndexSnapshotView;
  created: boolean;
};

type SnapshotServiceDependencies = {
  repository: WorkspaceIndexSnapshotRepository;
  evidenceRepository?: import("@/server/workspace-evidence-repository").PostgresWorkspaceEvidenceRepository;
  readWorkspace: (id: string) => Promise<WorkspaceRegistration>;
  authorizeWorkspaceSource: (id: string, governance?: { signal?: AbortSignal; deadlineAt?: number }) => Promise<AuthorizedWorkspaceSource>;
  runIndexer: typeof indexWorkspace;
  runIndexerV2?: (request: Parameters<typeof indexWorkspace>[0], options?: { signal?: AbortSignal; on_progress?: (phase: string, filesSeen: number, bytesSeen: number, terminal?: boolean) => void; stagingPort?: import("@/core/workspace-index/ingestion/engine-v2").BoundedEvidenceStagingPort }) => Promise<V2Outcome>;
  now: () => string;
};

function requestFingerprint(value: unknown): string {
  return `sha256:${sha256Canonical(value)}`;
}

function safeFailure(error: unknown): { code: string; evidence: Record<string, unknown> } {
  if (error instanceof HttpCommandError) {
    return { code: error.code, evidence: { code: error.code, message: error.message } };
  }
  if (error instanceof WorkspaceIndexingError) {
    return {
      code: error.code,
      evidence: {
        code: error.code,
        message: error.message,
        diagnostics: error.diagnostics.slice(0, 50),
        ...error.evidence,
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "CANONICAL_WORKSPACE_INDEX_INVALID",
      evidence: {
        code: "CANONICAL_WORKSPACE_INDEX_INVALID",
        issues: error.issues.slice(0, 50).map(issue => ({ path: issue.path.join("."), message: issue.message })),
      },
    };
  }
  // Otherwise-unexpected native Error: the failure code stays fail-closed, while bounded safe diagnostic
  // identity makes the next unexpected failure distinguishable without persisting stacks, causes,
  // environment data, secrets, or arbitrary raw serialization.
  const diagnostic = boundedFailureDiagnostic(error);
  return {
    code: "WORKSPACE_INDEX_SNAPSHOT_FAILED",
    evidence: {
      code: "WORKSPACE_INDEX_SNAPSHOT_FAILED",
      message: "The governed Snapshot operation failed.",
      errorName: diagnostic.errorName,
      ...(diagnostic.errorCode ? { errorCode: diagnostic.errorCode } : {}),
      diagnosticIdentitySha256: diagnostic.diagnosticIdentitySha256,
    },
  };
}

function validateCanonicalContract(raw: unknown): CanonicalWorkspaceIndexContract {
  const parsed = canonicalWorkspaceIndexContractSchema.parse(raw);
  const validation = validateCanonicalWorkspaceIndexContract(parsed);
  if (!validation.contract || validation.status === "REJECTED") {
    throw new HttpCommandError(
      422,
      "CANONICAL_WORKSPACE_INDEX_INVALID",
      "The Canonical Workspace Index Contract failed deterministic validation.",
      validation.diagnostics.slice(0, 50),
    );
  }
  const canonicalSha = canonicalWorkspaceIndexHash(validation.contract);
  if (validation.contract.integrity.canonical_payload_hash !== canonicalSha) {
    throw new HttpCommandError(422, "CANONICAL_WORKSPACE_INDEX_HASH_MISMATCH", "The Canonical Workspace Index integrity hash does not match the validated payload.");
  }
  return validation.contract;
}

async function assertProjectAssociation(
  repository: WorkspaceIndexSnapshotRepository,
  projectContextId?: string,
  governance?: DatabaseExecutionGovernance,
): Promise<void> {
  if (projectContextId) await repository.assertProjectContextExists(projectContextId, governance);
}

type FinalizationPersistenceAuthority = WorkspaceDurationPhaseAuthority & { governancePhase: "FINALIZATION" };

function finalizationPersistenceTimeoutEvidence(input: {
  authority: FinalizationPersistenceAuthority;
  attemptStartedAtMs: number;
  detailedProgressPhase?: "PERSISTING";
  nowMs?: number;
}): Record<string, unknown> {
  const now = input.nowMs ?? Date.now();
  return {
    durationPolicyId: input.authority.durationPolicyId,
    currentGovernancePhase: "FINALIZATION",
    detailedProgressPhase: input.detailedProgressPhase ?? "PERSISTING",
    elapsedAttemptDurationMs: Math.max(0, now - input.attemptStartedAtMs),
    phaseElapsedDurationMs: Math.max(0, now - input.authority.phaseStartedAtMs),
    phaseBudgetMs: input.authority.phaseBudgetMs,
    absoluteElapsedDurationMs: Math.max(0, now - input.attemptStartedAtMs),
    absoluteOperationMaxMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
  };
}

function finalizationPersistenceError(input: {
  authority: FinalizationPersistenceAuthority;
  attemptStartedAtMs: number;
  aborted: boolean;
}): WorkspaceIndexingError {
  if (input.aborted) {
    return new WorkspaceIndexingError(
      "WORKSPACE_INDEX_ABORTED",
      "The Workspace Index operation was aborted during governed Finalization persistence.",
      ["currentGovernancePhase=FINALIZATION", "detailedProgressPhase=PERSISTING"],
    );
  }
  const evidence = finalizationPersistenceTimeoutEvidence(input);
  return new WorkspaceIndexingError(
    "WORKSPACE_INDEX_TIMEOUT",
    "The Workspace Index Finalization persistence boundary exceeded its governed duration budget.",
    Object.entries(evidence).map(([key, value]) => `${key}=${String(value)}`),
    evidence,
  );
}

function attemptAbsoluteDatabaseGovernanceError(input: {
  error: DatabaseExecutionGovernanceError;
  attemptStartedAtMs: number;
  detailedProgressPhase: "RECOVER_STALE" | "PROJECT_ASSOCIATION" | "IDEMPOTENCY";
}): WorkspaceIndexingError {
  const now = Date.now();
  const elapsed = Math.max(0, now - input.attemptStartedAtMs);
  const evidence = {
    durationPolicyId: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.durationPolicyId,
    detailedProgressPhase: input.detailedProgressPhase,
    elapsedAttemptDurationMs: elapsed,
    absoluteElapsedDurationMs: elapsed,
    absoluteOperationMaxMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
  };
  if (input.error.reason === "ABORTED") {
    return new WorkspaceIndexingError(
      "WORKSPACE_INDEX_ABORTED",
      "The Registered Workspace request was aborted during governed pre-Source database execution.",
      Object.entries(evidence).map(([key, value]) => `${key}=${String(value)}`),
      evidence,
    );
  }
  return new WorkspaceIndexingError(
    "WORKSPACE_INDEX_TIMEOUT",
    "The Registered Workspace request exceeded its absolute duration authority during pre-Source database execution.",
    Object.entries(evidence).map(([key, value]) => `${key}=${String(value)}`),
    evidence,
  );
}

function attemptDatabaseGovernanceError(input: {
  error: DatabaseExecutionGovernanceError;
  attemptStartedAtMs: number;
  currentGovernancePhase: "SOURCE_AUTHORITY" | "DISCOVERY";
  detailedProgressPhase: "SOURCE_AUTHORITY" | "SCAN_BASE" | "RESERVING";
  phaseBudgetMs?: number;
}): WorkspaceIndexingError {
  const now = Date.now();
  const elapsed = Math.max(0, now - input.attemptStartedAtMs);
  const evidence = {
    durationPolicyId: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.durationPolicyId,
    currentGovernancePhase: input.currentGovernancePhase,
    detailedProgressPhase: input.detailedProgressPhase,
    elapsedAttemptDurationMs: elapsed,
    ...(input.phaseBudgetMs !== undefined ? { phaseElapsedDurationMs: elapsed, phaseBudgetMs: input.phaseBudgetMs } : {}),
    absoluteElapsedDurationMs: elapsed,
    absoluteOperationMaxMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
  };
  if (input.error.reason === "ABORTED") {
    return new WorkspaceIndexingError(
      "WORKSPACE_INDEX_ABORTED",
      "The Workspace Index operation was aborted during governed database execution.",
      Object.entries(evidence).map(([key, value]) => `${key}=${String(value)}`),
      evidence,
    );
  }
  return new WorkspaceIndexingError(
    "WORKSPACE_INDEX_TIMEOUT",
    "The Workspace Index operation exceeded its governed database duration authority.",
    Object.entries(evidence).map(([key, value]) => `${key}=${String(value)}`),
    evidence,
  );
}

export class WorkspaceIndexSnapshotService {
  constructor(private readonly dependencies: SnapshotServiceDependencies) {}

  async createOperation(raw: unknown, ownerAuthority: string, signal?: AbortSignal): Promise<WorkspaceIndexSnapshotCreateOperation> {
    const command = createSnapshotCommandSchema.parse(raw);
    if (command.sourceMode === "REGISTERED_WORKSPACE") {
      const attemptStartedAtMs = Date.now();
      const absoluteOperationDeadlineAt = workspaceAbsoluteOperationDeadlineAt(
        attemptStartedAtMs,
        DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
      );
      const absoluteAttemptGovernance: DatabaseExecutionGovernance = {
        deadlineAtMs: absoluteOperationDeadlineAt,
        signal,
      };
      try {
        await this.dependencies.repository.recoverStale(
          { staleBefore: new Date(attemptStartedAtMs - 5 * 60_000).toISOString(), completedAt: this.dependencies.now() },
          absoluteAttemptGovernance,
        );
      } catch (error) {
        if (error instanceof DatabaseExecutionGovernanceError) {
          throw attemptAbsoluteDatabaseGovernanceError({
            error,
            attemptStartedAtMs,
            detailedProgressPhase: "RECOVER_STALE",
          });
        }
        throw error;
      }
      try {
        await assertProjectAssociation(this.dependencies.repository, command.projectContextId, absoluteAttemptGovernance);
      } catch (error) {
        if (error instanceof DatabaseExecutionGovernanceError) {
          throw attemptAbsoluteDatabaseGovernanceError({
            error,
            attemptStartedAtMs,
            detailedProgressPhase: "PROJECT_ASSOCIATION",
          });
        }
        throw error;
      }
      return this.createRegistered(command, ownerAuthority, {
        attemptStartedAtMs,
        absoluteOperationDeadlineAt,
        governance: absoluteAttemptGovernance,
      });
    }

    await this.dependencies.repository.recoverStale({
      staleBefore: new Date(Date.now() - 5 * 60_000).toISOString(),
      completedAt: this.dependencies.now(),
    });
    await assertProjectAssociation(this.dependencies.repository, command.projectContextId);
    return this.createDiagnostic(command, ownerAuthority);
  }

  async create(raw: unknown, ownerAuthority: string): Promise<WorkspaceIndexSnapshotView> {
    return (await this.createOperation(raw, ownerAuthority)).snapshot;
  }

  private async createRegistered(
    command: Extract<CreateWorkspaceIndexSnapshotCommand, { sourceMode: "REGISTERED_WORKSPACE" }>,
    ownerAuthority: string,
    attemptAuthority: {
      attemptStartedAtMs: number;
      absoluteOperationDeadlineAt: number;
      governance: DatabaseExecutionGovernance;
    },
  ): Promise<WorkspaceIndexSnapshotCreateOperation> {
    const { attemptStartedAtMs, absoluteOperationDeadlineAt, governance: absoluteAttemptGovernance } = attemptAuthority;
    const signal = absoluteAttemptGovernance.signal;
    // Idempotency identity is derived only from the canonical client command + governing owner reference.
    // Dynamic backend state (current Workspace registration revision/head/indexer version/config) is bound to
    // the first created operation, but cannot make a legitimate replay conflict with the operation itself.
    const fingerprint = requestFingerprint({
      schema: "intentchord.workspace-index-snapshot-request.v4",
      sourceMode: command.sourceMode,
      workspaceRegistrationId: command.workspaceRegistrationId,
      projectContextId: command.projectContextId ?? null,
      ownerReference: ownerAuthority,
    });
    let replay: Awaited<ReturnType<WorkspaceIndexSnapshotRepository["readByIdempotencyKey"]>>;
    try {
      replay = await this.dependencies.repository.readByIdempotencyKey(command.idempotencyKey, absoluteAttemptGovernance);
    } catch (error) {
      if (error instanceof DatabaseExecutionGovernanceError) {
        throw attemptAbsoluteDatabaseGovernanceError({
          error,
          attemptStartedAtMs,
          detailedProgressPhase: "IDEMPOTENCY",
        });
      }
      throw error;
    }
    if (replay) {
      if (replay.requestFingerprintSha256 !== fingerprint) {
        throw new HttpCommandError(409, "IDEMPOTENCY_CONFLICT", "The Snapshot idempotency key is already bound to a different canonical request fingerprint.");
      }
      return { snapshot: replay, created: false };
    }

    // Registered Workspace source acquisition must cross the single backend Root Object Authority gate
    // before any preflight, traversal, or indexer filesystem read. The gate revalidates the actual current
    // root filesystem object against the Owner-verified persisted object identity and fails closed on
    // mismatch/unprovable identity.
    const startedAt = this.dependencies.now();
    const sourceAuthorityDeadlineAt = workspacePhaseDeadlineAt({
      phaseStartedAtMs: attemptStartedAtMs,
      phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.sourceAuthorityMaxMs,
      absoluteOperationDeadlineAt,
    });
    let authorizedSource: AuthorizedWorkspaceSource;
    try {
      authorizedSource = await this.dependencies.authorizeWorkspaceSource(command.workspaceRegistrationId, { signal, deadlineAt: sourceAuthorityDeadlineAt });
    } catch (error) {
      if (error instanceof DatabaseExecutionGovernanceError) {
        throw attemptDatabaseGovernanceError({
          error,
          attemptStartedAtMs,
          currentGovernancePhase: "SOURCE_AUTHORITY",
          detailedProgressPhase: "SOURCE_AUTHORITY",
          phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.sourceAuthorityMaxMs,
        });
      }
      if (error instanceof WorkspaceIndexBoundedError && (error.code === "WORKSPACE_INDEX_TIMEOUT" || error.code === "WORKSPACE_INDEX_ABORTED")) {
        const databaseEquivalent = new DatabaseExecutionGovernanceError(
          error.code === "WORKSPACE_INDEX_ABORTED" ? "ABORTED" : "TIMEOUT",
          sourceAuthorityDeadlineAt,
        );
        throw attemptDatabaseGovernanceError({
          error: databaseEquivalent,
          attemptStartedAtMs,
          currentGovernancePhase: "SOURCE_AUTHORITY",
          detailedProgressPhase: "SOURCE_AUTHORITY",
          phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.sourceAuthorityMaxMs,
        });
      }
      throw error;
    }
    const registration = authorizedSource.registration;
    const currentIdentity = authorizedSource.currentIdentity;
    if (registration.referenceType !== "LOCAL_PATH") {
      throw new HttpCommandError(422, "WORKSPACE_LOCAL_PATH_REQUIRED", "Automatic indexing requires a verified LOCAL_PATH Workspace registration.");
    }

    const governedScope = {
      scopeMode: "FULL_WORKSPACE",
      normalizedRoot: registration.normalizedReference,
      ownerRestrictedPaths: [] as string[],
      traversalPolicyId: WORKSPACE_TRAVERSAL_POLICY_ID,
      budgets: DEFAULT_WORKSPACE_INDEX_BUDGETS,
      durationGovernance: workspaceDurationConfigurationIdentity(DEFAULT_WORKSPACE_DURATION_GOVERNANCE),
      staleCreatingTimeoutMs: 5 * 60_000,
    };
    const indexConfiguration = workspaceIndexConfigurationDescriptor({ budgets: governedScope.budgets, durationGovernance: DEFAULT_WORKSPACE_DURATION_GOVERNANCE });
    const indexConfigurationSha256 = workspaceIndexConfigurationSha256(indexConfiguration);
    // Only the first real attempt binds a backend-selected scan base. Clients never choose predecessor authority.
    // These Backend DB boundaries do not receive a fresh phase allowance: they remain bounded by the
    // original attempt absolute deadline anchored before Source Authority began.
    let scanBase: Awaited<ReturnType<WorkspaceIndexSnapshotRepository["readLatestObservationHead"]>>;
    try {
      scanBase = await this.dependencies.repository.readLatestObservationHead(registration.id, absoluteAttemptGovernance);
    } catch (error) {
      if (error instanceof DatabaseExecutionGovernanceError) {
        throw attemptDatabaseGovernanceError({
          error,
          attemptStartedAtMs,
          currentGovernancePhase: "DISCOVERY",
          detailedProgressPhase: "SCAN_BASE",
        });
      }
      throw error;
    }
    let reserved: Awaited<ReturnType<WorkspaceIndexSnapshotRepository["reserve"]>>;
    try {
      reserved = await this.dependencies.repository.reserve({
        sourceMode: command.sourceMode,
        workspaceRegistrationId: registration.id,
        workspaceRegistrationRevision: registration.revision,
        workspaceRegistrationFingerprint: registration.fingerprint,
        ...(command.projectContextId ? { projectContextId: command.projectContextId } : {}),
        governedScope,
        ...(scanBase ? { scanBaseObservationId: scanBase.observationId } : {}),
        idempotencyKey: command.idempotencyKey,
        requestFingerprintSha256: fingerprint,
        ownerReference: ownerAuthority,
        startedAt,
      }, absoluteAttemptGovernance);
    } catch (error) {
      if (error instanceof DatabaseExecutionGovernanceError) {
        throw attemptDatabaseGovernanceError({
          error,
          attemptStartedAtMs,
          currentGovernancePhase: "DISCOVERY",
          detailedProgressPhase: "RESERVING",
        });
      }
      throw error;
    }
    if (!reserved.created) return { snapshot: reserved.snapshot, created: false };

    const persistenceAbortController = new AbortController();
    let persistenceDeadlineAt = absoluteOperationDeadlineAt;
    let persistenceDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let finalizationAuthority: FinalizationPersistenceAuthority | undefined;
    const abortPersistence = () => {
      if (!persistenceAbortController.signal.aborted) persistenceAbortController.abort();
    };
    const armPersistenceDeadline = (deadlineAt: number) => {
      persistenceDeadlineAt = Math.min(deadlineAt, absoluteOperationDeadlineAt);
      if (persistenceDeadlineTimer) clearTimeout(persistenceDeadlineTimer);
      const remainingMs = persistenceDeadlineAt - Date.now();
      if (remainingMs <= 0) {
        abortPersistence();
        return;
      }
      persistenceDeadlineTimer = setTimeout(abortPersistence, remainingMs);
    };
    const onExternalAbort = () => abortPersistence();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (signal?.aborted) abortPersistence();
    armPersistenceDeadline(absoluteOperationDeadlineAt);
    const persistenceGovernance = (): DatabaseExecutionGovernance => ({
      deadlineAtMs: persistenceDeadlineAt,
      signal: persistenceAbortController.signal,
    });
    const onDurationPhaseAuthority = (authority: WorkspaceDurationPhaseAuthority) => {
      if (authority.governancePhase !== "FINALIZATION") return;
      if (finalizationAuthority) {
        throw new WorkspaceIndexingError(
          "WORKSPACE_FINALIZATION_AUTHORITY_DUPLICATED",
          "The Workspace Indexer attempted to reset Finalization duration authority.",
        );
      }
      const expectedDeadlineAt = workspacePhaseDeadlineAt({
        phaseStartedAtMs: authority.phaseStartedAtMs,
        phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs,
        absoluteOperationDeadlineAt,
      });
      if (
        authority.durationPolicyId !== DEFAULT_WORKSPACE_DURATION_GOVERNANCE.durationPolicyId
        || authority.phaseBudgetMs !== DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs
        || authority.absoluteOperationDeadlineAt !== absoluteOperationDeadlineAt
        || authority.phaseDeadlineAt !== expectedDeadlineAt
      ) {
        throw new WorkspaceIndexingError(
          "WORKSPACE_FINALIZATION_AUTHORITY_INVALID",
          "The Workspace Indexer Finalization authority does not match the Backend-governed duration policy.",
        );
      }
      finalizationAuthority = { ...authority, governancePhase: "FINALIZATION" };
      armPersistenceDeadline(authority.phaseDeadlineAt);
    };

    // Progress admission stays open only while the primary operation is healthy. Once failure ownership
    // begins, no new progress persistence work may be admitted. Every admitted chain link receives a
    // rejection observer at the exact moment that link exists, so a progress rejection can NEVER become
    // unhandledRejection — including while terminal repository.fail(...) is still pending. The first
    // failure is retained and re-thrown on the healthy success path so governed WORKSPACE_INDEX_TIMEOUT
    // conversion semantics remain byte-identical to the previous await-progressWrite contract.
    let progressAdmissionOpen = true;
    let progressWrite = Promise.resolve();
    let firstProgressFailure: unknown;
    let progressSecondaryReportBudget = 3;
    const onProgress = (progress: WorkspaceProgressEvidence) => {
      if (!progressAdmissionOpen) return;
      progressWrite = progressWrite.then(() => this.dependencies.repository.updateProgress({
        id: reserved.snapshot.id,
        phase: progress.phase,
        evidence: progress as unknown as Record<string, unknown>,
        heartbeatAt: this.dependencies.now(),
      }, persistenceGovernance())).catch(progressError => {
        firstProgressFailure ??= progressError;
        if (progressSecondaryReportBudget-- > 0) {
          recordSecondaryDiagnostic(progressError, "workspace-index-progress-persistence-secondary");
        }
      });
    };
    const recordSecondaryDiagnostic = (error: unknown, channel: string) => {
      reportBoundedSecondaryDiagnostic(channel, error);
    };

    try {
      const engineChoice = parseWorkspaceIndexEngine(process.env);

      if (engineChoice === "V2" && this.dependencies.runIndexerV2) {
        // =====================================================================
        // V2 SECTIONED PATH — NEVER constructs CanonicalWorkspaceIndexContract
        // V2_PREVIOUS_CONTRACT_HYDRATION_COUNT=0
        // V2_FULL_CONTRACT_ASSEMBLY_COUNT=0
        // V2_WORKSPACE_FILE_ARRAY_ASSEMBLED=NO
        // V2_INLINE_V1_PERSISTENCE_REUSED=NO
        // =====================================================================

        // R2-F: Head-bound predecessor lookup — linked to the valid predecessor observation
        let predecessorAttestation: { closed_boundary_usn: number | null; journal_id: string; volume_serial: string; policy_hash: string } | null = null;
        if (scanBase) {
          try {
            const evidenceRepo = this.dependencies.evidenceRepository ?? lazyEvidenceRepo();
            predecessorAttestation = await evidenceRepo.getSealedAttestationForObservation(
              registration.id,
              scanBase.observationId,
            );
          } catch {
            // Predecessor lookup failure is non-fatal; bootstrap semantics apply
          }
        }

        const snapshotOpId = reserved.snapshot.id;
        const evidenceRepo = this.dependencies.evidenceRepository ?? lazyEvidenceRepo();

        // SERVICE-OWNED ABSTRACT BOUNDED STAGING WRITER / PORT (OPTION B)
        // Decoupled attempt-scoped staging port: Core Engine knows only this abstract contract.
        const stagingPort: import("@/core/workspace-index/ingestion/engine-v2").BoundedEvidenceStagingPort = {
          stageRecords: async (sectionType, records) => {
            if (records.length === 0) return;
            const batch = records.map(r => ({
              snapshot_operation_id: snapshotOpId,
              section_type: sectionType,
              record_seq: r.record_seq,
              record_id: r.record_id,
              record_digest: r.record_digest,
              source_file_revision_id: r.source_file_revision_id ?? null,
              record_json: r.record_json,
            }));
            await evidenceRepo.insertStagedRecords(batch);
          },
          stageSegment: async (sectionType, segment) => {
            await evidenceRepo.insertStagedSegment({
              snapshot_operation_id: snapshotOpId,
              section_type: sectionType,
              segment_seq: segment.segment_seq,
              record_count: segment.record_count,
              first_record_seq: segment.first_record_seq,
              last_record_seq: segment.last_record_seq,
              segment_digest: segment.segment_digest,
              byte_size: segment.byte_size,
            });
          },
        };

        // V2 PROGRESS PERSISTENCE BOUNDARY
        // Persist V2 progress bounded/coalesced into intentchord.workspace_ingestion_progress.
        // Never write V2-only phases to legacy workspace_index_snapshots.progress_phase.
        const onV2Progress = (phaseOrProgress: string | WorkspaceProgressEvidence, filesSeen = 0, bytesSeen = 0) => {
          if (!progressAdmissionOpen) return;
          const phase = typeof phaseOrProgress === "string" ? phaseOrProgress : phaseOrProgress.phase;
          const files = typeof phaseOrProgress === "string" ? filesSeen : (phaseOrProgress as Record<string, unknown>).discoveredFiles ?? (phaseOrProgress as Record<string, unknown>).filesSeen ?? filesSeen;
          const bytes = typeof phaseOrProgress === "string" ? bytesSeen : (phaseOrProgress as Record<string, unknown>).discoveredBytes ?? (phaseOrProgress as Record<string, unknown>).bytesSeen ?? bytesSeen;
          progressWrite = progressWrite.then(() => evidenceRepo.upsertProgress({
            snapshot_operation_id: snapshotOpId,
            phase,
            counters_json: { filesSeen: Number(files) || 0, bytesSeen: Number(bytes) || 0 },
            heartbeat_at: new Date(this.dependencies.now()),
          })).catch(progressError => {
            firstProgressFailure ??= progressError;
            if (progressSecondaryReportBudget-- > 0) {
              recordSecondaryDiagnostic(progressError, "workspace-index-progress-persistence-secondary");
            }
          });
        };

        const v2Result = await this.dependencies.runIndexerV2(
          {
            workspace_instance_id: registration.id,
            root_path: registration.normalizedReference,
            authorized_root_identity: { real_path: currentIdentity.realPath, identity: currentIdentity.rootObjectIdentity },
            // V2 NEVER hydrates previous_contract. Bounded predecessor authority only.
            predecessor_attestation: predecessorAttestation,
            // V2 OBSERVATION RESULT AUTHORITY: Previous observation head for B1 chronology classification.
            previous_observation: scanBase?.acceptedWorkspaceEvidenceArtifactId
              ? { workspace_revision_id: scanBase.workspaceRevisionId, accepted_workspace_evidence_artifact_id: scanBase.acceptedWorkspaceEvidenceArtifactId }
              : null,
            // V2 OBSERVATION RESULT AUTHORITY: Server-owned revision history lookup from persisted observations.
            was_revision_previously_observed: async (workspaceRevisionId: string) => {
              return this.dependencies.repository.wasRevisionPreviouslyObserved(registration.id, workspaceRevisionId, absoluteAttemptGovernance);
            },
            binding_type: "LOCAL_FILESYSTEM",
            owner_restricted_paths: governedScope.ownerRestrictedPaths,
            budgets: governedScope.budgets,
            duration_policy: DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
            attempt_started_at_ms: attemptStartedAtMs,
            signal,
            on_progress: onV2Progress,
            git_enrichment: {
              ...(currentIdentity.repositoryIdentity ? { repository_identity: currentIdentity.repositoryIdentity } : {}),
              ...(currentIdentity.branch ? { repository_identity: currentIdentity.branch } : {}),
              ...(currentIdentity.commitSha ? { commit_sha: currentIdentity.commitSha } : {}),
              rename_hints: [],
              diagnostics: [],
            },
            started_at: startedAt,
            now: this.dependencies.now,
          },
          { signal, on_progress: onV2Progress, stagingPort },
        );

        progressAdmissionOpen = false;

        if ("outcome" in v2Result && v2Result.outcome === "FAILED") {
          // V2 terminal failure — correct failure semantics
          const failureCode = v2Result.failureCode;
          const failureEvidence = {
            code: failureCode,
            message: v2Result.failureEvidence.message,
            ...(v2Result.failureEvidence.degradationReason ? { degradationReason: v2Result.failureEvidence.degradationReason } : {}),
            ...(v2Result.failureEvidence.churnEvidence ? { churnEvidence: v2Result.failureEvidence.churnEvidence } : {}),
          };
          try {
            await this.dependencies.repository.fail({
              id: reserved.snapshot.id,
              failureCode,
              safeFailureEvidence: failureEvidence,
              completedAt: this.dependencies.now(),
            }, persistenceGovernance());
          } catch (failPersistenceError) {
            recordSecondaryDiagnostic(failPersistenceError, "workspace-index-v2-terminal-fail-persistence-secondary");
          }
          throw new WorkspaceIndexingError(
            failureCode,
            v2Result.failureEvidence.message,
            [],
            failureEvidence,
          );
        }

        // V2 SEALED — sectioned evidence material
        if (!("sealPlan" in v2Result)) {
          throw new WorkspaceIndexingError(
            "WORKSPACE_V2_UNEXPECTED_RESULT",
            "V2 engine returned an unexpected result type.",
          );
        }
        const v2Sealed = v2Result as V2ExecutionResult;

        // MONOLITH GUARD: verify V2 never produced a full contract
        if ("contract" in v2Sealed && typeof (v2Sealed as Record<string, unknown>).contract === "object") {
          throw new WorkspaceIndexingError(
            "WORKSPACE_MONOLITH_PATH_FORBIDDEN",
            "V2 path attempted to construct a full CanonicalWorkspaceIndexContract.",
          );
        }

        await progressWrite;
        if (firstProgressFailure !== undefined) throw firstProgressFailure;

        // =====================================================================
        // V2 ATOMIC SEAL TRANSACTION — staged records + attestation + ONE txn
        // PREMATURE_V2_READY_PATH=NO
        // DB_ATOMIC_SEAL_IMPLEMENTED=YES
        // PART D: STAGING WRITE PATH — streaming writes occurred during ingestion via stagingPort
        // Obsolete post-engine authoritative dependency (for section.records -> insertStagedRecords) retired

        // PART E: ATTESTATION PRE-SEAL — open attestation, transition through RECONCILING, then seal to SEALED
        // Migration 015 wca_transition_guard requires: OPEN -> RECONCILING -> SEALED
        const isStrongProvider = v2Sealed.continuityAttestation.providerClass === "STRONG_CONTINUITY_PROVIDER";

        // R1-B: Policy authority — currentPolicyHash is the governed policy for THIS operation.
        // predecessorPolicyHash comes from the head-bound predecessor attestation.
        const volumeIdentityJson = isStrongProvider
          ? { journalId: v2Sealed.continuityAttestation.journalId, volumeSerial: v2Sealed.continuityAttestation.volumeSerial }
          : {};
        const journalIdentityJson = isStrongProvider
          ? { journalId: v2Sealed.continuityAttestation.journalId, volumeSerial: v2Sealed.continuityAttestation.volumeSerial }
          : null;
        const previousTrustedBoundaryUsn = v2Sealed.priorHead?.trustedBoundaryUsn != null
          ? String(v2Sealed.priorHead.trustedBoundaryUsn) : null;
        const openedBoundaryUsn = v2Sealed.continuityAttestation.openedBoundaryUsn != null
          ? String(v2Sealed.continuityAttestation.openedBoundaryUsn) : "0";
        const closedBoundaryUsn = v2Sealed.continuityAttestation.closedBoundaryUsn != null
          ? String(v2Sealed.continuityAttestation.closedBoundaryUsn) : null;

        // R1-C: Compute attestation_sha256 from exact canonical material (single source).
        const attestationDigestMaterial = buildAttestationDigestMaterial({
          attestationId: v2Sealed.continuityAttestation.attestationId,
          workspaceRegistrationId: registration.id,
          providerClass: v2Sealed.continuityAttestation.providerClass,
          providerId: v2Sealed.continuityAttestation.providerId,
          claimType: v2Sealed.continuityAttestation.claimType,
          volumeIdentityJson,
          journalIdentityJson,
          previousTrustedBoundaryUsn,
          openedBoundaryUsn,
          closedBoundaryUsn,
          bootstrap: v2Sealed.continuityAttestation.bootstrap,
          reconciliationPasses: v2Sealed.reconciliationPasses,
          policyHash: v2Sealed.continuityAttestation.currentPolicyHash,
          continuityEvidenceJson: v2Sealed.continuityEvidence,
        });
        const attestationSha256 = computeAttestationSha256(attestationDigestMaterial);

        await evidenceRepo.insertAttestationOpen({
          id: v2Sealed.continuityAttestation.attestationId,
          workspace_registration_id: registration.id,
          provider_class: v2Sealed.continuityAttestation.providerClass,
          provider_id: v2Sealed.continuityAttestation.providerId,
          claim_type: v2Sealed.continuityAttestation.claimType,
          volume_identity_json: volumeIdentityJson,
          journal_identity_json: journalIdentityJson,
          previous_trusted_boundary_usn: previousTrustedBoundaryUsn,
          opened_boundary_usn: openedBoundaryUsn,
          bootstrap: v2Sealed.continuityAttestation.bootstrap,
          policy_hash: v2Sealed.continuityAttestation.currentPolicyHash,
          continuity_evidence_json: v2Sealed.continuityEvidence,
          snapshot_operation_id: snapshotOpId,
        });
        await evidenceRepo.transitionAttestation(v2Sealed.continuityAttestation.attestationId, {
          attestation_state: "RECONCILING",
        });
        // R1-H: Complete SEALED transition shape with all deferred fields.
        await evidenceRepo.transitionAttestation(v2Sealed.continuityAttestation.attestationId, {
          attestation_state: "SEALED",
          closed_boundary_usn: closedBoundaryUsn ?? undefined,
          reconciliation_passes: v2Sealed.reconciliationPasses,
          continuity_evidence_json: v2Sealed.continuityEvidence,
          attestation_sha256: attestationSha256,
        });

        // R4-M10: Source binding identity — derive real sbi_ from actual binding metadata, NOT attestation ID.
        const sourceBindingId = stableWorkspaceIndexId("sbi", {
          normalized_reference: registration.normalizedReference,
          device_name: hostname(),
          platform: platform(),
        });

        // PART F: ONE ATOMIC SEAL TRANSACTION (S1-S8)
        return {
          snapshot: await this.dependencies.repository.sealV2Snapshot({
            snapshotId: reserved.snapshot.id,
            workspaceRegistrationId: registration.id,
            workspaceInstanceId: v2Sealed.workspaceInstanceId,
            completedAt: this.dependencies.now(),
            evidenceArtifact: {
              id: v2Sealed.artifactCandidate.artifactId,
              workspaceRevisionId: v2Sealed.artifactCandidate.workspaceRevisionId,
              indexConfigurationSha256,
              headerJson: v2Sealed.sealPlan.header_json,
              sectionManifestJson: v2Sealed.sealPlan.section_manifest_json,
              sectionManifestDigest: v2Sealed.artifactCandidate.sectionManifestDigest,
              artifactManifestSha256: v2Sealed.artifactCandidate.artifactManifestSha256,
              artifactSemanticSha256: v2Sealed.artifactCandidate.artifactSemanticSha256.startsWith("sha256:")
                ? v2Sealed.artifactCandidate.artifactSemanticSha256
                : `sha256:${v2Sealed.artifactCandidate.artifactSemanticSha256}`,
              canonicalCompatSha256: v2Sealed.sealPlan.canonical_compat_sha256,
            },
            sections: v2Sealed.sealPlan.sections.map(s => ({
              sectionType: s.section_type as import("@/core/workspace-index/sections/sectioned-contracts").EvidenceSectionType,
              sectionOrder: s.section_order,
              sectionSchemaVersion: s.section_schema_version,
              sectionDigest: s.section_digest,
              recordCount: s.record_count,
              segmentCount: s.segment_count,
            })),
            attestationId: v2Sealed.continuityAttestation.attestationId,
            observationResult: v2Sealed.observationResult,
            sourceBindingId,
            sourceBindingMetadata: { engine: "V2_SECTIONED" },
            bindingType: "LOCAL_FILESYSTEM",
            normalizedReference: registration.normalizedReference,
            treeFingerprint: v2Sealed.artifactCandidate.sectionManifestDigest.startsWith("sha256:")
              ? v2Sealed.artifactCandidate.sectionManifestDigest
              : `sha256:${v2Sealed.artifactCandidate.sectionManifestDigest}`,
          }, evidenceRepo, persistenceGovernance()),
          created: true,
        };
      }

      // =====================================================================
      // V1 HISTORICAL PATH — unchanged
      // =====================================================================
      const contract = validateCanonicalContract(await this.dependencies.runIndexer({
        workspace_instance_id: registration.id,
        root_path: registration.normalizedReference,
        authorized_root_identity: { real_path: currentIdentity.realPath, identity: currentIdentity.rootObjectIdentity },
        ...(scanBase?.canonicalIndex ? { previous_contract: scanBase.canonicalIndex } : {}),
        binding_type: "LOCAL_FILESYSTEM",
        owner_restricted_paths: governedScope.ownerRestrictedPaths,
        budgets: governedScope.budgets,
        duration_policy: DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
        attempt_started_at_ms: attemptStartedAtMs,
        on_duration_phase_authority: onDurationPhaseAuthority,
        signal,
        on_progress: onProgress,
        git_enrichment: {
          ...(currentIdentity.repositoryIdentity ? { repository_identity: currentIdentity.repositoryIdentity } : {}),
          ...(currentIdentity.branch ? { branch: currentIdentity.branch } : {}),
          ...(currentIdentity.commitSha ? { commit_sha: currentIdentity.commitSha } : {}),
          rename_hints: [],
          diagnostics: [],
        },
        started_at: startedAt,
        now: this.dependencies.now,
      }));
      if (!finalizationAuthority) {
        throw new WorkspaceIndexingError(
          "WORKSPACE_FINALIZATION_AUTHORITY_MISSING",
          "The Workspace Indexer did not publish the governed Finalization authority required for persistence.",
        );
      }
      await progressWrite;
      // Every admitted link self-observes its rejection; the retained first failure is re-thrown here so
      // the healthy success path keeps the exact governed conversion contract of the former
      // await-progressWrite rejection semantics.
      if (firstProgressFailure !== undefined) throw firstProgressFailure;
      const persistingEvidence = {
        phase: "PERSISTING",
        ...finalizationPersistenceTimeoutEvidence({ authority: finalizationAuthority, attemptStartedAtMs }),
      };
      await this.dependencies.repository.updateProgress({
        id: reserved.snapshot.id,
        phase: "PERSISTING",
        evidence: persistingEvidence,
        heartbeatAt: this.dependencies.now(),
      }, persistenceGovernance());
      if (contract.workspace.workspace_instance_id !== registration.id) {
        throw new HttpCommandError(422, "WORKSPACE_SNAPSHOT_IDENTITY_MISMATCH", "The generated Canonical Snapshot is not bound to the registered Workspace identity.");
      }
      if (
        contract.source_binding.binding_type !== "LOCAL_FILESYSTEM"
        || !sameLocalAbsolutePath(contract.source_binding.normalized_reference, registration.normalizedReference)
      ) {
        throw new HttpCommandError(409, "WORKSPACE_SOURCE_BINDING_AUTHORITY_MISMATCH", "The observed Source Binding is not the backend-verified registered Workspace binding.");
      }
      progressAdmissionOpen = false;
      return {
        snapshot: await this.dependencies.repository.completeRegisteredObservation({
          id: reserved.snapshot.id,
          workspaceRegistrationId: registration.id,
          contract,
          canonicalSha256: canonicalWorkspaceIndexHash(contract),
          indexConfiguration,
          indexConfigurationSha256,
          completedAt: this.dependencies.now(),
        }, persistenceGovernance()),
        created: true,
      };
    } catch (caught) {
      // INVARIANT 1: failure ownership begins here — no new progress persistence work may be admitted.
      progressAdmissionOpen = false;
      const error = caught instanceof DatabaseExecutionGovernanceError
        ? finalizationPersistenceError({
            authority: finalizationAuthority ?? {
              durationPolicyId: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.durationPolicyId,
              governancePhase: "FINALIZATION",
              phaseStartedAtMs: Math.min(Date.now(), persistenceDeadlineAt),
              phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs,
              phaseDeadlineAt: persistenceDeadlineAt,
              absoluteOperationDeadlineAt,
            },
            attemptStartedAtMs,
            aborted: Boolean(signal?.aborted),
          })
        : caught;
      const failure = safeFailure(error);
      // INVARIANT 2/8: terminal FAILED persistence is attempted first, under the SAME existing
      // persistence governance authority. Its own failure never replaces the primary error and is
      // captured as bounded secondary diagnostic evidence instead of being silently lost.
      let terminalPersistenceObserved = false;
      try {
        await this.dependencies.repository.fail({
          id: reserved.snapshot.id,
          failureCode: failure.code,
          safeFailureEvidence: failure.evidence,
          completedAt: this.dependencies.now(),
        }, persistenceGovernance());
        terminalPersistenceObserved = true;
      } catch (failPersistenceError) {
        // Terminal failure persistence remains diagnostic-only: observing its own failure never
        // replaces the primary error, restores canonical authority, or creates renewed authority.
        recordSecondaryDiagnostic(failPersistenceError, "workspace-index-terminal-fail-persistence-secondary");
      }
      // INVARIANT 3 is structural: every admitted link already carries its own rejection observer from
      // the moment the link exists, so no rejection window exists here — including while
      // repository.fail(...) above was still pending. Late rejections remain bounded secondary evidence
      // and can never become unhandledRejection or replace the primary error.
      if (!terminalPersistenceObserved) {
        recordSecondaryDiagnostic(error, "workspace-index-terminal-persistence-skipped-by-primary-failure");
      }
      throw error;
    } finally {
      if (persistenceDeadlineTimer) clearTimeout(persistenceDeadlineTimer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async createDiagnostic(
    command: Extract<CreateWorkspaceIndexSnapshotCommand, { sourceMode: "ADVANCED_DIAGNOSTIC" }>,
    ownerAuthority: string,
  ): Promise<WorkspaceIndexSnapshotCreateOperation> {
    const contract = validateCanonicalContract(command.workspaceIndex);
    let registration: WorkspaceRegistration | undefined;
    if (command.workspaceRegistrationId) {
      registration = await this.dependencies.readWorkspace(command.workspaceRegistrationId);
      if (
        contract.workspace.workspace_instance_id !== registration.id
        || !sameLocalAbsolutePath(contract.source_binding.normalized_reference, registration.normalizedReference)
      ) {
        throw new HttpCommandError(422, "DIAGNOSTIC_WORKSPACE_BINDING_MISMATCH", "The diagnostic Canonical Snapshot conflicts with the optional registered Workspace binding.");
      }
    }
    const canonicalSha256 = canonicalWorkspaceIndexHash(contract);
    const governedScope = {
      scopeMode: "CANONICAL_DIAGNOSTIC_PAYLOAD",
      filesystemRead: false,
    };
    const fingerprint = requestFingerprint({
      schema: "intentchord.workspace-index-snapshot-request.v1",
      sourceMode: command.sourceMode,
      canonicalSha256,
      workspaceRegistrationId: registration?.id ?? null,
      workspaceRegistrationRevision: registration?.revision ?? null,
      workspaceRegistrationFingerprint: registration?.fingerprint ?? null,
      projectContextId: command.projectContextId ?? null,
      canonicalContractVersion: contract.contract_version,
    });
    const startedAt = this.dependencies.now();
    const reserved = await this.dependencies.repository.reserve({
      sourceMode: command.sourceMode,
      ...(registration ? {
        workspaceRegistrationId: registration.id,
        workspaceRegistrationRevision: registration.revision,
        workspaceRegistrationFingerprint: registration.fingerprint,
      } : {}),
      ...(command.projectContextId ? { projectContextId: command.projectContextId } : {}),
      governedScope,
      idempotencyKey: command.idempotencyKey,
      requestFingerprintSha256: fingerprint,
      ownerReference: ownerAuthority,
      startedAt,
    });
    if (!reserved.created) return { snapshot: reserved.snapshot, created: false };
    try {
      return {
        snapshot: await this.dependencies.repository.complete({
          id: reserved.snapshot.id,
          contract,
          canonicalSha256,
          completedAt: this.dependencies.now(),
        }),
        created: true,
      };
    } catch (error) {
      const failure = safeFailure(error);
      await this.dependencies.repository.fail({
        id: reserved.snapshot.id,
        failureCode: failure.code,
        safeFailureEvidence: failure.evidence,
        completedAt: this.dependencies.now(),
      });
      throw error;
    }
  }
}

let _evidenceRepoLazy: PostgresWorkspaceEvidenceRepository | undefined;
function lazyEvidenceRepo(): PostgresWorkspaceEvidenceRepository {
  if (!_evidenceRepoLazy) _evidenceRepoLazy = new PostgresWorkspaceEvidenceRepository();
  return _evidenceRepoLazy;
}

const productionService = new WorkspaceIndexSnapshotService({
  repository: new PostgresWorkspaceIndexSnapshotRepository(),
  evidenceRepository: undefined,
  readWorkspace: readWorkspaceRegistration,
  authorizeWorkspaceSource: assertRegisteredWorkspaceSourceAuthority,
  runIndexer: indexWorkspace,
  runIndexerV2: async (request, options) => {
    const engine = parseWorkspaceIndexEngine(process.env);
    if (engine !== "V2") throw new Error("V2_ADAPTER_INVOKED_WITHOUT_V2_ENGINE");
    return indexWorkspaceV2(request, options);
  },
  now: () => new Date().toISOString(),
});

export async function createWorkspaceIndexSnapshotOperation(
  raw: unknown,
  ownerAuthority: string,
  signal?: AbortSignal,
): Promise<WorkspaceIndexSnapshotCreateOperation> {
  return productionService.createOperation(raw, ownerAuthority, signal);
}

export async function createWorkspaceIndexSnapshot(raw: unknown, ownerAuthority: string): Promise<WorkspaceIndexSnapshotView> {
  return productionService.create(raw, ownerAuthority);
}

export async function readPersistedWorkspaceIndexSnapshot(id: string) {
  if (!uuidSchema.safeParse(id).success) throw new HttpCommandError(400, "INVALID_IDENTIFIER", "Workspace Index Snapshot ID must be a UUID.");
  return new PostgresWorkspaceIndexSnapshotRepository().read(id);
}

export async function readPersistedWorkspaceIndexMappingAuthority(id: string) {
  if (!uuidSchema.safeParse(id).success) throw new HttpCommandError(400, "INVALID_IDENTIFIER", "Workspace Index Snapshot ID must be a UUID.");
  return new PostgresWorkspaceIndexSnapshotRepository().readMappingAuthority(id);
}


const preflightSchema = z.object({ workspaceRegistrationId: uuidSchema }).strict();

type RegisteredWorkspacePreflightDependencies = {
  authorizeWorkspaceSource: (id: string, governance?: { signal?: AbortSignal; deadlineAt?: number }) => Promise<AuthorizedWorkspaceSource>;
  inventoryWorkspace: typeof inventoryWorkspaceFiles;
};

export async function preflightRegisteredWorkspaceIndexWithDependencies(
  raw: unknown,
  dependencies: RegisteredWorkspacePreflightDependencies,
) {
  const command = preflightSchema.parse(raw);
  const attemptStartedAtMs = Date.now();
  const absoluteOperationDeadlineAt = workspaceAbsoluteOperationDeadlineAt(attemptStartedAtMs, DEFAULT_WORKSPACE_DURATION_GOVERNANCE);
  const sourceAuthorityDeadlineAt = workspacePhaseDeadlineAt({
    phaseStartedAtMs: attemptStartedAtMs,
    phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.sourceAuthorityMaxMs,
    absoluteOperationDeadlineAt,
  });
  // C21: source authority is proven before inventoryWorkspace is invoked. A stale/unprovable root therefore
  // causes zero inventory/traversal calls beyond the minimal root-object authority probe itself.
  const authorizedSource = await dependencies.authorizeWorkspaceSource(command.workspaceRegistrationId, { deadlineAt: sourceAuthorityDeadlineAt });
  const registration = authorizedSource.registration;
  const currentIdentity = authorizedSource.currentIdentity;
  if (registration.referenceType !== "LOCAL_PATH" || registration.verificationStatus !== "VERIFIED") {
    throw new HttpCommandError(409, "WORKSPACE_VERIFICATION_REQUIRED", "The registered Workspace must be a VERIFIED LOCAL_PATH Workspace.");
  }
  const discoveryStartedAtMs = Date.now();
  const discoveryDeadlineAt = workspacePhaseDeadlineAt({
    phaseStartedAtMs: discoveryStartedAtMs,
    phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.discoveryMaxMs,
    absoluteOperationDeadlineAt,
  });
  const inventory = await dependencies.inventoryWorkspace(
    registration.normalizedReference,
    [],
    new Date().toISOString(),
    {
      budgets: DEFAULT_WORKSPACE_INDEX_BUDGETS,
      startedAtMs: discoveryStartedAtMs,
      deadlineAt: discoveryDeadlineAt,
      expectedRoot: { realPath: currentIdentity.realPath, identity: currentIdentity.rootObjectIdentity },
    },
  );
  const durationDecision = deriveWorkspaceProcessingDurationBudget({
    discoveredFiles: inventory.totals.discovered_files,
    discoveredBytes: inventory.totals.discovered_bytes,
  }, DEFAULT_WORKSPACE_DURATION_GOVERNANCE);
  return {
    workspaceRegistrationId: registration.id,
    traversalPolicyId: WORKSPACE_TRAVERSAL_POLICY_ID,
    discoveredFiles: inventory.totals.discovered_files,
    discoveredBytes: inventory.totals.discovered_bytes,
    excludedTrees: inventory.excluded_boundaries,
    budgets: DEFAULT_WORKSPACE_INDEX_BUDGETS,
    durationGovernance: durationDecision,
    hashingPerformed: false,
    parsingPerformed: false,
  };
}

export async function preflightRegisteredWorkspaceIndex(raw: unknown) {
  const repository = new PostgresWorkspaceIndexSnapshotRepository();
  await repository.recoverStale({ staleBefore: new Date(Date.now() - 5 * 60_000).toISOString(), completedAt: new Date().toISOString() });
  return preflightRegisteredWorkspaceIndexWithDependencies(raw, {
    authorizeWorkspaceSource: assertRegisteredWorkspaceSourceAuthority,
    inventoryWorkspace: inventoryWorkspaceFiles,
  });
}

export async function readWorkspaceKnowledgeHistory(workspaceRegistrationId: string) {
  if (!uuidSchema.safeParse(workspaceRegistrationId).success) throw new HttpCommandError(400, "INVALID_IDENTIFIER", "Workspace Registration ID must be a UUID.");
  return new PostgresWorkspaceIndexSnapshotRepository().readWorkspaceHistory(workspaceRegistrationId);
}
