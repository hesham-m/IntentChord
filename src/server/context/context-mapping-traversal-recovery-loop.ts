import { ContextMappingTraversalRepository } from "@/server/context-mapping-traversal-repository";
import { ContextMappingTraversalExecutor } from "@/server/context/context-mapping-traversal-executor";
import { databasePool } from "@/server/db";

export const DEFAULT_RECOVERY_SCAN_INTERVAL_MS = 30_000;

declare global {
  var __INTENTCHORD_TRAVERSAL_RECOVERY_TIMER__: NodeJS.Timeout | undefined;
  var __INTENTCHORD_TRAVERSAL_RECOVERY_ACTIVE__: boolean | undefined;
}

/**
 * Runs a single recovery cycle: scans for abandoned or expired traversals
 * and claims them atomically with incremented epoch to continue execution.
 */
export async function runTraversalRecoveryCycle(
  traversalRepo?: ContextMappingTraversalRepository,
): Promise<number> {
  const repo = traversalRepo ?? new ContextMappingTraversalRepository();
  const recoverable = await repo.findRecoverableTraversals();
  let recoveredCount = 0;

  for (const item of recoverable) {
    try {
      // Find associated task ID from context_assembly_revisions -> context_assemblies
      const result = await databasePool().query<{ task_id: string }>(
        `SELECT a.task_id
           FROM intentchord.context_assembly_revisions r
           JOIN intentchord.context_assemblies a ON a.id = r.context_assembly_id
          WHERE r.id = $1`,
        [item.context_assembly_revision_id],
      );

      if (result.rows.length === 0) continue;
      const taskId = result.rows[0].task_id;

      const executor = new ContextMappingTraversalExecutor({ traversalRepo: repo });
      // Launch background execution; lease fencing guarantees single owner
      executor.executeTraversal(taskId, item.id).catch(() => {
        // Background failures are recorded in the traversal row
      });
      recoveredCount++;
    } catch {
      // Continue to next item
    }
  }

  return recoveredCount;
}

/**
 * Starts the traversal recovery loop once per runtime process.
 * Guards against duplicate loops during hot-reload or module re-imports.
 */
export function startTraversalRecoveryLoop(
  intervalMs = DEFAULT_RECOVERY_SCAN_INTERVAL_MS,
  traversalRepo?: ContextMappingTraversalRepository,
): void {
  if (globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_ACTIVE__) {
    return;
  }

  globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_ACTIVE__ = true;

  // Run immediate startup recovery cycle asynchronously
  runTraversalRecoveryCycle(traversalRepo).catch(() => {});

  // Start periodic background scanner
  globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_TIMER__ = setInterval(() => {
    runTraversalRecoveryCycle(traversalRepo).catch(() => {});
  }, intervalMs);
}

/**
 * Stops the periodic traversal recovery loop cleanly.
 */
export function stopTraversalRecoveryLoop(): void {
  if (globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_TIMER__) {
    clearInterval(globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_TIMER__);
    globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_TIMER__ = undefined;
  }
  globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_ACTIVE__ = false;
}
