import { globalRuntimeGovernanceCode } from "@/core/workspace-index/adapters/filesystem-errors";
import { ZodError } from "zod/v3";

export class HttpCommandError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ConflictError extends HttpCommandError {
  constructor(message = "The resource revision is stale.") {
    super(409, "REVISION_CONFLICT", message);
  }
}

export function requestError(error: unknown): HttpCommandError {
  if (error instanceof HttpCommandError) return error;
  const governedCode = globalRuntimeGovernanceCode(error);
  if (governedCode) {
    const isTerminalTimeControl = governedCode === "WORKSPACE_INDEX_ABORTED" || governedCode === "WORKSPACE_INDEX_TIMEOUT";
    return new HttpCommandError(
      isTerminalTimeControl ? 408 : 422,
      governedCode,
      governedCode === "WORKSPACE_INDEX_ABORTED"
        ? "The governed operation was aborted before terminal completion."
        : governedCode === "WORKSPACE_INDEX_TIMEOUT"
          ? "The governed operation exceeded its deadline before terminal completion."
          : "The governed operation exceeded its configured global runtime budget before terminal completion.",
    );
  }
  if (error instanceof ZodError) {
    return new HttpCommandError(
      400,
      "INVALID_REQUEST",
      "The command payload is invalid.",
      error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  if (error instanceof SyntaxError) {
    return new HttpCommandError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  return new HttpCommandError(500, "INTERNAL_ERROR", "The authoritative command failed.");
}
