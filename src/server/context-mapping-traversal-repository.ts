/**
 * INTENTCHORD CONTEXT MAPPING TRAVERSAL REPOSITORY
 *
 * Governed PostgreSQL repository for multi-window traversals, windows, candidates,
 * hierarchical reduction lineage, and lease-fenced mutations.
 *
 * Invariants:
 * 1. TRAVERSAL_FROZEN_AUTHORITY_IMMUTABLE
 * 2. REDUCTION_HASH_BINDING_VERIFIED (DAG by construction)
 * 3. CHILD_WRITES_ATOMICALLY_FENCED (every executor write verifies owner, epoch, expires_at)
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { databaseQuery, transaction } from "@/server/db";
import { canonicalJson, mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { HttpCommandError } from "@/server/errors";

export const GOVERNED_LEASE_CONFIG = {
  CONTEXT_MAPPING_LEASE_TTL_MS: 60_000,
  CONTEXT_MAPPING_HEARTBEAT_INTERVAL_MS: 15_000,
} as const;

export function validateLeaseTimingGovernance(ttlMs: number, heartbeatMs: number): void {
  if (ttlMs <= 0 || heartbeatMs <= 0) {
    throw new Error("LEASE_TIMINGS_INVALID: TTL and Heartbeat must be positive.");
  }
  if (heartbeatMs >= ttlMs / 2) {
    throw new Error("LEASE_TIMINGS_INVARIANT_VIOLATION: heartbeat interval must be strictly less than lease TTL / 2.");
  }
}

export type TraversalStatus =
  | "TOPOLOGY_IN_PROGRESS"
  | "TOPOLOGY_COMPLETE"
  | "DRILLDOWN_IN_PROGRESS"
  | "DRILLDOWN_COMPLETE"
  | "SYNTHESIS_IN_PROGRESS"
  | "SYNTHESIS_REDUCING"
  | "SYNTHESIS_COMPLETE"
  | "FAILED"
  | "STALE_AUTHORITY"
  | "CANCELLED";

export type TraversalPhase = "TOPOLOGY" | "DRILLDOWN" | "SYNTHESIS";

export type FrozenAuthorityTuple = {
  context_assembly_revision_id: string;
  workspace_registration_id: string;
  workspace_revision_id: string;
  workspace_index_snapshot_id: string;
  accepted_workspace_evidence_artifact_id: string;
  artifact_semantic_sha256: string;
  workspace_observation_id: string;
  authority_sequence: number;
  index_configuration_sha256: string;
};

export function computeTraversalAuthoritySha256(tuple: FrozenAuthorityTuple): string {
  const canonicalTuple = {
    accepted_workspace_evidence_artifact_id: tuple.accepted_workspace_evidence_artifact_id,
    artifact_semantic_sha256: tuple.artifact_semantic_sha256,
    authority_sequence: Number(tuple.authority_sequence),
    context_assembly_revision_id: tuple.context_assembly_revision_id,
    index_configuration_sha256: tuple.index_configuration_sha256,
    workspace_index_snapshot_id: tuple.workspace_index_snapshot_id,
    workspace_observation_id: tuple.workspace_observation_id,
    workspace_registration_id: tuple.workspace_registration_id,
    workspace_revision_id: tuple.workspace_revision_id,
  };
  return mapperSha256(canonicalTuple);
}

export type ContextMappingTraversalRow = FrozenAuthorityTuple & {
  id: string;
  traversal_authority_sha256: string;
  ai_execution_authority_sha256?: string | null;
  ai_execution_qualification_scope?: string | null;
  ai_execution_selection_authority_sequence?: number | string | null;
  ai_execution_scope?: string | null;
  ai_execution_selection_sequence?: number | string | null;
  ai_execution_active_engine_id?: string | null;
  ai_execution_active_engine_config_revision?: string | null;
  ai_execution_active_engine_configuration_sha256?: string | null;
  ai_execution_active_qualification_id?: string | null;
  ai_execution_active_capability_profile_version?: string | null;
  ai_execution_standby_engine_id?: string | null;
  ai_execution_standby_engine_config_revision?: string | null;
  ai_execution_standby_engine_configuration_sha256?: string | null;
  ai_execution_standby_qualification_id?: string | null;
  ai_execution_standby_capability_profile_version?: string | null;
  ai_execution_provider_configuration_snapshot?: unknown | null;
  traversal_status: TraversalStatus;
  current_phase: TraversalPhase;
  active_window_ordinal: number;
  cursor_artifact_id: string;
  cursor_section_id: number;
  cursor_section_type: string;
  cursor_section_schema_version: string;
  cursor_record_seq: number;
  topology_window_count: number;
  drilldown_window_count: number;
  reduction_level_count: number;
  executor_lease_owner: string | null;
  executor_lease_epoch: number;
  executor_lease_acquired_at: Date | null;
  executor_lease_expires_at: Date | null;
  executor_heartbeat_at: Date | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ContextMappingWindowRow = {
  id: string;
  traversal_id: string;
  traversal_authority_sha256: string;
  phase: "TOPOLOGY" | "DRILLDOWN";
  window_ordinal: number;
  cursor_artifact_id: string;
  cursor_section_id: number;
  cursor_section_type: string;
  start_cursor_record_seq: number;
  end_cursor_record_seq: number;
  token_count: number;
  window_input_sha256: string;
  cursor_section_schema_version: string;
  status: "READY" | "RUNNING" | "SUCCEEDED" | "FAILED";
  attempt_id: string | null;
  attempt_count: number;
  window_result_json: unknown;
  window_result_sha256: string | null;
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
};

export class StaleExecutorLeaseError extends HttpCommandError {
  constructor(workerId: string, epoch: number, message = "Executor lease epoch is stale or expired.") {
    super(409, "STALE_EXECUTOR_LEASE_RECLAIMED", `${message} worker=${workerId}, epoch=${epoch}`);
    this.name = "StaleExecutorLeaseError";
  }
}

export class PostgresContextMappingTraversalRepository {
  /**
   * Enforce atomic lease fencing inside a transaction client.
   * Proves that the worker still holds the lease and the epoch has not been bumped.
   */
  private async assertLeaseFencingInTransaction(
    client: PoolClient,
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
  ): Promise<void> {
    const res = await client.query(
      `UPDATE intentchord.context_mapping_traversals
          SET updated_at = clock_timestamp()
        WHERE id = $1
          AND executor_lease_owner = $2
          AND executor_lease_epoch = $3
          AND executor_lease_expires_at > clock_timestamp()`,
      [traversalId, workerId, leaseEpoch],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new StaleExecutorLeaseError(workerId, leaseEpoch);
    }
  }

  async createTraversal(
    authorityTuple: FrozenAuthorityTuple,
    initialCursor: {
      cursor_artifact_id: string;
      cursor_section_id: number;
      cursor_section_type: string;
      cursor_section_schema_version: string;
      cursor_record_seq: number;
    },
    frozenAiExecutionAuthority?: import("@/core/ai-context-mapper/types").FrozenAiExecutionAuthority,
  ): Promise<ContextMappingTraversalRow> {
    const traversalId = randomUUID();
    const traversalAuthoritySha256 = computeTraversalAuthoritySha256(authorityTuple);

    return await transaction(async client => {
      const res = await client.query<ContextMappingTraversalRow>(
        `INSERT INTO intentchord.context_mapping_traversals (
          id, context_assembly_revision_id, workspace_registration_id, workspace_revision_id,
          workspace_index_snapshot_id, accepted_workspace_evidence_artifact_id, artifact_semantic_sha256,
          workspace_observation_id, authority_sequence, index_configuration_sha256,
          traversal_authority_sha256, traversal_status, current_phase, active_window_ordinal,
          cursor_artifact_id, cursor_section_id, cursor_section_type, cursor_section_schema_version,
          cursor_record_seq, topology_window_count, drilldown_window_count, reduction_level_count,
          executor_lease_owner, executor_lease_epoch,
          ai_execution_authority_sha256, ai_execution_qualification_scope, ai_execution_selection_authority_sequence,
          ai_execution_active_engine_id, ai_execution_active_engine_config_revision,
          ai_execution_active_engine_configuration_sha256, ai_execution_active_qualification_id,
          ai_execution_active_capability_profile_version,
          ai_execution_standby_engine_id, ai_execution_standby_engine_config_revision,
          ai_execution_standby_engine_configuration_sha256, ai_execution_standby_qualification_id,
          ai_execution_standby_capability_profile_version,
          ai_execution_provider_configuration_snapshot
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, 'TOPOLOGY_IN_PROGRESS', 'TOPOLOGY', 1,
          $12, $13, $14, $15, $16, 0, 0, 0,
          NULL, 0,
          $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30::jsonb
        ) RETURNING *`,
        [
          traversalId,
          authorityTuple.context_assembly_revision_id,
          authorityTuple.workspace_registration_id,
          authorityTuple.workspace_revision_id,
          authorityTuple.workspace_index_snapshot_id,
          authorityTuple.accepted_workspace_evidence_artifact_id,
          authorityTuple.artifact_semantic_sha256,
          authorityTuple.workspace_observation_id,
          authorityTuple.authority_sequence,
          authorityTuple.index_configuration_sha256,
          traversalAuthoritySha256,
          initialCursor.cursor_artifact_id,
          initialCursor.cursor_section_id,
          initialCursor.cursor_section_type,
          initialCursor.cursor_section_schema_version,
          initialCursor.cursor_record_seq,
          frozenAiExecutionAuthority?.aiExecutionAuthoritySha256 ?? null,
          frozenAiExecutionAuthority?.qualificationScope ?? null,
          frozenAiExecutionAuthority?.selectionAuthoritySequence ?? null,
          frozenAiExecutionAuthority?.active.engineId ?? null,
          frozenAiExecutionAuthority?.active.engineConfigRevision ?? null,
          frozenAiExecutionAuthority?.active.engineConfigurationSha256 ?? null,
          frozenAiExecutionAuthority?.active.qualificationId ?? null,
          frozenAiExecutionAuthority?.active.capabilityProfileVersion ?? null,
          frozenAiExecutionAuthority?.standby?.engineId ?? null,
          frozenAiExecutionAuthority?.standby?.engineConfigRevision ?? null,
          frozenAiExecutionAuthority?.standby?.engineConfigurationSha256 ?? null,
          frozenAiExecutionAuthority?.standby?.qualificationId ?? null,
          frozenAiExecutionAuthority?.standby?.capabilityProfileVersion ?? null,
          frozenAiExecutionAuthority?.providerConfigurationSnapshot ? JSON.stringify(frozenAiExecutionAuthority.providerConfigurationSnapshot) : null,
        ],
      );
      return res.rows[0];
    });
  }

  async getTraversalById(traversalId: string): Promise<ContextMappingTraversalRow | null> {
    const res = await databaseQuery<ContextMappingTraversalRow>(
      "SELECT * FROM intentchord.context_mapping_traversals WHERE id = $1",
      [traversalId],
    );
    return res.rows[0] ?? null;
  }

  async getTraversalByAssemblyRevisionId(revisionId: string): Promise<ContextMappingTraversalRow | null> {
    const res = await databaseQuery<ContextMappingTraversalRow>(
      "SELECT * FROM intentchord.context_mapping_traversals WHERE context_assembly_revision_id = $1",
      [revisionId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Re-open a terminal FAILED topology/drilldown traversal for an explicit Owner retry.
   *
   * The frozen traversal authority and previous failed window stay immutable. The cursor
   * remains at the start of the failed work and active_window_ordinal advances so the retry
   * writes a fresh window + fresh Mapping Run instead of overwriting failed provenance.
   */
  async reopenFailedTraversalForRetry(traversalId: string): Promise<ContextMappingTraversalRow> {
    return transaction(async client => {
      const current = await client.query<ContextMappingTraversalRow>(
        "SELECT * FROM intentchord.context_mapping_traversals WHERE id = $1 FOR UPDATE",
        [traversalId],
      );
      if (!current.rowCount) {
        throw new HttpCommandError(404, "CONTEXT_MAPPING_TRAVERSAL_NOT_FOUND", "Context Mapping traversal was not found.");
      }
      const traversal = current.rows[0];
      if (traversal.traversal_status !== "FAILED") {
        throw new HttpCommandError(409, "CONTEXT_MAPPING_TRAVERSAL_NOT_FAILED", "Only a terminal FAILED traversal can be retried.");
      }
      if (traversal.current_phase === "SYNTHESIS") {
        throw new HttpCommandError(
          409,
          "CONTEXT_MAPPING_SYNTHESIS_RETRY_REQUIRES_REBUILD",
          "A failed synthesis traversal cannot be resumed in-place because partial reduction lineage may already exist.",
        );
      }

      const failedWindow = await client.query<{ id: string }>(
        `SELECT id
           FROM intentchord.context_mapping_windows
          WHERE traversal_id = $1
            AND phase = $2
            AND window_ordinal = $3
            AND status = 'FAILED'
          LIMIT 1`,
        [traversalId, traversal.current_phase, traversal.active_window_ordinal],
      );
      if (!failedWindow.rowCount) {
        throw new HttpCommandError(
          409,
          "CONTEXT_MAPPING_FAILED_WINDOW_REQUIRED",
          "Retry requires the exact failed topology/drilldown window provenance.",
        );
      }

      const nextStatus: TraversalStatus =
        traversal.current_phase === "TOPOLOGY" ? "TOPOLOGY_IN_PROGRESS" : "DRILLDOWN_IN_PROGRESS";

      const reopened = await client.query<ContextMappingTraversalRow>(
        `UPDATE intentchord.context_mapping_traversals
            SET traversal_status = $2,
                active_window_ordinal = active_window_ordinal + 1,
                failure_code = NULL,
                failure_reason = NULL,
                executor_lease_owner = NULL,
                executor_lease_expires_at = NULL,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [traversalId, nextStatus],
      );
      return reopened.rows[0];
    });
  }

  async claimOrRenewLease(
    traversalId: string,
    workerId: string,
    ttlMs: number = GOVERNED_LEASE_CONFIG.CONTEXT_MAPPING_LEASE_TTL_MS,
    heartbeatMs?: number,
  ): Promise<{ acquired: boolean; leaseEpoch: number; expiresAt: Date | null }> {
    const effectiveHeartbeatMs = heartbeatMs ?? Math.min(GOVERNED_LEASE_CONFIG.CONTEXT_MAPPING_HEARTBEAT_INTERVAL_MS, Math.floor(ttlMs / 3));
    validateLeaseTimingGovernance(ttlMs, effectiveHeartbeatMs);

    return await transaction(async client => {
      const res = await client.query<{ executor_lease_epoch: string; executor_lease_expires_at: Date }>(
        `UPDATE intentchord.context_mapping_traversals
            SET executor_lease_owner = $2,
                executor_lease_epoch = executor_lease_epoch + 1,
                executor_lease_acquired_at = clock_timestamp(),
                executor_lease_expires_at = clock_timestamp() + ($3 || ' milliseconds')::interval,
                executor_heartbeat_at = clock_timestamp()
          WHERE id = $1
            AND traversal_status IN ('TOPOLOGY_IN_PROGRESS', 'DRILLDOWN_IN_PROGRESS', 'SYNTHESIS_IN_PROGRESS', 'SYNTHESIS_REDUCING')
            AND (
              executor_lease_owner IS NULL
              OR executor_lease_expires_at < clock_timestamp()
              OR executor_lease_owner = $2
            )
        RETURNING executor_lease_epoch, executor_lease_expires_at`,
        [traversalId, workerId, ttlMs],
      );

      if ((res.rowCount ?? 0) === 0) {
        return { acquired: false, leaseEpoch: 0, expiresAt: null };
      }

      return {
        acquired: true,
        leaseEpoch: Number(res.rows[0].executor_lease_epoch),
        expiresAt: res.rows[0].executor_lease_expires_at,
      };
    });
  }

  async heartbeat(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    ttlMs = GOVERNED_LEASE_CONFIG.CONTEXT_MAPPING_LEASE_TTL_MS,
  ): Promise<boolean> {
    const res = await databaseQuery(
      `UPDATE intentchord.context_mapping_traversals
          SET executor_heartbeat_at = clock_timestamp(),
              executor_lease_expires_at = clock_timestamp() + ($4 || ' milliseconds')::interval
        WHERE id = $1
          AND executor_lease_owner = $2
          AND executor_lease_epoch = $3
          AND executor_lease_expires_at > clock_timestamp()`,
      [traversalId, workerId, leaseEpoch, ttlMs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async releaseLease(traversalId: string, workerId: string, leaseEpoch: number): Promise<void> {
    await databaseQuery(
      `UPDATE intentchord.context_mapping_traversals
          SET executor_lease_owner = NULL,
              executor_lease_expires_at = NULL
        WHERE id = $1
          AND executor_lease_owner = $2
          AND executor_lease_epoch = $3`,
      [traversalId, workerId, leaseEpoch],
    );
  }

  async createEvidenceWindow(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    windowData: {
      phase: "TOPOLOGY" | "DRILLDOWN";
      window_ordinal: number;
      cursor_artifact_id: string;
      cursor_section_id: number;
      cursor_section_type: string;
      cursor_section_schema_version?: string;
      start_cursor_record_seq: number;
      end_cursor_record_seq: number;
      token_count: number;
      window_input_sha256: string;
    },
  ): Promise<ContextMappingWindowRow> {
    return await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      const trav = await client.query<{ traversal_authority_sha256: string }>(
        "SELECT traversal_authority_sha256 FROM intentchord.context_mapping_traversals WHERE id = $1",
        [traversalId],
      );
      const authoritySha = trav.rows[0].traversal_authority_sha256;
      const windowId = randomUUID();

      const res = await client.query<ContextMappingWindowRow>(
        `INSERT INTO intentchord.context_mapping_windows (
          id, traversal_id, traversal_authority_sha256, phase, window_ordinal,
          cursor_artifact_id, cursor_section_id, cursor_section_type, cursor_section_schema_version,
          start_cursor_record_seq, end_cursor_record_seq, token_count,
          window_input_sha256, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'READY'
        ) RETURNING *`,
        [
          windowId,
          traversalId,
          authoritySha,
          windowData.phase,
          windowData.window_ordinal,
          windowData.cursor_artifact_id,
          windowData.cursor_section_id,
          windowData.cursor_section_type,
          windowData.cursor_section_schema_version ?? "v2",
          windowData.start_cursor_record_seq,
          windowData.end_cursor_record_seq,
          windowData.token_count,
          windowData.window_input_sha256,
        ],
      );

      return res.rows[0];
    });
  }

  async markWindowRunning(
    paramOrWindowId:
      | string
      | {
          windowId: string;
          traversalId: string;
          workerId: string;
          leaseEpoch: number;
          attemptId?: string;
        },
    traversalId?: string,
    workerId?: string,
    leaseEpoch?: number,
    attemptId?: string,
  ): Promise<void> {
    const params = typeof paramOrWindowId === "string"
      ? {
          windowId: paramOrWindowId,
          traversalId: traversalId!,
          workerId: workerId!,
          leaseEpoch: leaseEpoch!,
          attemptId: attemptId ?? randomUUID(),
        }
      : {
          windowId: paramOrWindowId.windowId,
          traversalId: paramOrWindowId.traversalId,
          workerId: paramOrWindowId.workerId,
          leaseEpoch: paramOrWindowId.leaseEpoch,
          attemptId: paramOrWindowId.attemptId ?? randomUUID(),
        };

    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, params.traversalId, params.workerId, params.leaseEpoch);

      const res = await client.query(
        `UPDATE intentchord.context_mapping_windows
            SET status = 'RUNNING',
                attempt_id = $2,
                attempt_count = attempt_count + 1
          WHERE id = $1 AND traversal_id = $3`,
        [params.windowId, params.attemptId, params.traversalId],
      );
      if ((res.rowCount ?? 0) === 0) {
        throw new Error(`WINDOW_NOT_FOUND: window ${params.windowId} on traversal ${params.traversalId}`);
      }
    });
  }

  async completeEvidenceWindow(
    windowId: string,
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    result: {
      window_result_json: unknown;
      window_result_sha256: string;
      new_cursor_record_seq: number;
    },
  ): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      // 1. Mark window succeeded with verified hash
      const wRes = await client.query(
        `UPDATE intentchord.context_mapping_windows
            SET status = 'SUCCEEDED',
                window_result_json = $2,
                window_result_sha256 = $3,
                completed_at = clock_timestamp()
          WHERE id = $1 AND traversal_id = $4`,
        [windowId, JSON.stringify(result.window_result_json), result.window_result_sha256, traversalId],
      );
      if ((wRes.rowCount ?? 0) === 0) {
        throw new Error(`WINDOW_UPDATE_FAILED: window ${windowId}`);
      }

      // 2. Atomically advance cursor and increment counts on traversal
      await client.query(
        `UPDATE intentchord.context_mapping_traversals
            SET cursor_record_seq = GREATEST(cursor_record_seq, $2),
                active_window_ordinal = active_window_ordinal + 1,
                topology_window_count = CASE WHEN current_phase = 'TOPOLOGY' THEN topology_window_count + 1 ELSE topology_window_count END,
                drilldown_window_count = CASE WHEN current_phase = 'DRILLDOWN' THEN drilldown_window_count + 1 ELSE drilldown_window_count END,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [traversalId, result.new_cursor_record_seq],
      );
    });
  }

  async failEvidenceWindow(
    windowId: string,
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    errorMessage: string,
  ): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      await client.query(
        `UPDATE intentchord.context_mapping_windows
            SET status = 'FAILED',
                error_message = $2,
                completed_at = clock_timestamp()
          WHERE id = $1 AND traversal_id = $3`,
        [windowId, errorMessage, traversalId],
      );
    });
  }

  async saveCandidateBatch(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    batchOrdinal: number,
    units: ReadonlyArray<{
      candidate_ordinal: number;
      workspace_registration_id: string;
      workspace_revision_id: string;
      accepted_workspace_evidence_artifact_id: string;
      source_file_revision_id: string;
      logical_unit_id: string;
      source_anchor_signature?: string | null;
      fact_ref?: string | null;
      relation_ref?: string | null;
    }>,
  ): Promise<string> {
    return await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      const trav = await client.query<{ traversal_authority_sha256: string }>(
        "SELECT traversal_authority_sha256 FROM intentchord.context_mapping_traversals WHERE id = $1",
        [traversalId],
      );
      const authoritySha = trav.rows[0].traversal_authority_sha256;
      const batchId = randomUUID();

      await client.query(
        `INSERT INTO intentchord.context_mapping_candidate_batches (
          id, traversal_id, traversal_authority_sha256, batch_ordinal, status, candidate_count
        ) VALUES ($1, $2, $3, $4, 'PENDING', $5)`,
        [batchId, traversalId, authoritySha, batchOrdinal, units.length],
      );

      for (const u of units) {
        await client.query(
          `INSERT INTO intentchord.context_mapping_candidate_units (
            id, batch_id, traversal_id, candidate_ordinal, workspace_registration_id,
            workspace_revision_id, accepted_workspace_evidence_artifact_id, source_file_revision_id,
            logical_unit_id, source_anchor_signature, fact_ref, relation_ref, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'SELECTED')
          ON CONFLICT (traversal_id, logical_unit_id) DO NOTHING`,
          [
            randomUUID(),
            batchId,
            traversalId,
            u.candidate_ordinal,
            u.workspace_registration_id,
            u.workspace_revision_id,
            u.accepted_workspace_evidence_artifact_id,
            u.source_file_revision_id,
            u.logical_unit_id,
            u.source_anchor_signature ?? null,
            u.fact_ref ?? null,
            u.relation_ref ?? null,
          ],
        );
      }

      return batchId;
    });
  }

  async getCandidateUnitsForTraversal(traversalId: string): Promise<ReadonlyArray<{
    id: string;
    batch_id: string;
    candidate_ordinal: number;
    logical_unit_id: string;
    source_file_revision_id: string;
    status: string;
  }>> {
    const res = await databaseQuery<{
      id: string;
      batch_id: string;
      candidate_ordinal: number;
      logical_unit_id: string;
      source_file_revision_id: string;
      status: string;
    }>(
      `SELECT id, batch_id, candidate_ordinal, logical_unit_id, source_file_revision_id, status
         FROM intentchord.context_mapping_candidate_units
        WHERE traversal_id = $1
        ORDER BY candidate_ordinal ASC`,
      [traversalId],
    );
    return res.rows;
  }

  async createReductionWindow(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    data: {
      reduction_level: number;
      reduction_ordinal: number;
      input_set_sha256: string;
      input_item_count: number;
      token_count: number;
    },
  ): Promise<string> {
    return await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      const trav = await client.query<{ traversal_authority_sha256: string }>(
        "SELECT traversal_authority_sha256 FROM intentchord.context_mapping_traversals WHERE id = $1",
        [traversalId],
      );
      const authoritySha = trav.rows[0].traversal_authority_sha256;
      const reductionWindowId = randomUUID();

      await client.query(
        `INSERT INTO intentchord.context_mapping_reduction_windows (
          id, traversal_id, traversal_authority_sha256, reduction_level, reduction_ordinal,
          input_set_sha256, input_item_count, token_count, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'READY')`,
        [
          reductionWindowId,
          traversalId,
          authoritySha,
          data.reduction_level,
          data.reduction_ordinal,
          data.input_set_sha256,
          data.input_item_count,
          data.token_count,
        ],
      );

      return reductionWindowId;
    });
  }

  async recordReductionInput(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    reductionWindowId: string,
    inputOrdinal: number,
    source: {
      source_mapping_window_id?: string;
      source_reduction_window_id?: string;
      source_output_sha256: string;
    },
  ): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      await client.query(
        `INSERT INTO intentchord.context_mapping_reduction_inputs (
          id, reduction_window_id, traversal_id, input_ordinal,
          source_mapping_window_id, source_reduction_window_id, source_output_sha256
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          reductionWindowId,
          traversalId,
          inputOrdinal,
          source.source_mapping_window_id ?? null,
          source.source_reduction_window_id ?? null,
          source.source_output_sha256,
        ],
      );
    });
  }

  async insertReductionInput(data: {
    id?: string;
    reductionWindowId: string;
    traversalId: string;
    inputOrdinal: number;
    sourceMappingWindowId?: string;
    sourceReductionWindowId?: string;
    sourceOutputSha256: string;
    workerId: string;
    leaseEpoch: number;
  }): Promise<void> {
    await this.recordReductionInput(
      data.traversalId,
      data.workerId,
      data.leaseEpoch,
      data.reductionWindowId,
      data.inputOrdinal,
      {
        source_mapping_window_id: data.sourceMappingWindowId,
        source_reduction_window_id: data.sourceReductionWindowId,
        source_output_sha256: data.sourceOutputSha256,
      },
    );
  }

  async completeReductionWindow(
    reductionWindowId: string,
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    output: {
      output_sha256: string;
      output_summary: unknown;
    },
  ): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      await client.query(
        `UPDATE intentchord.context_mapping_reduction_windows
            SET status = 'SUCCEEDED',
                output_sha256 = $2,
                output_summary = $3,
                completed_at = clock_timestamp()
          WHERE id = $1 AND traversal_id = $4`,
        [reductionWindowId, output.output_sha256, JSON.stringify(output.output_summary), traversalId],
      );

      await client.query(
        `UPDATE intentchord.context_mapping_traversals
            SET reduction_level_count = GREATEST(reduction_level_count, (
                  SELECT reduction_level FROM intentchord.context_mapping_reduction_windows WHERE id = $1
                )),
                updated_at = clock_timestamp()
          WHERE id = $2`,
        [reductionWindowId, traversalId],
      );
    });
  }

  async transitionPhase(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    nextPhase: TraversalPhase,
    nextStatus: TraversalStatus,
  ): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      await client.query(
        `UPDATE intentchord.context_mapping_traversals
            SET current_phase = $2,
                traversal_status = $3,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [traversalId, nextPhase, nextStatus],
      );
    });
  }

  async markTraversalComplete(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
  ): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      await client.query(
        `UPDATE intentchord.context_mapping_traversals
            SET traversal_status = 'SYNTHESIS_COMPLETE',
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [traversalId],
      );
    });
  }

  async markTraversalStale(traversalId: string, reason: string): Promise<void> {
    await databaseQuery(
      `UPDATE intentchord.context_mapping_traversals
          SET traversal_status = 'STALE_AUTHORITY',
               failure_code = 'STALE_CONTEXT_AUTHORITY',
               failure_reason = $2,
               executor_lease_owner = NULL,
               executor_lease_expires_at = NULL,
               updated_at = clock_timestamp()
         WHERE id = $1`,
      [traversalId, reason],
    );
  }

  async markTraversalFailed(traversalId: string, code: string, reason: string): Promise<void> {
    await databaseQuery(
      `UPDATE intentchord.context_mapping_traversals
          SET traversal_status = 'FAILED',
               failure_code = $2,
               failure_reason = $3,
               executor_lease_owner = NULL,
               executor_lease_expires_at = NULL,
               updated_at = clock_timestamp()
         WHERE id = $1`,
      [traversalId, code, reason],
    );
  }

  async discoverActiveTraversalsWithExpiredLeases(): Promise<ReadonlyArray<ContextMappingTraversalRow>> {
    const res = await databaseQuery<ContextMappingTraversalRow>(
      `SELECT * FROM intentchord.context_mapping_traversals
        WHERE traversal_status IN ('TOPOLOGY_IN_PROGRESS', 'DRILLDOWN_IN_PROGRESS', 'SYNTHESIS_IN_PROGRESS', 'SYNTHESIS_REDUCING')
          AND (executor_lease_owner IS NULL OR executor_lease_expires_at < clock_timestamp())
        ORDER BY created_at ASC`,
    );
    return res.rows;
  }

  async findActiveTraversalById(traversalId: string): Promise<ContextMappingTraversalRow | null> {
    return this.getTraversalById(traversalId);
  }

  async acquireOrReclaimLease(
    traversalId: string,
    workerId: string,
    ttlMs: number = GOVERNED_LEASE_CONFIG.CONTEXT_MAPPING_LEASE_TTL_MS,
  ): Promise<{ acquired: boolean; epoch: number }> {
    const res = await this.claimOrRenewLease(traversalId, workerId, ttlMs);
    return { acquired: res.acquired, epoch: res.leaseEpoch };
  }

  async findRecoverableTraversals(): Promise<ReadonlyArray<ContextMappingTraversalRow>> {
    return this.discoverActiveTraversalsWithExpiredLeases();
  }

  async markStaleAuthority(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    reason: string,
  ): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);
      await client.query(
        `UPDATE intentchord.context_mapping_traversals
            SET traversal_status = 'STALE_AUTHORITY',
                failure_code = 'STALE_CONTEXT_AUTHORITY',
                failure_reason = $2,
                executor_lease_owner = NULL,
                executor_lease_expires_at = NULL,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [traversalId, reason],
      );
    });
  }

  async failTraversal(
    traversalId: string,
    workerId: string,
    leaseEpoch: number,
    code: string,
    reason: string,
  ): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);
      await client.query(
        `UPDATE intentchord.context_mapping_traversals
            SET traversal_status = 'FAILED',
                failure_code = $2,
                failure_reason = $3,
                executor_lease_owner = NULL,
                executor_lease_expires_at = NULL,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [traversalId, code, reason],
      );
    });
  }

  async insertEvidenceWindow(data: {
    id: string;
    traversalId: string;
    traversalAuthoritySha256: string;
    phase: "TOPOLOGY" | "DRILLDOWN";
    windowOrdinal: number;
    cursorArtifactId: string;
    cursorSectionId: number;
    cursorSectionType: string;
    cursorSectionSchemaVersion?: string;
    startCursorRecordSeq: number;
    endCursorRecordSeq: number;
    tokenCount: number;
    windowInputSha256: string;
    workerId: string;
    leaseEpoch: number;
  }): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, data.traversalId, data.workerId, data.leaseEpoch);
      await client.query(
        `INSERT INTO intentchord.context_mapping_windows (
          id, traversal_id, traversal_authority_sha256, phase, window_ordinal,
          cursor_artifact_id, cursor_section_id, cursor_section_type, cursor_section_schema_version,
          start_cursor_record_seq, end_cursor_record_seq, token_count,
          window_input_sha256, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'READY'
        )`,
        [
          data.id,
          data.traversalId,
          data.traversalAuthoritySha256,
          data.phase,
          data.windowOrdinal,
          data.cursorArtifactId,
          data.cursorSectionId,
          data.cursorSectionType,
          data.cursorSectionSchemaVersion ?? "v2",
          data.startCursorRecordSeq,
          data.endCursorRecordSeq,
          data.tokenCount,
          data.windowInputSha256,
        ],
      );
    });
  }

  async completeWindow(data: {
    windowId: string;
    traversalId: string;
    windowResultJson: unknown;
    windowResultSha256: string;
    workerId: string;
    leaseEpoch: number;
  }): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, data.traversalId, data.workerId, data.leaseEpoch);
      const res = await client.query(
        `UPDATE intentchord.context_mapping_windows
            SET status = 'SUCCEEDED',
                window_result_json = $2,
                window_result_sha256 = $3,
                completed_at = clock_timestamp()
          WHERE id = $1 AND traversal_id = $4`,
        [data.windowId, JSON.stringify(data.windowResultJson), data.windowResultSha256, data.traversalId],
      );
      if ((res.rowCount ?? 0) === 0) {
        throw new Error(`WINDOW_COMPLETE_FAILED: ${data.windowId}`);
      }
    });
  }

  async failWindow(data: {
    windowId: string;
    traversalId: string;
    workerId: string;
    leaseEpoch: number;
    errorMessage?: string;
  }): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, data.traversalId, data.workerId, data.leaseEpoch);
      await client.query(
        `UPDATE intentchord.context_mapping_windows
            SET status = 'FAILED',
                error_message = $3,
                completed_at = clock_timestamp()
          WHERE id = $1 AND traversal_id = $2`,
        [data.windowId, data.traversalId, data.errorMessage ?? null],
      );
    });
  }

  async insertCandidateBatch(data: {
    id: string;
    traversalId: string;
    traversalAuthoritySha256: string;
    batchOrdinal: number;
    candidateCount: number;
    tokenCount: number;
    workerId: string;
    leaseEpoch: number;
  }): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, data.traversalId, data.workerId, data.leaseEpoch);
      await client.query(
        `INSERT INTO intentchord.context_mapping_candidate_batches (
          id, traversal_id, traversal_authority_sha256, batch_ordinal, status, candidate_count, token_count
        ) VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)`,
        [data.id, data.traversalId, data.traversalAuthoritySha256, data.batchOrdinal, data.candidateCount, data.tokenCount],
      );
    });
  }

  async insertCandidateUnits(
    units: ReadonlyArray<{
      id: string;
      batchId: string;
      traversalId: string;
      candidateOrdinal: number;
      workspaceRegistrationId: string;
      workspaceRevisionId: string;
      acceptedWorkspaceEvidenceArtifactId: string;
      sourceFileRevisionId: string;
      logicalUnitId: string;
      status: "SELECTED";
    }>,
    workerId: string,
    leaseEpoch: number,
  ): Promise<void> {
    if (units.length === 0) return;
    const traversalId = units[0].traversalId;
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);
      for (const u of units) {
        await client.query(
          `INSERT INTO intentchord.context_mapping_candidate_units (
            id, batch_id, traversal_id, candidate_ordinal, workspace_registration_id,
            workspace_revision_id, accepted_workspace_evidence_artifact_id, source_file_revision_id,
            logical_unit_id, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SELECTED')
          ON CONFLICT (traversal_id, logical_unit_id) DO NOTHING`,
          [
            u.id,
            u.batchId,
            u.traversalId,
            u.candidateOrdinal,
            u.workspaceRegistrationId,
            u.workspaceRevisionId,
            u.acceptedWorkspaceEvidenceArtifactId,
            u.sourceFileRevisionId,
            u.logicalUnitId,
          ],
        );
      }
    });
  }

  async findSelectedCandidateUnits(traversalId: string): Promise<ReadonlyArray<{
    id: string;
    batch_id: string;
    candidate_ordinal: number;
    logical_unit_id: string;
    source_file_revision_id: string;
    status: string;
  }>> {
    const res = await databaseQuery<{
      id: string;
      batch_id: string;
      candidate_ordinal: number;
      logical_unit_id: string;
      source_file_revision_id: string;
      status: string;
    }>(
      `SELECT id, batch_id, candidate_ordinal, logical_unit_id, source_file_revision_id, status
         FROM intentchord.context_mapping_candidate_units
        WHERE traversal_id = $1 AND status = 'SELECTED'
        ORDER BY candidate_ordinal ASC`,
      [traversalId],
    );
    return res.rows;
  }

  async markCandidateUnitsProcessed(
    candidateIds: readonly string[],
    windowId: string,
    workerId: string,
    leaseEpoch: number,
  ): Promise<void> {
    if (candidateIds.length === 0) return;
    await transaction(async client => {
      // Find traversalId from one of the candidates
      const travRes = await client.query<{ traversal_id: string }>(
        "SELECT traversal_id FROM intentchord.context_mapping_candidate_units WHERE id = $1",
        [candidateIds[0]],
      );
      if (travRes.rows.length === 0) return;
      const traversalId = travRes.rows[0].traversal_id;
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);

      await client.query(
        `UPDATE intentchord.context_mapping_candidate_units
            SET status = 'PROCESSED',
                processed_in_window_id = $2
          WHERE id = ANY($1::uuid[])`,
        [candidateIds, windowId],
      );
    });
  }

  async updateProgressAndCursor(data: {
    traversalId: string;
    cursorRecordSeq: number;
    topologyWindowCount: number;
    drilldownWindowCount: number;
    reductionLevelCount: number;
    activeWindowOrdinal: number;
    workerId: string;
    leaseEpoch: number;
  }): Promise<void> {
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, data.traversalId, data.workerId, data.leaseEpoch);
      await client.query(
        `UPDATE intentchord.context_mapping_traversals
            SET cursor_record_seq = GREATEST(cursor_record_seq, $2),
                topology_window_count = $3,
                drilldown_window_count = $4,
                reduction_level_count = $5,
                active_window_ordinal = $6,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [
          data.traversalId,
          data.cursorRecordSeq,
          data.topologyWindowCount,
          data.drilldownWindowCount,
          data.reductionLevelCount,
          data.activeWindowOrdinal,
        ],
      );
    });
  }

  async findSucceededWindows(traversalId: string): Promise<ReadonlyArray<ContextMappingWindowRow>> {
    const res = await databaseQuery<ContextMappingWindowRow>(
      `SELECT * FROM intentchord.context_mapping_windows
        WHERE traversal_id = $1 AND status = 'SUCCEEDED'
        ORDER BY phase ASC, window_ordinal ASC`,
      [traversalId],
    );
    return res.rows;
  }

  async insertReductionWindow(data: {
    id: string;
    traversalId: string;
    traversalAuthoritySha256: string;
    reductionLevel: number;
    reductionOrdinal: number;
    inputSetSha256: string;
    inputItemCount: number;
    inputEstimatedTokens?: number;
    outputEstimatedTokens?: number;
    tokenCount?: number;
    status: "READY" | "RUNNING" | "SUCCEEDED" | "FAILED";
    outputSha256?: string;
    outputSummary?: unknown;
    workerId: string;
    leaseEpoch: number;
  }): Promise<void> {
    const inTokens = data.inputEstimatedTokens ?? 0;
    const outTokens = data.outputEstimatedTokens ?? data.tokenCount ?? 0;
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, data.traversalId, data.workerId, data.leaseEpoch);
      await client.query(
        `INSERT INTO intentchord.context_mapping_reduction_windows (
          id, traversal_id, traversal_authority_sha256, reduction_level, reduction_ordinal,
          input_set_sha256, input_item_count, input_estimated_tokens, output_estimated_tokens, token_count, status, output_sha256, output_summary, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $11 = 'SUCCEEDED' THEN clock_timestamp() ELSE NULL END)`,
        [
          data.id,
          data.traversalId,
          data.traversalAuthoritySha256,
          data.reductionLevel,
          data.reductionOrdinal,
          data.inputSetSha256,
          data.inputItemCount,
          inTokens,
          outTokens,
          outTokens,
          data.status,
          data.outputSha256 ?? null,
          data.outputSummary ? JSON.stringify(data.outputSummary) : null,
        ],
      );
    });
  }

  async insertReductionInputs(
    inputs: ReadonlyArray<{
      id: string;
      reductionWindowId: string;
      traversalId: string;
      inputOrdinal: number;
      sourceMappingWindowId?: string;
      sourceReductionWindowId?: string;
      sourceOutputSha256: string;
    }>,
    workerId: string,
    leaseEpoch: number,
  ): Promise<void> {
    if (inputs.length === 0) return;
    const traversalId = inputs[0].traversalId;
    await transaction(async client => {
      await this.assertLeaseFencingInTransaction(client, traversalId, workerId, leaseEpoch);
      for (const item of inputs) {
        await client.query(
          `INSERT INTO intentchord.context_mapping_reduction_inputs (
            id, reduction_window_id, traversal_id, input_ordinal,
            source_mapping_window_id, source_reduction_window_id, source_output_sha256
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            item.id,
            item.reductionWindowId,
            item.traversalId,
            item.inputOrdinal,
            item.sourceMappingWindowId ?? null,
            item.sourceReductionWindowId ?? null,
            item.sourceOutputSha256,
          ],
        );
      }
    });
  }

  async transitionPhaseAndStatus(data: {
    traversalId: string;
    currentPhase: TraversalPhase;
    traversalStatus: TraversalStatus;
    workerId: string;
    leaseEpoch: number;
  }): Promise<void> {
    await this.transitionPhase(
      data.traversalId,
      data.workerId,
      data.leaseEpoch,
      data.currentPhase,
      data.traversalStatus,
    );
  }
}

export { PostgresContextMappingTraversalRepository as ContextMappingTraversalRepository };
export const contextMappingTraversalRepository = new PostgresContextMappingTraversalRepository();
