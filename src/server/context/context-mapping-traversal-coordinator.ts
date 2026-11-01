import type { PoolClient } from "pg";
import { assertCurrentEffectiveContextAuthority } from "@/server/context-head-authority";
import type {
  ContextMappingTraversalRepository,
  ContextMappingTraversalRow,
  TraversalPhase,
  TraversalStatus,
} from "@/server/context-mapping-traversal-repository";
import { HttpCommandError } from "@/server/errors";

export class StaleAuthorityError extends Error {
  constructor(message: string, public readonly detail?: unknown) {
    super(message);
    this.name = "StaleAuthorityError";
  }
}

/**
 * Owns legal Backend state transitions for multi-window context mapping traversals.
 * Revalidates effective Context Authority before every forward window.
 * Frontend cannot advance phases.
 */
export class ContextMappingTraversalCoordinator {
  constructor(private readonly repository: ContextMappingTraversalRepository) {}

  /**
   * Revalidates that the traversal's frozen authority is still the current effective Context Authority.
   * If drift is detected, transitions to STALE_AUTHORITY immediately and aborts.
   */
  async revalidateEffectiveAuthorityOrMarkStale(
    client: PoolClient,
    taskId: string,
    traversal: ContextMappingTraversalRow,
    workerId: string,
    leaseEpoch: number,
  ): Promise<boolean> {
    try {
      await assertCurrentEffectiveContextAuthority(
        client,
        taskId,
        traversal.context_assembly_revision_id,
        "STALE_CONTEXT_HEAD",
        [traversal.workspace_registration_id],
      );
      return true;
    } catch (error) {
      // Authority drift detected. Transition traversal to STALE_AUTHORITY.
      const reason = error instanceof Error ? error.message : String(error);
      await this.repository.markStaleAuthority(
        traversal.id,
        workerId,
        leaseEpoch,
        reason,
      );
      return false;
    }
  }

  /**
   * Advances traversal to next legal status/phase with fenced validation.
   */
  async advancePhase(
    traversalId: string,
    nextPhase: TraversalPhase,
    nextStatus: TraversalStatus,
    workerId: string,
    leaseEpoch: number,
  ): Promise<void> {
    const validTransitions: Record<TraversalStatus, TraversalStatus[]> = {
      TOPOLOGY_IN_PROGRESS: ["TOPOLOGY_COMPLETE", "FAILED", "STALE_AUTHORITY", "CANCELLED"],
      TOPOLOGY_COMPLETE: ["DRILLDOWN_IN_PROGRESS", "SYNTHESIS_IN_PROGRESS", "FAILED", "STALE_AUTHORITY", "CANCELLED"],
      DRILLDOWN_IN_PROGRESS: ["DRILLDOWN_COMPLETE", "FAILED", "STALE_AUTHORITY", "CANCELLED"],
      DRILLDOWN_COMPLETE: ["SYNTHESIS_IN_PROGRESS", "FAILED", "STALE_AUTHORITY", "CANCELLED"],
      SYNTHESIS_IN_PROGRESS: ["SYNTHESIS_REDUCING", "SYNTHESIS_COMPLETE", "FAILED", "STALE_AUTHORITY", "CANCELLED"],
      SYNTHESIS_REDUCING: ["SYNTHESIS_COMPLETE", "FAILED", "STALE_AUTHORITY", "CANCELLED"],
      SYNTHESIS_COMPLETE: [],
      FAILED: [],
      STALE_AUTHORITY: [],
      CANCELLED: [],
    };

    const current = await this.repository.findActiveTraversalById(traversalId);
    if (!current) {
      throw new Error(`TRAVERSAL_NOT_FOUND: ${traversalId}`);
    }

    const allowed = validTransitions[current.traversal_status];
    if (!allowed.includes(nextStatus)) {
      throw new Error(
        `ILLEGAL_TRAVERSAL_TRANSITION: Cannot transition from ${current.traversal_status} to ${nextStatus}`,
      );
    }

    await this.repository.transitionPhaseAndStatus({
      traversalId,
      currentPhase: nextPhase,
      traversalStatus: nextStatus,
      workerId,
      leaseEpoch,
    });
  }
}
