import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256_V2 } from "@/core/ai-context-mapper/prompt-v2";
import { assertMappingRunTransition } from "@/core/ai-context-mapper/state";
import type {
  InternalAiProviderConfigurationSnapshotV3,
  MappingAttemptView,
  MappingRunStatus,
  NormalizedProviderErrorCode,
  ProviderAttemptResponse,
  ProviderId,
} from "@/core/ai-context-mapper/types";
import {
  CONTEXT_ASSEMBLY_CONTRACT_VERSION,
  CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
  CONTEXT_MAPPING_PROMPT_TEMPLATE_ID_V2,
  CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,
  MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2,
  type ContextAssemblyMappingInputV2,
  type ContextMappingResultEnvelopeV2,
  type ContextMappingV2ValidationResult,
  type ModelContextAnalysisV2,
  type GovernedMappingInputSnapshotEnvelopeV2,
} from "@/core/ai-context-mapper/v2";
import { databaseQuery, transaction } from "@/server/db";
import { ConflictError, HttpCommandError } from "@/server/errors";

function asIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

type RunRow = QueryResultRow & {
  id: string;
  status: MappingRunStatus;
  context_assembly_revision_id: string;
  context_assembly_sha256: string;
  mapping_input_sha256: string;
  provider_configuration_snapshot: InternalAiProviderConfigurationSnapshotV3;
  final_attempt_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  execution_deadline_at: Date | string | null;
  deadline_policy_version: string | null;
  terminal_reason_code: string | null;
};

type AttemptRow = QueryResultRow & {
  id: string; mapping_run_id: string; attempt_ordinal: number; provider_id: ProviderId; channel_id: string;
  requested_model_id: string; response_model_id: string | null; provider_request_id: string | null;
  provider_system_fingerprint: string | null; status: MappingAttemptView["status"];
  normalized_error_code: NormalizedProviderErrorCode | null; started_at: Date | string; completed_at: Date | string | null;
  duration_ms: number | null; retry_count: number; raw_response_sha256: string | null; parsed_catalog_sha256: string | null;
  validation_summary: ContextMappingV2ValidationResult | null; usage_metadata: MappingAttemptView["usageMetadata"];
  rate_limit_metadata: MappingAttemptView["rateLimitMetadata"];
};

type V2ResultRow = QueryResultRow & {
  id: string; mapping_run_id: string; source_attempt_id: string; context_assembly_revision_id: string;
  analysis_outcome: ModelContextAnalysisV2["analysis_outcome"]; analysis_json: ModelContextAnalysisV2;
  analysis_sha256: string; deterministic_validation_evidence: ContextMappingV2ValidationResult;
  result_envelope: ContextMappingResultEnvelopeV2; created_at: Date | string;
};

export type ContextMappingV2RunView = {
  id: string;
  status: MappingRunStatus;
  contextAssemblyRevisionId: string;
  contextAssemblySha256: string;
  mappingInputSha256: string;
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
  finalAttemptId?: string;
  createdAt: string;
  updatedAt: string;
  executionDeadlineAt?: string;
  deadlinePolicyVersion?: string;
  terminalReasonCode?: string;
  result?: {
    id: string;
    attemptId: string;
    analysisOutcome: ModelContextAnalysisV2["analysis_outcome"];
    analysis: ModelContextAnalysisV2;
    analysisSha256: string;
    validation: ContextMappingV2ValidationResult;
    envelope: ContextMappingResultEnvelopeV2;
    createdAt: string;
  };
};

export type CreateContextMappingV2RunRecord = {
  id: string;
  input: ContextAssemblyMappingInputV2;
  inputSha256: string;
  assemblySha256: string;
  idempotencyKey: string;
  requestFingerprintSha256: string;
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
  standbyEnabled: boolean;
  standbyGovernanceState: "BLOCKED_BY_GOVERNANCE" | "QUALIFIED";
};

export type CompleteContextMappingV2AttemptRecord = {
  attemptId: string;
  status: MappingAttemptView["status"];
  normalizedErrorCode?: NormalizedProviderErrorCode;
  response?: ProviderAttemptResponse;
  validation?: ContextMappingV2ValidationResult;
  retryCount: number;
  completedAt: string;
};

function mapAttempt(row: AttemptRow): MappingAttemptView {
  return {
    id: row.id, runId: row.mapping_run_id, ordinal: Number(row.attempt_ordinal), providerId: row.provider_id,
    channelId: row.channel_id, requestedModelId: row.requested_model_id,
    ...(row.response_model_id ? { responseModelId: row.response_model_id } : {}),
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
    ...(row.provider_system_fingerprint ? { providerSystemFingerprint: row.provider_system_fingerprint } : {}),
    status: row.status, ...(row.normalized_error_code ? { normalizedErrorCode: row.normalized_error_code } : {}),
    startedAt: asIso(row.started_at)!, ...(row.completed_at ? { completedAt: asIso(row.completed_at)! } : {}),
    ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}), retryCount: Number(row.retry_count),
    ...(row.raw_response_sha256 ? { rawResponseSha256: row.raw_response_sha256 } : {}),
    ...(row.parsed_catalog_sha256 ? { parsedCatalogSha256: row.parsed_catalog_sha256 } : {}),
    ...(row.validation_summary ? { validationResult: row.validation_summary } : {}),
    usageMetadata: row.usage_metadata ?? {}, rateLimitMetadata: row.rate_limit_metadata ?? {},
  };
}

async function readRunWith(client: Pick<PoolClient, "query">, runId: string): Promise<ContextMappingV2RunView> {
  const run = await client.query<RunRow>(
    `select id,status,context_assembly_revision_id,context_assembly_sha256,mapping_input_sha256,
      provider_configuration_snapshot,final_attempt_id,created_at,updated_at,execution_deadline_at,deadline_policy_version,terminal_reason_code
     from intentchord.context_mapping_runs where id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2'`, [runId]);
  if (!run.rowCount) throw new HttpCommandError(404, "CONTEXT_MAPPING_V2_RUN_NOT_FOUND", "The V2 Context Mapping Run does not exist.");
  const result = await client.query<V2ResultRow>(
    `select id,mapping_run_id,source_attempt_id,context_assembly_revision_id,analysis_outcome,analysis_json,analysis_sha256,
      deterministic_validation_evidence,result_envelope,created_at
     from intentchord.context_mapping_v2_results where mapping_run_id=$1`, [runId]);
  const row = run.rows[0];
  const v2 = result.rows[0];
  return {
    id: row.id, status: row.status, contextAssemblyRevisionId: row.context_assembly_revision_id,
    contextAssemblySha256: row.context_assembly_sha256, mappingInputSha256: row.mapping_input_sha256,
    providerConfigurationSnapshot: row.provider_configuration_snapshot,
    ...(row.final_attempt_id ? { finalAttemptId: row.final_attempt_id } : {}),
    createdAt: asIso(row.created_at)!, updatedAt: asIso(row.updated_at)!,
    ...(row.execution_deadline_at ? { executionDeadlineAt: asIso(row.execution_deadline_at)! } : {}),
    ...(row.deadline_policy_version ? { deadlinePolicyVersion: row.deadline_policy_version } : {}),
    ...(row.terminal_reason_code ? { terminalReasonCode: row.terminal_reason_code } : {}),
    ...(v2 ? { result: {
      id: v2.id, attemptId: v2.source_attempt_id, analysisOutcome: v2.analysis_outcome,
      analysis: v2.analysis_json, analysisSha256: v2.analysis_sha256,
      validation: v2.deterministic_validation_evidence, envelope: v2.result_envelope, createdAt: asIso(v2.created_at)!,
    } } : {}),
  };
}

async function transitionRun(client: PoolClient, runId: string, status: MappingRunStatus, finalAttemptId?: string): Promise<void> {
  const locked = await client.query<{ status: MappingRunStatus }>(
    "select status from intentchord.context_mapping_runs where id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2' for update", [runId]);
  if (!locked.rowCount) throw new HttpCommandError(404, "CONTEXT_MAPPING_V2_RUN_NOT_FOUND", "The V2 Context Mapping Run does not exist.");
  assertMappingRunTransition(locked.rows[0].status, status);
  await client.query(
    "update intentchord.context_mapping_runs set status=$2,final_attempt_id=coalesce($3,final_attempt_id) where id=$1",
    [runId, status, finalAttemptId ?? null]);
}

const ACTIVE_V2_MAPPING_RUN_STATUSES: readonly MappingRunStatus[] = [
  "CREATED", "INPUT_VALIDATED", "PRIMARY_RUNNING", "PRIMARY_FAILED_TECHNICAL", "STANDBY_RUNNING", "VALIDATING",
];

export const CONTEXT_MAPPING_EXECUTION_DEADLINE_POLICY_V1 = "intentchord.context-mapping-execution-deadline.v1" as const;
const ORPHAN_REASON = "ORPHANED_ACTIVE_MAPPING_EXECUTION" as const;

function executionDeadlineAt(record: CreateContextMappingV2RunRecord): string {
  const activeTimeout = record.providerConfigurationSnapshot.active.timeout_ms;
  const standbyTimeout = record.standbyEnabled && record.providerConfigurationSnapshot.standby
    ? record.providerConfigurationSnapshot.standby.timeout_ms : 0;
  const boundedBudgetMs = activeTimeout * 2 + standbyTimeout + 30_000;
  return new Date(Date.now() + boundedBudgetMs).toISOString();
}

async function reconcileExpiredActiveRunsWith(client: PoolClient, assemblyRevisionId: string, nowIso = new Date().toISOString()): Promise<string[]> {
  const rows = await client.query<{id:string;status:MappingRunStatus;execution_deadline_at:Date|string|null;final_attempt_id:string|null}>(
    `select id,status,execution_deadline_at,final_attempt_id from intentchord.context_mapping_runs
     where context_assembly_revision_id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2' and status = any($2::text[])
     order by created_at,id for update`, [assemblyRevisionId,[...ACTIVE_V2_MAPPING_RUN_STATUSES]]);
  const reconciled:string[]=[];
  for(const run of rows.rows){
    if(!run.execution_deadline_at || Date.parse(asIso(run.execution_deadline_at)!) > Date.parse(nowIso)) continue;
    const attempt=await client.query<{id:string;started_at:Date|string}>(
      `select id,started_at from intentchord.context_mapping_attempts where mapping_run_id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2' and status='RUNNING' order by attempt_ordinal desc limit 1 for update`,[run.id]);
    let finalAttemptId=run.final_attempt_id;
    if(attempt.rowCount){
      finalAttemptId=attempt.rows[0].id;
      const durationMs=Math.max(0,Date.parse(nowIso)-Date.parse(asIso(attempt.rows[0].started_at)!));
      await client.query(`update intentchord.context_mapping_attempts set status='FAILED_TECHNICAL',normalized_error_code='MAPPER_ORPHANED_ACTIVE_EXECUTION',completed_at=$2,duration_ms=$3,retry_count=0,usage_metadata='{}'::jsonb,rate_limit_metadata='{}'::jsonb where id=$1 and status='RUNNING'`,[finalAttemptId,nowIso,durationMs]);
    }
    await client.query(`update intentchord.context_mapping_runs set status='FAILED',final_attempt_id=coalesce($2,final_attempt_id),terminal_reason_code=$3 where id=$1`,[run.id,finalAttemptId??null,ORPHAN_REASON]);
    reconciled.push(run.id);
  }
  return reconciled;
}

async function completeAttempt(client: PoolClient, record: CompleteContextMappingV2AttemptRecord): Promise<MappingAttemptView> {
  const existing = await client.query<{ started_at: Date | string }>(
    "select started_at from intentchord.context_mapping_attempts where id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2' and status='RUNNING' for update", [record.attemptId]);
  if (!existing.rowCount) throw new ConflictError("A V2 mapping attempt can be completed exactly once from RUNNING state.");
  const durationMs = Math.max(0, Date.parse(record.completedAt) - Date.parse(asIso(existing.rows[0].started_at)!));
  const response = record.response;
  await client.query(
    `update intentchord.context_mapping_attempts set
      status=$2,normalized_error_code=$3,response_model_id=$4,provider_request_id=$5,provider_system_fingerprint=$6,
      completed_at=$7,duration_ms=$8,retry_count=$9,usage_metadata=$10,rate_limit_metadata=$11,
      raw_response_sha256=$12,raw_response_body=$13,parsed_catalog_sha256=$14,validation_summary=$15
     where id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2' and status='RUNNING'`,
    [record.attemptId,record.status,record.normalizedErrorCode??null,response?.response_model_id??null,response?.provider_request_id??null,
      response?.provider_system_fingerprint??null,record.completedAt,durationMs,record.retryCount,JSON.stringify(response?.usage_metadata??{}),
      JSON.stringify(response?.rate_limit_metadata??{}),record.validation?.raw_response_sha256??null,response?.raw_model_content??null,
      record.validation?.parsed_analysis_sha256??null,record.validation?JSON.stringify(record.validation):null]);
  const row = await client.query<AttemptRow>(
    `select id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,response_model_id,provider_request_id,
      provider_system_fingerprint,status,normalized_error_code,started_at,completed_at,duration_ms,retry_count,raw_response_sha256,
      parsed_catalog_sha256,validation_summary,usage_metadata,rate_limit_metadata
     from intentchord.context_mapping_attempts where id=$1`, [record.attemptId]);
  return mapAttempt(row.rows[0]);
}

export class PostgresAiContextMappingV2Repository {
  async findIdempotentRun(idempotencyKey: string, requestFingerprintSha256: string): Promise<ContextMappingV2RunView | undefined> {
    const row = await databaseQuery<{ id: string; mapping_request_fingerprint_sha256: string }>(
      `select id,mapping_request_fingerprint_sha256 from intentchord.context_mapping_runs
       where mapping_idempotency_key=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2'`, [idempotencyKey]);
    if (!row.rowCount) return undefined;
    if (row.rows[0].mapping_request_fingerprint_sha256 !== requestFingerprintSha256) {
      throw new HttpCommandError(409, "IDEMPOTENCY_CONFLICT", "The V2 Mapping idempotency key is bound to a different governed request.");
    }
    return this.readRun(row.rows[0].id);
  }

  async createRun(record: CreateContextMappingV2RunRecord): Promise<ContextMappingV2RunView> {
    return transaction(async client => {
      const revision = await client.query<{ assembly_sha256: string }>(
        "select assembly_sha256 from intentchord.context_assembly_revisions where id=$1 for update",
        [record.input.context_assembly_revision_id]);
      if (!revision.rowCount || revision.rows[0].assembly_sha256 !== record.assemblySha256) {
        throw new HttpCommandError(409, "CONTEXT_ASSEMBLY_IDENTITY_MISMATCH", "The exact immutable Context Assembly Revision identity does not match this Mapping request.");
      }
      await reconcileExpiredActiveRunsWith(client, record.input.context_assembly_revision_id);
      const existingActiveRun = await client.query<{ id: string }>(
        `select id from intentchord.context_mapping_runs
         where context_assembly_revision_id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2'
           and status = any($2::text[])
         limit 1 for update`,
        [record.input.context_assembly_revision_id, [...ACTIVE_V2_MAPPING_RUN_STATUSES]],
      );
      if (existingActiveRun.rowCount) {
        throw new HttpCommandError(409, "CONTEXT_ASSEMBLY_MAPPING_ALREADY_ACTIVE", "A governed V2 Mapping Run is already active for this exact Context Assembly Revision.");
      }

      // Build the governed mapping input snapshot envelope for Migration 016.
      // V2 carries assembly-level authority — source bindings are validated
      // against context_assembly_sources by the Migration 016 guard.
      const sourceBindings = record.input.source_bindings;
      const governedEnvelope = {
        mapping_input_schema_version: CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
        source_authority: "CONTEXT_ASSEMBLY_REVISION" as const,
        context_assembly_revision_id: record.input.context_assembly_revision_id,
        context_assembly_sha256: record.assemblySha256,
        source_count: sourceBindings.length,
        source_bindings: sourceBindings,
        inner: record.input,
      };

      const active = record.providerConfigurationSnapshot.active;
      const standby = record.providerConfigurationSnapshot.standby;
      await client.query(
        `insert into intentchord.context_mapping_runs(
          id,mapping_input_snapshot_id,mapping_input_sha256,mapping_input_snapshot,workspace_index_contract_version,
          workspace_snapshot_id,workspace_index_sha256,eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,status,
          primary_provider_id,primary_channel_id,primary_model_id,standby_provider_id,standby_channel_id,standby_model_id,
          standby_enabled,standby_governance_state,provider_configuration_snapshot,workspace_index_snapshot_id,
          mapping_idempotency_key,mapping_request_fingerprint_sha256,qualification_scope,context_assembly_revision_id,context_assembly_sha256,execution_deadline_at,deadline_policy_version
        ) values($1,$2,$3,$4,$5,$6,$7,$8,0,$9,'CREATED',$10,$11,$12,$13,$14,$15,$16,$17,$18,null,$19,$20,$21,$22,$23,$24,$25)`,
        [record.id,record.input.context_assembly_revision_id,record.inputSha256,JSON.stringify(governedEnvelope),CONTEXT_ASSEMBLY_CONTRACT_VERSION,
          record.input.context_assembly_revision_id,record.assemblySha256,record.input.entries.length,record.input.provider_neutral_estimated_tokens,
          active.provider_id,active.channel_id,active.model_id,standby?.provider_id??null,standby?.channel_id??null,standby?.model_id??null,
          record.standbyEnabled,record.standbyGovernanceState,JSON.stringify(record.providerConfigurationSnapshot),record.idempotencyKey,
          record.requestFingerprintSha256,CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,record.input.context_assembly_revision_id,record.assemblySha256,executionDeadlineAt(record),CONTEXT_MAPPING_EXECUTION_DEADLINE_POLICY_V1]);
      return readRunWith(client, record.id);
    });
  }

  async transitionRunStatus(runId: string, status: MappingRunStatus, finalAttemptId?: string): Promise<void> {
    await transaction(async client => { await transitionRun(client, runId, status, finalAttemptId); });
  }

  async startAttempt(input: { id: string; runId: string; ordinal: number; providerId: ProviderId; channelId: string; requestedModelId: string; startedAt: string; runStatus: "PRIMARY_RUNNING" | "STANDBY_RUNNING" }): Promise<void> {
    await transaction(async client => {
      await transitionRun(client, input.runId, input.runStatus);
      await client.query(
        `insert into intentchord.context_mapping_attempts(
          id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,prompt_template_id,prompt_template_sha256,
          qualification_scope,status,started_at
        ) values($1,$2,$3,$4,$5,$6,$7,$8,'AI_CONTEXT_MAPPING_V2','RUNNING',$9)`,
        [input.id,input.runId,input.ordinal,input.providerId,input.channelId,input.requestedModelId,
          CONTEXT_MAPPING_PROMPT_TEMPLATE_ID_V2,AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256_V2,input.startedAt]);
    });
  }

  async finalizeTechnicalAttempt(record: CompleteContextMappingV2AttemptRecord & { status: "FAILED_TECHNICAL" }, runStatus: "PRIMARY_FAILED_TECHNICAL" | "FAILED"): Promise<MappingAttemptView> {
    return transaction(async client => {
      const attempt = await completeAttempt(client, record);
      await transitionRun(client, attempt.runId, runStatus, attempt.id);
      return attempt;
    });
  }

  async finalizeValidationFailure(record: CompleteContextMappingV2AttemptRecord & { status: "FAILED_VALIDATION" }): Promise<MappingAttemptView> {
    return transaction(async client => {
      const running = await client.query<{ mapping_run_id: string }>("select mapping_run_id from intentchord.context_mapping_attempts where id=$1 for update", [record.attemptId]);
      if (!running.rowCount) throw new ConflictError("V2 attempt is not RUNNING.");
      await transitionRun(client, running.rows[0].mapping_run_id, "VALIDATING");
      const attempt = await completeAttempt(client, record);
      await transitionRun(client, attempt.runId, "REJECTED_VALIDATION", attempt.id);
      return attempt;
    });
  }

  async finalizeSuccessfulAttempt(input: {
    completion: CompleteContextMappingV2AttemptRecord & { status: "SUCCEEDED"; response: ProviderAttemptResponse; validation: ContextMappingV2ValidationResult };
    resultId: string;
    runId: string;
    assemblyRevisionId: string;
    analysis: ModelContextAnalysisV2;
    analysisSha256: string;
    envelope: ContextMappingResultEnvelopeV2;
    createdAt: string;
  }): Promise<ContextMappingV2RunView> {
    return transaction(async client => {
      await transitionRun(client, input.runId, "VALIDATING");
      const attempt = await completeAttempt(client, input.completion);
      if (attempt.runId !== input.runId || attempt.id !== input.envelope.attempt_id) throw new ConflictError("V2 result provenance mismatch.");
      await client.query(
        `insert into intentchord.context_mapping_v2_results(
          id,mapping_run_id,source_attempt_id,context_assembly_revision_id,schema_version,analysis_outcome,analysis_json,analysis_sha256,
          deterministic_validation_evidence,result_envelope,created_at
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [input.resultId,input.runId,attempt.id,input.assemblyRevisionId,MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2,input.analysis.analysis_outcome,
          JSON.stringify(input.analysis),input.analysisSha256,JSON.stringify(input.completion.validation),JSON.stringify(input.envelope),input.createdAt]);
      const ordinal = await client.query<{ next_ordinal: number }>(
        `select coalesce(max(iteration_ordinal),0)+1 as next_ordinal from intentchord.context_assembly_mapping_iterations where context_assembly_revision_id=$1`,
        [input.assemblyRevisionId]);
      await client.query(
        `insert into intentchord.context_assembly_mapping_iterations(id,context_assembly_revision_id,mapping_run_id,v2_result_id,iteration_ordinal,analysis_outcome,created_at)
         values($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(),input.assemblyRevisionId,input.runId,input.resultId,Number(ordinal.rows[0].next_ordinal),input.analysis.analysis_outcome,input.createdAt]);
      const terminal = input.analysis.analysis_outcome === "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE"
        ? "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE" : "ANALYSIS_COMPLETE";
      await transitionRun(client, input.runId, terminal, attempt.id);
      return readRunWith(client, input.runId);
    });
  }

  async reconcileExpiredActiveRuns(contextAssemblyRevisionId: string, nowIso = new Date().toISOString()): Promise<string[]> {
    return transaction(client => reconcileExpiredActiveRunsWith(client, contextAssemblyRevisionId, nowIso));
  }

  async readRun(runId: string): Promise<ContextMappingV2RunView> {
    return transaction(client => readRunWith(client, runId));
  }

  async listAttempts(runId: string): Promise<MappingAttemptView[]> {
    const rows = await databaseQuery<AttemptRow>(
      `select id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,response_model_id,provider_request_id,
        provider_system_fingerprint,status,normalized_error_code,started_at,completed_at,duration_ms,retry_count,raw_response_sha256,
        parsed_catalog_sha256,validation_summary,usage_metadata,rate_limit_metadata
       from intentchord.context_mapping_attempts where mapping_run_id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2' order by attempt_ordinal`, [runId]);
    return rows.rows.map(mapAttempt);
  }
}
