/**
 * GOVERNED ENGINE ROUTER (Phase 4B Task B).
 *
 * Single parsing decision point for WORKSPACE_INDEX_ENGINE.
 * Called exactly once per operation at the service dependency construction layer.
 *
 * Accepted values: "V1" | "V2"
 * Absent → V1
 * Anything else → fail closed (throw)
 */

export type EngineChoice = "V1" | "V2";

const VALID_ENGINES: ReadonlySet<string> = new Set(["V1", "V2"]);

/**
 * Parse WORKSPACE_INDEX_ENGINE from the environment.
 *
 * - absent → V1
 * - "V1" → V1
 * - "V2" → V2
 * - anything else → throw (fail closed)
 *
 * Call exactly once per operation. Do not re-parse in continuity/authority,
 * in the engine, or in the API route.
 */
export function parseWorkspaceIndexEngine(
  env: Record<string, string | undefined>,
): EngineChoice {
  const raw = env.WORKSPACE_INDEX_ENGINE;
  if (raw === undefined || raw === null || raw === "") return "V1";
  if (!VALID_ENGINES.has(raw)) {
    throw new Error(
      `INVALID_WORKSPACE_INDEX_ENGINE:${JSON.stringify(raw)}; accepted values: V1, V2`,
    );
  }
  return raw as EngineChoice;
}
