import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256 } from "@/core/ai-context-mapper/prompt";
import { assertMappingRunTransition } from "@/core/ai-context-mapper/state";
import {
  MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
  PROMPT_TEMPLATE_ID,
  type CatalogValidationResult,
  type ContextMappingResultEnvelope,
  type InternalAiProviderConfigurationSnapshot,
  type MappingAttemptView,
  type MappingProposalView,
  type MappingRunStatus,
  type MappingRunView,
  type NormalizedProviderErrorCode,
  type OwnerContextDecisionView,
  type ProviderId,
} from "@/core/ai-context-mapper/types";
import type {
  AiContextMappingRepository,
  CompleteAttemptRecord,
  CreateRunRecord,
  SuccessfulAttemptRecord,
} from "@/core/ai-context-mapper/orchestrator";
import { databaseQuery, transaction } from "@/server/db";
import { ConflictError, HttpCommandError } from "@/server/errors";

function asIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function asObject<T>(value: unknown, fallback: T): T {
  return value && typeof value === "object" ? value as T : fallback;
}

type RunRow = QueryResultRow & {
  id: string;
  status: MappingRunStatus;
  mapping_input_snapshot_id: string;
  mapping_input_sha256: string;
  workspace_snapshot_id: string;
  workspace_index_sha256: string;
  workspace_index_snapshot_id: string | null;
  canonical_index_artifact_id: string | null;
  artifact_semantic_sha256: string | null;
  mapping_idempotency_key: string | null;
  mapping_request_fingerprint_sha256: string | null;
  eligible_entry_count: number;
  excluded_entry_count: number;
  provider_neutral_estimated_tokens: number;
  primary_provider_id: ProviderId;
  primary_channel_id: string;
  primary_model_id: string;
  standby_provider_id: ProviderId | null;
  standby_channel_id: string | null;
  standby_model_id: string | null;
  provider_configuration_snapshot: InternalAiProviderConfigurationSnapshot;
  standby_enabled: boolean;
  standby_governance_state: "BLOCKED_BY_GOVERNANCE" | "QUALIFIED";
  final_attempt_id: string | null;
  owner_verdict_state: "PENDING" | "ACCEPTED" | "REJECTED";
  created_at: Date | string;
  updated_at: Date | string;
};

type AttemptRow = QueryResultRow & {
  id: string;
  mapping_run_id: string;
  attempt_ordinal: number;
  provider_id: ProviderId;
  channel_id: string;
  requested_model_id: string;
  response_model_id: string | null;
  provider_request_id: string | null;
  provider_system_fingerprint: string | null;
  status: MappingAttemptView["status"];
  normalized_error_code: NormalizedProviderErrorCode | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  duration_ms: number | null;
  retry_count: number;
  raw_response_sha256: string | null;
  parsed_catalog_sha256: string | null;
  validation_summary: CatalogValidationResult | null;
  usage_metadata: MappingAttemptView["usageMetadata"];
  rate_limit_metadata: MappingAttemptView["rateLimitMetadata"];
};

type ProposalRow = QueryResultRow & {
  id: string;
  mapping_run_id: string;
  source_attempt_id: string;
  schema_version: string;
  proposal_json: MappingProposalView["modelProposal"];
  proposal_sha256: string;
  deterministic_validation_evidence: CatalogValidationResult;
  result_envelope: ContextMappingResultEnvelope;
  created_at: Date | string;
};

type VerdictRow = QueryResultRow & { verdict: "ACCEPT" | "REJECT"; note: string | null };

type ContextDecisionRow = QueryResultRow & {
  id: string;
  mapping_run_id: string;
  proposal_id: string;
  context_id: string;
  context_sha256: string;
  decision: "ACCEPT" | "REJECT";
  note: string | null;
  owner_reference: string;
  created_at: Date | string;
};

function mapAttempt(row: AttemptRow): MappingAttemptView {
  return {
    id: row.id,
    runId: row.mapping_run_id,
    ordinal: Number(row.attempt_ordinal),
    providerId: row.provider_id,
    channelId: row.channel_id,
    requestedModelId: row.requested_model_id,
    ...(row.response_model_id ? { responseModelId: row.response_model_id } : {}),
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
    ...(row.provider_system_fingerprint ? { providerSystemFingerprint: row.provider_system_fingerprint } : {}),
    status: row.status,
    ...(row.normalized_error_code ? { normalizedErrorCode: row.normalized_error_code } : {}),
    startedAt: asIso(row.started_at)!,
    ...(row.completed_at ? { completedAt: asIso(row.completed_at)! } : {}),
    ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}),
    retryCount: Number(row.retry_count),
    ...(row.raw_response_sha256 ? { rawResponseSha256: row.raw_response_sha256 } : {}),
    ...(row.parsed_catalog_sha256 ? { parsedCatalogSha256: row.parsed_catalog_sha256 } : {}),
    ...(row.validation_summary ? { validationResult: row.validation_summary } : {}),
    usageMetadata: asObject(row.usage_metadata, {}),
    rateLimitMetadata: asObject(row.rate_limit_metadata, {}),
  };
}

function mapProposal(row: ProposalRow): MappingProposalView {
  return {
    id: row.id,
    runId: row.mapping_run_id,
    attemptId: row.source_attempt_id,
    proposalSha256: row.proposal_sha256,
    schemaVersion: row.schema_version,
    validationEvidence: row.deterministic_validation_evidence,
    resultEnvelope: row.result_envelope,
    modelProposal: row.proposal_json,
    createdAt: asIso(row.created_at)!,
  };
}

function mapDecision(row: ContextDecisionRow): OwnerContextDecisionView {
  return {
    id: row.id,
    runId: row.mapping_run_id,
    proposalId: row.proposal_id,
    contextId: row.context_id,
    contextSha256: row.context_sha256,
    decision: row.decision,
    ...(row.note ? { note: row.note } : {}),
    ownerReference: row.owner_reference,
    createdAt: asIso(row.created_at)!,
  };
}

const runSelectV012 = `select id,status,mapping_input_snapshot_id,mapping_input_sha256,workspace_snapshot_id,
  workspace_index_sha256,workspace_index_snapshot_id,canonical_index_artifact_id,artifact_semantic_sha256,
  mapping_idempotency_key,mapping_request_fingerprint_sha256,
  eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,
  primary_provider_id,primary_channel_id,primary_model_id,standby_provider_id,standby_channel_id,standby_model_id,standby_enabled,
  standby_governance_state,provider_configuration_snapshot,final_attempt_id,owner_verdict_state,created_at,updated_at
  from intentchord.context_mapping_runs`;

const runSelectV010 = `select id,status,mapping_input_snapshot_id,mapping_input_sha256,workspace_snapshot_id,
  workspace_index_sha256,workspace_index_snapshot_id,null::text as canonical_index_artifact_id,
  null::text as artifact_semantic_sha256,mapping_idempotency_key,mapping_request_fingerprint_sha256,
  eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,
  primary_provider_id,primary_channel_id,primary_model_id,standby_provider_id,standby_channel_id,standby_model_id,standby_enabled,
  standby_governance_state,provider_configuration_snapshot,final_attempt_id,owner_verdict_state,created_at,updated_at
  from intentchord.context_mapping_runs`;

const runSelectV009 = `select id,status,mapping_input_snapshot_id,mapping_input_sha256,workspace_snapshot_id,
  workspace_index_sha256,null::uuid as workspace_index_snapshot_id,null::text as canonical_index_artifact_id,
  null::text as artifact_semantic_sha256,null::text as mapping_idempotency_key,
  null::text as mapping_request_fingerprint_sha256,eligible_entry_count,excluded_entry_count,
  provider_neutral_estimated_tokens,primary_provider_id,primary_channel_id,primary_model_id,standby_provider_id,
  standby_channel_id,standby_model_id,standby_enabled,standby_governance_state,provider_configuration_snapshot,final_attempt_id,owner_verdict_state,
  created_at,updated_at from intentchord.context_mapping_runs`;

type WorkspaceAnalysisPersistenceState = {
  snapshots: boolean;
  runBinding: boolean;
  artifactRunBinding: boolean;
  contextDecisions: boolean;
};

function asDatabaseQuery(queryable: Pick<PoolClient, "query">): typeof databaseQuery {
  return async <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => queryable.query<R>(text, values);
}

async function workspaceAnalysisPersistenceState(
  query: typeof databaseQuery,
): Promise<WorkspaceAnalysisPersistenceState> {
  const result = await query<{
    snapshots: boolean;
    run_binding: boolean;
    artifact_run_binding: boolean;
    context_decisions: boolean;
  }>(`select
      to_regclass('intentchord.workspace_index_snapshots') is not null as snapshots,
      exists(
        select 1 from information_schema.columns
        where table_schema='intentchord' and table_name='context_mapping_runs'
          and column_name='workspace_index_snapshot_id'
      ) as run_binding,
      (
        exists(
          select 1 from information_schema.columns
          where table_schema='intentchord' and table_name='context_mapping_runs'
            and column_name='canonical_index_artifact_id'
        ) and exists(
          select 1 from information_schema.columns
          where table_schema='intentchord' and table_name='context_mapping_runs'
            and column_name='artifact_semantic_sha256'
        ) and exists(
          select 1 from intentchord.schema_migrations
          where id='012_workspace_revision_observation_and_index_artifacts.sql'
        )
      ) as artifact_run_binding,
      to_regclass('intentchord.context_mapping_owner_context_decisions') is not null as context_decisions`);
  const row = result.rows[0];
  return {
    snapshots: Boolean(row?.snapshots),
    runBinding: Boolean(row?.run_binding),
    artifactRunBinding: Boolean(row?.artifact_run_binding),
    contextDecisions: Boolean(row?.context_decisions),
  };
}

function rollbackOnlyLegacyMode(): boolean {
  return process.env.NODE_ENV === "test" && process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST === "1";
}

async function readRunWith(queryable: Pick<PoolClient, "query">, runId: string): Promise<MappingRunView> {
  const persistence = await workspaceAnalysisPersistenceState(asDatabaseQuery(queryable));
  const runSelect = persistence.artifactRunBinding ? runSelectV012 : persistence.runBinding ? runSelectV010 : runSelectV009;
  const run = await queryable.query<RunRow>(`${runSelect} where id=$1`, [runId]);
  if (!run.rowCount) throw new HttpCommandError(404, "CONTEXT_MAPPING_RUN_NOT_FOUND", "The context mapping run does not exist.");
  const proposal = await queryable.query<ProposalRow>(
    `select id,mapping_run_id,source_attempt_id,schema_version,proposal_json,proposal_sha256,
      deterministic_validation_evidence,result_envelope,created_at
     from intentchord.context_catalog_proposals where mapping_run_id=$1`, [runId]);
  const verdict = await queryable.query<VerdictRow>(
    `select verdict,note from intentchord.context_mapping_owner_verdicts where mapping_run_id=$1`, [runId]);
  const decisions = persistence.contextDecisions
    ? await queryable.query<ContextDecisionRow>(
      `select id,mapping_run_id,proposal_id,context_id,context_sha256,decision,note,owner_reference,created_at
       from intentchord.context_mapping_owner_context_decisions where mapping_run_id=$1 order by context_id`, [runId])
    : { rows: [] as ContextDecisionRow[] };
  const row = run.rows[0];
  return {
    id: row.id,
    status: row.status,
    mappingInputSnapshotId: row.mapping_input_snapshot_id,
    mappingInputSha256: row.mapping_input_sha256,
    workspaceSnapshotId: row.workspace_snapshot_id,
    workspaceIndexSha256: row.workspace_index_sha256,
    ...(row.workspace_index_snapshot_id ? { workspaceIndexSnapshotId: row.workspace_index_snapshot_id } : {}),
    ...(row.canonical_index_artifact_id ? { canonicalIndexArtifactId: row.canonical_index_artifact_id } : {}),
    ...(row.artifact_semantic_sha256 ? { artifactSemanticSha256: row.artifact_semantic_sha256 } : {}),
    eligibleEntryCount: Number(row.eligible_entry_count),
    excludedEntryCount: Number(row.excluded_entry_count),
    estimatedTokens: Number(row.provider_neutral_estimated_tokens),
    primaryProviderId: row.primary_provider_id,
    primaryChannelId: row.primary_channel_id,
    primaryModelId: row.primary_model_id,
    ...(row.standby_provider_id ? { standbyProviderId: row.standby_provider_id } : {}),
    ...(row.standby_channel_id ? { standbyChannelId: row.standby_channel_id } : {}),
    ...(row.standby_model_id ? { standbyModelId: row.standby_model_id } : {}),
    providerConfigurationSnapshot: row.provider_configuration_snapshot,
    standbyEnabled: row.standby_enabled,
    standbyGovernanceState: row.standby_governance_state,
    ...(row.final_attempt_id ? { finalAttemptId: row.final_attempt_id } : {}),
    ownerVerdictState: row.owner_verdict_state,
    ...(verdict.rows[0]?.note ? { ownerVerdictNote: verdict.rows[0].note } : {}),
    createdAt: asIso(row.created_at)!,
    updatedAt: asIso(row.updated_at)!,
    ...(proposal.rows[0] ? { proposal: mapProposal(proposal.rows[0]) } : {}),
    ownerContextDecisions: decisions.rows.map(mapDecision),
  };
}

async function transitionRunWith(queryable: Pick<PoolClient, "query">, runId: string, status: MappingRunStatus, finalAttemptId?: string): Promise<void> {
  const locked = await queryable.query<{ status: MappingRunStatus }>("select status from intentchord.context_mapping_runs where id=$1 for update", [runId]);
  if (!locked.rowCount) throw new HttpCommandError(404, "CONTEXT_MAPPING_RUN_NOT_FOUND", "The context mapping run does not exist.");
  assertMappingRunTransition(locked.rows[0].status, status);
  if (finalAttemptId) {
    const attempt = await queryable.query("select 1 from intentchord.context_mapping_attempts where id=$1 and mapping_run_id=$2", [finalAttemptId, runId]);
    if (!attempt.rowCount) throw new ConflictError("Final attempt must belong to the same mapping run.");
  }
  await queryable.query(
    `update intentchord.context_mapping_runs set status=$2,final_attempt_id=coalesce($3,final_attempt_id) where id=$1`,
    [runId, status, finalAttemptId ?? null],
  );
}

async function completeAttemptWith(queryable: Pick<PoolClient, "query">, record: CompleteAttemptRecord): Promise<MappingAttemptView> {
  const existing = await queryable.query<{ started_at: Date | string }>(
    "select started_at from intentchord.context_mapping_attempts where id=$1 and status='RUNNING' for update", [record.attemptId]);
  if (!existing.rowCount) throw new ConflictError("A mapping attempt can be completed exactly once from RUNNING state.");
  const durationMs = Math.max(0, Date.parse(record.completedAt) - Date.parse(asIso(existing.rows[0].started_at)!));
  const response = record.response;
  const update = await queryable.query(
    `update intentchord.context_mapping_attempts set
      status=$2,normalized_error_code=$3,response_model_id=$4,provider_request_id=$5,
      provider_system_fingerprint=$6,completed_at=$7,duration_ms=$8,retry_count=$9,
      usage_metadata=$10,rate_limit_metadata=$11,raw_response_sha256=$12,raw_response_body=$13,
      parsed_catalog_sha256=$14,validation_summary=$15
     where id=$1 and status='RUNNING'`,
    [
      record.attemptId, record.status, record.normalizedErrorCode ?? null,
      response?.response_model_id ?? null, response?.provider_request_id ?? null,
      response?.provider_system_fingerprint ?? null, record.completedAt, durationMs, record.retryCount,
      JSON.stringify(response?.usage_metadata ?? {}), JSON.stringify(response?.rate_limit_metadata ?? {}),
      record.validation?.raw_response_sha256 ?? null, response?.raw_model_content ?? null,
      record.validation?.parsed_catalog_sha256 ?? null, record.validation ? JSON.stringify(record.validation) : null,
    ],
  );
  if (!update.rowCount) throw new ConflictError("A mapping attempt can be completed exactly once.");
  const row = await queryable.query<AttemptRow>(
    `select id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,response_model_id,
      provider_request_id,provider_system_fingerprint,status,normalized_error_code,started_at,completed_at,
      duration_ms,retry_count,raw_response_sha256,parsed_catalog_sha256,validation_summary,usage_metadata,rate_limit_metadata
     from intentchord.context_mapping_attempts where id=$1`, [record.attemptId]);
  return mapAttempt(row.rows[0]);
}

async function insertProposalWith(queryable: Pick<PoolClient, "query">, record: SuccessfulAttemptRecord): Promise<MappingProposalView> {
  const proposalSha = mapperSha256(record.proposal.catalog);
  await queryable.query(
    `insert into intentchord.context_catalog_proposals(
      id,mapping_run_id,source_attempt_id,schema_version,proposal_json,proposal_sha256,
      deterministic_validation_evidence,result_envelope,created_at
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      record.proposal.id, record.proposal.runId, record.proposal.attemptId,
      MODEL_PROPOSED_CATALOG_SCHEMA_VERSION, JSON.stringify(record.proposal.catalog), proposalSha,
      JSON.stringify(record.proposal.validation), JSON.stringify(record.envelope), record.proposal.createdAt,
    ],
  );
  const row = await queryable.query<ProposalRow>(
    `select id,mapping_run_id,source_attempt_id,schema_version,proposal_json,proposal_sha256,
      deterministic_validation_evidence,result_envelope,created_at
     from intentchord.context_catalog_proposals where id=$1`, [record.proposal.id]);
  return mapProposal(row.rows[0]);
}

export type MappingRunBinding = {
  workspaceIndexSnapshotId: string;
  idempotencyKey: string;
  requestFingerprintSha256: string;
};

export class ExistingMappingRunError extends Error {
  constructor(public readonly run: MappingRunView) {
    super("MAPPING_RUN_ALREADY_EXISTS");
  }
}

async function createLegacyRollbackTestSnapshot(client: PoolClient, record: CreateRunRecord): Promise<MappingRunBinding> {
  if (process.env.NODE_ENV !== "test" || process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST !== "1") {
    throw new HttpCommandError(500, "MAPPING_SNAPSHOT_BINDING_REQUIRED", "A persisted Workspace Index Snapshot binding is required.");
  }
  const id = randomUUID();
  const idempotencyKey = `legacy-test-snapshot-${record.id}`;
  const requestFingerprintSha256 = mapperSha256({ legacy_test_run_id: record.id });
  await client.query(
    `insert into intentchord.workspace_index_snapshots(
      id,source_mode,status,governed_scope,snapshot_idempotency_key,snapshot_request_fingerprint_sha256,
      canonical_contract_version,canonical_index_json,canonical_sha256,owner_reference,started_at,completed_at
    ) values($1,'ADVANCED_DIAGNOSTIC','READY','{}'::jsonb,$2,$3,$4,'{}'::jsonb,$5,'rollback-test',clock_timestamp(),clock_timestamp())`,
    [id, idempotencyKey, requestFingerprintSha256, record.input.workspace_index_contract_version, record.input.workspace_index_sha256],
  );
  return {
    workspaceIndexSnapshotId: id,
    idempotencyKey: `legacy-test-mapping-${record.id}`,
    requestFingerprintSha256: mapperSha256({ legacy_test_mapping_run_id: record.id }),
  };
}

export class PostgresAiContextMappingRepository implements AiContextMappingRepository {
  constructor(private readonly binding?: MappingRunBinding) {}

  async findIdempotentRun(idempotencyKey: string, requestFingerprintSha256: string): Promise<MappingRunView | undefined> {
    const persistence = await workspaceAnalysisPersistenceState(databaseQuery);
    if (!persistence.runBinding) {
      throw new HttpCommandError(503, "WORKSPACE_ANALYSIS_MIGRATION_REQUIRED", "Migration 010 must be applied before creating governed Workspace Analysis mappings.");
    }
    const runSelect = persistence.artifactRunBinding ? runSelectV012 : runSelectV010;
    const result = await databaseQuery<RunRow>(`${runSelect} where mapping_idempotency_key=$1`, [idempotencyKey]);
    if (!result.rowCount) return undefined;
    if (result.rows[0].mapping_request_fingerprint_sha256 !== requestFingerprintSha256) {
      throw new HttpCommandError(409, "IDEMPOTENCY_CONFLICT", "The Mapping idempotency key is already bound to a different canonical request fingerprint.");
    }
    return this.readRun(result.rows[0].id);
  }

  async createRun(record: CreateRunRecord): Promise<MappingRunView> {
    const activeEngine = record.providerConfigurationSnapshot.active;
    const standbyEngine = record.providerConfigurationSnapshot.standby;
    return transaction(async client => {
      const persistence = await workspaceAnalysisPersistenceState(asDatabaseQuery(client));
      if (!persistence.runBinding) {
        if (record.input.mapping_input_schema_version === "intentchord.ai-context-mapping-input.v2") {
          throw new HttpCommandError(503, "WORKSPACE_ANALYSIS_MIGRATION_012_REQUIRED", "Migration 012 must be applied before persisting Registered B1 Mapping Artifact authority.");
        }
        if (this.binding || !rollbackOnlyLegacyMode()) {
          throw new HttpCommandError(503, "WORKSPACE_ANALYSIS_MIGRATION_REQUIRED", "Migration 010 must be applied before creating governed Workspace Analysis mappings.");
        }
        await client.query(
          `insert into intentchord.context_mapping_runs(
            id,mapping_input_snapshot_id,mapping_input_sha256,mapping_input_snapshot,
            workspace_index_contract_version,workspace_snapshot_id,workspace_index_sha256,
            eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,status,
            primary_provider_id,primary_channel_id,primary_model_id,
            standby_provider_id,standby_channel_id,standby_model_id,standby_enabled,
            standby_governance_state,provider_configuration_snapshot
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CREATED',$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            record.id, record.input.mapping_input_snapshot_id, record.inputSha256, JSON.stringify(record.input),
            record.input.workspace_index_contract_version, record.input.workspace_snapshot_id, record.input.workspace_index_sha256,
            record.input.eligible_entry_count, record.input.excluded_entry_count, record.input.provider_neutral_estimated_tokens,
            activeEngine.provider_id, activeEngine.channel_id, activeEngine.model_id,
            standbyEngine?.provider_id ?? null, standbyEngine?.channel_id ?? null, standbyEngine?.model_id ?? null,
            record.standbyEnabled, record.standbyGovernanceState,
            JSON.stringify(record.providerConfigurationSnapshot),
          ],
        );
        return readRunWith(client, record.id);
      }

      const b1ArtifactBinding = record.input.mapping_input_schema_version === "intentchord.ai-context-mapping-input.v2"
        ? { id: record.input.canonical_index_artifact_id, semanticSha256: record.input.artifact_semantic_sha256 }
        : undefined;
      const isB1ArtifactInput = Boolean(b1ArtifactBinding);
      if (isB1ArtifactInput && !persistence.artifactRunBinding) {
        throw new HttpCommandError(503, "WORKSPACE_ANALYSIS_MIGRATION_012_REQUIRED", "Migration 012 must be applied before persisting Registered B1 Mapping Artifact authority.");
      }

      const binding = this.binding ?? await createLegacyRollbackTestSnapshot(client, record);
      const inserted = persistence.artifactRunBinding
        ? await client.query<{ id: string }>(
          `insert into intentchord.context_mapping_runs(
            id,mapping_input_snapshot_id,mapping_input_sha256,mapping_input_snapshot,
            workspace_index_contract_version,workspace_snapshot_id,workspace_index_sha256,
            workspace_index_snapshot_id,canonical_index_artifact_id,artifact_semantic_sha256,
            mapping_idempotency_key,mapping_request_fingerprint_sha256,
            eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,status,
            primary_provider_id,primary_channel_id,primary_model_id,
            standby_provider_id,standby_channel_id,standby_model_id,standby_enabled,
            standby_governance_state,provider_configuration_snapshot
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'CREATED',$16,$17,$18,$19,$20,$21,$22,$23,$24)
          on conflict(mapping_idempotency_key) where mapping_idempotency_key is not null do nothing returning id`,
          [
            record.id, record.input.mapping_input_snapshot_id, record.inputSha256, JSON.stringify(record.input),
            record.input.workspace_index_contract_version, record.input.workspace_snapshot_id, record.input.workspace_index_sha256,
            binding.workspaceIndexSnapshotId,
            b1ArtifactBinding?.id ?? null,
            b1ArtifactBinding?.semanticSha256 ?? null,
            binding.idempotencyKey, binding.requestFingerprintSha256,
            record.input.eligible_entry_count, record.input.excluded_entry_count, record.input.provider_neutral_estimated_tokens,
            activeEngine.provider_id, activeEngine.channel_id, activeEngine.model_id,
            standbyEngine?.provider_id ?? null, standbyEngine?.channel_id ?? null, standbyEngine?.model_id ?? null,
            record.standbyEnabled, record.standbyGovernanceState,
            JSON.stringify(record.providerConfigurationSnapshot),
          ],
        )
        : await client.query<{ id: string }>(
        `insert into intentchord.context_mapping_runs(
          id,mapping_input_snapshot_id,mapping_input_sha256,mapping_input_snapshot,
          workspace_index_contract_version,workspace_snapshot_id,workspace_index_sha256,
          workspace_index_snapshot_id,mapping_idempotency_key,mapping_request_fingerprint_sha256,
          eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,status,
          primary_provider_id,primary_channel_id,primary_model_id,
          standby_provider_id,standby_channel_id,standby_model_id,standby_enabled,
          standby_governance_state,provider_configuration_snapshot
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CREATED',$14,$15,$16,$17,$18,$19,$20,$21,$22)
        on conflict(mapping_idempotency_key) where mapping_idempotency_key is not null do nothing returning id`,
        [
          record.id, record.input.mapping_input_snapshot_id, record.inputSha256, JSON.stringify(record.input),
          record.input.workspace_index_contract_version, record.input.workspace_snapshot_id, record.input.workspace_index_sha256,
          binding.workspaceIndexSnapshotId, binding.idempotencyKey, binding.requestFingerprintSha256,
          record.input.eligible_entry_count, record.input.excluded_entry_count, record.input.provider_neutral_estimated_tokens,
          activeEngine.provider_id, activeEngine.channel_id, activeEngine.model_id,
          standbyEngine?.provider_id ?? null, standbyEngine?.channel_id ?? null, standbyEngine?.model_id ?? null,
          record.standbyEnabled, record.standbyGovernanceState,
          JSON.stringify(record.providerConfigurationSnapshot),
        ],
      );
      if (!inserted.rowCount) {
        const runSelect = persistence.artifactRunBinding ? runSelectV012 : runSelectV010;
        const existingRow = await client.query<RunRow>(`${runSelect} where mapping_idempotency_key=$1`, [binding.idempotencyKey]);
        if (!existingRow.rowCount) throw new Error("MAPPING_IDEMPOTENCY_RESERVATION_MISSING");
        if (existingRow.rows[0].mapping_request_fingerprint_sha256 !== binding.requestFingerprintSha256) {
          throw new HttpCommandError(409, "IDEMPOTENCY_CONFLICT", "The Mapping idempotency key is already bound to a different canonical request fingerprint.");
        }
        throw new ExistingMappingRunError(await readRunWith(client, existingRow.rows[0].id));
      }
      return readRunWith(client, record.id);
    });
  }

  async transitionRunStatus(runId: string, status: MappingRunStatus, finalAttemptId?: string): Promise<void> {
    await transaction(client => transitionRunWith(client, runId, status, finalAttemptId));
  }

  async startAttempt(input: { id: string; runId: string; ordinal: number; providerId: ProviderId; channelId: string; requestedModelId: string; startedAt: string; runStatus: "PRIMARY_RUNNING" | "STANDBY_RUNNING" }): Promise<void> {
    await transaction(async client => {
      await transitionRunWith(client, input.runId, input.runStatus);
      await client.query(
        `insert into intentchord.context_mapping_attempts(
          id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,
          prompt_template_id,prompt_template_sha256,status,started_at
        ) values($1,$2,$3,$4,$5,$6,$7,$8,'RUNNING',$9)`,
        [input.id, input.runId, input.ordinal, input.providerId, input.channelId, input.requestedModelId, PROMPT_TEMPLATE_ID, AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256, input.startedAt],
      );
    });
  }

  async finalizeTechnicalAttempt(record: CompleteAttemptRecord & { status: "FAILED_TECHNICAL" }, runStatus: "PRIMARY_FAILED_TECHNICAL" | "FAILED"): Promise<MappingAttemptView> {
    return transaction(async client => {
      const attempt = await completeAttemptWith(client, record);
      await transitionRunWith(client, attempt.runId, runStatus, attempt.id);
      return attempt;
    });
  }

  async finalizeValidationFailure(record: CompleteAttemptRecord & { status: "FAILED_VALIDATION" }): Promise<MappingAttemptView> {
    return transaction(async client => {
      const running = await client.query<{ mapping_run_id: string }>(
        "select mapping_run_id from intentchord.context_mapping_attempts where id=$1 and status='RUNNING' for update",
        [record.attemptId],
      );
      if (!running.rowCount) throw new ConflictError("A mapping attempt can be completed exactly once from RUNNING state.");
      await transitionRunWith(client, running.rows[0].mapping_run_id, "VALIDATING");
      const attempt = await completeAttemptWith(client, record);
      await transitionRunWith(client, attempt.runId, "REJECTED_VALIDATION", attempt.id);
      return attempt;
    });
  }

  async finalizeSuccessfulAttempt(record: SuccessfulAttemptRecord): Promise<MappingProposalView> {
    return transaction(async client => {
      const running = await client.query<{ mapping_run_id: string }>(
        "select mapping_run_id from intentchord.context_mapping_attempts where id=$1 and status='RUNNING' for update",
        [record.completion.attemptId],
      );
      if (!running.rowCount) throw new ConflictError("A mapping attempt can be completed exactly once from RUNNING state.");
      if (running.rows[0].mapping_run_id !== record.proposal.runId || record.completion.attemptId !== record.proposal.attemptId) {
        throw new ConflictError("Proposal provenance must bind to the completed attempt and run.");
      }
      await transitionRunWith(client, record.proposal.runId, "VALIDATING");
      const attempt = await completeAttemptWith(client, record.completion);
      const proposal = await insertProposalWith(client, record);
      await transitionRunWith(client, attempt.runId, "AWAITING_OWNER_REVIEW", attempt.id);
      return proposal;
    });
  }

  async readRun(runId: string): Promise<MappingRunView> {
    return transaction(client => readRunWith(client, runId));
  }

  async listAttempts(runId: string): Promise<MappingAttemptView[]> {
    const rows = await databaseQuery<AttemptRow>(
      `select id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,response_model_id,
        provider_request_id,provider_system_fingerprint,status,normalized_error_code,started_at,completed_at,
        duration_ms,retry_count,raw_response_sha256,parsed_catalog_sha256,validation_summary,usage_metadata,rate_limit_metadata
       from intentchord.context_mapping_attempts where mapping_run_id=$1 order by attempt_ordinal`, [runId]);
    return rows.rows.map(mapAttempt);
  }

  async recordOwnerReview(input: {
    runId: string;
    verdict: "ACCEPT" | "REJECT";
    contextDecisions: Array<{ contextId: string; decision: "ACCEPT" | "REJECT"; note?: string }>;
    note?: string;
    ownerAuthority: string;
    createdAt: string;
  }): Promise<MappingRunView> {
    return transaction(async client => {
      const persistence = await workspaceAnalysisPersistenceState(asDatabaseQuery(client));
      if (!persistence.contextDecisions) {
        throw new HttpCommandError(503, "WORKSPACE_ANALYSIS_MIGRATION_REQUIRED", "Migration 010 must be applied before recording Context-level Owner decisions.");
      }
      const locked = await client.query<{ status: MappingRunStatus; owner_verdict_state: string }>(
        "select status,owner_verdict_state from intentchord.context_mapping_runs where id=$1 for update", [input.runId]);
      if (!locked.rowCount) throw new HttpCommandError(404, "CONTEXT_MAPPING_RUN_NOT_FOUND", "The context mapping run does not exist.");
      if (locked.rows[0].status !== "AWAITING_OWNER_REVIEW" || locked.rows[0].owner_verdict_state !== "PENDING") {
        throw new HttpCommandError(409, "OWNER_REVIEW_STATE_CONFLICT", "Owner review is allowed exactly once while the validated proposal awaits review.");
      }
      const proposalResult = await client.query<ProposalRow>(
        `select id,mapping_run_id,source_attempt_id,schema_version,proposal_json,proposal_sha256,
          deterministic_validation_evidence,result_envelope,created_at
         from intentchord.context_catalog_proposals where mapping_run_id=$1 for update`, [input.runId]);
      if (!proposalResult.rowCount) throw new HttpCommandError(409, "VALIDATED_PROPOSAL_REQUIRED", "A validated Proposal is required before Owner review.");
      const proposal = mapProposal(proposalResult.rows[0]);
      const contexts = proposal.modelProposal.contexts;
      const byId = new Map(contexts.map(context => [context.context_id, context]));
      if (input.contextDecisions.length !== contexts.length || new Set(input.contextDecisions.map(item => item.contextId)).size !== contexts.length) {
        throw new HttpCommandError(409, "OWNER_REVIEW_INCOMPLETE", "Every proposed Context must receive exactly one explicit Owner decision.");
      }
      let accepted = 0;
      for (const decision of input.contextDecisions) {
        const context = byId.get(decision.contextId);
        if (!context) throw new HttpCommandError(409, "OWNER_REVIEW_UNKNOWN_CONTEXT", "An Owner decision references a Context outside the validated Proposal.");
        if (decision.decision === "ACCEPT") accepted += 1;
        await client.query(
          `insert into intentchord.context_mapping_owner_context_decisions(
            id,mapping_run_id,proposal_id,context_id,context_sha256,decision,note,owner_reference,created_at
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(), input.runId, proposal.id, context.context_id, mapperSha256(context), decision.decision, decision.note ?? null, input.ownerAuthority, input.createdAt],
        );
      }
      if (input.verdict === "ACCEPT" && accepted < 1) {
        throw new HttpCommandError(409, "OWNER_REVIEW_STATE_CONFLICT", "Run-level ACCEPT requires at least one explicitly accepted Context.");
      }
      if (input.verdict === "REJECT" && accepted !== 0) {
        throw new HttpCommandError(409, "OWNER_REVIEW_STATE_CONFLICT", "Run-level REJECT requires every proposed Context to be explicitly rejected.");
      }
      await client.query(
        `insert into intentchord.context_mapping_owner_verdicts(id,mapping_run_id,verdict,note,owner_reference,created_at)
         values($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), input.runId, input.verdict, input.note ?? null, input.ownerAuthority, input.createdAt],
      );
      const targetStatus = input.verdict === "ACCEPT" ? "OWNER_ACCEPTED" : "OWNER_REJECTED";
      const targetVerdictState = input.verdict === "ACCEPT" ? "ACCEPTED" : "REJECTED";
      assertMappingRunTransition(locked.rows[0].status, targetStatus);
      await client.query(
        `update intentchord.context_mapping_runs set status=$2,owner_verdict_state=$3 where id=$1`,
        [input.runId, targetStatus, targetVerdictState],
      );
      return readRunWith(client, input.runId);
    });
  }

  async recordOwnerVerdict(input: { runId: string; verdict: "ACCEPT" | "REJECT"; note?: string; ownerAuthority: string; createdAt: string }): Promise<MappingRunView> {
    const persistence = await workspaceAnalysisPersistenceState(databaseQuery);
    if (persistence.contextDecisions) {
      const run = await this.readRun(input.runId);
      if (!run.proposal) throw new HttpCommandError(409, "VALIDATED_PROPOSAL_REQUIRED", "A validated Proposal is required before Owner review.");
      return this.recordOwnerReview({
        ...input,
        contextDecisions: run.proposal.modelProposal.contexts.map(context => ({ contextId: context.context_id, decision: input.verdict })),
      });
    }
    if (!rollbackOnlyLegacyMode()) {
      throw new HttpCommandError(503, "WORKSPACE_ANALYSIS_MIGRATION_REQUIRED", "Migration 010 must be applied before recording governed Owner decisions.");
    }
    return transaction(async client => {
      const locked = await client.query<{ status: MappingRunStatus; owner_verdict_state: string }>(
        "select status,owner_verdict_state from intentchord.context_mapping_runs where id=$1 for update", [input.runId]);
      if (!locked.rowCount) throw new HttpCommandError(404, "CONTEXT_MAPPING_RUN_NOT_FOUND", "The context mapping run does not exist.");
      if (locked.rows[0].status !== "AWAITING_OWNER_REVIEW" || locked.rows[0].owner_verdict_state !== "PENDING") {
        throw new ConflictError("Owner verdict is allowed exactly once while the proposal awaits review.");
      }
      await client.query(
        `insert into intentchord.context_mapping_owner_verdicts(id,mapping_run_id,verdict,note,owner_reference,created_at)
         values($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), input.runId, input.verdict, input.note ?? null, input.ownerAuthority, input.createdAt],
      );
      const targetStatus = input.verdict === "ACCEPT" ? "OWNER_ACCEPTED" : "OWNER_REJECTED";
      const targetVerdictState = input.verdict === "ACCEPT" ? "ACCEPTED" : "REJECTED";
      assertMappingRunTransition(locked.rows[0].status, targetStatus);
      await client.query(
        `update intentchord.context_mapping_runs set status=$2,owner_verdict_state=$3 where id=$1`,
        [input.runId, targetStatus, targetVerdictState],
      );
      return readRunWith(client, input.runId);
    });
  }
}

export class InMemoryAiContextMappingRepository implements AiContextMappingRepository {
  private readonly runs = new Map<string, MappingRunView>();
  private readonly attempts = new Map<string, MappingAttemptView>();

  async createRun(record: CreateRunRecord): Promise<MappingRunView> {
    const now = new Date().toISOString();
    const activeEngine = record.providerConfigurationSnapshot.active;
    const standbyEngine = record.providerConfigurationSnapshot.standby;
    const run: MappingRunView = {
      id: record.id,
      status: "CREATED",
      mappingInputSnapshotId: record.input.mapping_input_snapshot_id,
      mappingInputSha256: record.inputSha256,
      workspaceSnapshotId: record.input.workspace_snapshot_id,
      workspaceIndexSha256: record.input.workspace_index_sha256,
      ...(record.input.mapping_input_schema_version === "intentchord.ai-context-mapping-input.v2" ? {
        canonicalIndexArtifactId: record.input.canonical_index_artifact_id,
        artifactSemanticSha256: record.input.artifact_semantic_sha256,
      } : {}),
      eligibleEntryCount: record.input.eligible_entry_count,
      excludedEntryCount: record.input.excluded_entry_count,
      estimatedTokens: record.input.provider_neutral_estimated_tokens,
      primaryProviderId: activeEngine.provider_id,
      primaryChannelId: activeEngine.channel_id,
      primaryModelId: activeEngine.model_id,
      ...(standbyEngine ? {
        standbyProviderId: standbyEngine.provider_id,
        standbyChannelId: standbyEngine.channel_id,
        standbyModelId: standbyEngine.model_id,
      } : {}),
      providerConfigurationSnapshot: record.providerConfigurationSnapshot,
      standbyEnabled: record.standbyEnabled,
      standbyGovernanceState: record.standbyGovernanceState,
      ownerVerdictState: "PENDING",
      createdAt: now,
      updatedAt: now,
      ownerContextDecisions: [],
    };
    this.runs.set(record.id, run);
    return run;
  }

  async transitionRunStatus(runId: string, status: MappingRunStatus, finalAttemptId?: string): Promise<void> {
    const run = await this.readRun(runId);
    assertMappingRunTransition(run.status, status);
    if (finalAttemptId && this.attempts.get(finalAttemptId)?.runId !== runId) throw new Error("FINAL_ATTEMPT_RUN_MISMATCH");
    this.runs.set(runId, { ...run, status, ...(finalAttemptId ? { finalAttemptId } : {}), updatedAt: new Date().toISOString() });
  }

  async startAttempt(input: { id: string; runId: string; ordinal: number; providerId: ProviderId; channelId: string; requestedModelId: string; startedAt: string; runStatus: "PRIMARY_RUNNING" | "STANDBY_RUNNING" }): Promise<void> {
    const run = await this.readRun(input.runId);
    assertMappingRunTransition(run.status, input.runStatus);
    const expected = input.ordinal === 1
      ? { providerId: run.primaryProviderId, channelId: run.primaryChannelId, modelId: run.primaryModelId }
      : input.ordinal === 2
        ? { providerId: run.standbyProviderId, channelId: run.standbyChannelId, modelId: run.standbyModelId }
        : undefined;
    if (!expected) throw new Error("ATTEMPT_ORDINAL_INVALID");
    if (input.providerId !== expected.providerId || input.channelId !== expected.channelId || input.requestedModelId !== expected.modelId) {
      throw new Error(input.ordinal === 1 ? "PRIMARY_ATTEMPT_ENGINE_MISMATCH" : "STANDBY_ATTEMPT_ENGINE_MISMATCH");
    }
    if (input.ordinal === 2 && (!run.standbyEnabled || run.standbyGovernanceState !== "QUALIFIED")) {
      throw new Error("STANDBY_ATTEMPT_GOVERNANCE_BLOCKED");
    }
    if ([...this.attempts.values()].some(item => item.runId === input.runId && item.ordinal === input.ordinal)) throw new Error("DUPLICATE_ATTEMPT_ORDINAL");
    this.runs.set(input.runId, { ...run, status: input.runStatus, updatedAt: input.startedAt });
    this.attempts.set(input.id, {
      id: input.id,
      runId: input.runId,
      ordinal: input.ordinal,
      providerId: input.providerId,
      channelId: input.channelId,
      requestedModelId: input.requestedModelId,
      status: "RUNNING",
      startedAt: input.startedAt,
      retryCount: 0,
      usageMetadata: {},
      rateLimitMetadata: {},
    });
  }

  private complete(record: CompleteAttemptRecord): MappingAttemptView {
    const attempt = this.attempts.get(record.attemptId);
    if (!attempt || attempt.status !== "RUNNING") throw new Error("ATTEMPT_COMPLETION_CONFLICT");
    const response = record.response;
    const completed: MappingAttemptView = {
      ...attempt,
      status: record.status,
      ...(record.normalizedErrorCode ? { normalizedErrorCode: record.normalizedErrorCode } : {}),
      ...(response?.response_model_id ? { responseModelId: response.response_model_id } : {}),
      ...(response?.provider_request_id ? { providerRequestId: response.provider_request_id } : {}),
      ...(response?.provider_system_fingerprint ? { providerSystemFingerprint: response.provider_system_fingerprint } : {}),
      completedAt: record.completedAt,
      durationMs: Math.max(0, Date.parse(record.completedAt) - Date.parse(attempt.startedAt)),
      retryCount: record.retryCount,
      ...(record.validation?.raw_response_sha256 ? { rawResponseSha256: record.validation.raw_response_sha256 } : {}),
      ...(record.validation?.parsed_catalog_sha256 ? { parsedCatalogSha256: record.validation.parsed_catalog_sha256 } : {}),
      ...(record.validation ? { validationResult: record.validation } : {}),
      usageMetadata: response?.usage_metadata ?? {},
      rateLimitMetadata: response?.rate_limit_metadata ?? {},
    };
    this.attempts.set(record.attemptId, completed);
    return completed;
  }

  async finalizeTechnicalAttempt(record: CompleteAttemptRecord & { status: "FAILED_TECHNICAL" }, runStatus: "PRIMARY_FAILED_TECHNICAL" | "FAILED"): Promise<MappingAttemptView> {
    const existing = this.attempts.get(record.attemptId);
    if (!existing || existing.status !== "RUNNING") throw new Error("ATTEMPT_COMPLETION_CONFLICT");
    const run = await this.readRun(existing.runId);
    assertMappingRunTransition(run.status, runStatus);
    const attempt = this.complete(record);
    this.runs.set(existing.runId, { ...run, status: runStatus, finalAttemptId: attempt.id, updatedAt: record.completedAt });
    return attempt;
  }

  async finalizeValidationFailure(record: CompleteAttemptRecord & { status: "FAILED_VALIDATION" }): Promise<MappingAttemptView> {
    const existing = this.attempts.get(record.attemptId);
    if (!existing || existing.status !== "RUNNING") throw new Error("ATTEMPT_COMPLETION_CONFLICT");
    const run = await this.readRun(existing.runId);
    assertMappingRunTransition(run.status, "VALIDATING");
    assertMappingRunTransition("VALIDATING", "REJECTED_VALIDATION");
    const attempt = this.complete(record);
    this.runs.set(existing.runId, { ...run, status: "REJECTED_VALIDATION", finalAttemptId: attempt.id, updatedAt: record.completedAt });
    return attempt;
  }

  async finalizeSuccessfulAttempt(record: SuccessfulAttemptRecord): Promise<MappingProposalView> {
    const existing = this.attempts.get(record.completion.attemptId);
    if (!existing || existing.status !== "RUNNING") throw new Error("ATTEMPT_COMPLETION_CONFLICT");
    if (existing.runId !== record.proposal.runId || existing.id !== record.proposal.attemptId) throw new Error("PROPOSAL_PROVENANCE_MISMATCH");
    const run = await this.readRun(existing.runId);
    assertMappingRunTransition(run.status, "VALIDATING");
    assertMappingRunTransition("VALIDATING", "AWAITING_OWNER_REVIEW");
    const attempt = this.complete(record.completion);
    const proposal: MappingProposalView = {
      id: record.proposal.id,
      runId: record.proposal.runId,
      attemptId: record.proposal.attemptId,
      proposalSha256: mapperSha256(record.proposal.catalog),
      schemaVersion: MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
      validationEvidence: record.proposal.validation,
      resultEnvelope: record.envelope,
      modelProposal: record.proposal.catalog,
      createdAt: record.proposal.createdAt,
    };
    this.runs.set(attempt.runId, {
      ...run,
      status: "AWAITING_OWNER_REVIEW",
      finalAttemptId: attempt.id,
      proposal,
      updatedAt: record.proposal.createdAt,
    });
    return proposal;
  }

  async readRun(runId: string): Promise<MappingRunView> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    return run;
  }

  async listAttempts(runId: string): Promise<MappingAttemptView[]> {
    return [...this.attempts.values()].filter(attempt => attempt.runId === runId).sort((left, right) => left.ordinal - right.ordinal);
  }

  async recordOwnerReview(input: {
    runId: string;
    verdict: "ACCEPT" | "REJECT";
    contextDecisions: Array<{ contextId: string; decision: "ACCEPT" | "REJECT"; note?: string }>;
    note?: string;
    ownerAuthority: string;
    createdAt: string;
  }): Promise<MappingRunView> {
    const run = await this.readRun(input.runId);
    if (run.status !== "AWAITING_OWNER_REVIEW" || run.ownerVerdictState !== "PENDING" || !run.proposal) {
      throw new HttpCommandError(409, "OWNER_VERDICT_CONFLICT", "Owner review is allowed exactly once while the validated Proposal awaits review.");
    }
    const contexts = run.proposal.modelProposal.contexts;
    const byId = new Map(contexts.map(context => [context.context_id, context]));
    if (input.contextDecisions.length !== contexts.length || new Set(input.contextDecisions.map(item => item.contextId)).size !== contexts.length) {
      throw new HttpCommandError(409, "OWNER_REVIEW_INCOMPLETE", "Every proposed Context must receive exactly one explicit Owner decision.");
    }
    let accepted = 0;
    const decisions: OwnerContextDecisionView[] = input.contextDecisions.map(decision => {
      const context = byId.get(decision.contextId);
      if (!context) {
        throw new HttpCommandError(409, "OWNER_REVIEW_UNKNOWN_CONTEXT", "An Owner decision references a Context outside the validated Proposal.");
      }
      if (decision.decision === "ACCEPT") accepted += 1;
      return {
        id: randomUUID(),
        runId: input.runId,
        proposalId: run.proposal!.id,
        contextId: context.context_id,
        contextSha256: mapperSha256(context),
        decision: decision.decision,
        ...(decision.note ? { note: decision.note } : {}),
        ownerReference: input.ownerAuthority,
        createdAt: input.createdAt,
      };
    });
    if (input.verdict === "ACCEPT" && accepted < 1) {
      throw new HttpCommandError(409, "OWNER_REVIEW_STATE_CONFLICT", "Run-level ACCEPT requires at least one explicitly accepted Context.");
    }
    if (input.verdict === "REJECT" && accepted !== 0) {
      throw new HttpCommandError(409, "OWNER_REVIEW_STATE_CONFLICT", "Run-level REJECT requires every proposed Context to be explicitly rejected.");
    }
    await this.transitionRunStatus(input.runId, input.verdict === "ACCEPT" ? "OWNER_ACCEPTED" : "OWNER_REJECTED");
    const transitioned = await this.readRun(input.runId);
    const next: MappingRunView = {
      ...transitioned,
      ownerVerdictState: input.verdict === "ACCEPT" ? "ACCEPTED" : "REJECTED",
      ...(input.note ? { ownerVerdictNote: input.note } : {}),
      ownerContextDecisions: decisions,
      updatedAt: input.createdAt,
    };
    this.runs.set(input.runId, next);
    return next;
  }

  async recordOwnerVerdict(input: { runId: string; verdict: "ACCEPT" | "REJECT"; note?: string; ownerAuthority: string; createdAt: string }): Promise<MappingRunView> {
    const run = await this.readRun(input.runId);
    if (!run.proposal) throw new HttpCommandError(409, "VALIDATED_PROPOSAL_REQUIRED", "A validated Proposal is required before Owner review.");
    return this.recordOwnerReview({
      ...input,
      contextDecisions: run.proposal.modelProposal.contexts.map(context => ({ contextId: context.context_id, decision: input.verdict })),
    });
  }
}
