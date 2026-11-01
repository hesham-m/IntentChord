import { randomUUID } from "node:crypto";
import { mapperSha256, canonicalJson, estimatedTokensForUtf8 } from "@/core/ai-context-mapper/canonical";
import type {
  ContextComponentV2,
  ContextRelationshipV2,
  MissingEvidenceRequestV2,
  MaterialContradictionV2,
  ModelContextAnalysisV2,
} from "@/core/ai-context-mapper/v2";
import {
  ContextMappingTraversalRepository,
  type ContextMappingTraversalRow,
} from "@/server/context-mapping-traversal-repository";
import { ContextMappingTraversalCoordinator } from "@/server/context/context-mapping-traversal-coordinator";
import {
  buildNextTopologyWindow,
  DEFAULT_TOPOLOGY_WINDOW_TOKEN_BUDGET,
} from "@/server/context/topology-window-builder";
import {
  buildNextDrilldownWindow,
  DEFAULT_DRILLDOWN_WINDOW_TOKEN_BUDGET,
  type DrilldownCandidateUnit,
} from "@/server/context/selective-drilldown-builder";
import {
  executeHierarchicalReduction,
  type ReductionSourceItem,
} from "@/server/context/hierarchical-context-synthesizer";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import { databasePool, transaction } from "@/server/db";
import { DEFAULT_REDUCTION_WINDOW_TOKEN_BUDGET } from "@/server/context/governed-token-budget";
import { AiContextMapperV2Orchestrator } from "@/core/ai-context-mapper/orchestrator-v2";
import { ReductionSynthesisAdapter } from "@/server/context/reduction-synthesis-adapter";
import { PostgresAiContextMappingV2Repository } from "@/server/ai-context-mapping-v2-repository";
import { createInternalAiProviderAdapter } from "@/server/internal-ai-engine-runtime";
import {
  readAiContextMapperV2Config,
  assertProductionInternalAiExecutionV2Ready,
  resolveInternalAiCredential,
  resolveQualifiedStandby,
  type ResolvedInternalAiEngineConfig,
} from "@/server/ai-context-mapper-config";
import { resolveV2InternalAiCredential } from "@/server/ai-context-mapper-config";
import { INTERNAL_AI_QUALIFICATION_SCOPE_V2 } from "@/core/ai-context-mapper/types";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";
import type { ContextAssemblyMappingInputV2 } from "@/core/ai-context-mapper/v2";

export const CONTEXT_MAPPING_LEASE_TTL_MS = 60_000;
export const CONTEXT_MAPPING_HEARTBEAT_INTERVAL_MS = 15_000;

function engineFromSnapshot(snap: any, role: "ACTIVE" | "STANDBY"): ResolvedInternalAiEngineConfig {
  return {
    engineId: snap.engine_id,
    engineConfigRevision: snap.engine_config_revision,
    engineConfigurationSha256: snap.engine_configuration_sha256,
    providerId: snap.provider_id,
    channelId: snap.channel_id,
    modelId: snap.model_id,
    endpoint: snap.endpoint,
    credentialReference: snap.credential_reference,
    transportProfileId: snap.transport_profile_id,
    behaviorProfileId: snap.behavior_profile_id,
    capabilityProfileVersion: snap.capability_profile_version,
    timeoutMs: snap.timeout_ms || 60_000,
    role,
    ownerEnabled: role === "ACTIVE",
    ...(snap.qualification ? {
      qualification: {
        qualificationId: snap.qualification.qualification_id,
        engineId: snap.qualification.engine_id,
        engineConfigRevision: snap.qualification.engine_config_revision,
        engineConfigurationSha256: snap.qualification.engine_configuration_sha256,
        qualificationStatus: snap.qualification.qualification_status,
        qualificationScope: snap.qualification.qualification_scope,
        qualifiedAt: snap.qualification.qualified_at,
        qualifiedBy: snap.qualification.qualified_by,
        evidenceReference: snap.qualification.evidence_reference,
        capabilityProfileVersion: snap.qualification.capability_profile_version,
      },
    } : {}),
  };
}

if (CONTEXT_MAPPING_HEARTBEAT_INTERVAL_MS >= CONTEXT_MAPPING_LEASE_TTL_MS / 2) {
  throw new Error("GOVERNANCE_VIOLATION: CONTEXT_MAPPING_HEARTBEAT_INTERVAL_MS must be strictly less than CONTEXT_MAPPING_LEASE_TTL_MS / 2.");
}

export type ContextMappingTraversalExecutorOptions = {
  workerId?: string;
  evidenceRepo?: PostgresWorkspaceEvidenceRepository;
  traversalRepo?: ContextMappingTraversalRepository;
  orchestrator?: AiContextMapperV2Orchestrator;
  reductionAdapter?: ReductionSynthesisAdapter;
};

export class ContextMappingTraversalExecutor {
  private readonly workerId: string;
  private readonly evidenceRepo: PostgresWorkspaceEvidenceRepository;
  private readonly traversalRepo: ContextMappingTraversalRepository;
  private readonly coordinator: ContextMappingTraversalCoordinator;
  private readonly orchestrator?: AiContextMapperV2Orchestrator;
  private readonly reductionAdapter?: ReductionSynthesisAdapter;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private currentEpoch = 0;

  constructor(options?: ContextMappingTraversalExecutorOptions) {
    this.workerId = options?.workerId ?? `worker_${randomUUID()}`;
    this.evidenceRepo = options?.evidenceRepo ?? new PostgresWorkspaceEvidenceRepository();
    this.traversalRepo = options?.traversalRepo ?? new ContextMappingTraversalRepository();
    this.coordinator = new ContextMappingTraversalCoordinator(this.traversalRepo);
    this.orchestrator = options?.orchestrator;
    this.reductionAdapter = options?.reductionAdapter;
  }

  private async getOrchestrator(traversal: ContextMappingTraversalRow): Promise<AiContextMapperV2Orchestrator> {
    if (this.orchestrator) return this.orchestrator;

    let active: ResolvedInternalAiEngineConfig;
    let standby: ResolvedInternalAiEngineConfig | undefined;
    let providerConfigurationSnapshot: any;
    let activeTimeoutMs = 60_000;
    let standbyTimeoutMs = 60_000;
    let standbyEnabled = false;
    let standbyGovernanceQualified = false;

    if (traversal.ai_execution_active_engine_id && traversal.ai_execution_provider_configuration_snapshot) {
      const snap = typeof traversal.ai_execution_provider_configuration_snapshot === "string"
        ? JSON.parse(traversal.ai_execution_provider_configuration_snapshot)
        : traversal.ai_execution_provider_configuration_snapshot;

      await internalAiEngineRegistryService.assertFrozenAiExecutionAuthorityValid({
        activeEngineId: traversal.ai_execution_active_engine_id,
        activeEngineConfigRevision: traversal.ai_execution_active_engine_config_revision!,
        activeEngineConfigurationSha256: traversal.ai_execution_active_engine_configuration_sha256!,
        activeQualificationId: traversal.ai_execution_active_qualification_id!,
        credentialReference: snap.active?.credential_reference || "ZAI_API_KEY",
        standbyEngineId: traversal.ai_execution_standby_engine_id ?? undefined,
        standbyEngineConfigRevision: traversal.ai_execution_standby_engine_config_revision ?? undefined,
        standbyEngineConfigurationSha256: traversal.ai_execution_standby_engine_configuration_sha256 ?? undefined,
        standbyQualificationId: traversal.ai_execution_standby_qualification_id ?? undefined,
        standbyCredentialReference: snap.standby?.credential_reference || undefined,
      });

      active = engineFromSnapshot(snap.active, "ACTIVE");
      activeTimeoutMs = active.timeoutMs;
      standby = snap.standby ? engineFromSnapshot(snap.standby, "STANDBY") : undefined;
      standbyTimeoutMs = standby?.timeoutMs ?? activeTimeoutMs;
      standbyEnabled = Boolean(snap.failover_policy?.enabled);
      standbyGovernanceQualified = Boolean(snap.failover_policy?.governance_qualified);
      providerConfigurationSnapshot = snap;
    } else {
      const config = readAiContextMapperV2Config();
      assertProductionInternalAiExecutionV2Ready(config);
      active = config.active;
      activeTimeoutMs = active.timeoutMs;
      standby = resolveQualifiedStandby(config);
      standbyTimeoutMs = standby?.timeoutMs ?? activeTimeoutMs;
      standbyEnabled = config.standbyEnabled;
      standbyGovernanceQualified = config.standbyGovernanceQualified;
      providerConfigurationSnapshot = config.providerConfigurationSnapshot;
    }

    const activeCredential = await resolveV2InternalAiCredential(active.credentialReference);
    if (!activeCredential) {
      throw new Error("INTERNAL_AI_ACTIVE_ENGINE_CREDENTIAL_REQUIRED: The qualified V2 Internal Engine credential is unavailable from the secret resolver.");
    }
    const standbyCredential = standby ? await resolveV2InternalAiCredential(standby.credentialReference) : undefined;

    const v2Repo = new PostgresAiContextMappingV2Repository();
    const rev = await databasePool().query<{ assembly_sha256: string }>(
      "SELECT assembly_sha256 FROM intentchord.context_assembly_revisions WHERE id = $1",
      [traversal.context_assembly_revision_id],
    );
    const assemblySha256 = rev.rows[0]?.assembly_sha256 ?? traversal.traversal_authority_sha256;

    return new AiContextMapperV2Orchestrator(
      v2Repo,
      createInternalAiProviderAdapter(active, {
        credentialOverride: activeCredential,
        executionMode: "PRODUCTION",
        expectedQualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      }),
      standby && standbyCredential
        ? createInternalAiProviderAdapter(standby, {
            credentialOverride: standbyCredential,
            executionMode: "STANDBY_FAILOVER",
            expectedQualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
          })
        : undefined,
      {
        providerConfigurationSnapshot,
        standbyEnabled,
        standbyGovernanceQualified,
        assemblySha256,
        idempotencyKey: `traversal:${traversal.id}:window:${traversal.active_window_ordinal}`,
        requestFingerprintSha256: mapperSha256({
          traversalId: traversal.id,
          windowOrdinal: traversal.active_window_ordinal,
          authoritySha256: traversal.traversal_authority_sha256,
        }),
        primaryRequestTimeoutMs: activeTimeoutMs,
        standbyRequestTimeoutMs: standbyTimeoutMs,
      },
    );
  }

  private async getReductionAdapter(traversal: ContextMappingTraversalRow): Promise<ReductionSynthesisAdapter> {
    if (this.reductionAdapter) return this.reductionAdapter;

    let active: ResolvedInternalAiEngineConfig;
    let standby: ResolvedInternalAiEngineConfig | undefined;
    let providerConfigurationSnapshot: any;
    let activeTimeoutMs = 60_000;
    let standbyTimeoutMs = 60_000;
    let standbyEnabled = false;
    let standbyGovernanceQualified = false;

    if (traversal.ai_execution_active_engine_id && traversal.ai_execution_provider_configuration_snapshot) {
      const snap = typeof traversal.ai_execution_provider_configuration_snapshot === "string"
        ? JSON.parse(traversal.ai_execution_provider_configuration_snapshot)
        : traversal.ai_execution_provider_configuration_snapshot;

      await internalAiEngineRegistryService.assertFrozenAiExecutionAuthorityValid({
        activeEngineId: traversal.ai_execution_active_engine_id,
        activeEngineConfigRevision: traversal.ai_execution_active_engine_config_revision!,
        activeEngineConfigurationSha256: traversal.ai_execution_active_engine_configuration_sha256!,
        activeQualificationId: traversal.ai_execution_active_qualification_id!,
        credentialReference: snap.active?.credential_reference || "ZAI_API_KEY",
        standbyEngineId: traversal.ai_execution_standby_engine_id ?? undefined,
        standbyEngineConfigRevision: traversal.ai_execution_standby_engine_config_revision ?? undefined,
        standbyEngineConfigurationSha256: traversal.ai_execution_standby_engine_configuration_sha256 ?? undefined,
        standbyQualificationId: traversal.ai_execution_standby_qualification_id ?? undefined,
        standbyCredentialReference: snap.standby?.credential_reference || undefined,
      });

      active = engineFromSnapshot(snap.active, "ACTIVE");
      activeTimeoutMs = active.timeoutMs;
      standby = snap.standby ? engineFromSnapshot(snap.standby, "STANDBY") : undefined;
      standbyTimeoutMs = standby?.timeoutMs ?? activeTimeoutMs;
      standbyEnabled = Boolean(snap.failover_policy?.enabled);
      standbyGovernanceQualified = Boolean(snap.failover_policy?.governance_qualified);
      providerConfigurationSnapshot = snap;
    } else {
      const config = readAiContextMapperV2Config();
      assertProductionInternalAiExecutionV2Ready(config);
      active = config.active;
      activeTimeoutMs = active.timeoutMs;
      standby = resolveQualifiedStandby(config);
      standbyTimeoutMs = standby?.timeoutMs ?? activeTimeoutMs;
      standbyEnabled = config.standbyEnabled;
      standbyGovernanceQualified = config.standbyGovernanceQualified;
      providerConfigurationSnapshot = config.providerConfigurationSnapshot;
    }

    const activeCredential = await resolveV2InternalAiCredential(active.credentialReference);
    if (!activeCredential) {
      throw new Error("INTERNAL_AI_ACTIVE_ENGINE_CREDENTIAL_REQUIRED: The qualified V2 Internal Engine credential is unavailable from the secret resolver.");
    }
    const standbyCredential = standby ? await resolveV2InternalAiCredential(standby.credentialReference) : undefined;

    return new ReductionSynthesisAdapter(
      createInternalAiProviderAdapter(active, {
        credentialOverride: activeCredential,
        executionMode: "PRODUCTION",
        expectedQualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      }),
      standby && standbyCredential
        ? createInternalAiProviderAdapter(standby, {
            credentialOverride: standbyCredential,
            executionMode: "STANDBY_FAILOVER",
            expectedQualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
          })
        : undefined,
      {
        providerConfigurationSnapshot,
        primaryRequestTimeoutMs: activeTimeoutMs,
        standbyRequestTimeoutMs: standbyTimeoutMs,
        standbyEnabled,
        standbyGovernanceQualified,
      },
    );
  }

  getWorkerId(): string {
    return this.workerId;
  }

  getCurrentEpoch(): number {
    return this.currentEpoch;
  }

  private startHeartbeat(traversalId: string): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      try {
        const ok = await this.traversalRepo.heartbeat(
          traversalId,
          this.workerId,
          this.currentEpoch,
          CONTEXT_MAPPING_LEASE_TTL_MS,
        );
        if (!ok) {
          this.stopHeartbeat();
        }
      } catch {
        this.stopHeartbeat();
      }
    }, CONTEXT_MAPPING_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Main execution loop for the traversal.
   * Fenced against stale workers across commit boundaries.
   */
  async executeTraversal(taskId: string, traversalId: string): Promise<ContextMappingTraversalRow> {
    // 1. Acquire or reclaim lease atomically
    const lease = await this.traversalRepo.acquireOrReclaimLease(
      traversalId,
      this.workerId,
      CONTEXT_MAPPING_LEASE_TTL_MS,
    );

    if (!lease.acquired) {
      const active = await this.traversalRepo.findActiveTraversalById(traversalId);
      if (!active) throw new Error(`TRAVERSAL_NOT_FOUND: ${traversalId}`);
      return active;
    }

    this.currentEpoch = lease.epoch;
    this.startHeartbeat(traversalId);

    try {
      let traversal = await this.traversalRepo.findActiveTraversalById(traversalId);
      if (!traversal) throw new Error(`TRAVERSAL_NOT_FOUND: ${traversalId}`);

      // Loop while active
      while (
        traversal.traversal_status !== "SYNTHESIS_COMPLETE" &&
        traversal.traversal_status !== "FAILED" &&
        traversal.traversal_status !== "STALE_AUTHORITY" &&
        traversal.traversal_status !== "CANCELLED"
      ) {
        // Authority check before every forward step
        const client = await databasePool().connect();
        let validAuthority = false;
        try {
          validAuthority = await this.coordinator.revalidateEffectiveAuthorityOrMarkStale(
            client,
            taskId,
            traversal,
            this.workerId,
            this.currentEpoch,
          );
        } finally {
          client.release();
        }

        if (!validAuthority) {
          break;
        }

        if (traversal.current_phase === "TOPOLOGY") {
          await this.executeTopologyPhase(traversal);
        } else if (traversal.current_phase === "DRILLDOWN") {
          await this.executeDrilldownPhase(traversal);
        } else if (traversal.current_phase === "SYNTHESIS") {
          await this.executeSynthesisPhase(traversal);
        }

        traversal = (await this.traversalRepo.findActiveTraversalById(traversalId))!;
      }

      await this.traversalRepo.releaseLease(traversalId, this.workerId, this.currentEpoch);
      return traversal;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.traversalRepo.failTraversal(
          traversalId,
          this.workerId,
          this.currentEpoch,
          "EXECUTOR_FAILURE",
          message,
        );
      } catch {
        // If lease lost or stolen, ignore secondary failure
      }
      throw error;
    } finally {
      this.stopHeartbeat();
    }
  }

  private async executeTopologyPhase(traversal: ContextMappingTraversalRow): Promise<void> {
    const nextWindow = await buildNextTopologyWindow({
      evidenceRepo: this.evidenceRepo,
      artifactId: traversal.accepted_workspace_evidence_artifact_id,
      traversalId: traversal.id,
      traversalAuthoritySha256: traversal.traversal_authority_sha256,
      windowOrdinal: traversal.active_window_ordinal,
      startCursorRecordSeq: Number(traversal.cursor_record_seq),
      tokenBudget: DEFAULT_TOPOLOGY_WINDOW_TOKEN_BUDGET,
    });

    if (!nextWindow) {
      // Topology complete. Transition to DRILLDOWN phase.
      await this.coordinator.advancePhase(
        traversal.id,
        "DRILLDOWN",
        "TOPOLOGY_COMPLETE",
        this.workerId,
        this.currentEpoch,
      );
      await this.coordinator.advancePhase(
        traversal.id,
        "DRILLDOWN",
        "DRILLDOWN_IN_PROGRESS",
        this.workerId,
        this.currentEpoch,
      );
      return;
    }

    const windowId = randomUUID();
    await this.traversalRepo.insertEvidenceWindow({
      id: windowId,
      traversalId: traversal.id,
      traversalAuthoritySha256: traversal.traversal_authority_sha256,
      phase: "TOPOLOGY",
      windowOrdinal: nextWindow.windowOrdinal,
      cursorArtifactId: traversal.accepted_workspace_evidence_artifact_id,
      cursorSectionId: traversal.cursor_section_id,
      cursorSectionType: traversal.cursor_section_type,
      cursorSectionSchemaVersion: traversal.cursor_section_schema_version,
      startCursorRecordSeq: nextWindow.startCursorRecordSeq,
      endCursorRecordSeq: nextWindow.endCursorRecordSeq,
      tokenCount: nextWindow.tokenCount,
      windowInputSha256: nextWindow.windowInputSha256,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });

    await this.traversalRepo.markWindowRunning({
      windowId,
      traversalId: traversal.id,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });

    // Execute governed AI Context Mapping for the topology window
    const mappingInput: ContextAssemblyMappingInputV2 = {
      schema_version: "intentchord.context-assembly-mapping-input.v1",
      context_assembly_id: traversal.context_assembly_revision_id,
      context_assembly_revision_id: traversal.context_assembly_revision_id,
      context_assembly_revision: 1,
      created_at: new Date().toISOString(),
      source_bindings: [{
        workspace_id: traversal.workspace_registration_id,
        workspace_registration_revision: 1,
        workspace_registration_fingerprint: traversal.traversal_authority_sha256,
        workspace_revision_id: traversal.workspace_revision_id,
        workspace_index_snapshot_id: traversal.workspace_index_snapshot_id,
        canonical_index_artifact_id: traversal.accepted_workspace_evidence_artifact_id,
        accepted_workspace_evidence_artifact_id: traversal.accepted_workspace_evidence_artifact_id,
        workspace_index_sha256: traversal.artifact_semantic_sha256,
        artifact_semantic_sha256: traversal.artifact_semantic_sha256,
      }],
      entries: nextWindow.entries,
      serialized_payload_sha256: nextWindow.windowInputSha256,
      provider_neutral_estimated_tokens: nextWindow.tokenCount,
      proof_obligations: ["TOPOLOGY_TRAVERSAL_PASS"],
    };

    const orchestrator = await this.getOrchestrator(traversal);
    const run = await orchestrator.run(mappingInput);
    if (!run.result || !run.result.analysis) {
      const errMsg = `TOPOLOGY_WINDOW_EXECUTION_FAILED: Window ${nextWindow.windowOrdinal} mapping failed. Status: ${run.status}`;
      await this.traversalRepo.failWindow({
        windowId,
        traversalId: traversal.id,
        workerId: this.workerId,
        leaseEpoch: this.currentEpoch,
        errorMessage: errMsg,
      });
      throw new Error(errMsg);
    }

    const resultPayload = run.result.analysis;
    const windowResultSha256 = run.result.analysisSha256;

    await this.traversalRepo.completeWindow({
      windowId,
      traversalId: traversal.id,
      windowResultJson: resultPayload,
      windowResultSha256,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });

    // Persist candidates if any discovered in this topology window
    const candidatesToPersist = nextWindow.candidateUnits?.length > 0
      ? nextWindow.candidateUnits
      : nextWindow.candidateUnitIds.map(luid => ({ logical_unit_id: luid, source_file_revision_id: `rev_${luid}` }));

    if (candidatesToPersist.length > 0) {
      const batchId = randomUUID();
      await this.traversalRepo.insertCandidateBatch({
        id: batchId,
        traversalId: traversal.id,
        traversalAuthoritySha256: traversal.traversal_authority_sha256,
        batchOrdinal: nextWindow.windowOrdinal,
        candidateCount: candidatesToPersist.length,
        tokenCount: nextWindow.tokenCount,
        workerId: this.workerId,
        leaseEpoch: this.currentEpoch,
      });

      const units = candidatesToPersist.map((cand, idx) => ({
        id: randomUUID(),
        batchId,
        traversalId: traversal.id,
        candidateOrdinal: idx + 1,
        workspaceRegistrationId: traversal.workspace_registration_id,
        workspaceRevisionId: traversal.workspace_revision_id,
        acceptedWorkspaceEvidenceArtifactId: traversal.accepted_workspace_evidence_artifact_id,
        sourceFileRevisionId: cand.source_file_revision_id,
        logicalUnitId: cand.logical_unit_id,
        status: "SELECTED" as const,
      }));

      await this.traversalRepo.insertCandidateUnits(units, this.workerId, this.currentEpoch);
    }

    // Advance cursor and active window ordinal
    await this.traversalRepo.updateProgressAndCursor({
      traversalId: traversal.id,
      cursorRecordSeq: nextWindow.endCursorRecordSeq,
      topologyWindowCount: traversal.topology_window_count + 1,
      drilldownWindowCount: traversal.drilldown_window_count,
      reductionLevelCount: traversal.reduction_level_count,
      activeWindowOrdinal: traversal.active_window_ordinal + 1,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });
  }

  private async executeDrilldownPhase(traversal: ContextMappingTraversalRow): Promise<void> {
    const selectedUnits = await this.traversalRepo.findSelectedCandidateUnits(traversal.id);
    if (selectedUnits.length === 0) {
      // No more candidates to drill down. Transition to SYNTHESIS.
      await this.coordinator.advancePhase(
        traversal.id,
        "SYNTHESIS",
        "DRILLDOWN_COMPLETE",
        this.workerId,
        this.currentEpoch,
      );
      await this.coordinator.advancePhase(
        traversal.id,
        "SYNTHESIS",
        "SYNTHESIS_IN_PROGRESS",
        this.workerId,
        this.currentEpoch,
      );
      return;
    }

    const candidateInputs: DrilldownCandidateUnit[] = selectedUnits.map(u => ({
      id: u.id,
      logical_unit_id: u.logical_unit_id,
      source_file_revision_id: u.source_file_revision_id,
      candidate_ordinal: u.candidate_ordinal,
    }));

    const drilldownResult = await buildNextDrilldownWindow({
      evidenceRepo: this.evidenceRepo,
      artifactId: traversal.accepted_workspace_evidence_artifact_id,
      traversalId: traversal.id,
      traversalAuthoritySha256: traversal.traversal_authority_sha256,
      windowOrdinal: traversal.active_window_ordinal,
      candidates: candidateInputs,
      tokenBudget: DEFAULT_DRILLDOWN_WINDOW_TOKEN_BUDGET,
    });

    if (!drilldownResult) {
      await this.coordinator.advancePhase(
        traversal.id,
        "SYNTHESIS",
        "DRILLDOWN_COMPLETE",
        this.workerId,
        this.currentEpoch,
      );
      await this.coordinator.advancePhase(
        traversal.id,
        "SYNTHESIS",
        "SYNTHESIS_IN_PROGRESS",
        this.workerId,
        this.currentEpoch,
      );
      return;
    }

    const windowId = randomUUID();
    await this.traversalRepo.insertEvidenceWindow({
      id: windowId,
      traversalId: traversal.id,
      traversalAuthoritySha256: traversal.traversal_authority_sha256,
      phase: "DRILLDOWN",
      windowOrdinal: drilldownResult.windowOrdinal,
      cursorArtifactId: traversal.accepted_workspace_evidence_artifact_id,
      cursorSectionId: traversal.cursor_section_id,
      cursorSectionType: traversal.cursor_section_type,
      cursorSectionSchemaVersion: traversal.cursor_section_schema_version,
      startCursorRecordSeq: drilldownResult.startCursorRecordSeq,
      endCursorRecordSeq: drilldownResult.endCursorRecordSeq,
      tokenCount: drilldownResult.tokenCount,
      windowInputSha256: drilldownResult.windowInputSha256,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });

    await this.traversalRepo.markWindowRunning({
      windowId,
      traversalId: traversal.id,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });

    // Execute governed AI Context Mapping for the drilldown window
    const mappingInput: ContextAssemblyMappingInputV2 = {
      schema_version: "intentchord.context-assembly-mapping-input.v1",
      context_assembly_id: traversal.context_assembly_revision_id,
      context_assembly_revision_id: traversal.context_assembly_revision_id,
      context_assembly_revision: 1,
      created_at: new Date().toISOString(),
      source_bindings: [{
        workspace_id: traversal.workspace_registration_id,
        workspace_registration_revision: 1,
        workspace_registration_fingerprint: traversal.traversal_authority_sha256,
        workspace_revision_id: traversal.workspace_revision_id,
        workspace_index_snapshot_id: traversal.workspace_index_snapshot_id,
        canonical_index_artifact_id: traversal.accepted_workspace_evidence_artifact_id,
        accepted_workspace_evidence_artifact_id: traversal.accepted_workspace_evidence_artifact_id,
        workspace_index_sha256: traversal.artifact_semantic_sha256,
        artifact_semantic_sha256: traversal.artifact_semantic_sha256,
      }],
      entries: drilldownResult.entries,
      serialized_payload_sha256: drilldownResult.windowInputSha256,
      provider_neutral_estimated_tokens: drilldownResult.tokenCount,
      proof_obligations: ["DRILLDOWN_TRAVERSAL_PASS"],
    };

    const orchestrator = await this.getOrchestrator(traversal);
    const run = await orchestrator.run(mappingInput);
    if (!run.result || !run.result.analysis) {
      const errMsg = `DRILLDOWN_WINDOW_EXECUTION_FAILED: Window ${drilldownResult.windowOrdinal} mapping failed. Status: ${run.status}`;
      await this.traversalRepo.failWindow({
        windowId,
        traversalId: traversal.id,
        workerId: this.workerId,
        leaseEpoch: this.currentEpoch,
        errorMessage: errMsg,
      });
      throw new Error(errMsg);
    }

    const resultPayload = run.result.analysis;
    const windowResultSha256 = run.result.analysisSha256;

    await this.traversalRepo.completeWindow({
      windowId,
      traversalId: traversal.id,
      windowResultJson: resultPayload,
      windowResultSha256,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });

    await this.traversalRepo.markCandidateUnitsProcessed(
      drilldownResult.processedCandidateIds,
      windowId,
      this.workerId,
      this.currentEpoch,
    );

    await this.traversalRepo.updateProgressAndCursor({
      traversalId: traversal.id,
      cursorRecordSeq: traversal.cursor_record_seq,
      topologyWindowCount: traversal.topology_window_count,
      drilldownWindowCount: traversal.drilldown_window_count + 1,
      reductionLevelCount: traversal.reduction_level_count,
      activeWindowOrdinal: traversal.active_window_ordinal + 1,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });
  }

  private async executeSynthesisPhase(traversal: ContextMappingTraversalRow): Promise<void> {
    await this.coordinator.advancePhase(
      traversal.id,
      "SYNTHESIS",
      "SYNTHESIS_REDUCING",
      this.workerId,
      this.currentEpoch,
    );

    const succeededWindows = await this.traversalRepo.findSucceededWindows(traversal.id);
    if (succeededWindows.length === 0) {
      throw new Error("SYNTHESIS_ERROR: No succeeded windows to reduce.");
    }

    const initialSources: ReductionSourceItem[] = succeededWindows.map(w => ({
      sourceType: "MAPPING_WINDOW",
      sourceId: w.id,
      sourceOutputSha256: w.window_result_sha256!,
      payload: (w.window_result_json as ReductionSourceItem["payload"]) ?? {},
    }));

    const reductionAdapter = await this.getReductionAdapter(traversal);
    const reductionResult = await executeHierarchicalReduction(
      this.traversalRepo,
      traversal.id,
      traversal.traversal_authority_sha256,
      this.workerId,
      this.currentEpoch,
      initialSources,
      {
        reductionAdapter,
        tokenBudget: DEFAULT_REDUCTION_WINDOW_TOKEN_BUDGET,
      },
    );

    await this.traversalRepo.updateProgressAndCursor({
      traversalId: traversal.id,
      cursorRecordSeq: traversal.cursor_record_seq,
      topologyWindowCount: traversal.topology_window_count,
      drilldownWindowCount: traversal.drilldown_window_count,
      reductionLevelCount: reductionResult.totalReductionLevels,
      activeWindowOrdinal: traversal.active_window_ordinal,
      workerId: this.workerId,
      leaseEpoch: this.currentEpoch,
    });

    await this.coordinator.advancePhase(
      traversal.id,
      "SYNTHESIS",
      "SYNTHESIS_COMPLETE",
      this.workerId,
      this.currentEpoch,
    );
  }
}
