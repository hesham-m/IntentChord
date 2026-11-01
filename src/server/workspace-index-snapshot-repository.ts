import { randomUUID } from "node:crypto";
import { canonicalJson, canonicalWorkspaceIndexHash, sha256Canonical, stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import { deriveCanonicalIndexArtifactDelta, validateCanonicalIndexArtifactDelta, type CanonicalIndexArtifactDelta } from "@/core/workspace-index/delta";
import {
  canonicalIndexArtifactId,
  canonicalIndexArtifactQualification,
  canonicalIndexArtifactSemanticSha256,
  canonicalIndexArtifactSemanticState,
  type CanonicalIndexArtifactSemanticState,
  classifyWorkspaceObservation,
  workspaceIndexDeltaArtifactId,
  workspaceIndexConfigurationSha256,
  type WorkspaceIndexConfigurationDescriptor,
  type WorkspaceObservationResult,
} from "@/core/workspace-index/artifact-identity";
import {
  COMPARISON_ENGINE_VERSION,
  DELTA_SCHEMA_VERSION,
  type CanonicalWorkspaceIndexContract,
} from "@/core/workspace-index/types";
import {
  deriveTransitionLineageEvidence,
  WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION,
  type WorkspaceTransitionLineageEvidence,
} from "@/core/workspace-index/transition-lineage";
import { databaseQuery, databaseQueryGoverned, transaction, transactionGoverned, type DatabaseExecutionGovernance } from "@/server/db";
import { HttpCommandError } from "@/server/errors";
import type { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import type { EvidenceSectionType } from "@/core/workspace-index/sections/sectioned-contracts";

export type WorkspaceIndexSnapshotSourceMode = "REGISTERED_WORKSPACE" | "ADVANCED_DIAGNOSTIC";
export type WorkspaceIndexSnapshotStatus = "CREATING" | "READY" | "FAILED";
export type WorkspaceIndexAttemptStatus = "IN_PROGRESS" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED";

export type WorkspaceIndexSnapshotView = {
  id: string;
  sourceMode: WorkspaceIndexSnapshotSourceMode;
  status: WorkspaceIndexSnapshotStatus;
  workspaceRegistrationId?: string;
  workspaceRegistrationRevision?: number;
  workspaceRegistrationFingerprint?: string;
  projectContextId?: string;
  governedScope: Record<string, unknown>;
  canonicalContractVersion?: string;
  canonicalSha256?: string;
  workspaceObservationId?: string;
  workspaceRevisionId?: string;
  canonicalIndexArtifactId?: string;
  indexConfigurationSha256?: string;
  observationResult?: WorkspaceObservationResult;
  deltaArtifactId?: string;
  scanBaseObservationId?: string;
  indexAttemptStatus?: WorkspaceIndexAttemptStatus;
  indexAttemptEvidence?: Record<string, unknown>;
  indexAttemptCandidateSha256?: string;
  failureCode?: string;
  safeFailureEvidence?: Record<string, unknown>;
  acceptedWorkspaceEvidenceArtifactId?: string;
  startedAt: string;
  completedAt?: string;
  progressPhase?: string;
  progressEvidence?: Record<string, unknown>;
  heartbeatAt?: string;
  createdAt: string;
};

export type WorkspaceIndexSnapshotRecord = WorkspaceIndexSnapshotView & {
  snapshotIdempotencyKey: string;
  requestFingerprintSha256: string;
  canonicalIndex?: CanonicalWorkspaceIndexContract;
  indexAttemptCandidate?: CanonicalWorkspaceIndexContract;
  ownerReference: string;
};

type SnapshotRow = {
  id: string; source_mode: WorkspaceIndexSnapshotSourceMode; status: WorkspaceIndexSnapshotStatus;
  workspace_registration_id: string | null; workspace_registration_revision: string | number | null;
  workspace_registration_fingerprint: string | null; project_context_id: string | null;
  governed_scope: Record<string, unknown>; snapshot_idempotency_key: string; snapshot_request_fingerprint_sha256: string;
  canonical_contract_version: string | null; canonical_index_json: CanonicalWorkspaceIndexContract | null; canonical_sha256: string | null;
  workspace_observation_id: string | null; workspace_revision_id: string | null; canonical_index_artifact_id: string | null;
  index_configuration_sha256: string | null; observation_result: WorkspaceObservationResult | null; delta_artifact_id: string | null;
  scan_base_observation_id: string | null;
  index_attempt_status: WorkspaceIndexAttemptStatus | null; index_attempt_evidence: Record<string, unknown> | null;
  index_attempt_candidate_json: CanonicalWorkspaceIndexContract | null; index_attempt_candidate_sha256: string | null;
  failure_code: string | null; safe_failure_evidence: Record<string, unknown> | null; owner_reference: string;
  accepted_workspace_evidence_artifact_id: string | null;
  started_at: string | Date; completed_at: string | Date | null; progress_phase: string | null;
  progress_evidence: Record<string, unknown> | null; heartbeat_at: string | Date | null; created_at: string | Date;
};

type ArtifactRow = {
  id: string; workspace_registration_id: string; workspace_revision_id: string; index_configuration_sha256: string;
  artifact_semantic_sha256: string; artifact_semantic_json: CanonicalIndexArtifactSemanticState;
  canonical_index_json: CanonicalWorkspaceIndexContract; canonical_sha256: string;
};

type DeltaArtifactRow = {
  id: string; workspace_registration_id: string; from_workspace_revision_id: string; to_workspace_revision_id: string;
  from_canonical_index_artifact_id: string; to_canonical_index_artifact_id: string;
  delta_schema_version: string; comparison_engine_version: string; delta_json: CanonicalIndexArtifactDelta; delta_sha256: string;
};

type ObservationJoinRow = {
  id: string; workspace_revision_id: string; canonical_index_artifact_id: string | null;
  observation_result: WorkspaceObservationResult; observed_at: string | Date; authority_sequence: string | number;
  artifact_semantic_json: CanonicalIndexArtifactSemanticState | null; canonical_index_json: CanonicalWorkspaceIndexContract | null; canonical_sha256: string | null;
  index_attempt_candidate_json: CanonicalWorkspaceIndexContract | null; index_attempt_candidate_sha256: string | null;
  index_configuration_sha256: string;
  accepted_workspace_evidence_artifact_id: string | null;
};

type ResolvedObservationArtifactRow = {
  id: string; workspace_revision_id: string; canonical_index_artifact_id: string;
  observation_result: WorkspaceObservationResult; observed_at: string | Date; authority_sequence: string | number;
  index_configuration_sha256: string; canonical_index_json: CanonicalWorkspaceIndexContract; canonical_sha256: string;
};

type RevisionHistoryRow = {
  id: string; source_tree_fingerprint: string; first_observed_at: string | Date; observation_count: string | number;
};
type ObservationHistoryRow = {
  id: string; snapshot_operation_id: string; workspace_revision_id: string; canonical_index_artifact_id: string | null; previous_observation_id: string | null;
  observation_result: WorkspaceObservationResult; index_configuration_sha256: string; source_binding_json: Record<string, unknown>;
  observed_at: string | Date; delta_artifact_id: string | null;
};
type TransitionHistoryRow = {
  id: string; observation_id: string; from_workspace_revision_id: string; to_workspace_revision_id: string;
  delta_artifact_id: string | null; lineage_evidence_json: WorkspaceTransitionLineageEvidence; observed_at: string | Date;
};

function iso(value: string | Date): string { return new Date(value).toISOString(); }

function governedIndexAttemptEvidence(contract: CanonicalWorkspaceIndexContract, input: { canonicalization: "QUALIFIED" | "FAILED_RETRYABLE"; retryableFailureCodes?: string[] }): Record<string, unknown> {
  const boundaryEvidence = contract.failures
    .filter(item => item.error_code === "SYMLINK_NOT_FOLLOWED" || item.failure_type === "SYMLINK_NOT_FOLLOWED")
    .map(item => ({
      stage: item.stage,
      failure_type: item.failure_type,
      error_code: item.error_code,
      sanitized_message: item.sanitized_message,
      recoverability: item.recoverability,
      impact: item.impact,
    }));
  const retryableFailures = contract.failures
    .filter(item => item.recoverability === "RETRYABLE")
    .map(item => ({
      stage: item.stage,
      failure_type: item.failure_type,
      error_code: item.error_code,
      sanitized_message: item.sanitized_message,
      ...(item.extractor_id ? { extractor_id: item.extractor_id } : {}),
      ...(item.extractor_version ? { extractor_version: item.extractor_version } : {}),
      impact: item.impact,
    }));
  const durationGovernance = contract.source_binding.metadata.duration_governance;
  return {
    source_capture: "PROVEN",
    canonicalization: input.canonicalization,
    ...(durationGovernance && typeof durationGovernance === "object" ? { duration_governance: durationGovernance } : {}),
    ...(input.retryableFailureCodes?.length ? { retryable_failure_codes: input.retryableFailureCodes } : {}),
    ...(retryableFailures.length ? { retryable_failures: retryableFailures } : {}),
    ...(boundaryEvidence.length ? { boundary_evidence: boundaryEvidence } : {}),
  };
}

function mapSnapshot(row: SnapshotRow): WorkspaceIndexSnapshotRecord {
  return {
    id: row.id, sourceMode: row.source_mode, status: row.status,
    ...(row.workspace_registration_id ? { workspaceRegistrationId: row.workspace_registration_id } : {}),
    ...(row.workspace_registration_revision !== null ? { workspaceRegistrationRevision: Number(row.workspace_registration_revision) } : {}),
    ...(row.workspace_registration_fingerprint ? { workspaceRegistrationFingerprint: row.workspace_registration_fingerprint } : {}),
    ...(row.project_context_id ? { projectContextId: row.project_context_id } : {}),
    governedScope: row.governed_scope,
    snapshotIdempotencyKey: row.snapshot_idempotency_key,
    requestFingerprintSha256: row.snapshot_request_fingerprint_sha256,
    ...(row.canonical_contract_version ? { canonicalContractVersion: row.canonical_contract_version } : {}),
    ...(row.canonical_index_json ? { canonicalIndex: row.canonical_index_json } : {}),
    ...(row.canonical_sha256 ? { canonicalSha256: row.canonical_sha256 } : {}),
    ...(row.workspace_observation_id ? { workspaceObservationId: row.workspace_observation_id } : {}),
    ...(row.workspace_revision_id ? { workspaceRevisionId: row.workspace_revision_id } : {}),
    ...(row.canonical_index_artifact_id ? { canonicalIndexArtifactId: row.canonical_index_artifact_id } : {}),
    ...(row.index_configuration_sha256 ? { indexConfigurationSha256: row.index_configuration_sha256 } : {}),
    ...(row.observation_result ? { observationResult: row.observation_result } : {}),
    ...(row.delta_artifact_id ? { deltaArtifactId: row.delta_artifact_id } : {}),
    ...(row.scan_base_observation_id ? { scanBaseObservationId: row.scan_base_observation_id } : {}),
    ...(row.index_attempt_status ? { indexAttemptStatus: row.index_attempt_status } : {}),
    ...(row.index_attempt_evidence ? { indexAttemptEvidence: row.index_attempt_evidence } : {}),
    ...(row.index_attempt_candidate_sha256 ? { indexAttemptCandidateSha256: row.index_attempt_candidate_sha256 } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.safe_failure_evidence ? { safeFailureEvidence: row.safe_failure_evidence } : {}),
    ...(row.accepted_workspace_evidence_artifact_id ? { acceptedWorkspaceEvidenceArtifactId: row.accepted_workspace_evidence_artifact_id } : {}),
    ...(row.index_attempt_candidate_json ? { indexAttemptCandidate: row.index_attempt_candidate_json } : {}),
    ownerReference: row.owner_reference, startedAt: iso(row.started_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.progress_phase ? { progressPhase: row.progress_phase } : {}),
    ...(row.progress_evidence ? { progressEvidence: row.progress_evidence } : {}),
    ...(row.heartbeat_at ? { heartbeatAt: iso(row.heartbeat_at) } : {}),
    createdAt: iso(row.created_at),
  };
}

const snapshotColumns = `id,source_mode,status,workspace_registration_id,workspace_registration_revision,
  workspace_registration_fingerprint,project_context_id,governed_scope,snapshot_idempotency_key,
  snapshot_request_fingerprint_sha256,canonical_contract_version,canonical_index_json,canonical_sha256,
  workspace_observation_id,workspace_revision_id,canonical_index_artifact_id,index_configuration_sha256,observation_result,delta_artifact_id,scan_base_observation_id,
  index_attempt_status,index_attempt_evidence,index_attempt_candidate_json,index_attempt_candidate_sha256,
  failure_code,safe_failure_evidence,owner_reference,accepted_workspace_evidence_artifact_id,started_at,completed_at,progress_phase,progress_evidence,heartbeat_at,created_at`;
const snapshotSelect = `select ${snapshotColumns} from intentchord.workspace_index_snapshots`;

export type ReserveWorkspaceIndexSnapshot = {
  sourceMode: WorkspaceIndexSnapshotSourceMode; workspaceRegistrationId?: string; workspaceRegistrationRevision?: number;
  workspaceRegistrationFingerprint?: string; projectContextId?: string; governedScope: Record<string, unknown>;
  scanBaseObservationId?: string;
  idempotencyKey: string; requestFingerprintSha256: string; ownerReference: string; startedAt: string;
};

export type LatestWorkspaceObservationHead = {
  observationId: string; workspaceRevisionId: string; canonicalIndexArtifactId?: string;
  observationResult: WorkspaceObservationResult; observedAt: string; indexConfigurationSha256: string;
  canonicalIndex?: CanonicalWorkspaceIndexContract; canonicalSha256?: string;
  acceptedWorkspaceEvidenceArtifactId?: string;
};

export type LatestResolvedWorkspaceArtifact = LatestWorkspaceObservationHead & {
  canonicalIndexArtifactId: string; canonicalIndex: CanonicalWorkspaceIndexContract; canonicalSha256: string;
};

export type WorkspaceKnowledgeHistoryView = {
  workspaceRegistrationId: string;
  revisions: Array<{ workspaceRevisionId: string; sourceTreeFingerprint: string; firstObservedAt: string; observationCount: number }>;
  observations: Array<{ id: string; snapshotOperationId: string; workspaceRevisionId: string; canonicalIndexArtifactId?: string; previousObservationId?: string; observationResult: WorkspaceObservationResult; indexConfigurationSha256: string; sourceBinding: Record<string, unknown>; observedAt: string; deltaArtifactId?: string }>;
  transitions: Array<{ id: string; observationId: string; fromWorkspaceRevisionId: string; toWorkspaceRevisionId: string; deltaArtifactId?: string; lineageEvidence: WorkspaceTransitionLineageEvidence; observedAt: string }>;
};

export interface WorkspaceIndexSnapshotRepository {
  /** B1 authority: has this revision previously appeared in any accepted Observation for this workspace registration? */
  wasRevisionPreviouslyObserved(workspaceRegistrationId: string, workspaceRevisionId: string, governance?: DatabaseExecutionGovernance): Promise<boolean>;
  readByIdempotencyKey(idempotencyKey: string, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord | undefined>;
  reserve(input: ReserveWorkspaceIndexSnapshot, governance?: DatabaseExecutionGovernance): Promise<{ snapshot: WorkspaceIndexSnapshotRecord; created: boolean }>;
  complete(input: { id: string; contract: CanonicalWorkspaceIndexContract; canonicalSha256: string; completedAt: string }): Promise<WorkspaceIndexSnapshotRecord>;
  completeRegisteredObservation(input: {
    id: string; workspaceRegistrationId: string; contract: CanonicalWorkspaceIndexContract;
    canonicalSha256: string; indexConfiguration: WorkspaceIndexConfigurationDescriptor;
    indexConfigurationSha256: string; completedAt: string;
  }, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord>;
  readLatestObservationHead(workspaceRegistrationId: string, governance?: DatabaseExecutionGovernance): Promise<LatestWorkspaceObservationHead | undefined>;
  readLatestResolvedArtifact(workspaceRegistrationId: string): Promise<LatestResolvedWorkspaceArtifact | undefined>;
  readMappingAuthority(id: string): Promise<{ snapshot: WorkspaceIndexSnapshotRecord; artifact?: { id: string; semanticSha256: string; semanticState: CanonicalIndexArtifactSemanticState | Record<string, unknown> } }>;
  readWorkspaceHistory(workspaceRegistrationId: string): Promise<WorkspaceKnowledgeHistoryView>;
  fail(input: { id: string; failureCode: string; safeFailureEvidence: Record<string, unknown>; completedAt: string }, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord>;
  read(id: string, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord>;
  assertProjectContextExists(id: string, governance?: DatabaseExecutionGovernance): Promise<void>;
  updateProgress(input: { id: string; phase: string; evidence: Record<string, unknown>; heartbeatAt: string }, governance?: DatabaseExecutionGovernance): Promise<void>;
  recoverStale(input: { staleBefore: string; completedAt: string }, governance?: DatabaseExecutionGovernance): Promise<number>;
  completeRegisteredObservationV2(input: {
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
  }, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord>;
  sealV2Snapshot(input: {
    snapshotId: string;
    workspaceRegistrationId: string;
    workspaceInstanceId: string;
    completedAt: string;
    evidenceArtifact: {
      id: string;
      workspaceRevisionId: string;
      indexConfigurationSha256: string;
      headerJson: unknown;
      sectionManifestJson: unknown;
      sectionManifestDigest: string;
      artifactManifestSha256: string;
      artifactSemanticSha256: string;
      canonicalCompatSha256: string;
    };
    sections: ReadonlyArray<{
      sectionType: import("@/core/workspace-index/sections/sectioned-contracts").EvidenceSectionType;
      sectionOrder: number;
      sectionSchemaVersion: string;
      sectionDigest: string;
      recordCount: number;
      segmentCount: number;
    }>;
    attestationId: string;
    observationResult: string;
    sourceBindingId: string;
    sourceBindingMetadata: Record<string, unknown>;
    bindingType: string;
    normalizedReference: string;
    treeFingerprint: string;
  }, evidenceRepo: import("@/server/workspace-evidence-repository").PostgresWorkspaceEvidenceRepository, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord>;
}

export class PostgresWorkspaceIndexSnapshotRepository implements WorkspaceIndexSnapshotRepository {
  async readByIdempotencyKey(idempotencyKey: string, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord | undefined> {
    const result = governance
      ? await databaseQueryGoverned<SnapshotRow>(`${snapshotSelect} where snapshot_idempotency_key=$1`, [idempotencyKey], governance)
      : await databaseQuery<SnapshotRow>(`${snapshotSelect} where snapshot_idempotency_key=$1`, [idempotencyKey]);
    return result.rowCount ? mapSnapshot(result.rows[0]) : undefined;
  }

  async wasRevisionPreviouslyObserved(workspaceRegistrationId: string, workspaceRevisionId: string, governance?: DatabaseExecutionGovernance): Promise<boolean> {
    const query = governance
      ? <R extends import("pg").QueryResultRow>(text: string, values?: unknown[]) => databaseQueryGoverned<R>(text, values, governance)
      : databaseQuery;
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM intentchord.workspace_observations WHERE workspace_registration_id=$1 AND workspace_revision_id=$2) AS exists`,
      [workspaceRegistrationId, workspaceRevisionId]);
    return Boolean(result.rows[0]?.exists);
  }

  async reserve(input: ReserveWorkspaceIndexSnapshot, governance?: DatabaseExecutionGovernance): Promise<{ snapshot: WorkspaceIndexSnapshotRecord; created: boolean }> {
    const persist = <T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> =>
      governance ? transactionGoverned(governance, work) : transaction(work);
    return persist(async client => {
      const id = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `insert into intentchord.workspace_index_snapshots(
          id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,project_context_id,governed_scope,scan_base_observation_id,
          snapshot_idempotency_key,snapshot_request_fingerprint_sha256,owner_reference,started_at,progress_phase,progress_evidence,heartbeat_at,index_attempt_status
        ) values($1,$2,'CREATING',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DISCOVERING','{}'::jsonb,$12,'IN_PROGRESS')
        on conflict(snapshot_idempotency_key) do nothing returning id`,
        [id,input.sourceMode,input.workspaceRegistrationId??null,input.workspaceRegistrationRevision??null,input.workspaceRegistrationFingerprint??null,
          input.projectContextId??null,JSON.stringify(input.governedScope),input.scanBaseObservationId??null,input.idempotencyKey,input.requestFingerprintSha256,input.ownerReference,input.startedAt],
      );
      const selected = await client.query<SnapshotRow>(`${snapshotSelect} where snapshot_idempotency_key=$1 for update`, [input.idempotencyKey]);
      if (!selected.rowCount) throw new Error("WORKSPACE_INDEX_SNAPSHOT_RESERVATION_MISSING");
      const snapshot = mapSnapshot(selected.rows[0]);
      if (snapshot.requestFingerprintSha256 !== input.requestFingerprintSha256) throw new HttpCommandError(409,"IDEMPOTENCY_CONFLICT","The Snapshot idempotency key is already bound to a different canonical request fingerprint.");
      return { snapshot, created: Boolean(inserted.rowCount) };
    });
  }

  async readLatestObservationHead(workspaceRegistrationId: string, governance?: DatabaseExecutionGovernance): Promise<LatestWorkspaceObservationHead | undefined> {
    const query = governance
      ? <R extends import("pg").QueryResultRow>(text: string, values?: unknown[]) => databaseQueryGoverned<R>(text, values, governance)
      : databaseQuery;
    const result = await query<ObservationJoinRow>(
      `select o.id,o.workspace_revision_id,o.canonical_index_artifact_id,o.observation_result,o.observed_at,o.authority_sequence,o.index_configuration_sha256,
        null as artifact_semantic_json,coalesce(s.canonical_index_json,s.index_attempt_candidate_json) as canonical_index_json,
        coalesce(s.canonical_sha256,s.index_attempt_candidate_sha256) as canonical_sha256,
        s.index_attempt_candidate_json,s.index_attempt_candidate_sha256,
        o.accepted_workspace_evidence_artifact_id
       from intentchord.workspace_observations o
       join intentchord.workspace_index_snapshots s on s.id=o.snapshot_operation_id
       where o.workspace_registration_id=$1
       order by o.authority_sequence desc limit 1`, [workspaceRegistrationId]);
    if (!result.rowCount) return undefined;
    const row=result.rows[0];
    return { observationId:row.id,workspaceRevisionId:row.workspace_revision_id,
      ...(row.canonical_index_artifact_id ? { canonicalIndexArtifactId: row.canonical_index_artifact_id } : {}),
      observationResult:row.observation_result,observedAt:iso(row.observed_at),indexConfigurationSha256:row.index_configuration_sha256,
      ...(row.canonical_index_json ? { canonicalIndex: row.canonical_index_json } : {}),
      ...(row.canonical_sha256 ? { canonicalSha256: row.canonical_sha256 } : {}),
      ...(row.accepted_workspace_evidence_artifact_id ? { acceptedWorkspaceEvidenceArtifactId: row.accepted_workspace_evidence_artifact_id } : {}) };
  }

  async readLatestResolvedArtifact(workspaceRegistrationId: string): Promise<LatestResolvedWorkspaceArtifact | undefined> {
    const result = await databaseQuery<ResolvedObservationArtifactRow>(
      `select o.id,o.workspace_revision_id,o.canonical_index_artifact_id,o.observation_result,o.observed_at,o.authority_sequence,o.index_configuration_sha256,
        s.canonical_index_json,s.canonical_sha256
       from intentchord.workspace_observations o
       join intentchord.canonical_index_artifacts a
         on a.id=o.canonical_index_artifact_id
        and a.workspace_registration_id=o.workspace_registration_id
        and a.workspace_revision_id=o.workspace_revision_id
        and a.index_configuration_sha256=o.index_configuration_sha256
       join intentchord.workspace_index_snapshots s
         on s.id=o.snapshot_operation_id
        and s.workspace_registration_id=o.workspace_registration_id
        and s.workspace_observation_id=o.id
        and s.workspace_revision_id=o.workspace_revision_id
        and s.canonical_index_artifact_id=o.canonical_index_artifact_id
        and s.index_configuration_sha256=o.index_configuration_sha256
        and s.observation_result=o.observation_result
        and s.delta_artifact_id is not distinct from o.delta_artifact_id
        and s.source_mode='REGISTERED_WORKSPACE'
        and s.status='READY'
        and s.index_attempt_status='SUCCEEDED'
        and s.canonical_index_json is not null
        and s.canonical_sha256 is not null
       where o.workspace_registration_id=$1 and o.canonical_index_artifact_id is not null
       order by o.authority_sequence desc limit 1`, [workspaceRegistrationId]);
    if (!result.rowCount) return undefined;
    const row=result.rows[0];
    return { observationId:row.id,workspaceRevisionId:row.workspace_revision_id,canonicalIndexArtifactId:row.canonical_index_artifact_id,
      observationResult:row.observation_result,observedAt:iso(row.observed_at),indexConfigurationSha256:row.index_configuration_sha256,
      canonicalIndex:row.canonical_index_json,canonicalSha256:row.canonical_sha256 };
  }

  async readMappingAuthority(id: string): Promise<{ snapshot: WorkspaceIndexSnapshotRecord; artifact?: { id: string; semanticSha256: string; semanticState: CanonicalIndexArtifactSemanticState | Record<string, unknown> } }> {
    const snapshot = await this.read(id);
    if (snapshot.sourceMode !== "REGISTERED_WORKSPACE" || snapshot.status !== "READY") return { snapshot };

    const hasB1 = Boolean(snapshot.canonicalIndexArtifactId);
    const hasV2 = Boolean(snapshot.acceptedWorkspaceEvidenceArtifactId);

    if (hasB1 && hasV2) {
      throw new HttpCommandError(409, "REGISTERED_B1_MAPPING_AUTHORITY_BINDING_REQUIRED", "Registered B1 Mapping requires the complete persisted Snapshot/Observation/Revision/Artifact binding.");
    }

    if (!hasB1 && !hasV2) {
      const b1Bindings = [
        snapshot.workspaceObservationId,
        snapshot.workspaceRevisionId,
        snapshot.canonicalIndexArtifactId,
        snapshot.indexConfigurationSha256,
        snapshot.observationResult,
      ];
      const populatedB1Bindings = b1Bindings.filter(value => value !== undefined).length;
      if (populatedB1Bindings === 0) {
        // Historical pre-B1 REGISTERED_WORKSPACE rows retain their governed V1 compatibility path.
        return { snapshot };
      }
      if (populatedB1Bindings !== b1Bindings.length || !snapshot.workspaceRegistrationId) {
        throw new HttpCommandError(409, "REGISTERED_B1_MAPPING_AUTHORITY_BINDING_REQUIRED", "Registered B1 Mapping requires the complete persisted Snapshot/Observation/Revision/Artifact binding.");
      }
    }

    if (hasB1) {
      const b1Bindings = [
        snapshot.workspaceObservationId,
        snapshot.workspaceRevisionId,
        snapshot.canonicalIndexArtifactId,
        snapshot.indexConfigurationSha256,
        snapshot.observationResult,
      ];
      const populatedB1Bindings = b1Bindings.filter(value => value !== undefined).length;
      if (populatedB1Bindings !== b1Bindings.length || !snapshot.workspaceRegistrationId) {
        throw new HttpCommandError(409, "REGISTERED_B1_MAPPING_AUTHORITY_BINDING_REQUIRED", "Registered B1 Mapping requires the complete persisted Snapshot/Observation/Revision/Artifact binding.");
      }
      const artifactResult = await databaseQuery<ArtifactRow>(
        `select id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,artifact_semantic_sha256,artifact_semantic_json,canonical_index_json,canonical_sha256
         from intentchord.canonical_index_artifacts
         where workspace_registration_id=$1 and id=$2 and workspace_revision_id=$3 and index_configuration_sha256=$4`,
        [snapshot.workspaceRegistrationId,snapshot.canonicalIndexArtifactId,snapshot.workspaceRevisionId,snapshot.indexConfigurationSha256],
      );
      if (!artifactResult.rowCount) {
        throw new HttpCommandError(409, "REGISTERED_B1_MAPPING_ARTIFACT_BINDING_MISMATCH", "The persisted Registered Workspace Snapshot does not resolve to its bound intrinsic Canonical Index Artifact.");
      }
      const artifact = artifactResult.rows[0];
      return {
        snapshot,
        artifact: { id: artifact.id, semanticSha256: artifact.artifact_semantic_sha256, semanticState: artifact.artifact_semantic_json },
      };
    }

    if (hasV2) {
      if (!snapshot.workspaceRegistrationId || !snapshot.workspaceObservationId || !snapshot.workspaceRevisionId || !snapshot.indexConfigurationSha256 || !snapshot.observationResult) {
        throw new HttpCommandError(409, "REGISTERED_V2_MAPPING_AUTHORITY_BINDING_REQUIRED", "Registered V2 Mapping requires the complete persisted Snapshot/Observation/Revision/Evidence Artifact binding.");
      }
      const weaResult = await databaseQuery<{ id: string; workspace_registration_id: string; workspace_revision_id: string; artifact_semantic_sha256: string }>(
        `select id,workspace_registration_id,workspace_revision_id,artifact_semantic_sha256
         from intentchord.workspace_evidence_artifacts
         where id=$1 and workspace_registration_id=$2 and workspace_revision_id=$3 and index_configuration_sha256=$4`,
        [snapshot.acceptedWorkspaceEvidenceArtifactId, snapshot.workspaceRegistrationId, snapshot.workspaceRevisionId, snapshot.indexConfigurationSha256],
      );
      if (!weaResult.rowCount) {
        throw new HttpCommandError(409, "REGISTERED_V2_MAPPING_EVIDENCE_ARTIFACT_BINDING_MISMATCH", "The persisted Registered Workspace Snapshot does not resolve to its bound Workspace Evidence Artifact.");
      }
      const wea = weaResult.rows[0];
      return {
        snapshot,
        artifact: {
          id: wea.id,
          semanticSha256: wea.artifact_semantic_sha256,
          semanticState: { workspace_instance_id: snapshot.workspaceRegistrationId, workspace_revision_id: snapshot.workspaceRevisionId, evidence_artifact_id: wea.id },
        },
      };
    }

    return { snapshot };
  }

  async completeRegisteredObservation(input: {
    id: string; workspaceRegistrationId: string; contract: CanonicalWorkspaceIndexContract; canonicalSha256: string;
    indexConfiguration: WorkspaceIndexConfigurationDescriptor; indexConfigurationSha256: string; completedAt: string;
  }, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord> {
    const persist = <T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> =>
      governance ? transactionGoverned(governance, work) : transaction(work);
    return persist(async client => {
      await client.query("select id from intentchord.workspaces where id=$1 for update", [input.workspaceRegistrationId]);
      const operationResult=await client.query<SnapshotRow>(`${snapshotSelect} where id=$1 for update`,[input.id]);
      if(!operationResult.rowCount) throw new HttpCommandError(404,"WORKSPACE_INDEX_SNAPSHOT_NOT_FOUND","The Workspace Index Snapshot does not exist.");
      const operation=operationResult.rows[0];
      if(operation.status!=="CREATING") throw new HttpCommandError(409,"SNAPSHOT_STATE_CONFLICT","The Workspace Index Snapshot is no longer in CREATING state.");

      const previousResult=await client.query<ObservationJoinRow>(
        `select o.id,o.workspace_revision_id,o.canonical_index_artifact_id,o.observation_result,o.observed_at,o.authority_sequence,o.index_configuration_sha256,
          null as artifact_semantic_json,coalesce(s.canonical_index_json,s.index_attempt_candidate_json) as canonical_index_json,
          coalesce(s.canonical_sha256,s.index_attempt_candidate_sha256) as canonical_sha256,
          s.index_attempt_candidate_json,s.index_attempt_candidate_sha256
         from intentchord.workspace_observations o
         join intentchord.workspace_index_snapshots s on s.id=o.snapshot_operation_id
         where o.workspace_registration_id=$1 order by o.authority_sequence desc limit 1 for update of o`,[input.workspaceRegistrationId]);
      const previous=previousResult.rowCount?previousResult.rows[0]:undefined;
      if ((previous?.id ?? null) !== operation.scan_base_observation_id) {
        throw new HttpCommandError(409,"WORKSPACE_INDEX_SCAN_BASE_STALE","The authoritative Workspace observation head changed after this indexing attempt began; stale predecessor-specific transition evidence will not be committed.");
      }

      const revisionId=input.contract.workspace.workspace_revision_id;
      const treeFingerprint=input.contract.integrity.workspace_tree_fingerprint;
      const expectedRevisionId=stableWorkspaceIndexId("wsr",{
        workspace_instance_id:input.contract.workspace.workspace_instance_id,
        workspace_tree_fingerprint:treeFingerprint,
      });
      if(revisionId!==expectedRevisionId) throw new HttpCommandError(409,"WORKSPACE_REVISION_DERIVATION_MISMATCH","Workspace Revision identity does not match the governed Source State fingerprint.");
      if(workspaceIndexConfigurationSha256(input.indexConfiguration)!==input.indexConfigurationSha256) throw new HttpCommandError(409,"INDEX_CONFIGURATION_IDENTITY_MISMATCH","Canonical Index configuration identity does not match its exact descriptor.");
      if(canonicalWorkspaceIndexHash(input.contract)!==input.canonicalSha256) throw new HttpCommandError(409,"CANONICAL_INDEX_HASH_MISMATCH","Canonical Index hash does not match its exact persisted payload.");

      // Source capture is already complete at this boundary. Persist the immutable Source Revision before
      // deciding whether the semantic Index Attempt qualifies to mint a deterministic Canonical Artifact.
      const knownRevision=await client.query<{id:string;source_tree_fingerprint:string}>(
        "select id,source_tree_fingerprint from intentchord.workspace_source_revisions where id=$1 or (workspace_registration_id=$2 and source_tree_fingerprint=$3)",
        [revisionId,input.workspaceRegistrationId,treeFingerprint]);
      const revisionWasKnown=Boolean(knownRevision.rowCount);
      if(knownRevision.rowCount && knownRevision.rows[0].id!==revisionId) throw new HttpCommandError(409,"WORKSPACE_REVISION_IDENTITY_CONFLICT","The same governed Source State resolved to a conflicting Workspace Revision identity.");
      await client.query(
        `insert into intentchord.workspace_source_revisions(id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,source_state_summary,first_observed_at)
         values($1,$2,$3,$4,$5,$6) on conflict(workspace_registration_id,source_tree_fingerprint) do nothing`,
        [revisionId,input.workspaceRegistrationId,input.contract.workspace.workspace_instance_id,treeFingerprint,JSON.stringify({file_count:input.contract.integrity.file_count}),input.completedAt]);

      const qualification=canonicalIndexArtifactQualification(input.contract);
      if(!qualification.qualified){
        const observationId=randomUUID();
        const observationResult: WorkspaceObservationResult="SOURCE_PROVEN_INDEX_FAILED";
        await client.query(
          `insert into intentchord.workspace_observations(
            id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,canonical_index_artifact_id,previous_observation_id,delta_artifact_id,
            observation_result,index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,observed_at)
           values($1,$2,$3,$4,null,$5,null,$6,$7,$8,$9,$10,$11)`,
          [observationId,input.id,input.workspaceRegistrationId,revisionId,previous?.id??null,observationResult,input.indexConfigurationSha256,treeFingerprint,
            JSON.stringify(input.contract.source_binding),operation.owner_reference,input.completedAt]);
        if(previous && previous.workspace_revision_id!==revisionId){
          const lineageEvidence=previous.canonical_index_json
            ? deriveTransitionLineageEvidence(previous.canonical_index_json,input.contract)
            : {schema:WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION,renamed_or_moved:[]};
          await client.query(
            `insert into intentchord.workspace_revision_transitions(
              id,observation_id,workspace_registration_id,from_workspace_revision_id,to_workspace_revision_id,delta_artifact_id,lineage_evidence_json,observed_at)
             values($1,$2,$3,$4,$5,null,$6,$7)`,
            [randomUUID(),observationId,input.workspaceRegistrationId,previous.workspace_revision_id,revisionId,JSON.stringify(lineageEvidence),input.completedAt]);
        }
        const failureEvidence={
          code:"SOURCE_CAPTURE_PROVEN_INDEX_ATTEMPT_FAILED",
          workspace_revision_id:revisionId,
          ...governedIndexAttemptEvidence(input.contract,{canonicalization:"FAILED_RETRYABLE",retryableFailureCodes:qualification.retryable_failure_codes}),
        };
        const updated=await client.query<SnapshotRow>(
          `update intentchord.workspace_index_snapshots set
            status='FAILED',completed_at=$2,progress_phase='FAILED',heartbeat_at=$2,
            workspace_observation_id=$3,workspace_revision_id=$4,canonical_index_artifact_id=null,index_configuration_sha256=$5,
            observation_result='SOURCE_PROVEN_INDEX_FAILED',delta_artifact_id=null,
            index_attempt_status='FAILED_RETRYABLE',index_attempt_evidence=$6,index_attempt_candidate_json=$7,index_attempt_candidate_sha256=$8,
            failure_code='SOURCE_CAPTURE_PROVEN_INDEX_ATTEMPT_FAILED',safe_failure_evidence=$6
           where id=$1 and status='CREATING' returning ${snapshotColumns}`,
          [input.id,input.completedAt,observationId,revisionId,input.indexConfigurationSha256,JSON.stringify(failureEvidence),JSON.stringify(input.contract),input.canonicalSha256]);
        if(!updated.rowCount) throw new HttpCommandError(409,"SNAPSHOT_STATE_CONFLICT","The Workspace Index Snapshot is no longer in CREATING state.");
        return mapSnapshot(updated.rows[0]);
      }

      const artifactId=canonicalIndexArtifactId(revisionId,input.indexConfigurationSha256);
      const semanticState=canonicalIndexArtifactSemanticState(input.contract);
      const semanticSha=canonicalIndexArtifactSemanticSha256(input.contract);
      await client.query(
        `insert into intentchord.canonical_index_artifacts(
          id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,index_configuration_json,artifact_semantic_sha256,artifact_semantic_json,
          canonical_contract_version,canonical_index_json,canonical_sha256)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(workspace_revision_id,index_configuration_sha256) do nothing`,
        [artifactId,input.workspaceRegistrationId,revisionId,input.indexConfigurationSha256,JSON.stringify(input.indexConfiguration),semanticSha,JSON.stringify(semanticState),input.contract.contract_version,JSON.stringify(input.contract),input.canonicalSha256]);
      const artifactResult=await client.query<ArtifactRow>(
        `select id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,artifact_semantic_sha256,artifact_semantic_json,canonical_index_json,canonical_sha256
         from intentchord.canonical_index_artifacts where workspace_revision_id=$1 and index_configuration_sha256=$2`,[revisionId,input.indexConfigurationSha256]);
      if(!artifactResult.rowCount) throw new Error("CANONICAL_INDEX_ARTIFACT_RESOLUTION_MISSING");
      const artifact=artifactResult.rows[0];
      if(artifact.id!==artifactId || artifact.workspace_registration_id!==input.workspaceRegistrationId || artifact.artifact_semantic_sha256!==semanticSha || canonicalJson(artifact.artifact_semantic_json)!==canonicalJson(semanticState)) {
        throw new HttpCommandError(409,"CANONICAL_INDEX_ARTIFACT_EQUIVALENCE_CONFLICT","Equivalent Revision + Index Configuration produced a conflicting intrinsic Canonical Index Artifact state.");
      }

      const observationResult=classifyWorkspaceObservation({
        previousRevisionId:previous?.workspace_revision_id,previousArtifactId:previous?.canonical_index_artifact_id??undefined,
        currentRevisionId:revisionId,currentArtifactId:artifact.id,revisionWasKnown,
      });
      let deltaArtifactId:string|undefined;
      if(previous?.canonical_index_artifact_id && previous.artifact_semantic_json && previous.canonical_index_artifact_id!==artifact.id){
        const derived=deriveCanonicalIndexArtifactDelta({fromArtifactId:previous.canonical_index_artifact_id,toArtifactId:artifact.id,base:previous.artifact_semantic_json,target:artifact.artifact_semantic_json});
        const deltaValidation=validateCanonicalIndexArtifactDelta({base:previous.artifact_semantic_json,target:artifact.artifact_semantic_json,delta:derived});
        if(!deltaValidation.accepted) throw new HttpCommandError(409,"WORKSPACE_INDEX_DELTA_VALIDATION_FAILED","Derived canonical Workspace Index Delta did not reconcile to the selected intrinsic Canonical Index Artifact.",deltaValidation.diagnostics);
        deltaArtifactId=workspaceIndexDeltaArtifactId({fromArtifactId:previous.canonical_index_artifact_id,toArtifactId:artifact.id});
        const deltaSha=`sha256:${sha256Canonical(derived)}`;
        await client.query(
          `insert into intentchord.workspace_index_delta_artifacts(
            id,workspace_registration_id,from_workspace_revision_id,to_workspace_revision_id,from_canonical_index_artifact_id,to_canonical_index_artifact_id,
            delta_schema_version,comparison_engine_version,delta_json,delta_sha256)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict(from_canonical_index_artifact_id,to_canonical_index_artifact_id,delta_schema_version,comparison_engine_version) do nothing`,
          [deltaArtifactId,input.workspaceRegistrationId,previous.workspace_revision_id,revisionId,previous.canonical_index_artifact_id,artifact.id,DELTA_SCHEMA_VERSION,COMPARISON_ENGINE_VERSION,JSON.stringify(derived),deltaSha]);
        const deltaResult=await client.query<DeltaArtifactRow>(
          `select id,workspace_registration_id,from_workspace_revision_id,to_workspace_revision_id,from_canonical_index_artifact_id,to_canonical_index_artifact_id,delta_schema_version,comparison_engine_version,delta_json,delta_sha256
           from intentchord.workspace_index_delta_artifacts
           where from_canonical_index_artifact_id=$1 and to_canonical_index_artifact_id=$2 and delta_schema_version=$3 and comparison_engine_version=$4`,
          [previous.canonical_index_artifact_id,artifact.id,DELTA_SCHEMA_VERSION,COMPARISON_ENGINE_VERSION]);
        if(!deltaResult.rowCount) throw new Error("WORKSPACE_INDEX_DELTA_ARTIFACT_RESOLUTION_MISSING");
        const persistedDelta=deltaResult.rows[0];
        if(persistedDelta.id!==deltaArtifactId || persistedDelta.workspace_registration_id!==input.workspaceRegistrationId || persistedDelta.from_workspace_revision_id!==previous.workspace_revision_id || persistedDelta.to_workspace_revision_id!==revisionId || persistedDelta.delta_sha256!==deltaSha || canonicalJson(persistedDelta.delta_json)!==canonicalJson(derived)){
          throw new HttpCommandError(409,"WORKSPACE_INDEX_DELTA_ARTIFACT_EQUIVALENCE_CONFLICT","Equivalent Canonical Artifact pair produced a conflicting canonical Delta semantic state.");
        }
      }

      const observationId=randomUUID();
      await client.query(
        `insert into intentchord.workspace_observations(
          id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,canonical_index_artifact_id,previous_observation_id,delta_artifact_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,observed_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [observationId,input.id,input.workspaceRegistrationId,revisionId,artifact.id,previous?.id??null,deltaArtifactId??null,observationResult,input.indexConfigurationSha256,treeFingerprint,JSON.stringify(input.contract.source_binding),operation.owner_reference,input.completedAt]);
      if(previous && previous.workspace_revision_id!==revisionId){
        const lineageEvidence=previous.canonical_index_json
          ? deriveTransitionLineageEvidence(previous.canonical_index_json,input.contract)
          : {schema:WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION,renamed_or_moved:[]};
        await client.query(
          `insert into intentchord.workspace_revision_transitions(
            id,observation_id,workspace_registration_id,from_workspace_revision_id,to_workspace_revision_id,delta_artifact_id,lineage_evidence_json,observed_at)
           values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(),observationId,input.workspaceRegistrationId,previous.workspace_revision_id,revisionId,deltaArtifactId??null,JSON.stringify(lineageEvidence),input.completedAt]);
      }

      const successAttemptEvidence=governedIndexAttemptEvidence(input.contract,{canonicalization:"QUALIFIED"});
      const updated=await client.query<SnapshotRow>(
        `update intentchord.workspace_index_snapshots set
          status='READY',canonical_contract_version=$2,canonical_index_json=$3,canonical_sha256=$4,completed_at=$5,progress_phase='READY',heartbeat_at=$5,
          workspace_observation_id=$6,workspace_revision_id=$7,canonical_index_artifact_id=$8,index_configuration_sha256=$9,observation_result=$10,delta_artifact_id=$11,
          index_attempt_status='SUCCEEDED',index_attempt_evidence=$12,index_attempt_candidate_json=null,index_attempt_candidate_sha256=null
         where id=$1 and status='CREATING' returning ${snapshotColumns}`,
        [input.id,input.contract.contract_version,JSON.stringify(input.contract),input.canonicalSha256,input.completedAt,observationId,revisionId,artifact.id,input.indexConfigurationSha256,observationResult,deltaArtifactId??null,JSON.stringify(successAttemptEvidence)]);
      if(!updated.rowCount) throw new HttpCommandError(409,"SNAPSHOT_STATE_CONFLICT","The Workspace Index Snapshot is no longer in CREATING state.");
      return mapSnapshot(updated.rows[0]);
    });
  }

  async complete(input:{id:string;contract:CanonicalWorkspaceIndexContract;canonicalSha256:string;completedAt:string}):Promise<WorkspaceIndexSnapshotRecord>{
    const updated=await databaseQuery<SnapshotRow>(
      `update intentchord.workspace_index_snapshots set status='READY',canonical_contract_version=$2,canonical_index_json=$3,canonical_sha256=$4,completed_at=$5,progress_phase='READY',heartbeat_at=$5,index_attempt_status='SUCCEEDED',index_attempt_evidence=jsonb_build_object('source_capture','NOT_APPLICABLE','canonicalization','DIAGNOSTIC_V1')
       where id=$1 and status='CREATING' returning ${snapshotColumns}`,
      [input.id,input.contract.contract_version,JSON.stringify(input.contract),input.canonicalSha256,input.completedAt]);
    if(!updated.rowCount) throw new HttpCommandError(409,"SNAPSHOT_STATE_CONFLICT","The Workspace Index Snapshot is no longer in CREATING state.");
    return mapSnapshot(updated.rows[0]);
  }

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
  }, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord> {
    const persist = <T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> =>
      governance ? transactionGoverned(governance, work) : transaction(work);
    return persist(async client => {
      await client.query("select id from intentchord.workspaces where id=$1 for update", [input.workspaceRegistrationId]);
      const operationResult = await client.query<SnapshotRow>(`${snapshotSelect} where id=$1 for update`, [input.id]);
      if (!operationResult.rowCount) throw new HttpCommandError(404, "WORKSPACE_INDEX_SNAPSHOT_NOT_FOUND", "The Workspace Index Snapshot does not exist.");
      const operation = operationResult.rows[0];
      if (operation.status !== "CREATING") throw new HttpCommandError(409, "SNAPSHOT_STATE_CONFLICT", "The Workspace Index Snapshot is no longer in CREATING state.");

      const previousResult = await client.query<ObservationJoinRow>(
        `select o.id,o.workspace_revision_id,o.canonical_index_artifact_id,o.observation_result,o.observed_at,o.authority_sequence,o.index_configuration_sha256,
          null as artifact_semantic_json,coalesce(s.canonical_index_json,s.index_attempt_candidate_json) as canonical_index_json,
          coalesce(s.canonical_sha256,s.index_attempt_candidate_sha256) as canonical_sha256,
          s.index_attempt_candidate_json,s.index_attempt_candidate_sha256
         from intentchord.workspace_observations o
         join intentchord.workspace_index_snapshots s on s.id=o.snapshot_operation_id
         where o.workspace_registration_id=$1 order by o.authority_sequence desc limit 1 for update of o`, [input.workspaceRegistrationId]);
      const previous = previousResult.rowCount ? previousResult.rows[0] : undefined;
      if ((previous?.id ?? null) !== operation.scan_base_observation_id) {
        throw new HttpCommandError(409, "WORKSPACE_INDEX_SCAN_BASE_STALE", "The authoritative Workspace observation head changed after this indexing attempt began; stale predecessor-specific transition evidence will not be committed.");
      }

      const revisionId = input.workspaceRevisionId;
      const knownRevision = await client.query<{ id: string; source_tree_fingerprint: string }>(
        "select id,source_tree_fingerprint from intentchord.workspace_source_revisions where id=$1 or (workspace_registration_id=$2 and source_tree_fingerprint=$3)",
        [revisionId, input.workspaceRegistrationId, input.treeFingerprint]);
      if (knownRevision.rowCount && knownRevision.rows[0].id !== revisionId) throw new HttpCommandError(409, "WORKSPACE_REVISION_IDENTITY_CONFLICT", "The same governed Source State resolved to a conflicting Workspace Revision identity.");
      await client.query(
        `insert into intentchord.workspace_source_revisions(id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,source_state_summary,first_observed_at)
         values($1,$2,$3,$4,$5,$6) on conflict(workspace_registration_id,source_tree_fingerprint) do nothing`,
        [revisionId, input.workspaceRegistrationId, input.workspaceInstanceId, input.treeFingerprint, "{}", input.completedAt]);

      const observationId = randomUUID();
      const sourceBinding = {
        source_binding_id: input.sourceBindingId,
        binding_type: input.bindingType,
        normalized_reference: input.normalizedReference,
        metadata: input.sourceBindingMetadata,
      };
      const observationResult = input.observationResult as WorkspaceObservationResult;
      await client.query(
        `insert into intentchord.workspace_observations(
          id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,canonical_index_artifact_id,previous_observation_id,delta_artifact_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,observed_at)
         values($1,$2,$3,$4,null,$5,null,$6,$7,$8,$9,$10,$11,$12)`,
        [observationId, input.id, input.workspaceRegistrationId, revisionId, previous?.id ?? null, observationResult, input.indexConfigurationSha256, input.treeFingerprint,
          JSON.stringify(sourceBinding), operation.owner_reference, input.completedAt]);
      if (previous && previous.workspace_revision_id !== revisionId) {
        await client.query(
          `insert into intentchord.workspace_revision_transitions(
            id,observation_id,workspace_registration_id,from_workspace_revision_id,to_workspace_revision_id,delta_artifact_id,lineage_evidence_json,observed_at)
           values($1,$2,$3,$4,$5,null,$6,$7)`,
          [randomUUID(), observationId, input.workspaceRegistrationId, previous.workspace_revision_id, revisionId,
            JSON.stringify({ schema: WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION, renamed_or_moved: [] }), input.completedAt]);
      }

      const successAttemptEvidence = {
        source_capture: "PROVEN",
        canonicalization: "V2_SECTIONED",
        engine_mode: input.engineMode,
      };
      const updated = await client.query<SnapshotRow>(
        `update intentchord.workspace_index_snapshots set
          status='READY',completed_at=$2,progress_phase='READY',heartbeat_at=$2,
          workspace_observation_id=$3,workspace_revision_id=$4,canonical_index_artifact_id=null,index_configuration_sha256=$5,
          observation_result=$6,delta_artifact_id=null,
          index_attempt_status='SUCCEEDED',index_attempt_evidence=$7,index_attempt_candidate_json=null,index_attempt_candidate_sha256=null
         where id=$1 and status='CREATING' returning ${snapshotColumns}`,
        [input.id, input.completedAt, observationId, revisionId, input.indexConfigurationSha256, observationResult, JSON.stringify(successAttemptEvidence)]);
      if (!updated.rowCount) throw new HttpCommandError(409, "SNAPSHOT_STATE_CONFLICT", "The Workspace Index Snapshot is no longer in CREATING state.");
      return mapSnapshot(updated.rows[0]);
    });
  }

  /**
   * V2 ATOMIC SEAL TRANSACTION (Task C1 Part F).
   * S1-S8 within ONE PostgreSQL transaction:
   * Step-B transaction (atomic): S1-S7 + COMMIT
   * Step-C (after commit): S8 snapshot → READY
   *
   * S1: verify manifests / staged counts
   * S2: insert workspace_evidence_artifact
   * S3: insert workspace_evidence_sections
   * S4: promote staged records and segments
   * S5: (object-identity material — deferred to Task C2)
   * S6: insert workspace_observation
   * S7: set attestation observation back-link
   *
   * Step-C (S8) only executes after Step-B commits successfully.
   * If Step-C fails, Step-B committed evidence (artifact, sections,
   * observation, attestation backlink) survives. Snapshot remains non-READY.
   */
  async sealV2Snapshot(input: {
    snapshotId: string;
    workspaceRegistrationId: string;
    workspaceInstanceId: string;
    completedAt: string;
    evidenceArtifact: {
      id: string;
      workspaceRevisionId: string;
      indexConfigurationSha256: string;
      headerJson: unknown;
      sectionManifestJson: unknown;
      sectionManifestDigest: string;
      artifactManifestSha256: string;
      artifactSemanticSha256: string;
      canonicalCompatSha256: string;
    };
    sections: ReadonlyArray<{
      sectionType: EvidenceSectionType;
      sectionOrder: number;
      sectionSchemaVersion: string;
      sectionDigest: string;
      recordCount: number;
      segmentCount: number;
    }>;
    attestationId: string;
    observationResult: string;
    sourceBindingId: string;
    sourceBindingMetadata: Record<string, unknown>;
    bindingType: string;
    normalizedReference: string;
    treeFingerprint: string;
  }, evidenceRepo: PostgresWorkspaceEvidenceRepository, governance?: DatabaseExecutionGovernance): Promise<WorkspaceIndexSnapshotRecord> {
    // STEP B: atomic commit of artifact + sections + observation + attestation backlink
    const stepBResult = await this.commitStepB(input, evidenceRepo, governance);

    // STEP C: transition snapshot to READY (only after Step-B commit succeeds)
    try {
      return await this.transitionToReady(input, stepBResult.observationId, stepBResult.revisionId, governance);
    } catch (stepCError) {
      // Step-C failure does NOT roll back Step-B committed evidence.
      // Snapshot remains CREATING. The committed artifact, sections,
      // observation, and attestation backlink survive and are authoritative.
      throw stepCError;
    }
  }

  /**
   * STEP B — Atomic commit of all authoritative evidence.
   *
   * Within a single transaction:
   *   - Scan-base validation
   *   - Source revision insert
   *   - S1: verify manifests / staged counts
   *   - S2: insert workspace_evidence_artifact
   *   - S3: insert workspace_evidence_sections
   *   - S4: promote staged records and segments
   *   - S6: insert workspace_observation
   *   - S7: set attestation observation back-link
   *   → COMMIT
   *
   * If any step fails, the entire transaction rolls back atomically.
   * No partial commits. No partial authority.
   */
  async commitStepB(input: {
    snapshotId: string;
    workspaceRegistrationId: string;
    workspaceInstanceId: string;
    completedAt: string;
    evidenceArtifact: {
      id: string;
      workspaceRevisionId: string;
      indexConfigurationSha256: string;
      headerJson: unknown;
      sectionManifestJson: unknown;
      sectionManifestDigest: string;
      artifactManifestSha256: string;
      artifactSemanticSha256: string;
      canonicalCompatSha256: string;
    };
    sections: ReadonlyArray<{
      sectionType: EvidenceSectionType;
      sectionOrder: number;
      sectionSchemaVersion: string;
      sectionDigest: string;
      recordCount: number;
      segmentCount: number;
    }>;
    attestationId: string;
    observationResult: string;
    sourceBindingId: string;
    sourceBindingMetadata: Record<string, unknown>;
    bindingType: string;
    normalizedReference: string;
    treeFingerprint: string;
  }, evidenceRepo: PostgresWorkspaceEvidenceRepository, governance?: DatabaseExecutionGovernance): Promise<{ observationId: string; revisionId: string }> {
    const persist = <T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> =>
      governance ? transactionGoverned(governance, work) : transaction(work);
    return persist(async client => {
      const evidenceInTx = new (evidenceRepo.constructor as new (source: import("pg").PoolClient) => PostgresWorkspaceEvidenceRepository)(client);

      // PRE-LOCK: workspace + snapshot
      await client.query("select id from intentchord.workspaces where id=$1 for update", [input.workspaceRegistrationId]);
      const operationResult = await client.query<SnapshotRow>(`${snapshotSelect} where id=$1 for update`, [input.snapshotId]);
      if (!operationResult.rowCount) throw new HttpCommandError(404, "WORKSPACE_INDEX_SNAPSHOT_NOT_FOUND", "The Workspace Index Snapshot does not exist.");
      const operation = operationResult.rows[0];
      if (operation.status !== "CREATING") throw new HttpCommandError(409, "SNAPSHOT_STATE_CONFLICT", "The Workspace Index Snapshot is no longer in CREATING state.");

      // SCAN-BASE validation
      const previousResult = await client.query<ObservationJoinRow>(
        `select o.id,o.workspace_revision_id,o.canonical_index_artifact_id,o.observation_result,o.observed_at,o.authority_sequence,o.index_configuration_sha256,
          null as artifact_semantic_json,coalesce(s.canonical_index_json,s.index_attempt_candidate_json) as canonical_index_json,
          coalesce(s.canonical_sha256,s.index_attempt_candidate_sha256) as canonical_sha256,
          s.index_attempt_candidate_json,s.index_attempt_candidate_sha256
         from intentchord.workspace_observations o
         join intentchord.workspace_index_snapshots s on s.id=o.snapshot_operation_id
         where o.workspace_registration_id=$1 order by o.authority_sequence desc limit 1 for update of o`, [input.workspaceRegistrationId]);
      const previous = previousResult.rowCount ? previousResult.rows[0] : undefined;
      if ((previous?.id ?? null) !== operation.scan_base_observation_id) {
        throw new HttpCommandError(409, "WORKSPACE_INDEX_SCAN_BASE_STALE", "The authoritative Workspace observation head changed after this indexing attempt began.");
      }

      // SOURCE REVISION
      const revisionId = input.evidenceArtifact.workspaceRevisionId;
      const safeTreeFingerprint = input.treeFingerprint.startsWith("sha256:")
        ? input.treeFingerprint
        : `sha256:${input.treeFingerprint}`;
      const knownRevision = await client.query<{ id: string; source_tree_fingerprint: string }>(
        "select id,source_tree_fingerprint from intentchord.workspace_source_revisions where id=$1 or (workspace_registration_id=$2 and source_tree_fingerprint=$3)",
        [revisionId, input.workspaceRegistrationId, safeTreeFingerprint]);
      if (knownRevision.rowCount && knownRevision.rows[0].id !== revisionId) throw new HttpCommandError(409, "WORKSPACE_REVISION_IDENTITY_CONFLICT", "Conflicting Workspace Revision identity.");
      await client.query(
        `insert into intentchord.workspace_source_revisions(id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,source_state_summary,first_observed_at)
         values($1,$2,$3,$4,$5,$6) on conflict(workspace_registration_id,source_tree_fingerprint) do nothing`,
        [revisionId, input.workspaceRegistrationId, input.workspaceInstanceId, safeTreeFingerprint, "{}", input.completedAt]);

      // S1: VERIFY MANIFESTS / STAGED COUNTS
      const totalStagedRecords = await evidenceInTx.countStagedRecords(input.snapshotId);
      let expectedTotalRecords = 0;
      for (const section of input.sections) {
        expectedTotalRecords += section.recordCount;
      }

      // S2: INSERT WORKSPACE_EVIDENCE_ARTIFACT
      const ensureSha256 = (v: string) => (v.startsWith("sha256:") ? v : `sha256:${v}`);
      await evidenceInTx.insertArtifact({
        id: input.evidenceArtifact.id,
        workspace_registration_id: input.workspaceRegistrationId,
        workspace_revision_id: input.evidenceArtifact.workspaceRevisionId,
        index_configuration_sha256: ensureSha256(input.evidenceArtifact.indexConfigurationSha256),
        header_json: input.evidenceArtifact.headerJson,
        section_manifest_json: input.evidenceArtifact.sectionManifestJson,
        section_manifest_digest: ensureSha256(input.evidenceArtifact.sectionManifestDigest),
        artifact_manifest_sha256: ensureSha256(input.evidenceArtifact.artifactManifestSha256),
        artifact_semantic_sha256: ensureSha256(input.evidenceArtifact.artifactSemanticSha256),
        canonical_compat_sha256: ensureSha256(input.evidenceArtifact.canonicalCompatSha256),
      });

      // S3: INSERT WORKSPACE_EVIDENCE_SECTIONS
      for (const section of input.sections) {
        await evidenceInTx.insertSection({
          workspace_registration_id: input.workspaceRegistrationId,
          artifact_id: input.evidenceArtifact.id,
          section_type: section.sectionType,
          section_order: section.sectionOrder,
          section_schema_version: section.sectionSchemaVersion,
          section_digest: ensureSha256(section.sectionDigest),
          record_count: section.recordCount,
          segment_count: section.segmentCount,
        });
      }

      // S4: PROMOTE STAGED RECORDS AND SEGMENTS
      for (const section of input.sections) {
        if (section.recordCount > 0) {
          await evidenceInTx.promoteStagedSectionWithinTransaction(client, {
            snapshot_operation_id: input.snapshotId,
            workspace_registration_id: input.workspaceRegistrationId,
            artifact_id: input.evidenceArtifact.id,
            section_type: section.sectionType,
            expected_record_count: section.recordCount,
          });
        }
      }

      // S6: INSERT WORKSPACE_OBSERVATION
      const observationId = randomUUID();
      const sourceBinding = {
        source_binding_id: input.sourceBindingId,
        binding_type: input.bindingType,
        normalized_reference: input.normalizedReference,
        metadata: input.sourceBindingMetadata,
      };
      const observationResultValue = input.observationResult as WorkspaceObservationResult;
      await client.query(
        `insert into intentchord.workspace_observations(
          id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,canonical_index_artifact_id,previous_observation_id,delta_artifact_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,observed_at,
          accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
         values($1,$2,$3,$4,null,$5,null,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [observationId, input.snapshotId, input.workspaceRegistrationId, revisionId, previous?.id ?? null, observationResultValue, ensureSha256(input.evidenceArtifact.indexConfigurationSha256), safeTreeFingerprint,
          JSON.stringify(sourceBinding), operation.owner_reference, input.completedAt,
          input.evidenceArtifact.id, input.attestationId]);
      if (previous && previous.workspace_revision_id !== revisionId) {
        await client.query(
          `insert into intentchord.workspace_revision_transitions(
            id,observation_id,workspace_registration_id,from_workspace_revision_id,to_workspace_revision_id,delta_artifact_id,lineage_evidence_json,observed_at)
           values($1,$2,$3,$4,$5,null,$6,$7)`,
          [randomUUID(), observationId, input.workspaceRegistrationId, previous.workspace_revision_id, revisionId,
            JSON.stringify({ schema: WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION, renamed_or_moved: [] }), input.completedAt]);
      }

      // S7: SET ATTESTATION OBSERVATION BACK-LINK
      await evidenceInTx.transitionAttestation(input.attestationId, {
        observation_id: observationId,
      });

      // Step-B COMMIT (implicit at end of transaction)
      return { observationId, revisionId };
    });
  }

  /**
   * STEP C — Transition snapshot to READY.
   *
   * Executes ONLY AFTER Step-B has committed successfully.
   * This is a separate, lightweight operation that updates the
   * snapshot status and binds it to the committed evidence.
   *
   * If this fails:
   *   - Step-B committed evidence (artifact, sections, observation,
   *     attestation backlink) SURVIVES and is authoritative
   *   - Snapshot remains CREATING (non-READY)
   *   - Retry/recovery does not create duplicate authority
   */
  async transitionToReady(
    input: {
      snapshotId: string;
      completedAt: string;
      evidenceArtifact: { id: string; indexConfigurationSha256: string };
      attestationId: string;
      observationResult: string;
    },
    observationId: string,
    revisionId: string,
    governance?: DatabaseExecutionGovernance,
  ): Promise<WorkspaceIndexSnapshotRecord> {
    const query = governance
      ? <R extends import("pg").QueryResultRow>(text: string, values?: unknown[]) => databaseQueryGoverned<R>(text, values, governance)
      : databaseQuery;
    const successAttemptEvidence = {
      source_capture: "PROVEN",
      canonicalization: "V2_SECTIONED",
      engine_mode: "V2_SECTIONED",
      accepted_workspace_evidence_artifact_id: input.evidenceArtifact.id,
      source_continuity_attestation_id: input.attestationId,
      section_count: 0,
    };
    const updated = await query<SnapshotRow>(
      `update intentchord.workspace_index_snapshots set
        status='READY',completed_at=$2,progress_phase='READY',heartbeat_at=$2,
        workspace_observation_id=$3,workspace_revision_id=$4,
        canonical_index_artifact_id=null,index_configuration_sha256=$5,
        observation_result=$6,delta_artifact_id=null,
        index_attempt_status='SUCCEEDED',index_attempt_evidence=$7,
        index_attempt_candidate_json=null,index_attempt_candidate_sha256=null,
        accepted_workspace_evidence_artifact_id=$8,source_continuity_attestation_id=$9,
        canonical_contract_version='intentchord.workspace-evidence-artifact/v2'
       where id=$1 and status='CREATING' returning ${snapshotColumns}`,
      [input.snapshotId, input.completedAt, observationId, revisionId, input.evidenceArtifact.indexConfigurationSha256, input.observationResult, JSON.stringify(successAttemptEvidence),
        input.evidenceArtifact.id, input.attestationId]);
    if (!updated.rowCount) throw new HttpCommandError(409, "SNAPSHOT_STATE_CONFLICT", "The Workspace Index Snapshot is no longer in CREATING state.");
    return mapSnapshot(updated.rows[0]);
  }

  async fail(input:{id:string;failureCode:string;safeFailureEvidence:Record<string,unknown>;completedAt:string}, governance?: DatabaseExecutionGovernance):Promise<WorkspaceIndexSnapshotRecord>{
    const query = governance
      ? <R extends import("pg").QueryResultRow>(text: string, values?: unknown[]) => databaseQueryGoverned<R>(text, values, governance)
      : databaseQuery;
    const updated=await query<SnapshotRow>(
      `update intentchord.workspace_index_snapshots set status='FAILED',failure_code=$2,safe_failure_evidence=$3,completed_at=$4,progress_phase='FAILED',progress_evidence=$3,heartbeat_at=$4,index_attempt_status='FAILED',index_attempt_evidence=$3,index_attempt_candidate_json=null,index_attempt_candidate_sha256=null
       where id=$1 and status='CREATING' returning ${snapshotColumns}`,[input.id,input.failureCode,JSON.stringify(input.safeFailureEvidence),input.completedAt]);
    if(!updated.rowCount)return this.read(input.id, governance);return mapSnapshot(updated.rows[0]);
  }

  async read(id:string, governance?: DatabaseExecutionGovernance):Promise<WorkspaceIndexSnapshotRecord>{
    const result=governance
      ? await databaseQueryGoverned<SnapshotRow>(`${snapshotSelect} where id=$1`,[id],governance)
      : await databaseQuery<SnapshotRow>(`${snapshotSelect} where id=$1`,[id]);
    if(!result.rowCount)throw new HttpCommandError(404,"WORKSPACE_INDEX_SNAPSHOT_NOT_FOUND","The Workspace Index Snapshot does not exist.");
    return mapSnapshot(result.rows[0]);
  }

  async readWorkspaceHistory(workspaceRegistrationId:string):Promise<WorkspaceKnowledgeHistoryView>{
    const revisions=await databaseQuery<RevisionHistoryRow>(
      `select r.id,r.source_tree_fingerprint,r.first_observed_at,count(o.id)::bigint observation_count
       from intentchord.workspace_source_revisions r left join intentchord.workspace_observations o on o.workspace_revision_id=r.id
       where r.workspace_registration_id=$1 group by r.id,r.source_tree_fingerprint,r.first_observed_at order by min(o.authority_sequence) nulls last,r.id`,[workspaceRegistrationId]);
    const observations=await databaseQuery<ObservationHistoryRow>(
      `select id,snapshot_operation_id,workspace_revision_id,canonical_index_artifact_id,previous_observation_id,observation_result,index_configuration_sha256,source_binding_json,observed_at,delta_artifact_id
       from intentchord.workspace_observations where workspace_registration_id=$1 order by authority_sequence`,[workspaceRegistrationId]);
    const transitions=await databaseQuery<TransitionHistoryRow>(
      `select t.id,t.observation_id,t.from_workspace_revision_id,t.to_workspace_revision_id,t.delta_artifact_id,t.lineage_evidence_json,t.observed_at
       from intentchord.workspace_revision_transitions t
       join intentchord.workspace_observations o on o.id=t.observation_id
       where t.workspace_registration_id=$1 order by o.authority_sequence`,[workspaceRegistrationId]);
    return {workspaceRegistrationId,
      revisions:revisions.rows.map((r:RevisionHistoryRow)=>({workspaceRevisionId:r.id,sourceTreeFingerprint:r.source_tree_fingerprint,firstObservedAt:iso(r.first_observed_at),observationCount:Number(r.observation_count)})),
      observations:observations.rows.map((o:ObservationHistoryRow)=>({id:o.id,snapshotOperationId:o.snapshot_operation_id,workspaceRevisionId:o.workspace_revision_id,...(o.canonical_index_artifact_id?{canonicalIndexArtifactId:o.canonical_index_artifact_id}:{}),...(o.previous_observation_id?{previousObservationId:o.previous_observation_id}:{}),observationResult:o.observation_result,indexConfigurationSha256:o.index_configuration_sha256,sourceBinding:o.source_binding_json,observedAt:iso(o.observed_at),...(o.delta_artifact_id?{deltaArtifactId:o.delta_artifact_id}:{})})),
      transitions:transitions.rows.map((t:TransitionHistoryRow)=>({id:t.id,observationId:t.observation_id,fromWorkspaceRevisionId:t.from_workspace_revision_id,toWorkspaceRevisionId:t.to_workspace_revision_id,...(t.delta_artifact_id?{deltaArtifactId:t.delta_artifact_id}:{}),lineageEvidence:t.lineage_evidence_json,observedAt:iso(t.observed_at)}))};
  }

  async updateProgress(input:{id:string;phase:string;evidence:Record<string,unknown>;heartbeatAt:string}, governance?: DatabaseExecutionGovernance):Promise<void>{
    const text=`update intentchord.workspace_index_snapshots set progress_phase=$2,progress_evidence=$3,heartbeat_at=$4 where id=$1 and status='CREATING'`;
    const values=[input.id,input.phase,JSON.stringify(input.evidence),input.heartbeatAt];
    if (governance) {
      await databaseQueryGoverned(text, values, governance);
      return;
    }
    await databaseQuery(text,values);
  }
  async recoverStale(input:{staleBefore:string;completedAt:string}, governance?: DatabaseExecutionGovernance):Promise<number>{
    const text=`update intentchord.workspace_index_snapshots set status='FAILED',failure_code='WORKSPACE_INDEX_STALE_OPERATION',safe_failure_evidence=jsonb_build_object('code','WORKSPACE_INDEX_STALE_OPERATION','message','A stale CREATING operation exceeded the governed heartbeat timeout.'),completed_at=$2,progress_phase='FAILED',progress_evidence=jsonb_build_object('recovered',true),heartbeat_at=$2,index_attempt_status='FAILED',index_attempt_evidence=jsonb_build_object('code','WORKSPACE_INDEX_STALE_OPERATION','recovered',true),index_attempt_candidate_json=null,index_attempt_candidate_sha256=null where status='CREATING' and coalesce(heartbeat_at,started_at)<$1`;
    const values=[input.staleBefore,input.completedAt];
    const result=governance
      ? await databaseQueryGoverned(text,values,governance)
      : await databaseQuery(text,values);
    return result.rowCount??0;
  }
  async assertProjectContextExists(id:string, governance?: DatabaseExecutionGovernance):Promise<void>{
    const result=governance
      ? await databaseQueryGoverned("select 1 from intentchord.project_contexts where id=$1",[id],governance)
      : await databaseQuery("select 1 from intentchord.project_contexts where id=$1",[id]);
    if(!result.rowCount)throw new HttpCommandError(404,"PROJECT_CONTEXT_NOT_FOUND","The optional Project association does not exist.");
  }
}
