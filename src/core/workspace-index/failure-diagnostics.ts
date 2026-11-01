import { createHash } from "node:crypto";

export type BoundedFailureDiagnostic = {
  errorName: string;
  errorCode?: string;
  diagnosticIdentitySha256: string;
};

const MAX_NAME_LENGTH = 120;
const MAX_CODE_LENGTH = 120;
const MAX_MESSAGE_HASH_INPUT_LENGTH = 512;

export function boundedFailureDiagnostic(error: unknown): BoundedFailureDiagnostic {
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown } | undefined;
  const rawName = typeof candidate?.name === "string" ? candidate.name : "";
  const rawMessage = typeof candidate?.message === "string" ? candidate.message : "";
  const rawCode = typeof candidate?.code === "string" && candidate.code.trim() ? candidate.code : undefined;
  const errorName = (rawName || "Unknown").slice(0, MAX_NAME_LENGTH);
  const identity = createHash("sha256")
    .update("intentchord.workspace-index.failure-diagnostic-identity/v1")
    .update("\u0000")
    .update(errorName)
    .update("\u0000")
    .update(rawCode?.slice(0, MAX_CODE_LENGTH) ?? "")
    .update("\u0000")
    .update(rawMessage.slice(0, MAX_MESSAGE_HASH_INPUT_LENGTH))
    .digest("hex");
  return {
    errorName,
    ...(rawCode ? { errorCode: rawCode.slice(0, MAX_CODE_LENGTH) } : {}),
    diagnosticIdentitySha256: `sha256:${identity}`,
  };
}

export function reportBoundedSecondaryDiagnostic(channel: string, error: unknown): void {
  console.error(`[INTENTCHORD_SECONDARY] ${channel} ${JSON.stringify(boundedFailureDiagnostic(error))}`);
}
