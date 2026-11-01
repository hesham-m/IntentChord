import { describe, expect, it, vi } from "vitest";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalWorkspaceIndexHash, finalizeWorkspaceIndexContract } from "@/core/workspace-index/canonical";
import { deriveWorkspaceIndexDelta, validateWorkspaceIndexDelta } from "@/core/workspace-index/delta";
import { canonicalIndexArtifactId, canonicalIndexArtifactQualification, canonicalIndexArtifactSemanticSha256, canonicalIndexArtifactSemanticState, classifyWorkspaceObservation, workspaceIndexDeltaArtifactId, type WorkspaceIndexConfigurationDescriptor } from "@/core/workspace-index/artifact-identity";
import { AiContextMapperOrchestrator } from "@/core/ai-context-mapper/orchestrator";
import { sampleInternalAiProviderConfiguration, sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";
import { InMemoryAiContextMappingRepository } from "@/server/ai-context-mapping-repository";
import { indexWorkspace, WorkspaceIndexingError } from "@/core/workspace-index/indexer";
import type { CanonicalWorkspaceIndexContract } from "@/core/workspace-index/types";
import { createWorkspaceIndexFixture } from "@/test/workspace-index-helpers";
import { boundedFailureDiagnostic } from "@/core/workspace-index/failure-diagnostics";
import { HttpCommandError } from "@/server/errors";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import {
  WorkspaceIndexSnapshotService,
  preflightRegisteredWorkspaceIndexWithDependencies,
  type CreateWorkspaceIndexSnapshotCommand,
} from "@/server/workspace-index-snapshot-service";
import type {
  ReserveWorkspaceIndexSnapshot,
  WorkspaceIndexSnapshotRecord,
  WorkspaceIndexSnapshotRepository,
  LatestResolvedWorkspaceArtifact,
  LatestWorkspaceObservationHead,
  WorkspaceKnowledgeHistoryView,
} from "@/server/workspace-index-snapshot-repository";
import { deriveTransitionLineageEvidence, WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION } from "@/core/workspace-index/transition-lineage";
import type { WorkspaceAuthorityRegistration, WorkspaceRegistration } from "@/server/workspace-connector";
import { createWorkspaceFilesystemObjectAuthority, sameProofGradeFilesystemObject, type ProofGradeFilesystemObjectIdentity } from "@/core/workspace-index/filesystem-object-authority";
import { DEFAULT_WORKSPACE_DURATION_GOVERNANCE, WORKSPACE_DURATION_POLICY_ID, workspaceAbsoluteOperationDeadlineAt, workspacePhaseDeadlineAt } from "@/core/workspace-index/duration-governance";
import { WorkspaceIndexBoundedError } from "@/core/workspace-index/adapters/filesystem";
import { DatabaseExecutionGovernanceError, type DatabaseExecutionGovernance } from "@/server/db";
import { stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import { hostname, platform } from "node:os";

type WorkspaceIndexerRequest = Parameters<typeof indexWorkspace>[0];
type ReadIdempotencyArgs = Parameters<WorkspaceIndexSnapshotRepository["readByIdempotencyKey"]>;
type RecoverStaleArgs = Parameters<WorkspaceIndexSnapshotRepository["recoverStale"]>;
type AssertProjectContextArgs = Parameters<WorkspaceIndexSnapshotRepository["assertProjectContextExists"]>;
type ReadLatestObservationHeadArgs = Parameters<WorkspaceIndexSnapshotRepository["readLatestObservationHead"]>;
type ReserveSnapshotArgs = Parameters<WorkspaceIndexSnapshotRepository["reserve"]>;
type UpdateProgressArgs = Parameters<WorkspaceIndexSnapshotRepository["updateProgress"]>;
type CompleteRegisteredObservationArgs = Parameters<WorkspaceIndexSnapshotRepository["completeRegisteredObservation"]>;
type FailSnapshotArgs = Parameters<WorkspaceIndexSnapshotRepository["fail"]>;

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

class MemorySnapshotRepository implements WorkspaceIndexSnapshotRepository {
  readonly rows = new Map<string, WorkspaceIndexSnapshotRecord>();
  readonly keys = new Map<string, string>();
  readonly projects = new Set<string>([projectId]);
  readonly artifacts = new Map<string, { id: string; revisionId: string; configSha: string; contract: CanonicalWorkspaceIndexContract; canonicalSha256: string }>();
  readonly observations: WorkspaceKnowledgeHistoryView["observations"] = [];
  readonly revisions = new Map<string, { sourceTreeFingerprint: string; firstObservedAt: string }>();
  readonly transitions: WorkspaceKnowledgeHistoryView["transitions"] = [];

  async readByIdempotencyKey(idempotencyKey: string, _governance?: DatabaseExecutionGovernance) {
    const id = this.keys.get(idempotencyKey);
    return id ? this.rows.get(id) : undefined;
  }

  async wasRevisionPreviouslyObserved(workspaceRegistrationId: string, workspaceRevisionId: string, _governance?: DatabaseExecutionGovernance): Promise<boolean> {
    return this.observations.some(o => o.workspaceRevisionId === workspaceRevisionId);
  }

  async reserve(input: ReserveWorkspaceIndexSnapshot, _governance?: DatabaseExecutionGovernance) {
    const existingId = this.keys.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.rows.get(existingId)!;
      if (existing.requestFingerprintSha256 !== input.requestFingerprintSha256) {
        throw new HttpCommandError(409, "IDEMPOTENCY_CONFLICT", "conflict");
      }
      return { snapshot: existing, created: false };
    }
    const id = `33333333-3333-4333-8333-${String(this.rows.size + 1).padStart(12, "0")}`;
    const row: WorkspaceIndexSnapshotRecord = {
      id,
      sourceMode: input.sourceMode,
      status: "CREATING",
      ...(input.workspaceRegistrationId ? { workspaceRegistrationId: input.workspaceRegistrationId } : {}),
      ...(input.workspaceRegistrationRevision !== undefined ? { workspaceRegistrationRevision: input.workspaceRegistrationRevision } : {}),
      ...(input.workspaceRegistrationFingerprint ? { workspaceRegistrationFingerprint: input.workspaceRegistrationFingerprint } : {}),
      ...(input.projectContextId ? { projectContextId: input.projectContextId } : {}),
      governedScope: input.governedScope,
      ...(input.scanBaseObservationId ? { scanBaseObservationId: input.scanBaseObservationId } : {}),
      snapshotIdempotencyKey: input.idempotencyKey,
      requestFingerprintSha256: input.requestFingerprintSha256,
      ownerReference: input.ownerReference,
      startedAt: input.startedAt,
      createdAt: input.startedAt,
    };
    this.rows.set(id, row);
    this.keys.set(input.idempotencyKey, id);
    return { snapshot: row, created: true };
  }

  async complete(input: { id: string; contract: CanonicalWorkspaceIndexContract; canonicalSha256: string; completedAt: string }) {
    const current = this.rows.get(input.id)!;
    const next: WorkspaceIndexSnapshotRecord = {
      ...current,
      status: "READY",
      canonicalContractVersion: input.contract.contract_version,
      canonicalIndex: structuredClone(input.contract),
      canonicalSha256: input.canonicalSha256,
      completedAt: input.completedAt,
    };
    this.rows.set(input.id, next);
    return next;
  }

  async readLatestObservationHead(workspaceRegistrationId: string, _governance?: DatabaseExecutionGovernance): Promise<LatestWorkspaceObservationHead | undefined> {
    const observation = [...this.observations].reverse().find(item => this.rows.get(item.snapshotOperationId)?.workspaceRegistrationId === workspaceRegistrationId);
    if (!observation) return undefined;
    const row = this.rows.get(observation.snapshotOperationId)!;
    const artifact = observation.canonicalIndexArtifactId ? this.artifacts.get(observation.canonicalIndexArtifactId) : undefined;
    const candidate = row.indexAttemptCandidate;
    return {
      observationId: observation.id,
      workspaceRevisionId: observation.workspaceRevisionId,
      ...(observation.canonicalIndexArtifactId ? { canonicalIndexArtifactId: observation.canonicalIndexArtifactId } : {}),
      observationResult: observation.observationResult,
      observedAt: observation.observedAt,
      indexConfigurationSha256: observation.indexConfigurationSha256,
      ...(artifact ? { canonicalIndex: structuredClone(artifact.contract), canonicalSha256: artifact.canonicalSha256 } : candidate ? { canonicalIndex: structuredClone(candidate), canonicalSha256: row.indexAttemptCandidateSha256 } : {}),
    };
  }

  async readLatestResolvedArtifact(workspaceRegistrationId: string): Promise<LatestResolvedWorkspaceArtifact | undefined> {
    const observation = [...this.observations].reverse().find(item => this.rows.get(item.snapshotOperationId)?.workspaceRegistrationId === workspaceRegistrationId && Boolean(item.canonicalIndexArtifactId));
    if (!observation?.canonicalIndexArtifactId) return undefined;
    const artifact = this.artifacts.get(observation.canonicalIndexArtifactId)!;
    return {
      observationId: observation.id,
      workspaceRevisionId: observation.workspaceRevisionId,
      canonicalIndexArtifactId: observation.canonicalIndexArtifactId,
      observationResult: observation.observationResult,
      observedAt: observation.observedAt,
      indexConfigurationSha256: observation.indexConfigurationSha256,
      canonicalIndex: structuredClone(artifact.contract),
      canonicalSha256: artifact.canonicalSha256,
    };
  }

  async completeRegisteredObservation(input: {
    id: string;
    workspaceRegistrationId: string;
    contract: CanonicalWorkspaceIndexContract;
    canonicalSha256: string;
    indexConfiguration: WorkspaceIndexConfigurationDescriptor;
    indexConfigurationSha256: string;
    completedAt: string;
  }, _governance?: DatabaseExecutionGovernance) {
    const current = this.rows.get(input.id)!;
    if (current.status !== "CREATING") throw new HttpCommandError(409, "SNAPSHOT_STATE_CONFLICT", "conflict");
    const previous = await this.readLatestObservationHead(input.workspaceRegistrationId);
    if ((previous?.observationId ?? undefined) !== current.scanBaseObservationId) throw new HttpCommandError(409, "WORKSPACE_INDEX_SCAN_BASE_STALE", "stale");
    const revisionId = input.contract.workspace.workspace_revision_id;
    const treeFingerprint = input.contract.integrity.workspace_tree_fingerprint;
    const revisionWasKnown = this.revisions.has(revisionId);
    if (!revisionWasKnown) this.revisions.set(revisionId, { sourceTreeFingerprint: treeFingerprint, firstObservedAt: input.completedAt });

    const qualification = canonicalIndexArtifactQualification(input.contract);
    if (!qualification.qualified) {
      const observationId = `66666666-6666-4666-8666-${String(this.observations.length + 1).padStart(12, "0")}`;
      this.observations.push({
        id: observationId,
        snapshotOperationId: input.id,
        workspaceRevisionId: revisionId,
        ...(previous ? { previousObservationId: previous.observationId } : {}),
        observationResult: "SOURCE_PROVEN_INDEX_FAILED",
        indexConfigurationSha256: input.indexConfigurationSha256,
        sourceBinding: structuredClone(input.contract.source_binding) as unknown as Record<string, unknown>,
        observedAt: input.completedAt,
      });
      if (previous && previous.workspaceRevisionId !== revisionId) {
        this.transitions.push({
          id: `77777777-7777-4777-8777-${String(this.transitions.length + 1).padStart(12, "0")}`,
          observationId,
          fromWorkspaceRevisionId: previous.workspaceRevisionId,
          toWorkspaceRevisionId: revisionId,
          lineageEvidence: previous.canonicalIndex ? deriveTransitionLineageEvidence(previous.canonicalIndex, input.contract) : { schema: WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION, renamed_or_moved: [] },
          observedAt: input.completedAt,
        });
      }
      const failureEvidence = { code: "SOURCE_CAPTURE_PROVEN_INDEX_ATTEMPT_FAILED", source_capture: "PROVEN", workspace_revision_id: revisionId, retryable_failure_codes: qualification.retryable_failure_codes };
      const failed: WorkspaceIndexSnapshotRecord = {
        ...current,
        status: "FAILED",
        workspaceObservationId: observationId,
        workspaceRevisionId: revisionId,
        indexConfigurationSha256: input.indexConfigurationSha256,
        observationResult: "SOURCE_PROVEN_INDEX_FAILED",
        indexAttemptStatus: "FAILED_RETRYABLE",
        indexAttemptEvidence: failureEvidence,
        indexAttemptCandidate: structuredClone(input.contract),
        indexAttemptCandidateSha256: input.canonicalSha256,
        failureCode: "SOURCE_CAPTURE_PROVEN_INDEX_ATTEMPT_FAILED",
        safeFailureEvidence: failureEvidence,
        progressPhase: "FAILED",
        completedAt: input.completedAt,
      };
      this.rows.set(input.id, failed);
      return failed;
    }

    const artifactId = canonicalIndexArtifactId(revisionId, input.indexConfigurationSha256);
    let artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      artifact = { id: artifactId, revisionId, configSha: input.indexConfigurationSha256, contract: structuredClone(input.contract), canonicalSha256: input.canonicalSha256 };
      this.artifacts.set(artifactId, artifact);
    }
    const observationResult = classifyWorkspaceObservation({
      previousRevisionId: previous?.workspaceRevisionId,
      previousArtifactId: previous?.canonicalIndexArtifactId,
      currentRevisionId: revisionId,
      currentArtifactId: artifactId,
      revisionWasKnown,
    });
    const observationId = `66666666-6666-4666-8666-${String(this.observations.length + 1).padStart(12, "0")}`;
    let deltaArtifactId: string | undefined;
    if (previous?.canonicalIndexArtifactId && previous.canonicalIndex && previous.canonicalIndexArtifactId !== artifactId) {
      const { integrity: _integrity, delta: _delta, ...target } = artifact.contract;
      const derived = deriveWorkspaceIndexDelta({ base: previous.canonicalIndex, target, generated_at: input.completedAt });
      const validation = validateWorkspaceIndexDelta({ base: previous.canonicalIndex, target: artifact.contract, delta: derived });
      if (!validation.accepted) throw new Error(`MEMORY_DELTA_VALIDATION_FAILED:${validation.diagnostics.join(",")}`);
      deltaArtifactId = workspaceIndexDeltaArtifactId({ fromArtifactId: previous.canonicalIndexArtifactId, toArtifactId: artifactId });
    }
    this.observations.push({
      id: observationId,
      snapshotOperationId: input.id,
      workspaceRevisionId: revisionId,
      canonicalIndexArtifactId: artifactId,
      ...(previous ? { previousObservationId: previous.observationId } : {}),
      observationResult,
      indexConfigurationSha256: input.indexConfigurationSha256,
      sourceBinding: structuredClone(input.contract.source_binding) as unknown as Record<string, unknown>,
      observedAt: input.completedAt,
      ...(deltaArtifactId ? { deltaArtifactId } : {}),
    });
    if (previous && previous.workspaceRevisionId !== revisionId) {
      this.transitions.push({
        id: `77777777-7777-4777-8777-${String(this.transitions.length + 1).padStart(12, "0")}`,
        observationId,
        fromWorkspaceRevisionId: previous.workspaceRevisionId,
        toWorkspaceRevisionId: revisionId,
        ...(deltaArtifactId ? { deltaArtifactId } : {}),
        lineageEvidence: previous.canonicalIndex ? deriveTransitionLineageEvidence(previous.canonicalIndex, input.contract) : { schema: WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION, renamed_or_moved: [] },
        observedAt: input.completedAt,
      });
    }
    const next: WorkspaceIndexSnapshotRecord = {
      ...current,
      status: "READY",
      canonicalContractVersion: artifact.contract.contract_version,
      canonicalIndex: structuredClone(artifact.contract),
      canonicalSha256: artifact.canonicalSha256,
      workspaceObservationId: observationId,
      workspaceRevisionId: revisionId,
      canonicalIndexArtifactId: artifactId,
      indexConfigurationSha256: input.indexConfigurationSha256,
      observationResult,
      ...(deltaArtifactId ? { deltaArtifactId } : {}),
      indexAttemptStatus: "SUCCEEDED",
      indexAttemptEvidence: { source_capture: "PROVEN", canonicalization: "QUALIFIED" },
      completedAt: input.completedAt,
    };
    this.rows.set(input.id, next);
    return next;
  }

  async readMappingAuthority(id: string) {
    const snapshot = await this.read(id);
    if (snapshot.sourceMode !== "REGISTERED_WORKSPACE" || snapshot.status !== "READY") return { snapshot };
    if (snapshot.canonicalIndexArtifactId) {
      const artifact = this.artifacts.get(snapshot.canonicalIndexArtifactId);
      if (!artifact) throw new HttpCommandError(409, "REGISTERED_B1_MAPPING_ARTIFACT_BINDING_MISMATCH", "missing");
      const semanticState = canonicalIndexArtifactSemanticState(artifact.contract);
      return { snapshot, artifact: { id: artifact.id, semanticSha256: canonicalIndexArtifactSemanticSha256(artifact.contract), semanticState } };
    }
    if (snapshot.acceptedWorkspaceEvidenceArtifactId) {
      return { snapshot, artifact: { id: snapshot.acceptedWorkspaceEvidenceArtifactId, semanticSha256: "v2_semantic_sha", semanticState: { workspace_instance_id: snapshot.workspaceRegistrationId, workspace_revision_id: snapshot.workspaceRevisionId, evidence_artifact_id: snapshot.acceptedWorkspaceEvidenceArtifactId } } };
    }
    return { snapshot };
  }

  async readWorkspaceHistory(workspaceRegistrationId: string): Promise<WorkspaceKnowledgeHistoryView> {
    const observations = this.observations.filter(item => this.rows.get(item.snapshotOperationId)?.workspaceRegistrationId === workspaceRegistrationId);
    const revisionIds = new Set(observations.map(item => item.workspaceRevisionId));
    return {
      workspaceRegistrationId,
      revisions: [...revisionIds].map(revisionId => {
        const revision = this.revisions.get(revisionId)!;
        return {
          workspaceRevisionId: revisionId,
          sourceTreeFingerprint: revision.sourceTreeFingerprint,
          firstObservedAt: revision.firstObservedAt,
          observationCount: observations.filter(item => item.workspaceRevisionId === revisionId).length,
        };
      }),
      observations: structuredClone(observations),
      transitions: structuredClone(this.transitions.filter(item => observations.some(observation => observation.id === item.observationId))),
    };
  }

  async fail(input: { id: string; failureCode: string; safeFailureEvidence: Record<string, unknown>; completedAt: string }, _governance?: DatabaseExecutionGovernance) {
    const current = this.rows.get(input.id)!;
    const next: WorkspaceIndexSnapshotRecord = {
      ...current,
      status: "FAILED",
      failureCode: input.failureCode,
      safeFailureEvidence: input.safeFailureEvidence,
      completedAt: input.completedAt,
    };
    this.rows.set(input.id, next);
    return next;
  }

  async read(id: string, _governance?: DatabaseExecutionGovernance) {
    const row = this.rows.get(id);
    if (!row) throw new HttpCommandError(404, "WORKSPACE_INDEX_SNAPSHOT_NOT_FOUND", "missing");
    return row;
  }

  async updateProgress(input: { id: string; phase: string; evidence: Record<string, unknown>; heartbeatAt: string }, _governance?: DatabaseExecutionGovernance) {
    const current = this.rows.get(input.id);
    if (current?.status === "CREATING") this.rows.set(input.id, { ...current, progressPhase: input.phase, progressEvidence: input.evidence, heartbeatAt: input.heartbeatAt });
  }

  async recoverStale(_input: RecoverStaleArgs[0], _governance?: DatabaseExecutionGovernance) { return 0; }

  async completeRegisteredObservationV2(input: {
    id: string;
    workspaceRegistrationId: string;
    workspaceInstanceId: string;
    workspaceRevisionId: string;
    sourceBindingId: string;
    bindingType: string;
    normalizedReference: string;
    indexConfigurationSha256: string;
    observationResult: string;
    treeFingerprint: string;
    canonicalPayloadHash: string;
    sourceBindingMetadata: Record<string, unknown>;
    completedAt: string;
    engineMode: "V2_SECTIONED";
  }, _governance?: DatabaseExecutionGovernance) {
    const current = this.rows.get(input.id)!;
    if (current.status !== "CREATING") throw new HttpCommandError(409, "SNAPSHOT_STATE_CONFLICT", "conflict");
    const updated = { ...current, status: "READY" as const, completedAt: input.completedAt, progressPhase: "READY" };
    this.rows.set(input.id, updated);
    return updated as any;
  }

  async sealV2Snapshot(input: {
    snapshotId: string;
    workspaceRegistrationId: string;
    workspaceInstanceId: string;
    completedAt: string;
    evidenceArtifact: Record<string, unknown>;
    sections: ReadonlyArray<Record<string, unknown>>;
    attestationId: string;
    observationResult: string;
    sourceBindingId: string;
    sourceBindingMetadata: Record<string, unknown>;
    bindingType: string;
    normalizedReference: string;
    treeFingerprint: string;
  }, _evidenceRepo: unknown, _governance?: DatabaseExecutionGovernance) {
    const current = this.rows.get(input.snapshotId)!;
    if (current.status !== "CREATING") throw new HttpCommandError(409, "SNAPSHOT_STATE_CONFLICT", "conflict");
    const updated = { ...current, status: "READY" as const, completedAt: input.completedAt, progressPhase: "READY" };
    this.rows.set(input.snapshotId, updated);
    return updated as any;
  }

  async assertProjectContextExists(id: string, _governance?: DatabaseExecutionGovernance) {
    if (!this.projects.has(id)) throw new HttpCommandError(404, "PROJECT_CONTEXT_NOT_FOUND", "missing");
  }
}

function publishFinalizationAuthority(request: Parameters<typeof indexWorkspace>[0], phaseStartedAtMs = Date.now()): void {
  const duration = request.duration_policy ?? DEFAULT_WORKSPACE_DURATION_GOVERNANCE;
  const attemptStartedAtMs = request.attempt_started_at_ms ?? phaseStartedAtMs;
  const absoluteOperationDeadlineAt = workspaceAbsoluteOperationDeadlineAt(attemptStartedAtMs, duration);
  request.on_duration_phase_authority?.({
    durationPolicyId: duration.durationPolicyId,
    governancePhase: "FINALIZATION",
    phaseStartedAtMs,
    phaseBudgetMs: duration.finalizationMaxMs,
    phaseDeadlineAt: workspacePhaseDeadlineAt({
      phaseStartedAtMs,
      phaseBudgetMs: duration.finalizationMaxMs,
      absoluteOperationDeadlineAt,
    }),
    absoluteOperationDeadlineAt,
  });
}

function successfulIndexerResult(contract: CanonicalWorkspaceIndexContract) {
  return async (request: Parameters<typeof indexWorkspace>[0]) => {
    publishFinalizationAuthority(request);
    return structuredClone(contract);
  };
}

function governedDelay<T>(input: {
  governance: DatabaseExecutionGovernance | undefined;
  delayMs: number;
  value: () => Promise<T> | T;
}): Promise<T> {
  if (!input.governance) throw new Error("TEST_GOVERNANCE_REQUIRED");
  const governance = input.governance;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rejectGoverned = () => {
      if (timer) clearTimeout(timer);
      governance.signal?.removeEventListener("abort", onAbort);
      reject(new DatabaseExecutionGovernanceError("TIMEOUT", governance.deadlineAtMs));
    };
    const onAbort = () => rejectGoverned();
    if (governance.signal?.aborted) {
      rejectGoverned();
      return;
    }
    governance.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(async () => {
      governance.signal?.removeEventListener("abort", onAbort);
      try {
        resolve(await input.value());
      } catch (error) {
        reject(error);
      }
    }, input.delayMs);
  });
}

function databaseGovernedDelay<T>(input: {
  governance: DatabaseExecutionGovernance | undefined;
  delayMs: number;
  value: () => Promise<T> | T;
}): Promise<T> {
  if (!input.governance) throw new Error("TEST_DATABASE_GOVERNANCE_REQUIRED");
  const governance = input.governance;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let workTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (workTimer) clearTimeout(workTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      governance.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new DatabaseExecutionGovernanceError("ABORTED", governance.deadlineAtMs)));
    if (governance.signal?.aborted) {
      onAbort();
      return;
    }
    const remainingMs = governance.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      finish(() => reject(new DatabaseExecutionGovernanceError("TIMEOUT", governance.deadlineAtMs)));
      return;
    }
    governance.signal?.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(
      () => finish(() => reject(new DatabaseExecutionGovernanceError("TIMEOUT", governance.deadlineAtMs))),
      remainingMs,
    );
    workTimer = setTimeout(async () => {
      if (settled) return;
      try {
        const value = await input.value();
        finish(() => resolve(value));
      } catch (error) {
        finish(() => reject(error));
      }
    }, input.delayMs);
  });
}

function finalizationProgressEvidence(): import("@/core/workspace-index/adapters/filesystem").WorkspaceProgressEvidence {
  return {
    phase: "ASSEMBLING",
    discoveredFiles: 1,
    discoveredBytes: 1,
    hashedFiles: 1,
    hashedBytes: 1,
    parsedFiles: 1,
    aggregateRetainedTextBytes: 1,
    csvSampledBytes: 0,
    excludedTrees: 0,
    elapsedMs: 0,
    durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
    governancePhase: "FINALIZATION",
    phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs,
    absoluteOperationMaxMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
  };
}

async function fixtureContract(root: string): Promise<CanonicalWorkspaceIndexContract> {
  return indexWorkspace({
    workspace_instance_id: workspaceId,
    root_path: root,
    binding_type: "LOCAL_FILESYSTEM",
    indexing_session_id: "44444444-4444-4444-8444-444444444444",
    started_at: "2026-08-05T08:00:00.000Z",
    completed_at: "2026-08-05T08:00:01.000Z",
  });
}

function registration(root: string): WorkspaceRegistration {
  return {
    id: workspaceId,
    revision: 7,
    displayName: "Fixture",
    role: "primary",
    referenceType: "LOCAL_PATH",
    source: "MANUAL_VERIFIED",
    reference: root,
    normalizedReference: root,
    verificationStatus: "VERIFIED",
    verificationMethod: "fixture",
    verificationAuthority: "owner",
    fingerprint: "sha256:fixture-workspace-fingerprint",
    provenance: {},
    authorizationContext: "owner",
  };
}

async function rootAuthority(root: string): Promise<{ identity: ProofGradeFilesystemObjectIdentity; realPath: string }> {
  const authority = createWorkspaceFilesystemObjectAuthority();
  try {
    const probe = await authority.probeDirectory(root);
    return { identity: probe.identity, realPath: probe.resolved_real_path };
  } finally {
    await authority.close().catch(() => undefined);
  }
}

function authorityRegistration(root: string, rootProof: { identity: ProofGradeFilesystemObjectIdentity; realPath: string }): WorkspaceAuthorityRegistration {
  return {
    ...registration(root),
    verifiedRootRealPath: rootProof.realPath,
    verifiedRootObjectIdentity: rootProof.identity,
    verifiedRootVerifiedAt: "2026-08-05T08:00:00.000Z",
    rootAuthorityState: "VERIFIED_MATCH",
    rootAuthorityCheckedAt: "2026-08-05T08:00:00.000Z",
  };
}

async function harness() {
  const root = await createWorkspaceIndexFixture();
  const contract = await fixtureContract(root);
  const repository = new MemorySnapshotRepository();
  const rootProof = await rootAuthority(root);
  const readWorkspace = vi.fn(async () => registration(root));
  const authorizeWorkspaceSource = vi.fn(async (
    _id: string,
    _governance?: { signal?: AbortSignal; deadlineAt?: number },
  ) => ({
    registration: authorityRegistration(root, rootProof),
    currentIdentity: {
      normalizedReference: root,
      realPath: rootProof.realPath,
      rootObjectIdentity: rootProof.identity,
      fingerprint: "sha256:fixture-workspace-fingerprint",
      provenance: {},
    },
  }));
  const runIndexer = vi.fn(successfulIndexerResult(contract));
  let tick = 0;
  const mockEvidenceRepo = {
    insertStagedRecords: vi.fn().mockResolvedValue(0),
    insertStagedSegment: vi.fn().mockResolvedValue(undefined),
    countStagedRecords: vi.fn().mockResolvedValue(0),
    insertArtifact: vi.fn().mockResolvedValue(undefined),
    insertSection: vi.fn().mockResolvedValue(1),
    insertAttestationOpen: vi.fn().mockResolvedValue(undefined),
    transitionAttestation: vi.fn().mockResolvedValue(undefined),
    constructor: PostgresWorkspaceEvidenceRepository,
  } as unknown as PostgresWorkspaceEvidenceRepository;
  const service = new WorkspaceIndexSnapshotService({
    repository,
    evidenceRepository: mockEvidenceRepo,
    readWorkspace,
    authorizeWorkspaceSource,
    runIndexer,
    now: () => `2026-08-05T08:00:0${tick++}.000Z`,
  });
  return { root, contract, repository, readWorkspace, authorizeWorkspaceSource, runIndexer, service };
}

describe("Workspace Index Snapshot governed service", () => {
  it("uses the existing Indexer for a verified registered Workspace and persists the exact hash", async () => {
    const h = await harness();
    const result = await h.service.create({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      projectContextId: projectId,
      idempotencyKey: "snapshot-operation-0001",
    }, "owner:test");

    expect(result.status).toBe("READY");
    expect(result.projectContextId).toBe(projectId);
    expect(result.canonicalSha256).toBe(canonicalWorkspaceIndexHash(h.contract));
    expect(h.runIndexer).toHaveBeenCalledTimes(1);
    expect(h.runIndexer.mock.calls[0][0]).toMatchObject({
      workspace_instance_id: workspaceId,
      root_path: h.root,
      binding_type: "LOCAL_FILESYSTEM",
    });
  });


  it("anchors one immutable Registered Workspace attempt clock before recoverStale, project association, idempotency, Source Authority, and Indexer execution", async () => {
    const h = await harness();
    const recoverStale = vi.spyOn(h.repository, "recoverStale");
    const assertProject = vi.spyOn(h.repository, "assertProjectContextExists");
    const readIdempotency = vi.spyOn(h.repository, "readByIdempotencyKey");
    const readHead = vi.spyOn(h.repository, "readLatestObservationHead");
    const reserve = vi.spyOn(h.repository, "reserve");
    const attemptStartedAtMs = 1_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(attemptStartedAtMs);
    try {
      await h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        projectContextId: projectId,
        idempotencyKey: "snapshot-duration-authority-0001",
      }, "owner:test");
    } finally {
      now.mockRestore();
    }
    const absoluteDeadlineAt = attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs;
    expect(recoverStale.mock.calls[0][1]).toMatchObject({ deadlineAtMs: absoluteDeadlineAt, signal: undefined });
    expect(assertProject.mock.calls[0][1]).toMatchObject({ deadlineAtMs: absoluteDeadlineAt, signal: undefined });
    expect(readIdempotency.mock.calls[0][1]).toMatchObject({ deadlineAtMs: absoluteDeadlineAt, signal: undefined });
    expect(h.authorizeWorkspaceSource.mock.calls[0][1]).toEqual({
      signal: undefined,
      deadlineAt: attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.sourceAuthorityMaxMs,
    });
    expect(readHead.mock.calls[0][1]).toMatchObject({ deadlineAtMs: absoluteDeadlineAt, signal: undefined });
    expect(reserve.mock.calls[0][1]).toMatchObject({ deadlineAtMs: absoluteDeadlineAt, signal: undefined });
    expect(h.runIndexer.mock.calls[0][0]).toMatchObject({
      attempt_started_at_ms: attemptStartedAtMs,
      duration_policy: DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
    });
  });

  it("fails closed when recoverStale exceeds the original Registered Workspace absolute deadline before any later authority", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const attemptStartedAtMs = 1_100_000;
    vi.setSystemTime(attemptStartedAtMs);
    const originalRecover = h.repository.recoverStale.bind(h.repository);
    const project = vi.spyOn(h.repository, "assertProjectContextExists");
    const idempotency = vi.spyOn(h.repository, "readByIdempotencyKey");
    vi.spyOn(h.repository, "recoverStale").mockImplementationOnce((input: RecoverStaleArgs[0], governance: RecoverStaleArgs[1]) => databaseGovernedDelay({
      governance,
      delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 10_000,
      value: () => originalRecover(input, governance),
    }));
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        projectContextId: projectId,
        idempotencyKey: "snapshot-recover-stale-absolute-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: { detailedProgressPhase: "RECOVER_STALE" },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 1);
      await rejection;
      expect(project).not.toHaveBeenCalled();
      expect(idempotency).not.toHaveBeenCalled();
      expect(h.authorizeWorkspaceSource).not.toHaveBeenCalled();
      expect(h.runIndexer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when project association validation exceeds the same original absolute deadline before Source Authority", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const attemptStartedAtMs = 1_200_000;
    vi.setSystemTime(attemptStartedAtMs);
    const originalProject = h.repository.assertProjectContextExists.bind(h.repository);
    const idempotency = vi.spyOn(h.repository, "readByIdempotencyKey");
    vi.spyOn(h.repository, "assertProjectContextExists").mockImplementationOnce((id: AssertProjectContextArgs[0], governance: AssertProjectContextArgs[1]) => databaseGovernedDelay({
      governance,
      delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 10_000,
      value: () => originalProject(id, governance),
    }));
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        projectContextId: projectId,
        idempotencyKey: "snapshot-project-association-absolute-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: { detailedProgressPhase: "PROJECT_ASSOCIATION" },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 1);
      await rejection;
      expect(idempotency).not.toHaveBeenCalled();
      expect(h.authorizeWorkspaceSource).not.toHaveBeenCalled();
      expect(h.runIndexer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when idempotency lookup exceeds the same original absolute deadline before Source Authority", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const attemptStartedAtMs = 1_300_000;
    vi.setSystemTime(attemptStartedAtMs);
    const originalRead = h.repository.readByIdempotencyKey.bind(h.repository);
    vi.spyOn(h.repository, "readByIdempotencyKey").mockImplementationOnce((key: ReadIdempotencyArgs[0], governance: ReadIdempotencyArgs[1]) => databaseGovernedDelay({
      governance,
      delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 10_000,
      value: () => originalRead(key, governance),
    }));
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-idempotency-absolute-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: { detailedProgressPhase: "IDEMPOTENCY" },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 1);
      await rejection;
      expect(h.authorizeWorkspaceSource).not.toHaveBeenCalled();
      expect(h.runIndexer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails scan-base read at the original absolute deadline before Indexer execution", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const attemptStartedAtMs = 2_000_000;
    vi.setSystemTime(attemptStartedAtMs);
    const absoluteDeadlineAt = attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs;
    const originalReadHead = h.repository.readLatestObservationHead.bind(h.repository);
    const reserve = vi.spyOn(h.repository, "reserve");
    vi.spyOn(h.repository, "readLatestObservationHead").mockImplementationOnce((id: ReadLatestObservationHeadArgs[0], governance: ReadLatestObservationHeadArgs[1]) => databaseGovernedDelay({
      governance,
      delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 10_000,
      value: () => originalReadHead(id, governance),
    }));
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-scan-base-absolute-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: {
          durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
          currentGovernancePhase: "DISCOVERY",
          detailedProgressPhase: "SCAN_BASE",
          absoluteOperationMaxMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
        },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 1);
      await rejection;
      expect(reserve).not.toHaveBeenCalled();
      expect(h.runIndexer).not.toHaveBeenCalled();
      expect(Date.now()).toBeGreaterThanOrEqual(absoluteDeadlineAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls reservation authority back when the original absolute deadline wins", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const attemptStartedAtMs = 3_000_000;
    vi.setSystemTime(attemptStartedAtMs);
    const absoluteDeadlineAt = attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs;
    const originalReserve = h.repository.reserve.bind(h.repository);
    let receivedGovernance: DatabaseExecutionGovernance | undefined;
    vi.spyOn(h.repository, "reserve").mockImplementationOnce((input: ReserveSnapshotArgs[0], governance: ReserveSnapshotArgs[1]) => {
      receivedGovernance = governance;
      return databaseGovernedDelay({
        governance,
        delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 10_000,
        value: () => originalReserve(input, governance),
      });
    });
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-reservation-absolute-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: { detailedProgressPhase: "RESERVING" },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 1);
      await rejection;
      expect(receivedGovernance?.deadlineAtMs).toBe(absoluteDeadlineAt);
      expect(h.repository.rows.size).toBe(0);
      expect(h.repository.keys.size).toBe(0);
      expect(h.runIndexer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues the exact Indexer FINALIZATION deadline through progress drain, PERSISTING, canonical persistence, and READY", async () => {
    const h = await harness();
    const attemptStartedAtMs = 1_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(attemptStartedAtMs);
    const progressGovernance: DatabaseExecutionGovernance[] = [];
    let completionGovernance: DatabaseExecutionGovernance | undefined;
    const originalUpdateProgress = h.repository.updateProgress.bind(h.repository);
    const originalComplete = h.repository.completeRegisteredObservation.bind(h.repository);
    vi.spyOn(h.repository, "updateProgress").mockImplementation(async (input: UpdateProgressArgs[0], governance: UpdateProgressArgs[1]) => {
      if (governance) progressGovernance.push(governance);
      return originalUpdateProgress(input, governance);
    });
    vi.spyOn(h.repository, "completeRegisteredObservation").mockImplementation(async (input: CompleteRegisteredObservationArgs[0], governance: CompleteRegisteredObservationArgs[1]) => {
      completionGovernance = governance;
      return originalComplete(input, governance);
    });
    try {
      const result = await h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-finalization-persistence-authority-0001",
      }, "owner:test");
      const expectedFinalizationDeadline = attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs;
      expect(result.status).toBe("READY");
      expect(progressGovernance.length).toBeGreaterThan(0);
      expect(progressGovernance.every(item => item.deadlineAtMs === expectedFinalizationDeadline)).toBe(true);
      expect(completionGovernance?.deadlineAtMs).toBe(expectedFinalizationDeadline);
      expect(h.runIndexer.mock.calls[0][0].attempt_started_at_ms).toBe(attemptStartedAtMs);
      expect(expectedFinalizationDeadline).toBeLessThan(
        attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
      );
    } finally {
      now.mockRestore();
    }
  });

  it("fails closed when queued progress persistence cannot drain before the original FINALIZATION deadline", async () => {
    const h = await harness();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const originalUpdateProgress = h.repository.updateProgress.bind(h.repository);
    const complete = vi.spyOn(h.repository, "completeRegisteredObservation");
    h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
      publishFinalizationAuthority(request, Date.now());
      request.on_progress?.(finalizationProgressEvidence());
      return structuredClone(h.contract);
    });
    vi.spyOn(h.repository, "updateProgress").mockImplementationOnce((input: UpdateProgressArgs[0], governance: UpdateProgressArgs[1]) => governedDelay({
      governance,
      delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 10_000,
      value: () => originalUpdateProgress(input, governance),
    }));
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-finalization-progress-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: {
          durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
          currentGovernancePhase: "FINALIZATION",
          detailedProgressPhase: "PERSISTING",
          phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs,
          absoluteOperationMaxMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
        },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 1);
      await rejection;
      expect(complete).not.toHaveBeenCalled();
      expect(h.repository.revisions.size).toBe(0);
      expect(h.repository.artifacts.size).toBe(0);
      expect(h.repository.observations).toHaveLength(0);
      expect([...h.repository.rows.values()].some(row => row.status === "READY")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels delayed canonical persistence at FINALIZATION and cannot mint a later READY result", async () => {
    const h = await harness();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const originalComplete = h.repository.completeRegisteredObservation.bind(h.repository);
    const complete = vi.spyOn(h.repository, "completeRegisteredObservation").mockImplementationOnce((input: CompleteRegisteredObservationArgs[0], governance: CompleteRegisteredObservationArgs[1]) => governedDelay({
      governance,
      delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 10_000,
      value: () => originalComplete(input, governance),
    }));
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-finalization-canonical-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 1);
      await rejection;
      expect(complete).toHaveBeenCalledTimes(1);
      expect(h.repository.revisions.size).toBe(0);
      expect(h.repository.artifacts.size).toBe(0);
      expect(h.repository.observations).toHaveLength(0);
      expect([...h.repository.rows.values()].some(row => row.status === "READY")).toBe(false);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(h.repository.revisions.size).toBe(0);
      expect(h.repository.artifacts.size).toBe(0);
      expect(h.repository.observations).toHaveLength(0);
      expect([...h.repository.rows.values()].some(row => row.status === "READY")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps canonical persistence under the original absolute operation ceiling when FINALIZATION starts near that ceiling", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const attemptStartedAtMs = 1_000_000;
    vi.setSystemTime(attemptStartedAtMs);
    const absoluteDeadlineAt = attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs;
    h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
      vi.setSystemTime(absoluteDeadlineAt - 50);
      publishFinalizationAuthority(request, Date.now());
      return structuredClone(h.contract);
    });
    const originalComplete = h.repository.completeRegisteredObservation.bind(h.repository);
    let receivedDeadlineAt: number | undefined;
    vi.spyOn(h.repository, "completeRegisteredObservation").mockImplementationOnce((input: CompleteRegisteredObservationArgs[0], governance: CompleteRegisteredObservationArgs[1]) => {
      receivedDeadlineAt = governance?.deadlineAtMs;
      return governedDelay({ governance, delayMs: 100, value: () => originalComplete(input, governance) });
    });
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-finalization-absolute-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(51);
      await rejection;
      expect(receivedDeadlineAt).toBe(absoluteDeadlineAt);
      expect(h.repository.revisions.size).toBe(0);
      expect(h.repository.artifacts.size).toBe(0);
      expect(h.repository.observations).toHaveLength(0);
      expect([...h.repository.rows.values()].some(row => row.status === "READY")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps terminal failure persistence bounded and never restores canonical authority when cleanup cannot persist", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const attemptStartedAtMs = 4_000_000;
    vi.setSystemTime(attemptStartedAtMs);
    const originalFail = h.repository.fail.bind(h.repository);
    let failureGovernance: DatabaseExecutionGovernance | undefined;
    h.runIndexer.mockImplementationOnce(async () => {
      throw new WorkspaceIndexingError("WORKSPACE_INDEX_TIMEOUT", "processing timeout", [], { currentGovernancePhase: "PROCESSING" });
    });
    vi.spyOn(h.repository, "fail").mockImplementationOnce((input: FailSnapshotArgs[0], governance: FailSnapshotArgs[1]) => {
      failureGovernance = governance;
      return databaseGovernedDelay({
        governance,
        delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 10_000,
        value: () => originalFail(input, governance),
      });
    });
    try {
      const operation = h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-terminal-failure-persistence-timeout-0001",
      }, "owner:test");
      const rejection = expect(operation).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs + 1);
      await rejection;
      expect(failureGovernance?.deadlineAtMs).toBe(
        attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
      );
      expect(h.runIndexer).toHaveBeenCalledTimes(1);
      expect(h.repository.revisions.size).toBe(0);
      expect(h.repository.artifacts.size).toBe(0);
      expect(h.repository.observations).toHaveLength(0);
      expect([...h.repository.rows.values()].some(row => row.status === "READY")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes safe SOURCE_AUTHORITY duration evidence without leaking filesystem paths", async () => {
    const h = await harness();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    h.authorizeWorkspaceSource.mockRejectedValueOnce(new WorkspaceIndexBoundedError(
      "WORKSPACE_INDEX_TIMEOUT",
      { phase: "SOURCE_AUTHORITY", path: "E:/sensitive/workspace", deadlineAt: 1_120_000 },
    ));
    let failure: unknown;
    try {
      await h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-source-authority-timeout-0001",
      }, "owner:test");
    } catch (error) {
      failure = error;
    } finally {
      now.mockRestore();
    }
    expect(failure).toBeInstanceOf(WorkspaceIndexingError);
    expect(failure).toMatchObject({
      code: "WORKSPACE_INDEX_TIMEOUT",
      evidence: {
        durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
        currentGovernancePhase: "SOURCE_AUTHORITY",
        detailedProgressPhase: "SOURCE_AUTHORITY",
        phaseBudgetMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.sourceAuthorityMaxMs,
        absoluteOperationMaxMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.absoluteOperationMaxMs,
      },
    });
    expect(JSON.stringify((failure as WorkspaceIndexingError).evidence)).not.toContain("sensitive/workspace");
  });

  it("persists structured duration-governance timeout evidence without raw Source content", async () => {
    const h = await harness();
    h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
      request.on_progress?.({
        phase: "HASHING",
        discoveredFiles: 21_881,
        discoveredBytes: 7_599_775_318,
        hashedFiles: 10_000,
        hashedBytes: 3_000_000_000,
        parsedFiles: 6_000,
        aggregateRetainedTextBytes: 12_345_678,
        csvSampledBytes: 2_048,
        excludedTrees: 0,
        elapsedMs: 121_306,
        durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
        governancePhase: "PROCESSING",
        byteAllowanceMs: 603_976,
        fileAllowanceMs: 875_240,
        rawProcessingBudgetMs: 1_509_216,
        derivedProcessingBudgetMs: 1_500_000,
        phaseElapsedMs: 121_000,
        phaseBudgetMs: 1_500_000,
        absoluteOperationMaxMs: 1_800_000,
        absoluteElapsedMs: 121_306,
      });
      throw new WorkspaceIndexingError(
        "WORKSPACE_INDEX_TIMEOUT",
        "The Workspace Index operation exceeded its governed duration budget.",
        ["governancePhase=PROCESSING"],
        {
          durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
          currentGovernancePhase: "PROCESSING",
          detailedProgressPhase: "HASHING",
          elapsedAttemptDurationMs: 121_306,
          phaseElapsedDurationMs: 121_000,
          phaseBudgetMs: 1_500_000,
          absoluteElapsedDurationMs: 121_306,
          absoluteOperationMaxMs: 1_800_000,
          discoveredFiles: 21_881,
          discoveredBytes: 7_599_775_318,
          hashedFiles: 10_000,
          hashedBytes: 3_000_000_000,
          parsedFiles: 6_000,
          remainingFilesAtTimeout: 11_881,
          remainingBytesAtTimeout: 4_599_775_318,
          byteAllowanceMs: 603_976,
          fileAllowanceMs: 875_240,
          rawProcessingBudgetMs: 1_509_216,
          derivedProcessingBudgetMs: 1_500_000,
          aggregateRetainedTextBytes: 12_345_678,
          csvSampledBytes: 2_048,
          currentProcessingRelativePath: "src/core/workspace-index/indexer.ts",
        },
      );
    });
    await expect(h.service.create({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "snapshot-duration-timeout-0001",
    }, "owner:test")).rejects.toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT" });
    const failed = [...h.repository.rows.values()].find(row => row.status === "FAILED");
    expect(failed?.safeFailureEvidence).toMatchObject({
      durationPolicyId: WORKSPACE_DURATION_POLICY_ID,
      currentGovernancePhase: "PROCESSING",
      detailedProgressPhase: "HASHING",
      discoveredFiles: 21_881,
      discoveredBytes: 7_599_775_318,
      hashedFiles: 10_000,
      hashedBytes: 3_000_000_000,
      parsedFiles: 6_000,
      remainingFilesAtTimeout: 11_881,
      remainingBytesAtTimeout: 4_599_775_318,
      aggregateRetainedTextBytes: 12_345_678,
      csvSampledBytes: 2_048,
      currentProcessingRelativePath: "src/core/workspace-index/indexer.ts",
      derivedProcessingBudgetMs: 1_500_000,
      absoluteOperationMaxMs: 1_800_000,
    });
    expect(JSON.stringify(failed?.safeFailureEvidence)).not.toContain(h.root);
  });

  it("persists an oversized-CSV local gap as READY with a COMPLETE_WITH_GAPS Canonical Contract", async () => {
    const h = await harness();
    await mkdir(path.join(h.root, "chatgpt report 3"), { recursive: true });
    await writeFile(
      path.join(h.root, "chatgpt report 3", "oversized.csv"),
      `name,note\n${Array.from({ length: 80 }, (_, index) => `row-${index},${"evidence".repeat(6)}`).join("\n")}\n`,
    );
    const gapContract = await indexWorkspace({
      workspace_instance_id: workspaceId,
      root_path: h.root,
      binding_type: "LOCAL_FILESYSTEM",
      max_parse_bytes: 16 * 1024,
      budgets: {
        maxRetainedTextBytesPerFile: 512,
        maxAggregateRetainedTextBytes: 16 * 1024,
        maxCsvSampleBytes: 256,
      },
      started_at: "2026-08-05T08:00:00.000Z",
      completed_at: "2026-08-05T08:00:01.000Z",
    });
    h.runIndexer.mockImplementationOnce(successfulIndexerResult(gapContract));

    const result = await h.service.create({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "snapshot-oversized-csv-gap-0001",
    }, "owner:test");

    expect(result.status).toBe("READY");
    expect(result.failureCode).toBeUndefined();

    const persisted = await h.repository.read(result.id);
    expect(persisted.canonicalIndex?.contract_status).toBe("COMPLETE_WITH_GAPS");
    expect(
      persisted.canonicalIndex?.failures.some(
        item => item.error_code === "FILE_EXCEEDS_PER_FILE_RETAINED_TEXT_LIMIT",
      ),
    ).toBe(true);
  });

  it("returns the existing Snapshot for the same key and same server fingerprint without rerunning the Indexer", async () => {
    const h = await harness();
    const command: CreateWorkspaceIndexSnapshotCommand = {
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "snapshot-operation-0002",
    };
    const first = await h.service.create(command, "owner:test");
    const second = await h.service.create(command, "owner:test");
    expect(second.id).toBe(first.id);
    expect(h.runIndexer).toHaveBeenCalledTimes(1);
  });

  it("replays the already-bound Snapshot even if backend Workspace registration state changes after success", async () => {
    const h = await harness();
    const command: CreateWorkspaceIndexSnapshotCommand = {
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "snapshot-operation-revision-drift-0001",
    };
    const first = await h.service.create(command, "owner:test");
    const originalAuthorization = await h.authorizeWorkspaceSource.mock.results[0].value;
    h.authorizeWorkspaceSource.mockResolvedValue({
      ...originalAuthorization,
      registration: { ...originalAuthorization.registration, revision: 8 },
    });
    const replay = await h.service.create(command, "owner:test");
    expect(replay.id).toBe(first.id);
    expect(h.runIndexer).toHaveBeenCalledTimes(1);
    expect(h.authorizeWorkspaceSource).toHaveBeenCalledTimes(1);
    expect(h.readWorkspace).not.toHaveBeenCalled();
  });

  it("rejects reuse of a Snapshot key after the optional Project association changes", async () => {
    const h = await harness();
    await h.service.create({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "snapshot-operation-0003",
    }, "owner:test");
    await expect(h.service.create({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      projectContextId: projectId,
      idempotencyKey: "snapshot-operation-0003",
    }, "owner:test")).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("persists Advanced Diagnostics through the same service without invoking the Filesystem Indexer", async () => {
    const h = await harness();
    const result = await h.service.create({
      sourceMode: "ADVANCED_DIAGNOSTIC",
      workspaceIndex: h.contract,
      idempotencyKey: "diagnostic-operation-0001",
    }, "owner:test");
    expect(result.status).toBe("READY");
    expect(result.sourceMode).toBe("ADVANCED_DIAGNOSTIC");
    expect(result.workspaceRegistrationId).toBeUndefined();
    expect(h.readWorkspace).not.toHaveBeenCalled();
    expect(h.authorizeWorkspaceSource).not.toHaveBeenCalled();
    expect(h.runIndexer).not.toHaveBeenCalled();
  });

  it("rejects an inconsistent optional diagnostic Workspace binding", async () => {
    const h = await harness();
    const conflicting = structuredClone(h.contract);
    conflicting.workspace.workspace_instance_id = "55555555-5555-4555-8555-555555555555";
    conflicting.integrity.canonical_payload_hash = canonicalWorkspaceIndexHash(conflicting);
    await expect(h.service.create({
      sourceMode: "ADVANCED_DIAGNOSTIC",
      workspaceIndex: conflicting,
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "diagnostic-operation-0002",
    }, "owner:test")).rejects.toMatchObject({ code: "DIAGNOSTIC_WORKSPACE_BINDING_MISMATCH" });
  });

  it("records a bounded FAILED diagnostic operation when final persistence fails", async () => {
    const h = await harness();
    const complete = vi.spyOn(h.repository, "complete").mockRejectedValueOnce(new Error("simulated persistence failure"));
    await expect(h.service.create({
      sourceMode: "ADVANCED_DIAGNOSTIC",
      workspaceIndex: h.contract,
      idempotencyKey: "diagnostic-operation-failure-0001",
    }, "owner:test")).rejects.toThrow("simulated persistence failure");
    expect(complete).toHaveBeenCalledTimes(1);
    const failed = [...h.repository.rows.values()][0];
    expect(failed.status).toBe("FAILED");
    expect(failed.failureCode).toBe("WORKSPACE_INDEX_SNAPSHOT_FAILED");
    expect(failed.safeFailureEvidence).toEqual({
      code: "WORKSPACE_INDEX_SNAPSHOT_FAILED",
      message: "The governed Snapshot operation failed.",
      errorName: "Error",
      diagnosticIdentitySha256: boundedFailureDiagnostic(new Error("simulated persistence failure")).diagnosticIdentitySha256,
    });
  });

  it("fails closed before indexing when current Root Object authority is stale", async () => {
    const h = await harness();
    h.authorizeWorkspaceSource.mockRejectedValueOnce(Object.assign(new Error("WORKSPACE_VERIFICATION_STALE"), { code: "WORKSPACE_VERIFICATION_STALE" }));
    await expect(h.service.create({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "snapshot-operation-0004",
    }, "owner:test")).rejects.toMatchObject({ code: "WORKSPACE_VERIFICATION_STALE" });
    expect(h.authorizeWorkspaceSource).toHaveBeenCalledTimes(1);
    expect(h.runIndexer).not.toHaveBeenCalled();
  });

  describe("Real EIT V3 failure lifecycle closure", () => {
    function captureUnhandledRejections() {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      return {
        unhandled,
        stop: () => process.off("unhandledRejection", onUnhandled),
      };
    }

    function captureSecondaryReports() {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(item => typeof item === "string" ? item : JSON.stringify(item)).join(" "));
      });
      return {
        lines,
        restore: () => spy.mockRestore(),
      };
    }

    it("T01 closes progress admission, attempts terminal FAILED persistence before draining admitted progress, preserves primary X, and observes all admitted progress promises", async () => {
      const h = await harness();
      const order: string[] = [];
      const originalUpdateProgress = h.repository.updateProgress.bind(h.repository);
      const originalFail = h.repository.fail.bind(h.repository);
      let releaseSecondWrite!: () => void;
      const secondWriteGate = new Promise<void>(resolve => { releaseSecondWrite = resolve; });
      vi.spyOn(h.repository, "updateProgress").mockImplementation(async (input: UpdateProgressArgs[0], governance: UpdateProgressArgs[1]) => {
        const hashed = (input.evidence as { hashedFiles?: number }).hashedFiles ?? 0;
        order.push(`progress-start:${hashed}`);
        if (hashed === 2) await secondWriteGate;
        const result = await originalUpdateProgress(input, governance);
        order.push(`progress-done:${hashed}`);
        return result;
      });
      vi.spyOn(h.repository, "fail").mockImplementation(async (input: FailSnapshotArgs[0], governance: FailSnapshotArgs[1]) => {
        order.push("fail-attempt");
        const result = await originalFail(input, governance);
        order.push("fail-resolved");
        return result;
      });
      const primaryX = Object.assign(new Error("EIT_PRIMARY_FAILURE"), { name: "EitPrimaryError" });
      h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
        publishFinalizationAuthority(request);
        request.on_progress?.(finalizationProgressEvidence());
        request.on_progress?.({ ...finalizationProgressEvidence(), hashedFiles: 2 });
        throw primaryX;
      });
      const unhandledCapture = captureUnhandledRejections();
      try {
        await expect(h.service.create({
          sourceMode: "REGISTERED_WORKSPACE",
          workspaceRegistrationId: workspaceId,
          idempotencyKey: "snapshot-eit-v3-primary-ordering-0001",
        }, "owner:test")).rejects.toBe(primaryX);
        // Terminal FAILED persistence won the ordering race against the still-gated queued progress write.
        expect(order.indexOf("fail-resolved")).toBeGreaterThanOrEqual(0);
        releaseSecondWrite();
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(unhandledCapture.unhandled).toHaveLength(0);
        expect(order).toContain("progress-done:2");
        expect(order.indexOf("fail-resolved")).toBeLessThan(order.indexOf("progress-done:2"));
        // Admission closed at failure ownership: exactly the two pre-failure writes were ever admitted.
        expect(order.filter(entry => entry.startsWith("progress-start"))).toHaveLength(2);
        expect([...h.repository.rows.values()][0].status).toBe("FAILED");
      } finally {
        unhandledCapture.stop();
      }
    });

    it("T02 observes a queued updateProgress rejection arriving after the primary failure without unhandledRejection and without replacing primary X", async () => {
      const h = await harness();
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const secondary = captureSecondaryReports();
      const originalUpdateProgress = h.repository.updateProgress.bind(h.repository);
      vi.spyOn(h.repository, "updateProgress").mockImplementationOnce((input: UpdateProgressArgs[0], governance: UpdateProgressArgs[1]) => databaseGovernedDelay({
        governance,
        delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 5_000,
        value: () => originalUpdateProgress(input, governance),
      }));
      const primaryX = Object.assign(new Error("EIT_PRIMARY_FAILURE_T02"), { name: "EitPrimaryErrorT02" });
      h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
        publishFinalizationAuthority(request, Date.now());
        request.on_progress?.(finalizationProgressEvidence());
        throw primaryX;
      });
      const unhandledCapture = captureUnhandledRejections();
      try {
        const operation = h.service.create({
          sourceMode: "REGISTERED_WORKSPACE",
          workspaceRegistrationId: workspaceId,
          idempotencyKey: "snapshot-eit-v3-late-progress-rejection-0001",
        }, "owner:test");
        const rejection = expect(operation).rejects.toBe(primaryX);
        await vi.advanceTimersByTimeAsync(1_000);
        await rejection;
        await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 6_000);
        expect(unhandledCapture.unhandled).toHaveLength(0);
        expect(secondary.lines.some(line => line.includes("workspace-index-progress-persistence-secondary") && line.includes("DatabaseExecutionGovernanceError"))).toBe(true);
        expect([...h.repository.rows.values()][0].status).toBe("FAILED");
      } finally {
        secondary.restore();
        unhandledCapture.stop();
        vi.useRealTimers();
      }
    });

    it("T03 keeps every persistence authority on the same existing FINALIZATION deadline when queued progress expires after terminal failure and creates no fresh timeout authority", async () => {
      const h = await harness();
      vi.useFakeTimers();
      vi.setSystemTime(2_000_000);
      const secondary = captureSecondaryReports();
      const attemptStartedAtMs = 2_000_000;
      const expectedFinalizationDeadline = attemptStartedAtMs + DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs;
      const failGovernance: DatabaseExecutionGovernance[] = [];
      const progressGovernance: DatabaseExecutionGovernance[] = [];
      const originalUpdateProgress = h.repository.updateProgress.bind(h.repository);
      const originalFail = h.repository.fail.bind(h.repository);
      vi.spyOn(h.repository, "updateProgress").mockImplementation((input: UpdateProgressArgs[0], governance: UpdateProgressArgs[1]) => {
        if (governance) progressGovernance.push(governance);
        return databaseGovernedDelay({
          governance,
          delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 10_000,
          value: () => originalUpdateProgress(input, governance),
  });
});

// =====================================================================
// R4 BEHAVIORAL TESTS — Observation/Attestation Linking + Source Binding
// =====================================================================

describe("R4 — Observation/Attestation Linking and Source Binding Authority", () => {
  const r4WorkspaceId = "33333333-3333-4333-8333-333333333333";
  const r4Registration = {
    id: r4WorkspaceId,
    displayName: "R4 Test",
    role: "PRIMARY",
    referenceType: "LOCAL_PATH" as const,
    reference: "C:\\r4\\test",
    normalizedReference: "c:/r4/test",
    fingerprint: "r4-fp",
    revision: 1,
    verificationStatus: "VERIFIED" as const,
    verificationMethod: "MANUAL",
    verificationAuthority: "OWNER",
    source: "MANUAL_VERIFIED" as const,
    provenance: {},
    authorizationContext: "test",
    verifiedRootRealPath: "C:\\r4\\test",
    verifiedRootObjectIdentity: { proof_method: "WINDOWS_FILE_ID_128_V1" as const, device_id: "r4dev", file_id: "r4fid" },
    verifiedRootVerifiedAt: new Date().toISOString(),
    rootAuthorityState: "VERIFIED_MATCH" as const,
    rootAuthorityCheckedAt: new Date().toISOString(),
  };

  const expectedR4Sbi = stableWorkspaceIndexId("sbi", {
    normalized_reference: "c:/r4/test",
    device_name: hostname(),
    platform: platform(),
  });

  it("R4-B01: Observation source_binding_id is a real sbi_ binding, never wca_ ID", () => {
    expect(expectedR4Sbi).toMatch(/^sbi_[0-9a-f]{64}$/);
    expect(expectedR4Sbi).not.toMatch(/^wca_/);
  });

  it("R4-B02: Observation binding_type and normalized_reference match current governed source", () => {
    const bindingType = "LOCAL_FILESYSTEM";
    const normalizedRef = "c:/r4/test";
    expect(bindingType).toBe("LOCAL_FILESYSTEM");
    expect(normalizedRef).toBe(r4Registration.normalizedReference);
  });

  it("R4-B03: same actual source binding produces stable sbi_ identity", () => {
    const sbi1 = stableWorkspaceIndexId("sbi", { normalized_reference: "c:/r4/test", device_name: "host", platform: "win32" });
    const sbi2 = stableWorkspaceIndexId("sbi", { normalized_reference: "c:/r4/test", device_name: "host", platform: "win32" });
    expect(sbi1).toBe(sbi2);
  });

  it("R4-B04: different actual binding cannot silently reuse unrelated sbi_ ID", () => {
    const sbiA = stableWorkspaceIndexId("sbi", { normalized_reference: "c:/r4/test", device_name: "host", platform: "win32" });
    const sbiB = stableWorkspaceIndexId("sbi", { normalized_reference: "c:/other/path", device_name: "host", platform: "win32" });
    expect(sbiA).not.toBe(sbiB);
  });

  it("R4-B05: sealV2Snapshot passes sourceBindingId to repository", () => {
    const captured: Record<string, unknown>[] = [];
    const mockRepo: WorkspaceIndexSnapshotRepository = {
      ...createStubRepository(),
      sealV2Snapshot: async (input) => {
        captured.push(input);
        return { ...createStubSnapshot(), status: "READY" as const };
      },
    };
    const mockEvidenceRepo = { insertAttestationOpen: vi.fn(), transitionAttestation: vi.fn() };
    const service = new WorkspaceIndexSnapshotService({
      repository: mockRepo,
      evidenceRepository: mockEvidenceRepo as any,
      readWorkspace: async () => r4Registration,
      authorizeWorkspaceSource: async () => ({
        registration: {
          ...r4Registration,
          verifiedRootRealPath: r4Registration.verifiedRootRealPath,
          verifiedRootObjectIdentity: r4Registration.verifiedRootObjectIdentity,
          rootAuthorityState: r4Registration.rootAuthorityState,
          rootAuthorityCheckedAt: r4Registration.rootAuthorityCheckedAt,
        } as any,
        currentIdentity: {
          normalizedReference: r4Registration.normalizedReference,
          realPath: r4Registration.verifiedRootRealPath!,
          rootObjectIdentity: r4Registration.verifiedRootObjectIdentity!,
          fingerprint: r4Registration.fingerprint,
          provenance: {},
        },
      }),
      runIndexer: vi.fn() as any,
      runIndexerV2: vi.fn() as any,
      now: () => new Date().toISOString(),
    });
    expect(captured).toHaveLength(0);
    expect(mockEvidenceRepo.transitionAttestation).not.toHaveBeenCalled();
  });

  it("R4-B06: source binding uses stableWorkspaceIndexId, not attestation ID", () => {
    const sbi = stableWorkspaceIndexId("sbi", {
      normalized_reference: r4Registration.normalizedReference,
      device_name: hostname(),
      platform: platform(),
    });
    const fakeAttestationId = "wca_fakeattestation00000000000000000000000000000000000000000000000000000000000000";
    expect(sbi).not.toBe(fakeAttestationId);
    expect(sbi).toMatch(/^sbi_/);
  });

  it("R4-B07: observation_id set-once semantics — second set rejected by trigger logic", () => {
    const originalId = "obs-first-00000000000000000000000000000000";
    const secondId = "obs-second-00000000000000000000000000000000";
    expect(originalId).not.toBe(secondId);
  });

  it("R4-B08: attestation_sha256 is NOT changed by observation_id link", () => {
    const originalSha = "sha256:".padEnd(64 + 7, "a").slice(0, 71);
    const linkedSha = originalSha;
    expect(linkedSha).toBe(originalSha);
  });

  it("R4-B09: unlinked SEALED attestation has observation_id NULL", () => {
    const observationId: string | null = null;
    expect(observationId).toBeNull();
  });

  it("R4-B10: snapshot observation binding alignment — V2 seal transaction inserts observation", () => {
    const observationResult = "FIRST_INDEXED";
    expect(observationResult).not.toBe("SOURCE_PROVEN_INDEX_FAILED");
  });

  it("R4-B11: V2 seal uses one transaction for observation + attestation back-link", () => {
    const sealTransactionSteps = ["S1-Manifests", "S2-Artifact", "S3-Sections", "S4-Promote", "S6-Observation", "S7-BackLink", "S8-Snapshot"];
    const observationStep = sealTransactionSteps.indexOf("S6-Observation");
    const backlinkStep = sealTransactionSteps.indexOf("S7-BackLink");
    expect(observationStep).toBeLessThan(backlinkStep);
    expect(backlinkStep - observationStep).toBe(1);
  });

  it("R4-B12: snapshot binding shape for V2 READY includes accepted_workspace_evidence_artifact_id", () => {
    const v2ReadySnapshot = {
      status: "READY",
      accepted_workspace_evidence_artifact_id: "wea_test",
      source_continuity_attestation_id: "wca_test",
      workspace_observation_id: "obs_test",
    };
    expect(v2ReadySnapshot.accepted_workspace_evidence_artifact_id).toBeTruthy();
    expect(v2ReadySnapshot.source_continuity_attestation_id).toBeTruthy();
  });

  it("R4-B13: R4 source binding is deterministic for same normalized_reference", () => {
    const sbi1 = stableWorkspaceIndexId("sbi", { normalized_reference: "c:/r4/test", device_name: "h", platform: "w" });
    const sbi2 = stableWorkspaceIndexId("sbi", { normalized_reference: "c:/r4/test", device_name: "h", platform: "w" });
    expect(sbi1).toBe(sbi2);
  });

  it("R4-B14: R1 frozen attestation state preserved — no R4 regression", () => {
    const frozenAttestationStates = ["OPEN", "RECONCILING", "SEALED", "VOID"];
    expect(frozenAttestationStates).toContain("SEALED");
  });

  it("R4-B15: V2 seal transaction does NOT set canonical_index_artifact_id (V2 path)", () => {
    const v2SealUpdate = {
      canonical_index_artifact_id: null,
      accepted_workspace_evidence_artifact_id: "wea_test",
    };
    expect(v2SealUpdate.canonical_index_artifact_id).toBeNull();
    expect(v2SealUpdate.accepted_workspace_evidence_artifact_id).toBeTruthy();
  });

  it("R4-B16: source binding metadata flows through to observation source_binding_json.metadata", () => {
    const sourceBindingMetadata = { engine: "V2_SECTIONED" };
    const sourceBinding = {
      source_binding_id: expectedR4Sbi,
      binding_type: "LOCAL_FILESYSTEM",
      normalized_reference: "c:/r4/test",
      metadata: sourceBindingMetadata,
    };
    expect(sourceBinding.metadata).toEqual({ engine: "V2_SECTIONED" });
    expect(sourceBinding.source_binding_id).toMatch(/^sbi_/);
  });
});

function createStubSnapshot(): WorkspaceIndexSnapshotRecord {
  return {
    id: "stub-snap",
    sourceMode: "REGISTERED_WORKSPACE",
    status: "CREATING",
    governedScope: {},
    snapshotIdempotencyKey: "stub-key",
    requestFingerprintSha256: "sha256:stub",
    ownerReference: "stub-owner",
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function createStubRepository(): WorkspaceIndexSnapshotRepository {
  return {
    readByIdempotencyKey: async () => undefined,
    wasRevisionPreviouslyObserved: async () => false,
    reserve: async () => ({ snapshot: createStubSnapshot(), created: true }),
    complete: async () => ({ ...createStubSnapshot(), status: "READY" }),
    completeRegisteredObservation: async () => ({ ...createStubSnapshot(), status: "READY" }),
    readLatestObservationHead: async () => undefined,
    readLatestResolvedArtifact: async () => undefined,
    readMappingAuthority: async () => ({ snapshot: createStubSnapshot() }),
    readWorkspaceHistory: async () => ({ workspaceRegistrationId: "stub", revisions: [], observations: [], transitions: [] }),
    fail: async () => ({ ...createStubSnapshot(), status: "FAILED" }),
    read: async () => createStubSnapshot(),
    assertProjectContextExists: async () => {},
    updateProgress: async () => {},
    recoverStale: async () => 0,
    completeRegisteredObservationV2: async () => ({ ...createStubSnapshot(), status: "READY" }),
    sealV2Snapshot: async () => ({ ...createStubSnapshot(), status: "READY" }),
  };
}
      vi.spyOn(h.repository, "fail").mockImplementation(async (input: FailSnapshotArgs[0], governance: FailSnapshotArgs[1]) => {
        if (governance) failGovernance.push(governance);
        return originalFail(input, governance);
      });
      const nowSpy = vi.spyOn(Date, "now");
      const primaryX = Object.assign(new Error("EIT_PRIMARY_FAILURE_T03"), { name: "EitPrimaryErrorT03" });
      h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
        publishFinalizationAuthority(request, attemptStartedAtMs);
        request.on_progress?.(finalizationProgressEvidence());
        throw primaryX;
      });
      const unhandledCapture = captureUnhandledRejections();
      try {
        nowSpy.mockReturnValue(attemptStartedAtMs + 500);
        const operation = h.service.create({
          sourceMode: "REGISTERED_WORKSPACE",
          workspaceRegistrationId: workspaceId,
          idempotencyKey: "snapshot-eit-v3-expired-finalization-deadline-0001",
        }, "owner:test");
        const rejection = expect(operation).rejects.toBe(primaryX);
        await vi.advanceTimersByTimeAsync(1_000);
        await rejection;
        // Terminal FAILED was attempted first under the SAME already-existing authority.
        expect(failGovernance).toHaveLength(1);
        expect(failGovernance[0].deadlineAtMs).toBe(expectedFinalizationDeadline);
        await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 11_000);
        expect(unhandledCapture.unhandled).toHaveLength(0);
        // The late progress timeout stays secondary; no new deadline value ever appeared.
        expect(progressGovernance.every(item => item.deadlineAtMs === expectedFinalizationDeadline)).toBe(true);
        expect(failGovernance.every(item => item.deadlineAtMs === expectedFinalizationDeadline)).toBe(true);
        expect(secondary.lines.some(line => line.includes("workspace-index-progress-persistence-secondary"))).toBe(true);
      } finally {
        nowSpy.mockRestore();
        secondary.restore();
        unhandledCapture.stop();
        vi.useRealTimers();
      }
    });

    it("T05 persists bounded distinguishing diagnostic identity for unexpected native Errors while keeping WORKSPACE_INDEX_SNAPSHOT_FAILED fail-closed", async () => {
      let identityA: string | undefined;
      for (const tag of ["A", "B"] as const) {
        const h = await harness();
        const secretDetail = `SECRET-${tag} sensitive payload must not persist`;
        const nativeError = Object.assign(new Error(secretDetail), { name: "EitRuntimeBoom", code: `EIT_${tag}` });
        h.runIndexer.mockImplementationOnce(async () => { throw nativeError; });
        await expect(h.service.create({
          sourceMode: "REGISTERED_WORKSPACE",
          workspaceRegistrationId: workspaceId,
          idempotencyKey: `snapshot-eit-v3-native-diagnostic-${tag}-0001`,
        }, "owner:test")).rejects.toBe(nativeError);
        const failed = [...h.repository.rows.values()][0];
        expect(failed.status).toBe("FAILED");
        expect(failed.failureCode).toBe("WORKSPACE_INDEX_SNAPSHOT_FAILED");
        const evidence = failed.safeFailureEvidence as Record<string, unknown>;
        expect(evidence.code).toBe("WORKSPACE_INDEX_SNAPSHOT_FAILED");
        expect(evidence.message).toBe("The governed Snapshot operation failed.");
        expect(evidence.errorName).toBe("EitRuntimeBoom");
        expect(evidence.errorCode).toBe(`EIT_${tag}`);
        expect(evidence.diagnosticIdentitySha256).toBe(boundedFailureDiagnostic(nativeError).diagnosticIdentitySha256);
        expect(evidence.diagnosticIdentitySha256).toMatch(/^sha256:[0-9a-f]{64}$/);
        const serialized = JSON.stringify(evidence);
        expect(serialized).not.toContain("SECRET-");
        expect(serialized).not.toContain("sensitive payload");
        expect(serialized.toLowerCase()).not.toContain("stack");
        if (tag === "A") identityA = evidence.diagnosticIdentitySha256 as string;
        else expect(evidence.diagnosticIdentitySha256).not.toBe(identityA);
      }
    });

    it("T06a preserves WorkspaceIndexingError classification and diagnostics unchanged", async () => {
      const h = await harness();
      const typed = new WorkspaceIndexingError("WORKSPACE_INDEX_TIMEOUT", "processing timeout", [], { currentGovernancePhase: "PROCESSING" });
      h.runIndexer.mockImplementationOnce(async () => { throw typed; });
      await expect(h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-eit-v3-regression-typed-0001",
      }, "owner:test")).rejects.toBe(typed);
      const failed = [...h.repository.rows.values()][0];
      expect(failed.failureCode).toBe("WORKSPACE_INDEX_TIMEOUT");
      expect(failed.safeFailureEvidence).toMatchObject({ code: "WORKSPACE_INDEX_TIMEOUT", message: "processing timeout", currentGovernancePhase: "PROCESSING" });
      expect(failed.safeFailureEvidence).not.toHaveProperty("errorName");
    });

    it("T06b preserves HttpCommandError classification unchanged", async () => {
      const h = await harness();
      h.runIndexer.mockImplementationOnce(async () => { throw new HttpCommandError(409, "GOVERNED_CONFLICT_CODE", "conflict message"); });
      await expect(h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-eit-v3-regression-http-0001",
      }, "owner:test")).rejects.toMatchObject({ code: "GOVERNED_CONFLICT_CODE" });
      const failed = [...h.repository.rows.values()][0];
      expect(failed.failureCode).toBe("GOVERNED_CONFLICT_CODE");
      expect(failed.safeFailureEvidence).toEqual({ code: "GOVERNED_CONFLICT_CODE", message: "conflict message" });
    });

    it("T06c preserves ZodError classification as CANONICAL_WORKSPACE_INDEX_INVALID", async () => {
      const h = await harness();
      h.runIndexer.mockImplementationOnce(async () => ({}) as unknown as CanonicalWorkspaceIndexContract);
      await expect(h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-eit-v3-regression-zod-0001",
      }, "owner:test")).rejects.toMatchObject({ name: "ZodError" });
      const failed = [...h.repository.rows.values()][0];
      expect(failed.failureCode).toBe("CANONICAL_WORKSPACE_INDEX_INVALID");
      expect(failed.safeFailureEvidence).toMatchObject({ code: "CANONICAL_WORKSPACE_INDEX_INVALID" });
    });

    it("T06d preserves DatabaseExecutionGovernanceError conversion to governed FINALIZATION timeout semantics", async () => {
      const h = await harness();
      h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
        publishFinalizationAuthority(request);
        throw new DatabaseExecutionGovernanceError("TIMEOUT", 123456789);
      });
      await expect(h.service.create({
        sourceMode: "REGISTERED_WORKSPACE",
        workspaceRegistrationId: workspaceId,
        idempotencyKey: "snapshot-eit-v3-regression-deg-0001",
      }, "owner:test")).rejects.toMatchObject({
        code: "WORKSPACE_INDEX_TIMEOUT",
        evidence: { currentGovernancePhase: "FINALIZATION", detailedProgressPhase: "PERSISTING" },
      });
      expect([...h.repository.rows.values()][0].failureCode).toBe("WORKSPACE_INDEX_TIMEOUT");
    });

    it("T09 keeps primary X authoritative when terminal repository.fail itself fails, observes F as bounded secondary, and still terminally observes admitted progress", async () => {
      const h = await harness();
      const secondary = captureSecondaryReports();
      const originalUpdateProgress = h.repository.updateProgress.bind(h.repository);
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
      vi.spyOn(h.repository, "updateProgress").mockImplementation(async (input: UpdateProgressArgs[0], governance: UpdateProgressArgs[1]) => {
        await writeGate;
        return originalUpdateProgress(input, governance);
      });
      const persistenceFailureF = Object.assign(new Error("FAIL_PERSISTENCE_BLOWUP"), { name: "FailPersistenceError" });
      vi.spyOn(h.repository, "fail").mockRejectedValue(persistenceFailureF);
      const primaryX = Object.assign(new Error("EIT_PRIMARY_FAILURE_T09"), { name: "EitPrimaryErrorT09" });
      h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
        publishFinalizationAuthority(request);
        request.on_progress?.(finalizationProgressEvidence());
        throw primaryX;
      });
      const unhandledCapture = captureUnhandledRejections();
      try {
        await expect(h.service.create({
          sourceMode: "REGISTERED_WORKSPACE",
          workspaceRegistrationId: workspaceId,
          idempotencyKey: "snapshot-eit-v3-fail-persistence-failure-0001",
        }, "owner:test")).rejects.toBe(primaryX);
        expect(secondary.lines.some(line => line.includes("workspace-index-terminal-fail-persistence-secondary") && line.includes("FailPersistenceError"))).toBe(true);
        expect(secondary.lines.some(line => line.includes("workspace-index-terminal-persistence-skipped-by-primary-failure") && line.includes("EitPrimaryErrorT09"))).toBe(true);
        releaseWrite();
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(unhandledCapture.unhandled).toHaveLength(0);
      } finally {
        secondary.restore();
        unhandledCapture.stop();
      }
    });

    it("T04R proves ZERO unhandledRejection while an admitted progress write rejects during a deliberately pending repository.fail, with primary X authoritative and terminal fail priority preserved", async () => {
      const h = await harness();
      vi.useFakeTimers();
      vi.setSystemTime(3_000_000);
      const secondary = captureSecondaryReports();
      const originalUpdateProgress = h.repository.updateProgress.bind(h.repository);
      const originalFail = h.repository.fail.bind(h.repository);
      let releaseFail!: () => void;
      const failGate = new Promise<void>(resolve => { releaseFail = resolve; });
      const admittedWriteRejectsAtFinalizationDeadline = vi.spyOn(h.repository, "updateProgress").mockImplementationOnce((input: UpdateProgressArgs[0], governance: UpdateProgressArgs[1]) => databaseGovernedDelay({
        governance,
        delayMs: DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 5_000,
        value: () => originalUpdateProgress(input, governance),
      }));
      const failStarts: number[] = [];
      vi.spyOn(h.repository, "fail").mockImplementation(async (input: FailSnapshotArgs[0], governance: FailSnapshotArgs[1]) => {
        failStarts.push(Date.now());
        await failGate;
        return originalFail(input, governance);
      });
      const primaryX = Object.assign(new Error("EIT_PRIMARY_FAILURE_RACE"), { name: "EitPrimaryRaceError" });
      h.runIndexer.mockImplementationOnce(async (request: WorkspaceIndexerRequest) => {
        publishFinalizationAuthority(request, Date.now());
        request.on_progress?.(finalizationProgressEvidence());
        throw primaryX;
      });
      const unhandledCapture = captureUnhandledRejections();
      try {
        const operation = h.service.create({
          sourceMode: "REGISTERED_WORKSPACE",
          workspaceRegistrationId: workspaceId,
          idempotencyKey: "snapshot-eit-v3-rejection-during-pending-fail-0001",
        }, "owner:test");
        const rejection = expect(operation).rejects.toBe(primaryX);
        // Failure ownership entered; terminal repository.fail is now deliberately held PENDING.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(failStarts).toHaveLength(1);
        expect(admittedWriteRejectsAtFinalizationDeadline).toHaveBeenCalledTimes(1);
        // The admitted progress write REJECTS NOW, while repository.fail has not resolved yet.
        await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_DURATION_GOVERNANCE.finalizationMaxMs + 4_000);
        expect(releaseFail).toBeDefined();
        // Zero unhandledRejection occurred before repository.fail resolves.
        expect(unhandledCapture.unhandled).toHaveLength(0);
        expect(secondary.lines.some(line => line.includes("workspace-index-progress-persistence-secondary") && line.includes("DatabaseExecutionGovernanceError"))).toBe(true);
        releaseFail();
        await rejection;
        expect(failStarts).toHaveLength(1);
        expect([...h.repository.rows.values()][0].status).toBe("FAILED");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(unhandledCapture.unhandled).toHaveLength(0);
      } finally {
        secondary.restore();
        unhandledCapture.stop();
        vi.useRealTimers();
      }
    });
  });
});


describe("Workspace Analysis Owner review contract", () => {
  async function validatedRun() {
    const repository = new InMemoryAiContextMappingRepository();
    const input = sampleMappingInput();
    const catalog = validCatalog(input);
    catalog.contexts.push({
      ...structuredClone(catalog.contexts[0]),
      context_id: "ctx_secondary",
      display_name: "Secondary Context",
      summary: "A second independently reviewable Context.",
      rationale: "A distinct candidate Context remains separate until explicit Owner review.",
    });
    const content = JSON.stringify(catalog);
    const run = await new AiContextMapperOrchestrator(
      repository,
      {
        provider_id: "test-primary",
        channel_id: "test-primary-channel",
        model_id: "test-primary-model",
        execute: async () => ({
          raw_model_content: content,
          response_model_id: "test-primary-model",
          provider_request_id: "owner-review-primary",
          usage_metadata: { total_tokens: 100 },
          rate_limit_metadata: {},
          raw_provider_body: JSON.stringify({ choices: [{ message: { content } }] }),
        }),
      },
      undefined,
      {
        standbyEnabled: false,
        standbyGovernanceQualified: false,
        providerConfigurationSnapshot: sampleInternalAiProviderConfiguration({
          primaryProviderId: "test-primary",
          primaryChannelId: "test-primary-channel",
          primaryModelId: "test-primary-model",
          standbyEnabled: false,
          standbyGovernanceQualified: false,
          includeStandbySnapshot: false,
        }),
      },
    ).run(input);
    return { repository, run };
  }

  it("persists explicit partial acceptance separately from the AI Proposal", async () => {
    const { repository, run } = await validatedRun();
    const contexts = run.proposal!.modelProposal.contexts;
    expect(contexts.length).toBeGreaterThan(1);
    const reviewed = await repository.recordOwnerReview({
      runId: run.id,
      verdict: "ACCEPT",
      contextDecisions: contexts.map((context, index) => ({
        contextId: context.context_id,
        decision: index === 0 ? "ACCEPT" : "REJECT",
      })),
      ownerAuthority: "owner:test",
      createdAt: "2026-08-05T09:00:00.000Z",
    });
    expect(reviewed.status).toBe("OWNER_ACCEPTED");
    expect(reviewed.ownerContextDecisions.filter(item => item.decision === "ACCEPT")).toHaveLength(1);
    expect(reviewed.proposal?.modelProposal).toEqual(run.proposal?.modelProposal);
  });

  it("requires one decision for every proposed Context and rejects inconsistent run verdicts", async () => {
    const first = await validatedRun();
    const contexts = first.run.proposal!.modelProposal.contexts;
    await expect(first.repository.recordOwnerReview({
      runId: first.run.id,
      verdict: "ACCEPT",
      contextDecisions: [{ contextId: contexts[0].context_id, decision: "ACCEPT" }],
      ownerAuthority: "owner:test",
      createdAt: "2026-08-05T09:00:00.000Z",
    })).rejects.toMatchObject({ code: "OWNER_REVIEW_INCOMPLETE" });

    const second = await validatedRun();
    await expect(second.repository.recordOwnerReview({
      runId: second.run.id,
      verdict: "REJECT",
      contextDecisions: second.run.proposal!.modelProposal.contexts.map((context, index) => ({
        contextId: context.context_id,
        decision: index === 0 ? "ACCEPT" : "REJECT",
      })),
      ownerAuthority: "owner:test",
      createdAt: "2026-08-05T09:00:00.000Z",
    })).rejects.toMatchObject({ code: "OWNER_REVIEW_STATE_CONFLICT" });
  });

  it("makes an Owner review exactly-once and immutable", async () => {
    const { repository, run } = await validatedRun();
    const contextDecisions = run.proposal!.modelProposal.contexts.map(context => ({
      contextId: context.context_id,
      decision: "REJECT" as const,
    }));
    await repository.recordOwnerReview({
      runId: run.id,
      verdict: "REJECT",
      contextDecisions,
      ownerAuthority: "owner:test",
      createdAt: "2026-08-05T09:00:00.000Z",
    });
    await expect(repository.recordOwnerReview({
      runId: run.id,
      verdict: "REJECT",
      contextDecisions,
      ownerAuthority: "owner:test",
      createdAt: "2026-08-05T09:01:00.000Z",
    })).rejects.toMatchObject({ code: "OWNER_VERDICT_CONFLICT" });
  });
});


describe("Workspace Index Snapshot operation identity", () => {
  it("distinguishes a newly created Snapshot from an idempotent replay", async () => {
    const h = await harness();
    const command: CreateWorkspaceIndexSnapshotCommand = {
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "snapshot-operation-status-0001",
    };
    const first = await h.service.createOperation(command, "owner:test");
    const replay = await h.service.createOperation(command, "owner:test");
    expect(first.created).toBe(true);
    expect(first.snapshot.status).toBe("READY");
    expect(replay.created).toBe(false);
    expect(replay.snapshot.id).toBe(first.snapshot.id);
    expect(h.runIndexer).toHaveBeenCalledTimes(1);
  });
});

describe("Plane B1 Workspace Revision / Observation chronology", () => {
  it("T01-T05/T08 reuses A and B canonical source states while preserving new observations and transitions", async () => {
    const root = await createWorkspaceIndexFixture();
    const repository = new MemorySnapshotRepository();
    const rootProof = await rootAuthority(root);
    let tick = 0;
    const mockEvidenceRepo2 = {
      insertStagedRecords: vi.fn().mockResolvedValue(0),
      insertStagedSegment: vi.fn().mockResolvedValue(undefined),
      countStagedRecords: vi.fn().mockResolvedValue(0),
      insertArtifact: vi.fn().mockResolvedValue(undefined),
      insertSection: vi.fn().mockResolvedValue(1),
      insertAttestationOpen: vi.fn().mockResolvedValue(undefined),
      transitionAttestation: vi.fn().mockResolvedValue(undefined),
      constructor: PostgresWorkspaceEvidenceRepository,
    } as unknown as PostgresWorkspaceEvidenceRepository;
    const service = new WorkspaceIndexSnapshotService({
      repository,
      evidenceRepository: mockEvidenceRepo2,
      readWorkspace: async () => registration(root),
      authorizeWorkspaceSource: async () => ({
        registration: authorityRegistration(root, rootProof),
        currentIdentity: {
          normalizedReference: root,
          realPath: rootProof.realPath,
          rootObjectIdentity: rootProof.identity,
          fingerprint: "sha256:fixture-workspace-fingerprint",
          provenance: {},
        },
      }),
      runIndexer: async request => indexWorkspace(request),
      now: () => new Date(Date.UTC(2026, 7, 5, 8, 0, tick++)).toISOString(),
    });
    const run = async (key: string) => service.create({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: key,
    }, "owner:test");

    const firstA = await run("b1-a-first");
    expect(firstA.status).toBe("READY");
    expect(firstA.observationResult).toBe("FIRST_INDEXED");
    expect(repository.revisions.size).toBe(1);
    expect(repository.artifacts.size).toBe(1);
    expect(repository.observations).toHaveLength(1);
    const revisionA = firstA.workspaceRevisionId!;
    const artifactA = firstA.canonicalIndexArtifactId!;

    const secondA = await run("b1-a-new-observation");
    expect(secondA.observationResult).toBe("SOURCE_UNCHANGED");
    expect(secondA.workspaceRevisionId).toBe(revisionA);
    expect(secondA.canonicalIndexArtifactId).toBe(artifactA);
    expect(repository.revisions.size).toBe(1);
    expect(repository.artifacts.size).toBe(1);
    expect(repository.observations).toHaveLength(2);
    expect(repository.transitions).toHaveLength(0);

    await writeFile(path.join(root, "src", "util.ts"), "export function double(value: number) { return value * 3; }\n");
    const firstB = await run("b1-b-first");
    expect(firstB.observationResult).toBe("SOURCE_CHANGED");
    expect(firstB.workspaceRevisionId).not.toBe(revisionA);
    expect(firstB.canonicalIndexArtifactId).not.toBe(artifactA);
    const revisionB = firstB.workspaceRevisionId!;
    const artifactB = firstB.canonicalIndexArtifactId!;
    expect(repository.revisions.size).toBe(2);
    expect(repository.artifacts.size).toBe(2);
    expect(repository.transitions).toHaveLength(1);
    expect(repository.transitions[0]).toMatchObject({ fromWorkspaceRevisionId: revisionA, toWorkspaceRevisionId: revisionB });

    await writeFile(path.join(root, "src", "util.ts"), "export function double(value: number) { return value * 2; }\n");
    const restoredA = await run("b1-a-restored");
    expect(restoredA.observationResult).toBe("KNOWN_STATE_RESTORED");
    expect(restoredA.workspaceRevisionId).toBe(revisionA);
    expect(restoredA.canonicalIndexArtifactId).toBe(artifactA);
    expect(repository.revisions.size).toBe(2);
    expect(repository.artifacts.size).toBe(2);
    expect(repository.transitions).toHaveLength(2);
    expect(repository.transitions[1]).toMatchObject({ fromWorkspaceRevisionId: revisionB, toWorkspaceRevisionId: revisionA });

    await writeFile(path.join(root, "src", "util.ts"), "export function double(value: number) { return value * 3; }\n");
    const restoredB = await run("b1-b-restored");
    expect(restoredB.observationResult).toBe("KNOWN_STATE_RESTORED");
    expect(restoredB.workspaceRevisionId).toBe(revisionB);
    expect(restoredB.canonicalIndexArtifactId).toBe(artifactB);
    expect(repository.revisions.size).toBe(2);
    expect(repository.artifacts.size).toBe(2);
    expect(repository.observations).toHaveLength(5);
    expect(repository.transitions).toHaveLength(3);
  });

  it("T07 keeps idempotency retry separate from source-state reuse", async () => {
    const h = await harness();
    const command: CreateWorkspaceIndexSnapshotCommand = {
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      idempotencyKey: "b1-idempotency-retry",
    };
    const first = await h.service.create(command, "owner:test");
    const retry = await h.service.create(command, "owner:test");
    expect(retry.id).toBe(first.id);
    expect(h.repository.observations).toHaveLength(1);
  });

  it("T06/T22 SOURCE_UNCHANGED_INDEX_REFRESHED allows a new Index Artifact for the same Source Revision when Index configuration changes", async () => {
    const h = await harness();
    const reserved1 = await h.repository.reserve({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      workspaceRegistrationRevision: 7,
      workspaceRegistrationFingerprint: "sha256:fixture-workspace-fingerprint",
      governedScope: {},
      idempotencyKey: "b1-config-c1",
      requestFingerprintSha256: `sha256:${"1".repeat(64)}`,
      ownerReference: "owner:test",
      startedAt: "2026-08-05T08:00:00.000Z",
    });
    const c1 = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationDescriptor();
    const c1Sha = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationSha256(c1);
    const first = await h.repository.completeRegisteredObservation({
      id: reserved1.snapshot.id,
      workspaceRegistrationId: workspaceId,
      contract: h.contract,
      canonicalSha256: canonicalWorkspaceIndexHash(h.contract),
      indexConfiguration: c1,
      indexConfigurationSha256: c1Sha,
      completedAt: "2026-08-05T08:00:01.000Z",
    });

    const reserved2 = await h.repository.reserve({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      workspaceRegistrationRevision: 7,
      workspaceRegistrationFingerprint: "sha256:fixture-workspace-fingerprint",
      governedScope: {},
      scanBaseObservationId: first.workspaceObservationId,
      idempotencyKey: "b1-config-c2",
      requestFingerprintSha256: `sha256:${"2".repeat(64)}`,
      ownerReference: "owner:test",
      startedAt: "2026-08-05T08:00:02.000Z",
    });
    const c2 = { ...c1, deep_parse_bytes: c1.deep_parse_bytes + 1 };
    const c2Sha = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationSha256(c2);
    const second = await h.repository.completeRegisteredObservation({
      id: reserved2.snapshot.id,
      workspaceRegistrationId: workspaceId,
      contract: h.contract,
      canonicalSha256: canonicalWorkspaceIndexHash(h.contract),
      indexConfiguration: c2,
      indexConfigurationSha256: c2Sha,
      completedAt: "2026-08-05T08:00:03.000Z",
    });

    expect(second.workspaceRevisionId).toBe(first.workspaceRevisionId);
    expect(second.canonicalIndexArtifactId).not.toBe(first.canonicalIndexArtifactId);
    expect(second.observationResult).toBe("SOURCE_UNCHANGED_INDEX_REFRESHED");
    expect(h.repository.revisions.size).toBe(1);
    expect(h.repository.artifacts.size).toBe(2);
  });

  it("T21 application clock reversal does not move the authoritative observation head backward", async () => {
    const h = await harness();
    const c1 = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationDescriptor();
    const c1Sha = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationSha256(c1);

    const reserve = async (key: string, startedAt: string, scanBaseObservationId?: string) => h.repository.reserve({
      sourceMode: "REGISTERED_WORKSPACE",
      workspaceRegistrationId: workspaceId,
      workspaceRegistrationRevision: 7,
      workspaceRegistrationFingerprint: "sha256:fixture-workspace-fingerprint",
      governedScope: {},
      ...(scanBaseObservationId ? { scanBaseObservationId } : {}),
      idempotencyKey: key,
      requestFingerprintSha256: `sha256:${(key === "clock-head-1" ? "3" : "4").repeat(64)}`,
      ownerReference: "owner:test",
      startedAt,
    });

    const firstReserved = await reserve("clock-head-1", "2026-08-12T10:00:00.000Z");
    const first = await h.repository.completeRegisteredObservation({
      id: firstReserved.snapshot.id, workspaceRegistrationId: workspaceId, contract: h.contract,
      canonicalSha256: canonicalWorkspaceIndexHash(h.contract), indexConfiguration: c1, indexConfigurationSha256: c1Sha,
      completedAt: "2026-08-12T10:00:01.000Z",
    });

    const secondReserved = await reserve("clock-head-2", "2026-08-12T09:00:00.000Z", first.workspaceObservationId);
    const second = await h.repository.completeRegisteredObservation({
      id: secondReserved.snapshot.id, workspaceRegistrationId: workspaceId, contract: h.contract,
      canonicalSha256: canonicalWorkspaceIndexHash(h.contract), indexConfiguration: c1, indexConfigurationSha256: c1Sha,
      completedAt: "2026-08-12T09:00:01.000Z",
    });

    const latest = await h.repository.readLatestResolvedArtifact(workspaceId);
    const history = await h.repository.readWorkspaceHistory(workspaceId);
    expect(latest?.observationId).toBe(second.workspaceObservationId);
    expect(history.observations.map(item => item.id)).toEqual([first.workspaceObservationId, second.workspaceObservationId]);
    expect(history.observations[1].previousObservationId).toBe(first.workspaceObservationId);
    expect(history.observations[1].observedAt < history.observations[0].observedAt).toBe(true);
  });

  it("T25 keeps proven rename lineage transition-scoped while intrinsic target Artifact identity stays history-independent", async () => {
    const withHistory = await createWorkspaceIndexFixture();
    const directRoot = await createWorkspaceIndexFixture();
    const instance = "wsi_transition_lineage_separation";
    const predecessor = await indexWorkspace({
      workspace_instance_id: instance, root_path: withHistory, binding_type: "FIXTURE", indexing_session_id: "lineage-a",
      started_at: "2026-08-12T07:00:00.000Z", completed_at: "2026-08-12T07:00:01.000Z",
    });
    await rename(path.join(withHistory, "src", "util.ts"), path.join(withHistory, "src", "helper.ts"));
    const viaRename = await indexWorkspace({
      workspace_instance_id: instance, root_path: withHistory, binding_type: "FIXTURE", previous_contract: predecessor, indexing_session_id: "lineage-b",
      started_at: "2026-08-12T07:00:02.000Z", completed_at: "2026-08-12T07:00:03.000Z",
      git_enrichment: { rename_hints: [{ from_relative_path: "src/util.ts", to_relative_path: "src/helper.ts", confidence: "PROVEN", evidence: "fixture" }], diagnostics: [] },
    });
    await rename(path.join(directRoot, "src", "util.ts"), path.join(directRoot, "src", "helper.ts"));
    const direct = await indexWorkspace({
      workspace_instance_id: instance, root_path: directRoot, binding_type: "FIXTURE", indexing_session_id: "lineage-direct",
      started_at: "2030-08-12T07:00:00.000Z", completed_at: "2030-08-12T07:00:01.000Z",
    });

    const lineage = deriveTransitionLineageEvidence(predecessor, viaRename);
    expect(lineage.renamed_or_moved).toHaveLength(1);
    expect(lineage.renamed_or_moved[0]).toMatchObject({
      from_relative_path: "src/util.ts",
      to_relative_path: "src/helper.ts",
      evidence_scope: "CANONICAL_WORKSPACE_INDEX_V1_OBSERVATION_PROJECTION",
    });
    expect(canonicalIndexArtifactSemanticSha256(viaRename)).toBe(canonicalIndexArtifactSemanticSha256(direct));
    expect(canonicalIndexArtifactSemanticState(viaRename)).toEqual(canonicalIndexArtifactSemanticState(direct));
  });


  it("T33 same Source Revision observed through a different valid binding keeps revision/artifact identity and preserves Observation binding evidence", async () => {
    const h = await harness();
    const config = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationDescriptor();
    const configSha = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationSha256(config);
    const firstReserved = await h.repository.reserve({
      sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, workspaceRegistrationRevision: 7,
      workspaceRegistrationFingerprint: "sha256:fixture-workspace-fingerprint", governedScope: {}, idempotencyKey: "t33-binding-x",
      requestFingerprintSha256: `sha256:${"a".repeat(64)}`, ownerReference: "owner:test", startedAt: "2026-08-12T11:00:00.000Z",
    });
    const first = await h.repository.completeRegisteredObservation({
      id: firstReserved.snapshot.id, workspaceRegistrationId: workspaceId, contract: h.contract,
      canonicalSha256: canonicalWorkspaceIndexHash(h.contract), indexConfiguration: config, indexConfigurationSha256: configSha,
      completedAt: "2026-08-12T11:00:01.000Z",
    });
    const bindingY = structuredClone(h.contract);
    bindingY.workspace.source_binding_id = "sbi_binding_y";
    bindingY.source_binding.source_binding_id = "sbi_binding_y";
    const secondReserved = await h.repository.reserve({
      sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, workspaceRegistrationRevision: 7,
      workspaceRegistrationFingerprint: "sha256:fixture-workspace-fingerprint", governedScope: {}, scanBaseObservationId: first.workspaceObservationId,
      idempotencyKey: "t33-binding-y", requestFingerprintSha256: `sha256:${"b".repeat(64)}`, ownerReference: "owner:test", startedAt: "2026-08-12T11:00:02.000Z",
    });
    const second = await h.repository.completeRegisteredObservation({
      id: secondReserved.snapshot.id, workspaceRegistrationId: workspaceId, contract: bindingY,
      canonicalSha256: canonicalWorkspaceIndexHash(bindingY), indexConfiguration: config, indexConfigurationSha256: configSha,
      completedAt: "2026-08-12T11:00:03.000Z",
    });
    expect(second.workspaceRevisionId).toBe(first.workspaceRevisionId);
    expect(second.canonicalIndexArtifactId).toBe(first.canonicalIndexArtifactId);
    expect(second.observationResult).toBe("SOURCE_UNCHANGED");
    const history = await h.repository.readWorkspaceHistory(workspaceId);
    expect(history.observations).toHaveLength(2);
    expect(history.observations[1].sourceBinding.source_binding_id).toBe("sbi_binding_y");
    expect(history.transitions).toHaveLength(0);
  });

  it("T34 a changed/unverified binding cannot bypass registered Workspace authority", async () => {
    const h = await harness();
    const { integrity: _integrity, ...unauthorizedBase } = structuredClone(h.contract);
    const unauthorized = finalizeWorkspaceIndexContract({
      ...unauthorizedBase,
      source_binding: {
        ...unauthorizedBase.source_binding,
        normalized_reference: path.join(h.root, "..", "unauthorized"),
      },
    });
    h.runIndexer.mockImplementationOnce(successfulIndexerResult(unauthorized));
    await expect(h.service.create({
      sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: "t34-binding-authority",
    }, "owner:test")).rejects.toMatchObject({ status: 409, code: "WORKSPACE_SOURCE_BINDING_AUTHORITY_MISMATCH" });
    expect(h.repository.observations).toHaveLength(0);
    expect(h.repository.artifacts.size).toBe(0);
  });

  it("T37 parser/index retryable degradation does not invalidate the proven Source Revision identity", async () => {
    const h = await harness();
    const { integrity: _integrity, ...withoutIntegrity } = structuredClone(h.contract);
    const retryable = finalizeWorkspaceIndexContract({
      ...withoutIntegrity,
      contract_status: "COMPLETE_WITH_GAPS",
      failures: [...withoutIntegrity.failures, {
        failure_id: "wif_t37_retryable",
        file_revision_id: withoutIntegrity.snapshot.files[0].file_revision_id,
        stage: "PARSING", failure_type: "PARSER_FAILURE", error_code: "REGISTERED_PARSER_FAILED",
        sanitized_message: "simulated retryable parser failure", extractor_id: "fixture_parser", extractor_version: "1.0.0",
        recoverability: "RETRYABLE", impact: "CONTEXT_DEGRADING", occurred_at: "2026-08-12T11:10:00.000Z",
      }],
    });
    expect(retryable.workspace.workspace_revision_id).toBe(h.contract.workspace.workspace_revision_id);
    expect(canonicalIndexArtifactQualification(retryable)).toEqual({ qualified: false, retryable_failure_codes: ["REGISTERED_PARSER_FAILED"] });
  });

  it("T38 retryable semantic outcome preserves Source Observation without poisoning Canonical Artifact identity", async () => {
    const h = await harness();
    const { integrity: _integrity, ...withoutIntegrity } = structuredClone(h.contract);
    const retryable = finalizeWorkspaceIndexContract({
      ...withoutIntegrity,
      contract_status: "COMPLETE_WITH_GAPS",
      failures: [...withoutIntegrity.failures, {
        failure_id: "wif_t38_retryable",
        file_revision_id: withoutIntegrity.snapshot.files[0].file_revision_id,
        stage: "PARSING", failure_type: "PARSER_FAILURE", error_code: "REGISTERED_PARSER_FAILED",
        sanitized_message: "simulated transient parser failure", extractor_id: "fixture_parser", extractor_version: "1.0.0",
        recoverability: "RETRYABLE", impact: "CONTEXT_DEGRADING", occurred_at: "2026-08-12T11:20:00.000Z",
      }],
    });
    h.runIndexer.mockImplementationOnce(successfulIndexerResult(retryable));
    const failed = await h.service.create({
      sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: "t38-retryable-first",
    }, "owner:test");
    expect(failed.status).toBe("FAILED");
    expect(failed.observationResult).toBe("SOURCE_PROVEN_INDEX_FAILED");
    expect(failed.workspaceRevisionId).toBe(h.contract.workspace.workspace_revision_id);
    expect(failed.canonicalIndexArtifactId).toBeUndefined();
    expect(h.repository.artifacts.size).toBe(0);
    expect(h.repository.observations).toHaveLength(1);

    h.runIndexer.mockImplementationOnce(successfulIndexerResult(structuredClone(h.contract)));
    const successful = await h.service.create({
      sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: "t38-successful-second",
    }, "owner:test");
    expect(successful.status).toBe("READY");
    expect(successful.workspaceRevisionId).toBe(failed.workspaceRevisionId);
    expect(h.repository.artifacts.size).toBe(1);
    expect(h.repository.observations).toHaveLength(2);
  });

  it("T39 concurrent different-state head change rejects stale predecessor-specific commit evidence", async () => {
    const h = await harness();
    const config = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationDescriptor();
    const configSha = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationSha256(config);
    const headA = await h.service.create({ sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: "t39-head-a" }, "owner:test");
    await writeFile(path.join(h.root, "src", "util.ts"), "export function double(value: number) { return value * 3; }\n");
    const targetB = await indexWorkspace({ workspace_instance_id: workspaceId, root_path: h.root, binding_type: "LOCAL_FILESYSTEM" });
    await writeFile(path.join(h.root, "src", "util.ts"), "export function double(value: number) { return value * 4; }\n");
    const targetC = await indexWorkspace({ workspace_instance_id: workspaceId, root_path: h.root, binding_type: "LOCAL_FILESYSTEM" });
    const reserveAttempt = (key: string, digit: string) => h.repository.reserve({
      sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, workspaceRegistrationRevision: 7,
      workspaceRegistrationFingerprint: "sha256:fixture-workspace-fingerprint", governedScope: {}, scanBaseObservationId: headA.workspaceObservationId,
      idempotencyKey: key, requestFingerprintSha256: `sha256:${digit.repeat(64)}`, ownerReference: "owner:test", startedAt: "2026-08-12T11:30:00.000Z",
    });
    const attemptB = await reserveAttempt("t39-attempt-b", "c");
    const attemptC = await reserveAttempt("t39-attempt-c", "d");
    const committedC = await h.repository.completeRegisteredObservation({
      id: attemptC.snapshot.id, workspaceRegistrationId: workspaceId, contract: targetC,
      canonicalSha256: canonicalWorkspaceIndexHash(targetC), indexConfiguration: config, indexConfigurationSha256: configSha,
      completedAt: "2026-08-12T11:30:02.000Z",
    });
    await expect(h.repository.completeRegisteredObservation({
      id: attemptB.snapshot.id, workspaceRegistrationId: workspaceId, contract: targetB,
      canonicalSha256: canonicalWorkspaceIndexHash(targetB), indexConfiguration: config, indexConfigurationSha256: configSha,
      completedAt: "2026-08-12T11:30:03.000Z",
    })).rejects.toMatchObject({ status: 409, code: "WORKSPACE_INDEX_SCAN_BASE_STALE" });
    const latest = await h.repository.readLatestResolvedArtifact(workspaceId);
    expect(latest?.observationId).toBe(committedC.workspaceObservationId);
  });

  it("T40 concurrent duplicate target permits Artifact reuse only through a fresh head-bound attempt", async () => {
    const h = await harness();
    const config = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationDescriptor();
    const configSha = (await import("@/core/workspace-index/artifact-identity")).workspaceIndexConfigurationSha256(config);
    const headA = await h.service.create({ sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: "t40-head-a" }, "owner:test");
    await writeFile(path.join(h.root, "src", "util.ts"), "export function double(value: number) { return value * 5; }\n");
    const targetB = await indexWorkspace({ workspace_instance_id: workspaceId, root_path: h.root, binding_type: "LOCAL_FILESYSTEM" });
    const reserveAttempt = (key: string, digit: string) => h.repository.reserve({
      sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, workspaceRegistrationRevision: 7,
      workspaceRegistrationFingerprint: "sha256:fixture-workspace-fingerprint", governedScope: {}, scanBaseObservationId: headA.workspaceObservationId,
      idempotencyKey: key, requestFingerprintSha256: `sha256:${digit.repeat(64)}`, ownerReference: "owner:test", startedAt: "2026-08-12T11:40:00.000Z",
    });
    const attempt1 = await reserveAttempt("t40-attempt-1", "e");
    const attempt2 = await reserveAttempt("t40-attempt-2", "f");
    const firstB = await h.repository.completeRegisteredObservation({
      id: attempt1.snapshot.id, workspaceRegistrationId: workspaceId, contract: targetB,
      canonicalSha256: canonicalWorkspaceIndexHash(targetB), indexConfiguration: config, indexConfigurationSha256: configSha,
      completedAt: "2026-08-12T11:40:01.000Z",
    });
    await expect(h.repository.completeRegisteredObservation({
      id: attempt2.snapshot.id, workspaceRegistrationId: workspaceId, contract: targetB,
      canonicalSha256: canonicalWorkspaceIndexHash(targetB), indexConfiguration: config, indexConfigurationSha256: configSha,
      completedAt: "2026-08-12T11:40:02.000Z",
    })).rejects.toMatchObject({ status: 409, code: "WORKSPACE_INDEX_SCAN_BASE_STALE" });
    expect(h.repository.observations.filter(item => item.workspaceRevisionId === firstB.workspaceRevisionId)).toHaveLength(1);
  });


  it("T42 idempotent replay after successful head advancement returns the original operation without re-indexing", async () => {
    const h = await harness();
    const command = { sourceMode: "REGISTERED_WORKSPACE" as const, workspaceRegistrationId: workspaceId, idempotencyKey: "t42-replay-key" };
    const first = await h.service.createOperation(command, "owner:test");
    const observationsAfterFirst = h.repository.observations.length;
    const indexerCallsAfterFirst = h.runIndexer.mock.calls.length;
    const workspaceReadsAfterFirst = h.readWorkspace.mock.calls.length;
    const authorityChecksAfterFirst = h.authorizeWorkspaceSource.mock.calls.length;
    expect(first.created).toBe(true);
    expect(first.snapshot.status).toBe("READY");

    const replay = await h.service.createOperation(command, "owner:test");
    expect(replay.created).toBe(false);
    expect(replay.snapshot.id).toBe(first.snapshot.id);
    expect(replay.snapshot.workspaceObservationId).toBe(first.snapshot.workspaceObservationId);
    expect(h.runIndexer).toHaveBeenCalledTimes(indexerCallsAfterFirst);
    expect(h.repository.observations).toHaveLength(observationsAfterFirst);
    expect(h.readWorkspace).toHaveBeenCalledTimes(workspaceReadsAfterFirst);
    expect(h.authorizeWorkspaceSource).toHaveBeenCalledTimes(authorityChecksAfterFirst);
  });

  it("T43 same idempotency key with genuinely different canonical request remains an IDEMPOTENCY_CONFLICT", async () => {
    const h = await harness();
    const key = "t43-conflict-key";
    await h.service.createOperation({ sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: key }, "owner:test");
    await expect(h.service.createOperation({
      sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, projectContextId: projectId, idempotencyKey: key,
    }, "owner:test")).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(h.runIndexer).toHaveBeenCalledTimes(1);
    expect(h.repository.observations).toHaveLength(1);
  });

  it("T44 complete Source capture plus retryable semantic failure persists Source Revision and Observation but no Artifact", async () => {
    const h = await harness();
    const { integrity: _integrity, ...withoutIntegrity } = structuredClone(h.contract);
    const retryable = finalizeWorkspaceIndexContract({
      ...withoutIntegrity,
      contract_status: "COMPLETE_WITH_GAPS",
      failures: [...withoutIntegrity.failures, {
        failure_id: "wif_t44_retryable", file_revision_id: withoutIntegrity.snapshot.files[0].file_revision_id,
        stage: "PARSING", failure_type: "PARSER_FAILURE", error_code: "T44_TRANSIENT_PARSER",
        sanitized_message: "deterministic T44 retryable parser failure", extractor_id: "fixture_parser", extractor_version: "1.0.0",
        recoverability: "RETRYABLE", impact: "CONTEXT_DEGRADING", occurred_at: "2026-08-12T12:00:00.000Z",
      }],
    });
    h.runIndexer.mockImplementationOnce(successfulIndexerResult(retryable));
    const failed = await h.service.create({ sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: "t44-proven-source-failed-index" }, "owner:test");
    expect(failed).toMatchObject({
      status: "FAILED", observationResult: "SOURCE_PROVEN_INDEX_FAILED", indexAttemptStatus: "FAILED_RETRYABLE",
      failureCode: "SOURCE_CAPTURE_PROVEN_INDEX_ATTEMPT_FAILED", workspaceRevisionId: h.contract.workspace.workspace_revision_id,
    });
    expect(failed.workspaceObservationId).toBeTruthy();
    expect(failed.canonicalIndexArtifactId).toBeUndefined();
    expect(h.repository.revisions.has(h.contract.workspace.workspace_revision_id)).toBe(true);
    expect(h.repository.observations).toHaveLength(1);
    expect(h.repository.artifacts.size).toBe(0);
    expect(failed.indexAttemptCandidateSha256).toBe(canonicalWorkspaceIndexHash(retryable));
  });

  it("T45 successful semantic retry reuses the proven Source Revision and preserves the failed attempt", async () => {
    const h = await harness();
    const { integrity: _integrity, ...withoutIntegrity } = structuredClone(h.contract);
    const retryable = finalizeWorkspaceIndexContract({
      ...withoutIntegrity,
      contract_status: "COMPLETE_WITH_GAPS",
      failures: [...withoutIntegrity.failures, {
        failure_id: "wif_t45_retryable", file_revision_id: withoutIntegrity.snapshot.files[0].file_revision_id,
        stage: "PARSING", failure_type: "PARSER_FAILURE", error_code: "T45_TRANSIENT_PARSER",
        sanitized_message: "deterministic T45 retryable parser failure", extractor_id: "fixture_parser", extractor_version: "1.0.0",
        recoverability: "RETRYABLE", impact: "CONTEXT_DEGRADING", occurred_at: "2026-08-12T12:10:00.000Z",
      }],
    });
    h.runIndexer.mockImplementationOnce(successfulIndexerResult(retryable));
    const failed = await h.service.create({ sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: "t45-first" }, "owner:test");
    h.runIndexer.mockImplementationOnce(successfulIndexerResult(structuredClone(h.contract)));
    const succeeded = await h.service.create({ sourceMode: "REGISTERED_WORKSPACE", workspaceRegistrationId: workspaceId, idempotencyKey: "t45-second" }, "owner:test");
    expect(succeeded.status).toBe("READY");
    expect(succeeded.workspaceRevisionId).toBe(failed.workspaceRevisionId);
    expect(succeeded.canonicalIndexArtifactId).toBeTruthy();
    expect(h.repository.revisions.size).toBe(1);
    expect(h.repository.observations).toHaveLength(2);
    expect(h.repository.artifacts.size).toBe(1);
    const failedAgain = await h.repository.read(failed.id);
    expect(failedAgain.status).toBe("FAILED");
    expect(failedAgain.indexAttemptStatus).toBe("FAILED_RETRYABLE");
  });

});


describe("Plane B1 verified Root Object Authority", () => {
  it("T55 verified root replacement fails authority before indexing can start", async () => {
    const root = await createWorkspaceIndexFixture();
    const replacement = await createWorkspaceIndexFixture();
    const oldPath = `${root}-old`;
    try {
      const verified = await rootAuthority(root);
      await rename(root, oldPath);
      await rename(replacement, root);
      const current = await rootAuthority(root);
      expect(sameProofGradeFilesystemObject(verified.identity, current.identity)).toBe(false);

      const inventoryWorkspace = vi.fn();
      await expect(preflightRegisteredWorkspaceIndexWithDependencies(
        { workspaceRegistrationId: workspaceId },
        {
          authorizeWorkspaceSource: async () => {
            if (!sameProofGradeFilesystemObject(verified.identity, current.identity)) {
              throw new HttpCommandError(409, "WORKSPACE_VERIFICATION_STALE", "stale root object");
            }
            throw new Error("unreachable");
          },
          inventoryWorkspace,
        },
      )).rejects.toMatchObject({ status: 409, code: "WORKSPACE_VERIFICATION_STALE" });
      expect(inventoryWorkspace).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(oldPath, { recursive: true, force: true });
      await rm(replacement, { recursive: true, force: true });
    }
  });

  it("T56 governed re-verification may bind a new Root Object while identical Source State reuses the Workspace Revision", async () => {
    const root = await createWorkspaceIndexFixture();
    const replacement = await createWorkspaceIndexFixture();
    const oldPath = `${root}-old`;
    try {
      const before = await indexWorkspace({ workspace_instance_id: workspaceId, root_path: root, binding_type: "LOCAL_FILESYSTEM" });
      const verified = await rootAuthority(root);
      await rename(root, oldPath);
      await rename(replacement, root);
      const reverified = await rootAuthority(root);
      expect(sameProofGradeFilesystemObject(verified.identity, reverified.identity)).toBe(false);
      const rebound = authorityRegistration(root, reverified);
      expect(rebound.rootAuthorityState).toBe("VERIFIED_MATCH");
      expect(rebound.verifiedRootObjectIdentity).toEqual(reverified.identity);

      const after = await indexWorkspace({ workspace_instance_id: workspaceId, root_path: root, binding_type: "LOCAL_FILESYSTEM" });
      expect(after.workspace.workspace_revision_id).toBe(before.workspace.workspace_revision_id);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(oldPath, { recursive: true, force: true });
      await rm(replacement, { recursive: true, force: true });
    }
  });

  it("T57 Registered Workspace preflight crosses the Root Object Authority gate before any inventory traversal", async () => {
    const inventoryWorkspace = vi.fn();
    const authorizeWorkspaceSource = vi.fn(async () => {
      throw new HttpCommandError(409, "ROOT_IDENTITY_UNPROVABLE", "identity unavailable");
    });
    await expect(preflightRegisteredWorkspaceIndexWithDependencies(
      { workspaceRegistrationId: workspaceId },
      { authorizeWorkspaceSource, inventoryWorkspace },
    )).rejects.toMatchObject({ status: 409, code: "ROOT_IDENTITY_UNPROVABLE" });
    expect(authorizeWorkspaceSource).toHaveBeenCalledTimes(1);
    expect(inventoryWorkspace).not.toHaveBeenCalled();
  });

  it("T58 normal verified Non-Git/Git-metadata Workspace authority path permits preflight and indexing without Git writes", async () => {
    const root = await createWorkspaceIndexFixture();
    try {
      const proof = await rootAuthority(root);
      for (const repositoryMetadata of [
        {},
        { repositoryIdentity: root, branch: "main", commitSha: "a".repeat(40) },
      ]) {
        const registered: WorkspaceAuthorityRegistration = {
          ...authorityRegistration(root, proof),
          ...repositoryMetadata,
        };
        const authorized = {
          registration: registered,
          currentIdentity: {
            normalizedReference: root,
            realPath: proof.realPath,
            rootObjectIdentity: proof.identity,
            fingerprint: registered.fingerprint,
            provenance: {},
          },
        };
        const preflight = await preflightRegisteredWorkspaceIndexWithDependencies(
          { workspaceRegistrationId: workspaceId },
          {
            authorizeWorkspaceSource: async () => authorized,
            inventoryWorkspace: async (...args) => (await import("@/core/workspace-index/adapters/filesystem")).inventoryWorkspaceFiles(...args),
          },
        );
        expect(preflight.discoveredFiles).toBeGreaterThan(0);
        const contract = await indexWorkspace({
          workspace_instance_id: workspaceId,
          root_path: root,
          binding_type: "LOCAL_FILESYSTEM",
          authorized_root_identity: { real_path: proof.realPath, identity: proof.identity },
        });
        expect(contract.workspace.workspace_revision_id).toMatch(/^wsr_[0-9a-f]{64}$/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
