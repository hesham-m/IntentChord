import { HttpCommandError, requestError } from "@/server/errors";

const WORKSPACE_INDEX_PERSISTENCE_SENTINELS = new Set([
  "WORKSPACE_INDEX_SNAPSHOT_RESERVATION_MISSING",
  "CANONICAL_INDEX_ARTIFACT_RESOLUTION_MISSING",
  "WORKSPACE_INDEX_DELTA_ARTIFACT_RESOLUTION_MISSING",
]);

export function workspaceIndexRequestError(error: unknown): HttpCommandError {
  const bounded = requestError(error);
  if (bounded.code !== "INTERNAL_ERROR") return bounded;
  if (error instanceof Error && WORKSPACE_INDEX_PERSISTENCE_SENTINELS.has(error.message)) {
    return new HttpCommandError(
      409,
      error.message,
      "Workspace Index persistence authority could not resolve the governed snapshot/artifact identity.",
    );
  }
  return new HttpCommandError(
    500,
    "WORKSPACE_INDEX_UNCLASSIFIED_FAILURE",
    "Workspace Index failed before governed terminal completion. Inspect authoritative runtime evidence for the underlying cause.",
  );
}
