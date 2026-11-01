export class WorkspaceIndexBoundedError extends Error {
  constructor(public readonly code: string, public readonly evidence: Record<string, unknown>) {
    super(code);
  }
}

export type WorkspaceTerminalRuntimeGovernanceCode = "WORKSPACE_INDEX_ABORTED" | "WORKSPACE_INDEX_TIMEOUT";

export type WorkspaceGlobalRuntimeGovernanceCode = WorkspaceTerminalRuntimeGovernanceCode
  | "WORKSPACE_INDEX_FILE_BUDGET_EXCEEDED"
  | "WORKSPACE_INDEX_BYTE_BUDGET_EXCEEDED"
  | "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED"
  | "WORKSPACE_INDEX_AGGREGATE_TEXT_BUDGET_EXCEEDED";

const TERMINAL_RUNTIME_GOVERNANCE_CODES = new Set<WorkspaceTerminalRuntimeGovernanceCode>([
  "WORKSPACE_INDEX_ABORTED",
  "WORKSPACE_INDEX_TIMEOUT",
]);

const GLOBAL_RUNTIME_GOVERNANCE_CODES = new Set<WorkspaceGlobalRuntimeGovernanceCode>([
  ...TERMINAL_RUNTIME_GOVERNANCE_CODES,
  "WORKSPACE_INDEX_FILE_BUDGET_EXCEEDED",
  "WORKSPACE_INDEX_BYTE_BUDGET_EXCEEDED",
  "WORKSPACE_INDEX_HASH_BUDGET_EXCEEDED",
  "WORKSPACE_INDEX_AGGREGATE_TEXT_BUDGET_EXCEEDED",
]);

export function terminalRuntimeGovernanceCode(error: unknown): WorkspaceTerminalRuntimeGovernanceCode | undefined {
  if (error instanceof WorkspaceIndexBoundedError && TERMINAL_RUNTIME_GOVERNANCE_CODES.has(error.code as WorkspaceTerminalRuntimeGovernanceCode)) {
    return error.code as WorkspaceTerminalRuntimeGovernanceCode;
  }
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;
  if (code && TERMINAL_RUNTIME_GOVERNANCE_CODES.has(code as WorkspaceTerminalRuntimeGovernanceCode)) {
    return code as WorkspaceTerminalRuntimeGovernanceCode;
  }
  const message = typeof candidate?.message === "string" ? candidate.message : undefined;
  if (message && TERMINAL_RUNTIME_GOVERNANCE_CODES.has(message as WorkspaceTerminalRuntimeGovernanceCode)) {
    return message as WorkspaceTerminalRuntimeGovernanceCode;
  }
  return undefined;
}

export function isTerminalRuntimeGovernanceError(error: unknown): boolean {
  return terminalRuntimeGovernanceCode(error) !== undefined;
}

export function globalRuntimeGovernanceCode(error: unknown): WorkspaceGlobalRuntimeGovernanceCode | undefined {
  const terminal = terminalRuntimeGovernanceCode(error);
  if (terminal) return terminal;
  if (error instanceof WorkspaceIndexBoundedError && GLOBAL_RUNTIME_GOVERNANCE_CODES.has(error.code as WorkspaceGlobalRuntimeGovernanceCode)) {
    return error.code as WorkspaceGlobalRuntimeGovernanceCode;
  }
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;
  if (code && GLOBAL_RUNTIME_GOVERNANCE_CODES.has(code as WorkspaceGlobalRuntimeGovernanceCode)) {
    return code as WorkspaceGlobalRuntimeGovernanceCode;
  }
  const message = typeof candidate?.message === "string" ? candidate.message : undefined;
  if (message && GLOBAL_RUNTIME_GOVERNANCE_CODES.has(message as WorkspaceGlobalRuntimeGovernanceCode)) {
    return message as WorkspaceGlobalRuntimeGovernanceCode;
  }
  return undefined;
}

export function isGlobalRuntimeGovernanceError(error: unknown): boolean {
  return globalRuntimeGovernanceCode(error) !== undefined;
}
